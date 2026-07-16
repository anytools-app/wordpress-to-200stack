import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import pLimit from "p-limit";

import type { ApiDef, FieldDef, MigrationConfig } from "../config.js";
import type { LegacyDocument } from "../parse/index.js";

type FetchLike = typeof fetch;
type ImportState = Record<string, string>;
type ContentIdMap = Record<string, string>;
export type MediaMapEntry = { assetUrl: string; uploadedAt?: string };
type MediaMap = Record<string, MediaMapEntry>;
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
  /** Path to the state/map written by `wpkit media upload`. Requires `config`. */
  mediaMapPath?: string;
  /** Optional mapping information used only to normalize the microCMS write payload. */
  config?: MigrationConfig;
};
export type ImportFailure = { api: string; contentId: string; phase: "payload" | "upsert" | "relation"; message: string };
export type ImportWarning = { api: string; contentId: string; fieldId: string; value: unknown; reason: "invalidNumber" | "invalidSelectOption" | "missingMediaMap" };
export type ImportResult = {
  total: number; wouldUpload: number; wouldAutoAssign: number; autoAssigned: number; provisional: number; uploaded: number; skipped: number; oversized: number; dryRun: boolean;
  failures: ImportFailure[];
  warnings: ImportWarning[];
  totals: Array<{ api: string; expected: number; actual?: number; matches?: boolean }>;
};

const MAX_PAYLOAD_BYTES = 180 * 1024;
const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const checksumPayload = (payload: Record<string, unknown>): string => createHash("sha256").update(JSON.stringify(payload)).digest("hex");

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

function fieldsForApi(api: ApiDef): Map<string, FieldDef> {
  const fields = new Map(api.fields.map((field) => [field.fieldId, field]));
  if (api.kindField) {
    const options = [...new Set(Array.isArray(api.from) ? api.from : [api.from])];
    fields.set(api.kindField, { metaKey: "", fieldId: api.kindField, type: "select", options });
  }
  return fields;
}

/**
 * Keeps the durable IR representation intact while matching microCMS's write API.
 * Relations are sent later through their dedicated PATCH path and never enter here.
 */
function replaceImage(value: unknown, mediaMap: MediaMap, document: LegacyDocument, fieldId: string, warnings: ImportWarning[]): unknown {
  if (typeof value !== "string" || value === "") return value;
  const mapped = mediaMap[value]?.assetUrl;
  if (mapped) return mapped;
  warnings.push({ api: document.api, contentId: document.contentId, fieldId, value, reason: "missingMediaMap" });
  return undefined;
}

function replaceMappedImages(document: LegacyDocument, payload: Record<string, unknown>, definition: ApiDef, mediaMap: MediaMap, warnings: ImportWarning[]): Record<string, unknown> {
  const mapped = { ...payload };
  if (definition.featuredImage && "featuredImage" in mapped) {
    const value = replaceImage(mapped.featuredImage, mediaMap, document, "featuredImage", warnings);
    if (value === undefined) delete mapped.featuredImage; else mapped.featuredImage = value;
  }
  for (const field of definition.fields.filter((item) => item.type === "image")) {
    if (!(field.fieldId in mapped)) continue;
    const value = replaceImage(mapped[field.fieldId], mediaMap, document, field.fieldId, warnings);
    if (value === undefined) delete mapped[field.fieldId]; else mapped[field.fieldId] = value;
  }
  for (const repeater of definition.repeaters ?? []) {
    const imageColumns = repeater.columns.filter((column) => column.type === "image");
    const rows = mapped[repeater.fieldId];
    if (!imageColumns.length || !Array.isArray(rows)) continue;
    mapped[repeater.fieldId] = rows.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return row;
      const next = { ...(row as Record<string, unknown>) };
      for (const column of imageColumns) {
        if (!(column.fieldId in next)) continue;
        const value = replaceImage(next[column.fieldId], mediaMap, document, `${repeater.fieldId}.${column.fieldId}`, warnings);
        if (value === undefined) delete next[column.fieldId]; else next[column.fieldId] = value;
      }
      return next;
    });
  }
  return mapped;
}

