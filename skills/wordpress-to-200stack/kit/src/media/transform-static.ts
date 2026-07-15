import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, posix, relative } from "node:path";

import sharp from "sharp";

export type StaticMediaEntry = { local: string; width: number; height: number; bytes: number };
type Manifest = Record<string, unknown>;

export type StaticMediaTransformOptions = {
  dir: string;
  include: string;
  manifestPath: string;
  cacheDir?: string;
  maxWidth?: number;
  quality?: number;
  dryRun?: boolean;
  prune?: boolean;
};

export type StaticMediaTransformResult = {
  converted: number;
  copied: number;
  skipped: number;
  cssRewritten: number;
  pruned: number;
  sourceBytes: number;
  outputBytes: number;
  manifestEntries: number;
};

const RASTER_EXTENSION = /\.(?:jpe?g|png|gif|webp)$/i;
const SVG_EXTENSION = /\.svg$/i;
const HASHED_IMAGE = /\.[a-f0-9]{8}\.(?:gif|webp|svg)$/i;

function isStaticMedia(pathname: string): boolean {
  // SVG icons remain SVG (no raster conversion), but receive the same immutable
  // content-addressed pathname. SVG webfonts stay outside the media pipeline.
  return RASTER_EXTENSION.test(pathname) || (SVG_EXTENSION.test(pathname) && !/\/(?:font|fonts)\//i.test(pathname));
}

function pathnameFor(dir: string, file: string): string {
  return `/${relative(dir, file).split("\\").join("/")}`;
}

function toFilePath(dir: string, pathname: string): string {
  return join(dir, pathname.replace(/^\/+/, ""));
}

function isEntry(value: unknown): value is StaticMediaEntry {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && typeof (value as Partial<StaticMediaEntry>).local === "string";
}

function isIncluded(pathname: string, include: string): boolean {
  // The CLI accepts a glob-shaped include so callers can scope a public tree without
  // bringing in a glob dependency. `wp-content/**` is intentionally the useful form.
  const prefix = include.replace(/\\/g, "/").replace(/\/\*\*.*$/, "").replace(/^\/+|\/+$/g, "");
  return pathname.startsWith(`/${prefix}/`) || pathname === `/${prefix}`;
}

async function files(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isFile()) return [path];
      return entry.isDirectory() ? files(path) : [];
    }));
    return nested.flat();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function outputPathname(pathname: string, output: Buffer, extension: string): string {
  const hash = createHash("sha256").update(output).digest("hex").slice(0, 8);
  return extension === ".gif" || extension === ".svg" ? `${pathname}.${hash}${extension}` : `${pathname}.${hash}.webp`;
}

