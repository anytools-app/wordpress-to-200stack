import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import pLimit from "p-limit";

import type { LegacyDocument } from "../parse/index.js";

type FetchLike = typeof fetch;
type ImportState = Record<string, string>;
export type ImportOptions = {
  irDir: string;
  only?: string;
  sourceId?: number;
  dryRun?: boolean;
  concurrency?: number;
  serviceDomain?: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
  sleep?: (milliseconds: number) => Promise<void>;
};
export type ImportFailure = { api: string; contentId: string; phase: "payload" | "upsert" | "relation"; message: string };
export type ImportResult = {
  total: number; wouldUpload: number; uploaded: number; skipped: number; oversized: number; dryRun: boolean;
  failures: ImportFailure[];
  totals: Array<{ api: string; expected: number; actual?: number; matches?: boolean }>;
};

const MAX_PAYLOAD_BYTES = 180 * 1024;
const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

class WriteRateLimiter {
  private tail = Promise.resolve();
  private lastStart = 0;
  constructor(private readonly sleep: (milliseconds: number) => Promise<void>) {}
  async take(): Promise<void> {
    let release: () => void = () => undefined;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = turn;
    await previous;
    const wait = Math.max(0, this.lastStart + 250 - Date.now());
    if (wait > 0) await this.sleep(wait);
    this.lastStart = Date.now();
    release();
  }
}

function documentPayload(document: LegacyDocument): Record<string, unknown> {
  return {
    title: document.content.title,
    legacyPath: document.route.path,
    ...(document.content.legacyBodyHtml ? { legacyBodyHtml: document.content.legacyBodyHtml } : {}),
    wpId: document.source.wpId,
    publishedAtLegacy: document.content.publishedAt,
    seoTitle: document.seo?.title ?? "",
    seoDescription: document.seo?.description ?? "",
    noindex: document.seo?.noindex ?? false,
    ...document.fields,
    ...Object.fromEntries(Object.entries(document.repeaters).map(([fieldId, rows]) => [fieldId, rows.map((row) => ({ fieldId, ...row }))])),
    ...(document.kind ? { kind: document.kind } : {}),
    ...(document.featuredImage ? { featuredImage: document.featuredImage } : {}),
  };
}

async function readDocuments(irDir: string): Promise<LegacyDocument[]> {
  const body = await readFile(join(irDir, "documents.ndjson"), "utf8");
  return body.split("\n").filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as LegacyDocument; }
    catch { throw new Error(`documents.ndjson:${index + 1}: JSON を読み取れません`); }
  });
}
async function readState(path: string): Promise<ImportState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("object ではありません");
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`import-state.json を読み取れません: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function requestWithRetry(fetchImpl: FetchLike, limiter: WriteRateLimiter, url: string, init: RequestInit, sleep: (milliseconds: number) => Promise<void>): Promise<Response> {
  let last: Response | undefined;
  for (let retry = 0; retry <= 5; retry += 1) {
    await limiter.take();
    try {
      const response = await fetchImpl(url, init);
      if (response.status !== 429 && response.status < 500) return response;
      last = response;
    } catch (error) {
      if (retry === 5) throw error;
    }
    if (retry < 5) await sleep(250 * (2 ** retry));
  }
  return last!;
}

function baseUrl(serviceDomain: string): string {
  if (!/^[a-z0-9-]+$/i.test(serviceDomain)) throw new Error("MICROCMS_SERVICE_DOMAIN が不正です");
  return `https://${serviceDomain}.microcms.io/api/v1`;
}

