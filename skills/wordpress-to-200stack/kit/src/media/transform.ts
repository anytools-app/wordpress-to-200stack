import { createHash } from "node:crypto";
import { readFile, readdir, stat, unlink, writeFile, mkdir } from "node:fs/promises";
import { dirname, extname, join, relative, sep } from "node:path";

import sharp from "sharp";

type CacheMetadata = { url?: unknown; status?: unknown };
type LegacyDocumentReference = {
  featuredImage?: unknown;
  fields?: unknown;
  repeaters?: unknown;
  content?: { legacyBodyHtml?: unknown };
};

export type LocalMediaEntry = { local: string; width: number; height: number; bytes: number };
export type MediaTransformSummary = {
  referenced: number;
  cached: number;
  missing: number;
  converted: number;
  copied: number;
  skipped: number;
  pruned: number;
  sourceBytes: number;
  outputBytes: number;
};
/** The deployed manifest deliberately keeps upload pathnames at its top level for O(1) site lookups. */
export type MediaTransformManifest = { missing: string[]; summary: MediaTransformSummary } & Record<string, unknown>;
export type MediaTransformOptions = {
  irDir: string;
  cacheDir: string;
  outDir: string;
  manifestPath: string;
  maxWidth?: number;
  quality?: number;
  dryRun?: boolean;
  prune?: boolean;
};
export type MediaTransformResult = { manifest: MediaTransformManifest; entries: Record<string, LocalMediaEntry> };
type TransformOutcome = { sourceUrl: string; missing?: true; pathname?: string; entry?: LocalMediaEntry; sourceBytes?: number; status?: "converted" | "copied" | "skipped" };

const IMAGE_EXTENSION = /\.(?:jpe?g|png|gif|webp)$/i;
const URL_CANDIDATE = /(?:https?:)?\/\/[^\s"'<>]+|\/wp-content\/uploads\/[^\s"'<>]+/gi;
function defaultOrigin(): string { return process.env.WPKIT_ORIGIN ?? "https://example.invalid"; }
function originAliasHosts(): Set<string> { return new Set((process.env.WPKIT_ORIGIN_ALIASES ?? "").split(",").map((host) => host.trim()).filter(Boolean)); }

function cacheKey(url: string): string { return createHash("sha1").update(url).digest("hex"); }

function uploadUrl(raw: string): URL | undefined {
  const decoded = raw.replaceAll("&amp;", "&");
  try {
    const url = new URL(decoded.startsWith("//") ? `https:${decoded}` : decoded, defaultOrigin());
    // A fragment is not part of an HTTP request and therefore cannot be part of a remote-cache key.
    url.hash = "";
    // Legacy documents may mix retired alias hosts with the canonical origin,
    // while the fetch-once cache is keyed by the latter (WPKIT_ORIGIN_ALIASES, comma separated).
    if (originAliasHosts().has(url.hostname)) url.hostname = new URL(defaultOrigin()).hostname;
    return url.pathname.startsWith("/wp-content/uploads/") && IMAGE_EXTENSION.test(url.pathname) ? url : undefined;
  } catch {
    return undefined;
  }
}

function addStringUrls(value: string, urls: Set<string>): void {
  const direct = uploadUrl(value);
  if (direct) urls.add(direct.href);
  for (const match of value.matchAll(URL_CANDIDATE)) {
    const url = uploadUrl(match[0]);
    if (url) urls.add(url.href);
  }
}

function collectNestedUrls(value: unknown, urls: Set<string>): void {
  if (typeof value === "string") { addStringUrls(value, urls); return; }
  if (Array.isArray(value)) { for (const item of value) collectNestedUrls(item, urls); return; }
  if (value && typeof value === "object") for (const item of Object.values(value)) collectNestedUrls(item, urls);
}

/** Collect only image references actually rendered by documents; attachments.ndjson is intentionally ignored. */
export function collectReferencedMediaUrls(documents: readonly LegacyDocumentReference[]): string[] {
  const urls = new Set<string>();
  for (const document of documents) {
    collectNestedUrls(document.featuredImage, urls);
    collectNestedUrls(document.fields, urls);
    collectNestedUrls(document.repeaters, urls);
    collectNestedUrls(document.content?.legacyBodyHtml, urls);
  }
  return [...urls].sort();
}

function parseNdjson(value: string): LegacyDocumentReference[] {
  return value.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as LegacyDocumentReference);
}

async function readDocuments(irDir: string): Promise<LegacyDocumentReference[]> {
  return parseNdjson(await readFile(join(irDir, "documents.ndjson"), "utf8"));
}

