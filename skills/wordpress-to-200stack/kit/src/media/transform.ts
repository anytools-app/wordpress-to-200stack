import { createHash } from "node:crypto";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

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
};
export type MediaTransformResult = { manifest: MediaTransformManifest; entries: Record<string, LocalMediaEntry> };
type TransformOutcome = { sourceUrl: string; missing?: true; pathname?: string; entry?: LocalMediaEntry; sourceBytes?: number; status?: "converted" | "copied" | "skipped" };

const IMAGE_EXTENSION = /\.(?:jpe?g|png|gif|webp)$/i;
const URL_CANDIDATE = /(?:https?:)?\/\/[^\s"'<>]+|\/wp-content\/uploads\/[^\s"'<>]+/gi;
const DEFAULT_ORIGIN = process.env.WPKIT_ORIGIN ?? "https://example.invalid";

function cacheKey(url: string): string { return createHash("sha1").update(url).digest("hex"); }

function uploadUrl(raw: string): URL | undefined {
  const decoded = raw.replaceAll("&amp;", "&");
  try {
    const url = new URL(decoded.startsWith("//") ? `https:${decoded}` : decoded, DEFAULT_ORIGIN);
    // A fragment is not part of an HTTP request and therefore cannot be part of a remote-cache key.
    url.hash = "";
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

async function readPreviousManifest(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function isLocalEntry(value: unknown): value is LocalMediaEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<LocalMediaEntry>;
  return typeof entry.local === "string" && Number.isInteger(entry.width) && Number.isInteger(entry.height) && Number.isInteger(entry.bytes);
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

function filePath(root: string, pathname: string): string {
  return join(root, pathname.replace(/^\/+/, ""));
}

async function existingEntry(previous: Record<string, unknown>, pathname: string, local: string, outputPath: string): Promise<LocalMediaEntry | undefined> {
  const entry = previous[pathname];
  if (!isLocalEntry(entry) || entry.local !== local) return undefined;
  try {
    return (await stat(outputPath)).size === entry.bytes ? entry : undefined;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
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
  const [documents, previous] = await Promise.all([readDocuments(options.irDir), readPreviousManifest(options.manifestPath)]);
  const urls = collectReferencedMediaUrls(documents);
  const maxWidth = options.maxWidth ?? 1600;
  const quality = options.quality ?? 75;
  const entries: Record<string, LocalMediaEntry> = {};
  const missing: string[] = [];
  const summary: MediaTransformSummary = { referenced: urls.length, cached: 0, missing: 0, converted: 0, copied: 0, skipped: 0, sourceBytes: 0, outputBytes: 0 };

  const processUrl = async (sourceUrl: string): Promise<TransformOutcome> => {
    const url = new URL(sourceUrl);
    const body = await readCached(sourceUrl, options.cacheDir);
    if (!body) return { sourceUrl, missing: true };
    const kind = extension(url.pathname);
    const pathname = url.pathname;
    const local = `/media${outputPathname(url, kind)}`;
    const outputPath = filePath(options.outDir, outputPathname(url, kind));
    const prior = await existingEntry(previous, pathname, local, outputPath);
    if (prior) {
      return { sourceUrl, pathname, entry: prior, sourceBytes: body.byteLength, status: "skipped" };
    }

    const transformed = await transformImage(body, kind, maxWidth, quality);
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
  const manifest: MediaTransformManifest = { ...entries, missing, summary };
  if (!options.dryRun) {
    await mkdir(dirname(options.manifestPath), { recursive: true });
    await writeFile(options.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { manifest, entries };
}