function rewriteBodyMedia(document: LegacyDocument, value: unknown, mediaMap: MediaMap, warnings: ImportWarning[]): unknown {
  if (typeof value !== "string") return value;
  const rewriteUrl = (url: string): string => {
    let isUpload = false;
    try { isUpload = /^\/wp-content\/uploads\/.*\.(?:avif|gif|jpe?g|png|webp)$/i.test(new URL(url.replaceAll("&amp;", "&"), process.env.WPKIT_ORIGIN ?? "https://example.invalid").pathname); }
    catch { return url; }
    if (!isUpload) return url;
    const mapped = mediaMap[url]?.assetUrl;
    if (mapped) return mapped;
    warnings.push({ api: document.api, contentId: document.contentId, fieldId: "legacyBodyHtml", value: url, reason: "missingMediaMap" });
    return url;
  };
  return value.replace(/\b(src|srcset)=(['"])([^'"]+)\2/gi, (_whole, attribute: string, quote: string, attributeValue: string) => {
    const rewritten = attribute.toLowerCase() === "srcset"
      ? attributeValue.split(",").map((candidate) => {
        const match = candidate.match(/^(\s*)(\S+)([\s\S]*)$/);
        return match ? `${match[1] ?? ""}${rewriteUrl(match[2] ?? "")}${match[3] ?? ""}` : candidate;
      }).join(",")
      : rewriteUrl(attributeValue);
    return `${attribute}=${quote}${rewritten}${quote}`;
  });
}

function stripNullValues(payload: Record<string, unknown>): Record<string, unknown> {
  // microCMS はメディアフィールドに null を送ると 504 でタイムアウトする(2026-07 実測)。
  // 新規入稿で null を送る必要はないため、null/undefined のキーは送信しない(repeater 内も同様)。
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    cleaned[key] = Array.isArray(value)
      ? value.map((item) => (item && typeof item === "object" && !Array.isArray(item) ? stripNullValues(item as Record<string, unknown>) : item))
      : value;
  }
  return cleaned;
}

