import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import sharp from "sharp";

import type { MigrationConfig } from "../config.js";
import type { LegacyDocument } from "../parse/index.js";

const MAX_BYTES = 5 * 1024 * 1024;
const UPLOAD_INTERVAL_MS = 500;

export type MediaMapEntry = { assetUrl: string; uploadedAt: string };
export type MediaMap = Record<string, MediaMapEntry>;
export type MediaUploadResult = {
  referenced: number;
  cached: number;
  missing: string[];
  oversized: number;
  sourceBytes: number;
  uploaded: number;
  skipped: number;
  failures: Array<{ url: string; message: string }>;
  dryRun: boolean;
};
export type MediaUploadOptions = {
  irDir: string;
  cacheDir: string;
  config: MigrationConfig;
  mapPath: string;
  only?: string;
  limit?: number;
  dryRun?: boolean;
  serviceDomain?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
};

function cacheKey(url: string): string { return createHash("sha1").update(url).digest("hex"); }

async function readDocuments(irDir: string): Promise<LegacyDocument[]> {
  const body = await readFile(join(irDir, "documents.ndjson"), "utf8");
  return body.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as LegacyDocument; }
    catch { throw new Error(`documents.ndjson:${index + 1}: JSON を読み取れません`); }
  });
}

async function readMap(path: string): Promise<MediaMap> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object ではありません");
    const map: MediaMap = {};
    for (const [url, entry] of Object.entries(value)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const item = entry as Partial<MediaMapEntry>;
      if (typeof item.assetUrl === "string" && typeof item.uploadedAt === "string") map[url] = { assetUrl: item.assetUrl, uploadedAt: item.uploadedAt };
    }
    return map;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`media map を読み取れません: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readCached(url: string, cacheDir: string): Promise<Buffer | undefined> {
  const key = cacheKey(url);
  try {
    const [body, raw] = await Promise.all([readFile(join(cacheDir, `${key}.bin`)), readFile(join(cacheDir, `${key}.json`), "utf8")]);
    const metadata = JSON.parse(raw) as { url?: unknown; status?: unknown };
    return metadata.url === url && typeof metadata.status === "number" && metadata.status >= 200 && metadata.status < 300 ? body : undefined;
  } catch { return undefined; }
}

function imageUrls(document: LegacyDocument, config: MigrationConfig): string[] {
  const definition = config.apis[document.api];
  if (!definition) return [];
  const urls: string[] = [];
  // Smart Custom Fields may contain a display label in an image-shaped legacy field.
  // Only a remotely cached HTTP URL can be uploaded, so labels are intentionally ignored.
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    try { const url = new URL(value); if (url.protocol === "http:" || url.protocol === "https:") urls.push(value); }
    catch { /* not an upload URL */ }
  };
  if (definition.featuredImage) add(document.featuredImage);
  for (const field of definition.fields) if (field.type === "image") add(document.fields[field.fieldId]);
  for (const repeater of definition.repeaters ?? []) {
    const imageColumns = repeater.columns.filter((column) => column.type === "image");
    if (imageColumns.length === 0) continue;
    for (const row of document.repeaters[repeater.fieldId] ?? []) for (const column of imageColumns) add(row[column.fieldId]);
  }
  return urls;
}

/** CMS-editable image fields only. HTML body and generic document assets deliberately stay out. */
export function collectCmsImageUrls(documents: readonly LegacyDocument[], config: MigrationConfig, only?: string): string[] {
  const urls = new Set<string>();
  for (const document of documents) if (!only || document.api === only) for (const url of imageUrls(document, config)) urls.add(url);
  return [...urls].sort();
}

async function preparedUpload(body: Buffer): Promise<{ body: Buffer; type: string; filenameExtension: string; converted: boolean }> {
  if (body.byteLength <= MAX_BYTES) return { body, type: "application/octet-stream", filenameExtension: "", converted: false };
  let quality = 80;
  let converted: Buffer | undefined;
  do {
    converted = await sharp(body).rotate().resize({ width: 2560, withoutEnlargement: true }).webp({ quality }).toBuffer();
    if (converted.byteLength <= MAX_BYTES || quality <= 50) break;
    quality -= 10;
  } while (quality >= 50);
  if (converted!.byteLength > MAX_BYTES) {
    throw new Error(`WebP 変換後も 5MB を超えています (${converted!.byteLength} bytes, quality ${quality})`);
  }
  return { body: converted!, type: "image/webp", filenameExtension: ".webp", converted: true };
}

function filenameFor(url: string, extension: string): string {
  try {
    const name = new URL(url).pathname.split("/").pop() || "image";
    return extension ? `${name.replace(/\.[^.]+$/, "")}${extension}` : name;
  } catch { return extension ? `image${extension}` : "image"; }
}

function managementUrl(domain: string): string {
  if (!/^[a-z0-9-]+$/i.test(domain)) throw new Error("MICROCMS_SERVICE_DOMAIN が不正です");
  return `https://${domain}.microcms-management.io/api/v1/media`;
}