export { documentPayload };
export async function importDocuments(options: ImportOptions): Promise<ImportResult> {
  const serviceDomain = options.serviceDomain ?? process.env.MICROCMS_SERVICE_DOMAIN;
  const apiKey = options.apiKey ?? process.env.MICROCMS_API_KEY;
  if (!options.dryRun && (!serviceDomain || !apiKey)) throw new Error("MICROCMS_SERVICE_DOMAIN と MICROCMS_API_KEY が必要です");
  const documents = (await readDocuments(options.irDir)).filter((document) => (!options.only || document.api === options.only) && (options.sourceId === undefined || document.source.wpId === options.sourceId));
  const selectedContentIds = new Set(documents.map((document) => document.contentId));
  const statePath = join(options.irDir, "import-state.json");
  const state = await readState(statePath);
  const result: ImportResult = { total: documents.length, wouldUpload: 0, uploaded: 0, skipped: 0, oversized: 0, dryRun: Boolean(options.dryRun), failures: [], totals: [] };
  const candidates: Array<{ document: LegacyDocument; payload: Record<string, unknown>; checksum: string }> = [];
  for (const document of documents) {
    const payload = documentPayload(document);
    // parse calculates this after relation resolution; preserve that durable IR checksum in state.
    const payloadChecksum = document.payloadChecksum;
    if (state[document.contentId] === payloadChecksum) { result.skipped += 1; continue; }
    if (byteLength(payload) > MAX_PAYLOAD_BYTES) { result.oversized += 1; result.failures.push({ api: document.api, contentId: document.contentId, phase: "payload", message: `payload が ${MAX_PAYLOAD_BYTES} bytes を超えています` }); continue; }
    candidates.push({ document, payload, checksum: payloadChecksum });
  }
  result.wouldUpload = candidates.length;
  if (options.dryRun) return result;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? delay;
  const limiter = new WriteRateLimiter(sleep);
  const root = baseUrl(serviceDomain!);
  const headers = { "X-MICROCMS-API-KEY": apiKey!, "Content-Type": "application/json" };
  const limit = pLimit(Math.max(1, options.concurrency ?? 1));
  await Promise.all(candidates.map((candidate) => limit(async () => {
    const url = `${root}/${encodeURIComponent(candidate.document.api)}/${encodeURIComponent(candidate.document.contentId)}`;
    try {
      const response = await requestWithRetry(fetchImpl, limiter, url, { method: "PUT", headers, body: JSON.stringify(candidate.payload) }, sleep);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state[candidate.document.contentId] = candidate.checksum;
      result.uploaded += 1;
    } catch (error: unknown) { result.failures.push({ api: candidate.document.api, contentId: candidate.document.contentId, phase: "upsert", message: error instanceof Error ? error.message : String(error) }); }
  })));
  // Relations must run only after every target content ID has been created.
  for (const document of documents) {
    if (!state[document.contentId]) continue;
    const relationValues = new Map<string, string>();
    for (const relation of document.relations) if (relation.targetContentId && (!selectedContentIds.has(relation.targetContentId) || state[relation.targetContentId]) && !relationValues.has(relation.fieldId)) relationValues.set(relation.fieldId, relation.targetContentId);
    if (relationValues.size === 0) continue;
    const url = `${root}/${encodeURIComponent(document.api)}/${encodeURIComponent(document.contentId)}`;
    try {
      const response = await requestWithRetry(fetchImpl, limiter, url, { method: "PATCH", headers, body: JSON.stringify(Object.fromEntries(relationValues)) }, sleep);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error: unknown) { result.failures.push({ api: document.api, contentId: document.contentId, phase: "relation", message: error instanceof Error ? error.message : String(error) }); }
  }
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const documentsByApi = new Map<string, LegacyDocument[]>();
  for (const document of documents) documentsByApi.set(document.api, [...(documentsByApi.get(document.api) ?? []), document]);
  for (const [api, group] of documentsByApi) {
    const expected = group.length;
    try {
      const response = await fetchImpl(`${root}/${encodeURIComponent(api)}?limit=0&fields=id`, { headers: { "X-MICROCMS-API-KEY": apiKey! } });
      const body = await response.json() as { totalCount?: unknown };
      const actual = typeof body.totalCount === "number" ? body.totalCount : undefined;
      result.totals.push({ api, expected, actual, matches: actual === expected });
    } catch { result.totals.push({ api, expected }); }
  }
  return result;
}
