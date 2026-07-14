import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createPacer, parseRetryAfter, type PacerOptions, type PacerStats } from "../core/pacer.js";
import type { AttachmentEntry, LegacyDocument } from "../parse/index.js";

export type MediaManifestEntry = {
  sourceUrl: string;
  path: string;
  bytes: number;
  contentType: string;
  sha256: string;
  status: "ok" | "missing" | "invalid-type";
  fetchedAt: string;
};

export type MediaPullResult = {
  ok: number;
  missing: number;
  invalid: number;
  skipped: number;
  manifest: MediaManifestEntry[];
  missingUrls: string[];
};

export type MediaPullOptions = {
  irDir: string;
  mediaDir?: string;
  concurrency?: number;
  limit?: number;
  includeDerived?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  startIntervalMs?: number;
  minIntervalMs?: number;
  adaptive?: boolean;
  pacerOptions?: Partial<Omit<PacerOptions, "startIntervalMs" | "minIntervalMs" | "maxConcurrency" | "adaptive">>;
  onPacerStats?: (stats: PacerStats) => void;
};

function parseNdjson<T>(value: string): T[] {
  return value.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
}

async function readNdjson<T>(path: string): Promise<T[]> {
  try { return parseNdjson<T>(await readFile(path, "utf8")); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function uploadPath(url: URL): string | undefined {
  if (!url.pathname.startsWith("/wp-content/uploads/")) return undefined;
  return url.pathname;
}

/** Combines the original attachment path with WordPress metadata size filenames. */
export function collectMediaUrls(attachments: AttachmentEntry[], documents: Pick<LegacyDocument, "assets">[], includeDerived = false): string[] {
  const urls = new Set<string>();
  const add = (raw: string) => {
    try {
      const url = new URL(raw);
      // Cache-busting query strings do not identify a different WordPress upload file.
      url.search = "";
      url.hash = "";
      if (uploadPath(url)) urls.add(url.toString());
    } catch { /* malformed source URLs remain outside the media manifest */ }
  };
  for (const attachment of attachments) {
    add(attachment.url);
    if (!includeDerived) continue;
    let directory: URL;
    try { directory = new URL(".", attachment.url); } catch { continue; }
    for (const derived of attachment.derivedSizes) add(new URL(derived.file, directory).toString());
  }
  for (const document of documents) for (const asset of document.assets) add(asset);
  return [...urls].sort();
}

function emptyDigest(): string { return createHash("sha256").update("").digest("hex"); }
function retryableStatus(status: number): boolean { return status === 429 || status >= 500; }
function defaultSleep(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function download(fetchImpl: typeof fetch, url: string, sleep: (milliseconds: number) => Promise<void>): Promise<Response | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(url);
      if (!retryableStatus(response.status) || attempt === 2) return response;
    } catch (error) {
      if (attempt === 2) return undefined;
    }
    await sleep(250 * (2 ** attempt));
  }
  return undefined;
}

export async function pullMedia(options: MediaPullOptions): Promise<MediaPullResult> {
  const mediaDir = options.mediaDir ?? "./media";
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const [attachments, documents] = await Promise.all([
    readNdjson<AttachmentEntry>(join(options.irDir, "attachments.ndjson")),
    readNdjson<LegacyDocument>(join(options.irDir, "documents.ndjson")),
  ]);
  const urls = collectMediaUrls(attachments, documents, options.includeDerived).slice(0, options.limit);
  await mkdir(mediaDir, { recursive: true });
  const pacer = createPacer({
    ...options.pacerOptions,
    maxConcurrency: Math.max(1, options.concurrency ?? 6),
    minIntervalMs: Math.max(0, options.minIntervalMs ?? 0),
    startIntervalMs: Math.max(0, options.startIntervalMs ?? 1000),
    adaptive: options.adaptive ?? true,
  });
  let completedRequests = 0;
  const results = await Promise.all(urls.map(async (sourceUrl): Promise<{ entry: MediaManifestEntry; skipped: boolean }> => {
    const parsed = new URL(sourceUrl);
    const relativePath = uploadPath(parsed);
    if (!relativePath) throw new Error(`uploads path ではありません: ${sourceUrl}`);
    const outputPath = join(mediaDir, relativePath);
    const fetchedAt = new Date().toISOString();
    const response = await pacer.run(
      () => download(fetchImpl, sourceUrl, sleep),
      (downloaded) => ({
        ok: !!downloaded && downloaded.ok,
        ...(downloaded?.status === 429 ? { retryAfterMs: parseRetryAfter(downloaded.headers.get("retry-after"), options.pacerOptions?.now?.()) } : {}),
      }),
    );
    completedRequests += 1;
    if (completedRequests % 10 === 0) options.onPacerStats?.(pacer.stats());
    if (!response || !response.ok) {
      return { skipped: false, entry: { sourceUrl, path: relativePath, bytes: 0, contentType: response?.headers.get("content-type") ?? "", sha256: emptyDigest(), status: "missing", fetchedAt } };
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (/^text\/html(?:;|$)/i.test(contentType)) {
      return { skipped: false, entry: { sourceUrl, path: relativePath, bytes: 0, contentType, sha256: emptyDigest(), status: "invalid-type", fetchedAt } };
    }
    const contentLength = Number(response.headers.get("content-length"));
    try {
      const existing = await stat(outputPath);
      if (Number.isFinite(contentLength) && existing.size === contentLength) {
        const sha256 = createHash("sha256").update(await readFile(outputPath)).digest("hex");
        return { skipped: true, entry: { sourceUrl, path: relativePath, bytes: existing.size, contentType, sha256, status: "ok", fetchedAt } };
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const body = Buffer.from(await response.arrayBuffer());
    const bytes = body.byteLength;
    const sha256 = createHash("sha256").update(body).digest("hex");
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, body);
    return { skipped: false, entry: { sourceUrl, path: relativePath, bytes, contentType, sha256, status: "ok", fetchedAt } };
  }));
  options.onPacerStats?.(pacer.stats());
  const manifest = results.map((result) => result.entry);
  const missingUrls = manifest.filter((entry) => entry.status === "missing").map((entry) => entry.sourceUrl);
  await Promise.all([
    writeFile(join(mediaDir, "manifest.ndjson"), manifest.map((entry) => JSON.stringify(entry)).join("\n") + (manifest.length ? "\n" : "")),
    writeFile(join(mediaDir, "missing.txt"), missingUrls.join("\n") + (missingUrls.length ? "\n" : "")),
  ]);
  return {
    ok: manifest.filter((entry) => entry.status === "ok").length,
    missing: missingUrls.length,
    invalid: manifest.filter((entry) => entry.status === "invalid-type").length,
    skipped: results.filter((result) => result.skipped).length,
    manifest,
    missingUrls,
  };
}