class RateLimiter {
  private lastStart = 0;
  constructor(private readonly sleep: (milliseconds: number) => Promise<void>) {}
  async take(): Promise<void> {
    const wait = Math.max(0, this.lastStart + UPLOAD_INTERVAL_MS - Date.now());
    if (wait > 0) await this.sleep(wait);
    this.lastStart = Date.now();
  }
}

/** Uploads cache-backed CMS image references; it never fetches the legacy origin. */
export async function uploadMedia(options: MediaUploadOptions): Promise<MediaUploadResult> {
  const documents = await readDocuments(options.irDir);
  const urls = collectCmsImageUrls(documents, options.config, options.only).slice(0, options.limit);
  const map = await readMap(options.mapPath);
  const result: MediaUploadResult = { referenced: urls.length, cached: 0, missing: [], oversized: 0, sourceBytes: 0, uploaded: 0, skipped: 0, failures: [], dryRun: Boolean(options.dryRun) };
  const cached: Array<{ url: string; body: Buffer }> = [];
  for (const url of urls) {
    if (map[url]) { result.skipped += 1; continue; }
    const body = await readCached(url, options.cacheDir);
    if (!body) { result.missing.push(url); continue; }
    result.cached += 1;
    result.sourceBytes += body.byteLength;
    if (body.byteLength > MAX_BYTES) result.oversized += 1;
    cached.push({ url, body });
  }
  result.missing.sort();
  if (options.dryRun) return result;

  const serviceDomain = options.serviceDomain ?? process.env.MICROCMS_SERVICE_DOMAIN;
  const apiKey = options.apiKey ?? process.env.MICROCMS_API_KEY;
  if (!serviceDomain || !apiKey) throw new Error("MICROCMS_SERVICE_DOMAIN と MICROCMS_API_KEY が必要です");
  const fetchImpl = options.fetchImpl ?? fetch;
  const limiter = new RateLimiter(options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))));
  const now = options.now ?? (() => new Date());
  const endpoint = managementUrl(serviceDomain);
  for (const entry of cached) {
    try {
      const prepared = await preparedUpload(entry.body);
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(prepared.body)], { type: prepared.type }), filenameFor(entry.url, prepared.filenameExtension));
      await limiter.take();
      const response = await fetchImpl(endpoint, { method: "POST", headers: { "X-MICROCMS-API-KEY": apiKey }, body: form });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 1000)}`);
      const payload = await response.json() as { url?: unknown };
      if (typeof payload.url !== "string" || !payload.url) throw new Error("レスポンスに配信 URL がありません");
      map[entry.url] = { assetUrl: payload.url, uploadedAt: now().toISOString() };
      result.uploaded += 1;
    } catch (error: unknown) { result.failures.push({ url: entry.url, message: error instanceof Error ? error.message : String(error) }); }
  }
  await mkdir(dirname(options.mapPath), { recursive: true });
  await writeFile(options.mapPath, `${JSON.stringify(map, null, 2)}\n`);
  return result;
}
