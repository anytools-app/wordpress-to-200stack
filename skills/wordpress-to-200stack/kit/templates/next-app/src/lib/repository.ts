import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { dataDirectory, readBuildDataManifest, readCachedDocuments, readCachedRoutes, type LegacyDocument, type RouteEntry } from "./manifest";
import type { MicroCmsRecord } from "./microcms";

type CachedMicroCmsRecords = Record<string, MicroCmsRecord[]>;

const COMMON_FIELDS = new Set(["id", "createdAt", "updatedAt", "publishedAt", "revisedAt", "title", "legacyPath", "legacyBodyHtml", "wpId", "publishedAtLegacy", "seoTitle", "seoDescription", "noindex", "kind", "featuredImage"]);

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function repeaterValues(api: string, record: MicroCmsRecord, documents: readonly LegacyDocument[]): Record<string, Array<Record<string, unknown>>> {
  const knownRepeaters = new Set(documents.filter((document) => document.api === api).flatMap((document) => Object.keys(document.repeaters)));
  return Object.fromEntries(Object.entries(record)
    .filter(([key, value]) => !COMMON_FIELDS.has(key) && Array.isArray(value) && (knownRepeaters.has(key) || value.some((entry) => Boolean(objectValue(entry)))))
    .map(([key, value]) => [key, normalizeMediaValue(value) as Array<Record<string, unknown>>]));
}

/** microCMS の画像フィールドは {url,width,height} で返る。サイト内は IR と同じ URL 文字列に正規化する。 */
function normalizeMediaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeMediaValue);
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.url === "string" && ("width" in candidate || "height" in candidate)) return candidate.url;
    return Object.fromEntries(Object.entries(candidate).map(([key, entry]) => [key, normalizeMediaValue(entry)]));
  }
  return value;
}

function applyMicroCmsRecord(document: LegacyDocument, record: MicroCmsRecord): LegacyDocument {
  const fields = Object.fromEntries(Object.entries(record)
    .filter(([key]) => !COMMON_FIELDS.has(key) && !(key in document.repeaters))
    .map(([key, value]) => [key, normalizeMediaValue(value)]));
  const repeaters = Object.fromEntries(Object.keys(document.repeaters).map((key) => [
    key,
    Array.isArray(record[key]) ? (normalizeMediaValue(record[key]) as Array<Record<string, unknown>>) : document.repeaters[key],
  ]));
  return {
    ...document,
    kind: stringValue(record.kind, document.kind ?? "") || undefined,
    content: {
      title: stringValue(record.title, document.content.title),
      legacyBodyHtml: stringValue(record.legacyBodyHtml, document.content.legacyBodyHtml),
      excerpt: document.content.excerpt,
      publishedAt: stringValue(record.publishedAtLegacy, document.content.publishedAt),
    },
    seo: {
      title: stringValue(record.seoTitle, document.seo?.title ?? "") || undefined,
      description: stringValue(record.seoDescription, document.seo?.description ?? "") || undefined,
      noindex: booleanValue(record.noindex, document.seo?.noindex),
    },
    fields: { ...document.fields, ...fields },
    repeaters,
    ...(typeof normalizeMediaValue(record.featuredImage) === "string" ? { featuredImage: normalizeMediaValue(record.featuredImage) as string } : {}),
  };
}

function firstRouteSegment(route: Pick<RouteEntry, "path" | "segments">): string | undefined {
  return route.segments[0] ?? route.path.split("/").filter(Boolean)[0];
}

