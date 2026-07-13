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

function applyMicroCmsRecord(document: LegacyDocument, record: MicroCmsRecord): LegacyDocument {
  const fields = Object.fromEntries(Object.entries(record).filter(([key]) => !COMMON_FIELDS.has(key) && !(key in document.repeaters)));
  const repeaters = Object.fromEntries(Object.keys(document.repeaters).map((key) => [
    key,
    Array.isArray(record[key]) ? record[key] as Array<Record<string, unknown>> : document.repeaters[key],
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
    ...(typeof record.featuredImage === "string" ? { featuredImage: record.featuredImage } : {}),
  };
}

/** IR の route/source 情報を正とし、microCMS が保持する公開フィールドを重ねる。 */
export function hydrateDocuments(documents: readonly LegacyDocument[], source: "ir" | "microcms", records: CachedMicroCmsRecords = {}): LegacyDocument[] {
  if (source === "ir") return [...documents];
  return documents.map((document) => {
    const record = records[document.api]?.find((entry) => entry.id === document.contentId);
    if (!record) throw new Error(`microCMS ${document.api}/${document.contentId} が IR 台帳に対して不足しています`);
    return applyMicroCmsRecord(document, record);
  });
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
    const hydrated = hydrateDocuments(documents, buildManifest.source, records);
    return new ContentRepository(hydrated, routes, new Map(hydrated.map((document) => [document.contentId, document])));
  }

  allRoutes(): RouteEntry[] { return this.routes; }

  findByRoute(path: string[]): LegacyDocument | undefined {
    const normalized = path.length === 0 ? "/" : `/${path.join("/")}`;
    const route = this.routes.find((entry) => entry.path === normalized);
    return route ? this.documentsById.get(route.contentId) : undefined;
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