function normalizePayload(document: LegacyDocument, payload: Record<string, unknown>, config: MigrationConfig | undefined, warnings: ImportWarning[], mediaMap?: MediaMap): Record<string, unknown> {
  const definition = config?.apis[document.api];
  const bodyMappedPayload = mediaMap && "legacyBodyHtml" in payload
    ? { ...payload, legacyBodyHtml: rewriteBodyMedia(document, payload.legacyBodyHtml, mediaMap, warnings) }
    : payload;
  // --config is opt-in so existing import behavior remains unchanged.
  if (!definition) return stripNullValues(bodyMappedPayload);
  const fields = fieldsForApi(definition);
  const imageMappedPayload = mediaMap ? replaceMappedImages(document, bodyMappedPayload, definition, mediaMap, warnings) : bodyMappedPayload;
  const normalized: Record<string, unknown> = {};
  for (const [fieldId, value] of Object.entries(imageMappedPayload)) {
    const field = fields.get(fieldId);
    // Empty strings are unset values in microCMS, regardless of field type.
    // A number-field empty string is also reported because it is a rejected value.
    if (value === "") {
      if (field?.type === "number") warnings.push({ api: document.api, contentId: document.contentId, fieldId, value, reason: "invalidNumber" });
      continue;
    }
    if (!field) { normalized[fieldId] = value; continue; }
    if (field.options && typeof value === "string") {
      if (!field.options.includes(value)) {
        warnings.push({ api: document.api, contentId: document.contentId, fieldId, value, reason: "invalidSelectOption" });
        continue;
      }
      normalized[fieldId] = [value];
      continue;
    }
    if (field.type === "number" && typeof value === "string") {
      const number = Number(value);
      if (value.trim() === "" || Number.isNaN(number)) {
        warnings.push({ api: document.api, contentId: document.contentId, fieldId, value, reason: "invalidNumber" });
        continue;
      }
      normalized[fieldId] = number;
      continue;
    }
    normalized[fieldId] = value;
  }
  return stripNullValues(normalized);
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
async function readContentIdMap(path: string): Promise<ContentIdMap> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("object ではありません");
    const entries = Object.entries(parsed);
    if (entries.some((entry) => typeof entry[1] !== "string" || entry[1] === "")) throw new Error("暫定 contentId と採番済み ID の文字列ペアではありません");
    return Object.fromEntries(entries);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`contentid-map.json を読み取れません: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function readMediaMap(path: string): Promise<MediaMap> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("object ではありません");
    const entries = Object.entries(parsed).filter((entry): entry is [string, MediaMapEntry] => {
      const value = entry[1];
      return Boolean(value) && typeof value === "object" && !Array.isArray(value) && typeof (value as MediaMapEntry).assetUrl === "string";
    });
    if (entries.length !== Object.keys(parsed).length) throw new Error("assetUrl を持たないエントリがあります");
    return Object.fromEntries(entries);
  } catch (error: unknown) {
    throw new Error(`media-map を読み取れません: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function requestWithRetry(fetchImpl: FetchLike, limiter: WriteRateLimiter, url: string, init: RequestInit, sleep: (milliseconds: number) => Promise<void>): Promise<Response> {
  let last: Response | undefined;
  for (let retry = 0; retry <= 5; retry += 1) {
    await limiter.take();
    try {
      // 応答が返らないハング(504系の間欠障害時に実測)をリトライへ転換するため60秒で打ち切る。
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      let response: Response;
      try { response = await fetchImpl(url, { ...init, signal: controller.signal }); }
      finally { clearTimeout(timer); }
      if (response.status !== 429 && response.status < 500) return response;
      last = response;
    } catch (error) {
      if (retry === 5) throw error;
    }
    if (retry < 5) await sleep(Math.min(2_000 * (2 ** retry), 30_000));
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
  if (options.mediaMapPath && !options.config) throw new Error("--media-map には --config が必要です");
  const mediaMap = options.mediaMapPath ? await readMediaMap(options.mediaMapPath) : undefined;
  const allDocuments = await readDocuments(options.irDir);
  const documents = allDocuments.filter((document) => (!options.only || document.api === options.only) && (options.sourceId === undefined || document.source.wpId === options.sourceId));
  const selectedContentIds = new Set(documents.map((document) => document.contentId));
  const provisionalContentIds = new Set(allDocuments.filter((document) => document.contentIdProvisional).map((document) => document.contentId));
  const statePath = join(options.irDir, "import-state.json");
  const contentIdMapPath = join(options.irDir, "contentid-map.json");
  const state = await readState(statePath);
  const contentIdMap = await readContentIdMap(contentIdMapPath);
  let contentIdMapWrites = Promise.resolve();
  const persistContentIdMap = async (): Promise<void> => {
    contentIdMapWrites = contentIdMapWrites.then(() => writeFile(contentIdMapPath, `${JSON.stringify(contentIdMap, null, 2)}\n`));
    return contentIdMapWrites;
  };
  const result: ImportResult = { total: documents.length, wouldUpload: 0, wouldAutoAssign: 0, autoAssigned: 0, provisional: documents.filter((document) => document.contentIdProvisional).length, uploaded: 0, skipped: 0, oversized: 0, dryRun: Boolean(options.dryRun), failures: [], warnings: [], totals: [] };
  const candidates: Array<{ document: LegacyDocument; payload: Record<string, unknown>; checksum: string }> = [];
  for (const document of documents) {
    const payload = normalizePayload(document, documentPayload(document), options.config, result.warnings, mediaMap);
    // Without --media-map retain the durable IR checksum exactly. With it, the
    // map changes the write payload, so use that payload as the idempotency key
    // and do not let an earlier text-field import suppress the media migration.
    const payloadChecksum = mediaMap ? checksumPayload(payload) : document.payloadChecksum;
    if (state[document.contentId] === payloadChecksum && (!document.contentIdProvisional || contentIdMap[document.contentId])) { result.skipped += 1; continue; }
    if (byteLength(payload) > MAX_PAYLOAD_BYTES) { result.oversized += 1; result.failures.push({ api: document.api, contentId: document.contentId, phase: "payload", message: `payload が ${MAX_PAYLOAD_BYTES} bytes を超えています` }); continue; }
    candidates.push({ document, payload, checksum: payloadChecksum });
  }
  result.wouldUpload = candidates.length;
  result.wouldAutoAssign = candidates.filter(({ document }) => document.contentIdProvisional && !contentIdMap[document.contentId]).length;
  if (options.dryRun) return result;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? delay;
  const limiter = new WriteRateLimiter(sleep);
  const root = baseUrl(serviceDomain!);
  const headers = { "X-MICROCMS-API-KEY": apiKey!, "Content-Type": "application/json" };
  const limit = pLimit(Math.max(1, options.concurrency ?? 1));
  await Promise.all(candidates.map((candidate) => limit(async () => {
    try {
      const assignedContentId = candidate.document.contentIdProvisional ? contentIdMap[candidate.document.contentId] : undefined;
      const url = assignedContentId
        ? `${root}/${encodeURIComponent(candidate.document.api)}/${encodeURIComponent(assignedContentId)}`
        : candidate.document.contentIdProvisional
          ? `${root}/${encodeURIComponent(candidate.document.api)}`
          : `${root}/${encodeURIComponent(candidate.document.api)}/${encodeURIComponent(candidate.document.contentId)}`;
      const method = assignedContentId || !candidate.document.contentIdProvisional ? "PUT" : "POST";
      let response = await requestWithRetry(fetchImpl, limiter, url, { method, headers, body: JSON.stringify(candidate.payload) }, sleep);
      if (response.status === 400 && method === "PUT") {
        const text = await response.text().catch(() => "");
        // microCMS の PUT は新規作成専用。既存コンテンツは PATCH で更新する(state 消失時も冪等に再実行できるように)。
        if (/already exists/i.test(text)) response = await requestWithRetry(fetchImpl, limiter, url, { method: "PATCH", headers, body: JSON.stringify(candidate.payload) }, sleep);
        else throw new Error(`HTTP 400: ${text.slice(0, 300)}`);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`);
      if (method === "POST") {
        const body = await response.json().catch(() => undefined) as { id?: unknown } | undefined;
        if (typeof body?.id !== "string" || body.id === "") throw new Error("POST レスポンスに採番された id がありません");
        contentIdMap[candidate.document.contentId] = body.id;
        try { await persistContentIdMap(); }
        catch (error) {
          delete contentIdMap[candidate.document.contentId];
          throw error;
        }
        result.autoAssigned += 1;
      }
      state[candidate.document.contentId] = candidate.checksum;
      result.uploaded += 1;
    } catch (error: unknown) { result.failures.push({ api: candidate.document.api, contentId: candidate.document.contentId, phase: "upsert", message: error instanceof Error ? error.message : String(error) }); }
  })));
  // Relations must run only after every target content ID has been created.
  for (const document of documents) {
    if (!state[document.contentId]) continue;
    const assignedDocumentId = document.contentIdProvisional ? contentIdMap[document.contentId] : document.contentId;
    if (!assignedDocumentId) continue;
    const relationValues = new Map<string, string>();
    for (const relation of document.relations) {
      if (!relation.targetContentId || relationValues.has(relation.fieldId)) continue;
      const targetIsProvisional = provisionalContentIds.has(relation.targetContentId);
      const mappedTargetId = contentIdMap[relation.targetContentId];
      if ((targetIsProvisional && !mappedTargetId) || (selectedContentIds.has(relation.targetContentId) && !state[relation.targetContentId])) continue;
      relationValues.set(relation.fieldId, mappedTargetId ?? relation.targetContentId);
    }
    if (relationValues.size === 0) continue;
    const url = `${root}/${encodeURIComponent(document.api)}/${encodeURIComponent(assignedDocumentId)}`;
    try {
      const response = await requestWithRetry(fetchImpl, limiter, url, { method: "PATCH", headers, body: JSON.stringify(Object.fromEntries(relationValues)) }, sleep);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`);
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