function defaultSurface(api: string, kind: string | undefined, documents: readonly LegacyDocument[], routes: readonly RouteEntry[]): string {
  if (api === "people") return kind === "vendors" ? "vendors" : "staff";

  const counts = new Map<string, number>();
  const existingRoutes = routes.filter((entry) => entry.api === api);
  for (const route of existingRoutes.length ? existingRoutes : documents.filter((document) => document.api === api).map((document) => document.route)) {
    const segment = firstRouteSegment(route);
    if (segment) counts.set(segment, (counts.get(segment) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([leftSegment, leftCount], [rightSegment, rightCount]) => rightCount - leftCount || leftSegment.localeCompare(rightSegment))[0]?.[0] ?? api;
}

function relationTargetApi(targetContentId: string, documents: readonly LegacyDocument[], records: CachedMicroCmsRecords): string {
  const document = documents.find((candidate) => candidate.contentId === targetContentId);
  if (document) return document.api;
  return Object.entries(records).find(([, entries]) => entries.some((entry) => entry.id === targetContentId))?.[0] ?? "";
}

function relationsFromRecord(record: MicroCmsRecord, documents: readonly LegacyDocument[], records: CachedMicroCmsRecords): LegacyDocument["relations"] {
  return Object.entries(record).flatMap(([fieldId, value]) => {
    if (COMMON_FIELDS.has(fieldId)) return [];
    const reference = objectValue(value);
    const targetContentId = reference && typeof reference.id === "string" ? reference.id : undefined;
    if (!targetContentId) return [];
    return [{ fieldId, toApi: relationTargetApi(targetContentId, documents, records), targetWpId: 0, targetContentId }];
  });
}

function syntheticDocument(api: string, record: MicroCmsRecord, documents: readonly LegacyDocument[], routes: readonly RouteEntry[], records: CachedMicroCmsRecords): LegacyDocument {
  const kind = stringValue(record.kind, "") || undefined;
  const surface = defaultSurface(api, kind, documents, routes);
  const path = `/${surface}/${record.id}`;
  const base: LegacyDocument = {
    synthetic: true,
    source: {
      wpId: 0,
      postType: api,
      status: "publish",
      ...(typeof record.updatedAt === "string" ? { modifiedGmt: record.updatedAt } : {}),
    },
    api,
    kind,
    contentId: record.id,
    route: { legacyUrl: path, path, segments: [surface, record.id], trailingSlash: false },
    content: {
      title: "",
      legacyBodyHtml: "",
      excerpt: "",
      publishedAt: stringValue(record.publishedAt, ""),
    },
    seo: undefined,
    taxonomies: [],
    // people の既存一覧は fields.kind を参照するため、IR 由来文書と同じ形を保つ。
    fields: kind ? { kind } : {},
    repeaters: repeaterValues(api, record, documents),
    relations: relationsFromRecord(record, documents, records),
    assets: [],
    payloadChecksum: `microcms:${api}/${record.id}`,
  };
  return applyMicroCmsRecord(base, record);
}

function syntheticRoutes(documents: readonly LegacyDocument[], routes: readonly RouteEntry[]): RouteEntry[] {
  const existingPaths = new Set(routes.map((route) => route.path));
  const existingIds = new Set(routes.map((route) => route.contentId));
  const additions: RouteEntry[] = [];
  for (const document of documents) {
    if (!document.synthetic || existingPaths.has(document.route.path) || existingIds.has(document.contentId)) continue;
    existingPaths.add(document.route.path);
    existingIds.add(document.contentId);
    additions.push({ ...document.route, api: document.api, contentId: document.contentId, wpId: document.source.wpId });
  }
  return [...routes, ...additions];
}

const emittedSynthesisWarnings = new Set<string>();

function warnSynthesis(message: string): void {
  if (emittedSynthesisWarnings.has(message)) return;
  emittedSynthesisWarnings.add(message);
  console.warn(message);
}

/** IR の route/source 情報を正とし、microCMS が保持する公開フィールドを重ねる。 */
export function hydrateDocuments(documents: readonly LegacyDocument[], source: "ir" | "microcms", records: CachedMicroCmsRecords = {}, routes: readonly RouteEntry[] = []): LegacyDocument[] {
  if (source === "ir") return [...documents];
  const hydrated = documents.map((document) => {
    const record = records[document.api]?.find((entry) => entry.id === document.contentId);
    if (!record) throw new Error(`microCMS ${document.api}/${document.contentId} が IR 台帳に対して不足しています`);
    return applyMicroCmsRecord(document, record);
  });
  const contentIds = new Set(hydrated.map((document) => document.contentId));
  const paths = new Set([...routes.map((route) => route.path), ...hydrated.map((document) => document.route.path)]);
  for (const [api, entries] of Object.entries(records)) {
    for (const record of entries) {
      if (contentIds.has(record.id)) continue;
      const document = syntheticDocument(api, record, hydrated, routes, records);
      if (paths.has(document.route.path)) {
        warnSynthesis(`microCMS ${api}/${record.id} は既存ルート ${document.route.path} と衝突するため合成をスキップします`);
        continue;
      }
      contentIds.add(document.contentId);
      paths.add(document.route.path);
      hydrated.push(document);
    }
  }
  return hydrated;
}

async function readMicroCmsCache(): Promise<CachedMicroCmsRecords> {
  try {
    return JSON.parse(await readFile(join(dataDirectory(), "microcms.json"), "utf8")) as CachedMicroCmsRecords;
  } catch (error) {
    throw new Error(`microCMS キャッシュを読み取れません: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export class ContentRepository {
  private constructor(
    private readonly documents: LegacyDocument[],
    private readonly routes: RouteEntry[],
    private readonly documentsById: Map<string, LegacyDocument>,
  ) {}

  static async load(): Promise<ContentRepository> {
    const [documents, routes, buildManifest] = await Promise.all([readCachedDocuments(), readCachedRoutes(), readBuildDataManifest()]);
    const records = buildManifest.source === "microcms" ? await readMicroCmsCache() : {};
    const hydrated = hydrateDocuments(documents, buildManifest.source, records, routes);
    return new ContentRepository(hydrated, syntheticRoutes(hydrated, routes), new Map(hydrated.map((document) => [document.contentId, document])));
  }

  allRoutes(): RouteEntry[] { return this.routes; }

  byApi(api: string): LegacyDocument[] {
    return this.documents.filter((document) => document.api === api);
  }

  findByRoute(path: string[]): LegacyDocument | undefined {
    const normalized = path.length === 0 ? "/" : `/${path.map((segment) => {
      try { return decodeURIComponent(segment); } catch { return segment; }
    }).join("/")}`;
    const route = this.routes.find((entry) => entry.path === normalized);
    return route ? this.documentsById.get(route.contentId) : undefined;
  }

  findByContentId(contentId: string): LegacyDocument | undefined {
    return this.documentsById.get(contentId);
  }

  findByWpId(wpId: number): LegacyDocument | undefined {
    return this.documents.find((document) => document.source.wpId === wpId);
  }

  latestByApi(limit = 3): Array<{ api: string; documents: LegacyDocument[] }> {
    const groups = new Map<string, LegacyDocument[]>();
    for (const document of this.documents) groups.set(document.api, [...(groups.get(document.api) ?? []), document]);
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([api, documents]) => ({
      api,
      documents: [...documents].sort((left, right) => right.content.publishedAt.localeCompare(left.content.publishedAt)).slice(0, limit),
    }));
  }
}