async function transform(source: Buffer, extension: string, maxWidth: number, quality: number): Promise<{ output: Buffer; width: number; height: number; converted: boolean }> {
  const metadata = await sharp(source, { animated: extension === ".gif" }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("画像の寸法を取得できませんでした");
  if (extension === ".gif" || extension === ".svg") return { output: source, width: metadata.width, height: metadata.height, converted: false };

  let image = sharp(source).rotate();
  if (metadata.width > maxWidth) image = image.resize({ width: maxWidth, withoutEnlargement: true });
  const output = await image.webp({ quality }).toBuffer({ resolveWithObject: true });
  return { output: output.data, width: output.info.width, height: output.info.height, converted: extension !== ".webp" || metadata.width > maxWidth };
}

function resolveCssUrl(cssPathname: string, raw: string): string | undefined {
  const value = raw.trim();
  if (!value || value.startsWith("data:") || value.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//")) return undefined;
  const path = value.split(/[?#]/, 1)[0];
  if (!path) return undefined;
  return path.startsWith("/") ? posix.normalize(path) : posix.resolve(posix.dirname(cssPathname), path);
}

function rewriteCss(css: string, cssPathname: string, manifest: Manifest): { css: string; count: number } {
  let count = 0;
  const rewritten = css.replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, (whole, quote: string, value: string) => {
    const pathname = resolveCssUrl(cssPathname, value);
    const entry = pathname && manifest[pathname];
    if (!isEntry(entry) || entry.local === value) return whole;
    count += 1;
    return `url(${quote}${entry.local}${quote})`;
  });
  return { css: rewritten, count };
}

async function readManifest(path: string): Promise<Manifest> {
  try {
    const data = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("manifest は JSON object である必要があります");
    return data as Manifest;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function cachedSources(cacheDir: string | undefined, include: string): Promise<Map<string, Buffer>> {
  const sources = new Map<string, Buffer>();
  if (!cacheDir) return sources;
  for (const metadataPath of (await files(cacheDir)).filter((path) => extname(path).toLowerCase() === ".json")) {
    try {
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { url?: unknown; status?: unknown };
      if (typeof metadata.url !== "string" || metadata.status !== 200) continue;
      const url = new URL(metadata.url);
      if (!isIncluded(url.pathname, include) || !isStaticMedia(url.pathname)) continue;
      const body = await readFile(join(dirname(metadataPath), `${createHash("sha1").update(metadata.url).digest("hex")}.bin`));
      sources.set(url.pathname, body);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return sources;
}

/** Transform local theme assets without network access and keep the upload manifest entries intact. */
export async function transformStaticMedia(options: StaticMediaTransformOptions): Promise<StaticMediaTransformResult> {
  const maxWidth = options.maxWidth ?? 1600;
  const quality = options.quality ?? 75;
  const manifest = await readManifest(options.manifestPath);
  const allFiles = await files(options.dir);
  const scopedFiles = allFiles.filter((file) => isIncluded(pathnameFor(options.dir, file), options.include));
  const cached = await cachedSources(options.cacheDir, options.include);
  const result: StaticMediaTransformResult = { converted: 0, copied: 0, skipped: 0, cssRewritten: 0, pruned: 0, sourceBytes: 0, outputBytes: 0, manifestEntries: 0 };

  const localSources = scopedFiles.filter((file) => isStaticMedia(file) && !HASHED_IMAGE.test(file))
    .map(async (sourcePath) => ({ sourcePathname: pathnameFor(options.dir, sourcePath), sourcePath, source: await readFile(sourcePath) }));
  const sources: Array<{ sourcePathname: string; sourcePath?: string; source: Buffer }> = await Promise.all(localSources);
  for (const [sourcePathname, source] of cached) {
    if (!manifest[sourcePathname] && !sources.some((candidate) => candidate.sourcePathname === sourcePathname)) sources.push({ sourcePathname, source });
  }
  for (const { sourcePathname, sourcePath, source } of sources) {
    const extension = extname(sourcePathname).toLowerCase();
    const transformed = await transform(source, extension, maxWidth, quality);
    const local = outputPathname(sourcePathname, transformed.output, extension);
    const destination = toFilePath(options.dir, local);
    const entry: StaticMediaEntry = { local, width: transformed.width, height: transformed.height, bytes: transformed.output.byteLength };
    const exists = await stat(destination).then(async (info) => info.size === transformed.output.byteLength
      && createHash("sha256").update(await readFile(destination)).digest("hex") === createHash("sha256").update(transformed.output).digest("hex"), () => false);

    manifest[sourcePathname] = entry;
    result.sourceBytes += source.byteLength;
    result.outputBytes += transformed.output.byteLength;
    if (exists) result.skipped += 1;
    else if (transformed.converted) result.converted += 1;
    else result.copied += 1;
    if (!options.dryRun) {
      if (!exists) {
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, transformed.output);
      }
      if (sourcePath) await unlink(sourcePath);
    }
  }

  for (const cssPath of scopedFiles.filter((file) => extname(file).toLowerCase() === ".css")) {
    const css = await readFile(cssPath, "utf8");
    const rewritten = rewriteCss(css, pathnameFor(options.dir, cssPath), manifest);
    result.cssRewritten += rewritten.count;
    if (!options.dryRun && rewritten.count > 0) await writeFile(cssPath, rewritten.css);
  }

  if (options.prune && !options.dryRun) {
    const referenced = new Set(Object.values(manifest).filter(isEntry).map((entry) => entry.local));
    for (const file of scopedFiles.filter((file) => HASHED_IMAGE.test(file))) {
      const pathname = pathnameFor(options.dir, file);
      if (!referenced.has(pathname)) { await unlink(file); result.pruned += 1; }
    }
  }

  result.manifestEntries = Object.values(manifest).filter(isEntry).length;
  if (!options.dryRun) {
    await mkdir(dirname(options.manifestPath), { recursive: true });
    await writeFile(options.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return result;
}