async function readCached(url: string, cacheDir: string): Promise<Buffer | undefined> {
  const key = cacheKey(url);
  try {
    const [body, rawMetadata] = await Promise.all([
      readFile(join(cacheDir, `${key}.bin`)),
      readFile(join(cacheDir, `${key}.json`), "utf8"),
    ]);
    const metadata = JSON.parse(rawMetadata) as CacheMetadata;
    const status = metadata.status;
    if (metadata.url !== url || typeof status !== "number" || !Number.isInteger(status) || status < 200 || status >= 300) return undefined;
    return body;
  } catch {
    return undefined;
  }
}

function manifestFormat(path: string): "json" | "ts" {
  return extname(path).toLowerCase() === ".ts" ? "ts" : "json";
}

function importPath(manifestPath: string, outputPath: string): string {
  const path = relative(dirname(manifestPath), outputPath).split(sep).join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

function typeScriptManifest(manifestPath: string, entries: Record<string, LocalMediaEntry>, outDir: string): string {
  const imports: string[] = [];
  const records: string[] = [];
  for (const [index, [pathname]] of Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)).entries()) {
    const outputPath = filePath(outDir, outputPathname(new URL(pathname, defaultOrigin()), extension(pathname)));
    imports.push(`import m${index} from ${JSON.stringify(importPath(manifestPath, outputPath))};`);
    records.push(`  ${JSON.stringify(pathname)}: m${index},`);
  }
  return [
    "// 自動生成: wpkit media transform",
    'import type { StaticImageData } from "next/image";',
    ...imports,
    "",
    "const manifest: Record<string, StaticImageData> = {",
    ...records,
    "};",
    "",
    "export default manifest;",
    "",
  ].join("\n");
}

function extension(pathname: string): "jpg" | "png" | "gif" | "webp" {
  const found = pathname.toLowerCase().match(/\.([a-z]+)$/)?.[1];
  if (found === "jpeg" || found === "jpg") return "jpg";
  if (found === "png" || found === "gif" || found === "webp") return found;
  throw new Error(`未対応の画像形式です: ${pathname}`);
}

function outputPathname(url: URL, kind: ReturnType<typeof extension>): string {
  return kind === "jpg" || kind === "png" ? `${url.pathname}.webp` : url.pathname;
}

/** JSON manifests are served from public/, so their output name carries the transformed content identity. */
function hashedOutputPathname(url: URL, kind: ReturnType<typeof extension>, body: Buffer): string {
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 8);
  return kind === "jpg" || kind === "png"
    ? `${url.pathname}.${hash}.webp`
    : `${url.pathname}.${hash}.${kind}`;
}

function filePath(root: string, pathname: string): string {
  return join(root, pathname.replace(/^\/+/, ""));
}

async function existingTypeScriptEntry(pathname: string, local: string, outputPath: string): Promise<LocalMediaEntry | undefined> {
  try {
    const [file, metadata] = await Promise.all([stat(outputPath), sharp(outputPath, { animated: extension(pathname) === "gif" }).metadata()]);
    return metadata.width && metadata.height ? { local, width: metadata.width, height: metadata.height, bytes: file.size } : undefined;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function existingHashedEntry(local: string, outputPath: string, body: Buffer, width: number, height: number): Promise<LocalMediaEntry | undefined> {
  try {
    const existing = await readFile(outputPath);
    const expectedHash = createHash("sha256").update(body).digest("hex");
    if (existing.byteLength !== body.byteLength || createHash("sha256").update(existing).digest("hex") !== expectedHash) return undefined;
    return { local, width, height, bytes: existing.byteLength };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function pruneUnreferencedFiles(outDir: string, referenced: Set<string>): Promise<number> {
  try {
    const files = async (directory: string, relativeDirectory = ""): Promise<string[]> => {
      const entries = await readdir(directory, { withFileTypes: true });
      const nested = await Promise.all(entries.map(async (entry) => {
        const relativePath = join(relativeDirectory, entry.name);
        if (entry.isFile()) return [relativePath];
        return entry.isDirectory() ? files(join(directory, entry.name), relativePath) : [];
      }));
      return nested.flat();
    };
    const stale = (await files(outDir)).filter((path) => !referenced.has(path));
    await Promise.all(stale.map((path) => unlink(join(outDir, path))));
    return stale.length;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function transformImage(body: Buffer, kind: ReturnType<typeof extension>, maxWidth: number, quality: number): Promise<{ body: Buffer; width: number; height: number; converted: boolean }> {
  const metadata = await sharp(body, { animated: kind === "gif" }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("画像の寸法を取得できませんでした");
  if (kind === "gif") return { body, width: metadata.width, height: metadata.height, converted: false };
  if (kind === "webp" && metadata.width <= maxWidth) return { body, width: metadata.width, height: metadata.height, converted: false };

  let image = sharp(body).rotate();
  if (metadata.width > maxWidth) image = image.resize({ width: maxWidth, withoutEnlargement: true });
  const output = kind === "webp" ? await image.webp().toBuffer({ resolveWithObject: true }) : await image.webp({ quality }).toBuffer({ resolveWithObject: true });
  return { body: output.data, width: output.info.width, height: output.info.height, converted: true };
}

/** Transform cached upload references only. This function intentionally has no network dependency. */
export async function transformMedia(options: MediaTransformOptions): Promise<MediaTransformResult> {
  const format = manifestFormat(options.manifestPath);
  const documents = await readDocuments(options.irDir);
  const urls = collectReferencedMediaUrls(documents);
  const maxWidth = options.maxWidth ?? 1600;
  const quality = options.quality ?? 75;
  const entries: Record<string, LocalMediaEntry> = {};
  const missing: string[] = [];
  const summary: MediaTransformSummary = { referenced: urls.length, cached: 0, missing: 0, converted: 0, copied: 0, skipped: 0, pruned: 0, sourceBytes: 0, outputBytes: 0 };

  const processUrl = async (sourceUrl: string): Promise<TransformOutcome> => {
    const url = new URL(sourceUrl);
    const body = await readCached(sourceUrl, options.cacheDir);
    if (!body) return { sourceUrl, missing: true };
    const kind = extension(url.pathname);
    const pathname = url.pathname;
    if (format === "ts") {
      const local = `/media${outputPathname(url, kind)}`;
      const outputPath = filePath(options.outDir, outputPathname(url, kind));
      const prior = await existingTypeScriptEntry(pathname, local, outputPath);
      if (prior) return { sourceUrl, pathname, entry: prior, sourceBytes: body.byteLength, status: "skipped" };
      const transformed = await transformImage(body, kind, maxWidth, quality);
      const entry: LocalMediaEntry = { local, width: transformed.width, height: transformed.height, bytes: transformed.body.byteLength };
      if (!options.dryRun) {
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, transformed.body);
      }
      return { sourceUrl, pathname, entry, sourceBytes: body.byteLength, status: transformed.converted ? "converted" : "copied" };
    }

    const transformed = await transformImage(body, kind, maxWidth, quality);
    const hashedPathname = hashedOutputPathname(url, kind, transformed.body);
    const local = `/media${hashedPathname}`;
    const outputPath = filePath(options.outDir, hashedPathname);
    const prior = await existingHashedEntry(local, outputPath, transformed.body, transformed.width, transformed.height);
    if (prior) return { sourceUrl, pathname, entry: prior, sourceBytes: body.byteLength, status: "skipped" };
    const entry: LocalMediaEntry = { local, width: transformed.width, height: transformed.height, bytes: transformed.body.byteLength };
    if (!options.dryRun) {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, transformed.body);
    }
    return { sourceUrl, pathname, entry, sourceBytes: body.byteLength, status: transformed.converted ? "converted" : "copied" };
  };

  // Sharp itself uses worker threads; four source files in flight keeps this bounded while avoiding a multi-minute dry-run.
  const concurrency = 4;
  for (let offset = 0; offset < urls.length; offset += concurrency) {
    const outcomes = await Promise.all(urls.slice(offset, offset + concurrency).map(processUrl));
    for (const outcome of outcomes) {
      if (outcome.missing) { missing.push(outcome.sourceUrl); continue; }
      if (!outcome.pathname || !outcome.entry || !outcome.status || outcome.sourceBytes === undefined) throw new Error(`変換結果が不正です: ${outcome.sourceUrl}`);
      entries[outcome.pathname] = outcome.entry;
      summary.cached += 1;
      summary.sourceBytes += outcome.sourceBytes;
      summary.outputBytes += outcome.entry.bytes;
      summary[outcome.status] += 1;
    }
  }

  missing.sort();
  summary.missing = missing.length;
  if (format === "json" && options.prune && !options.dryRun) {
    const referenced = new Set(Object.values(entries).map((entry) => entry.local.replace(/^\/media\//, "")));
    summary.pruned = await pruneUnreferencedFiles(options.outDir, referenced);
  }
  const manifest: MediaTransformManifest = { ...entries, missing, summary };
  if (!options.dryRun) {
    await mkdir(dirname(options.manifestPath), { recursive: true });
    if (format === "json") {
      await writeFile(options.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    } else {
      await Promise.all([
        writeFile(options.manifestPath, typeScriptManifest(options.manifestPath, entries, options.outDir)),
        writeFile(join(dirname(options.manifestPath), "media-missing.json"), `${JSON.stringify({ missing, summary }, null, 2)}\n`),
      ]);
    }
  }
  return { manifest, entries };
}
