import {
  normalizeRoutePath,
  type LegacyDocument,
  type MediaDimensions,
  type MicroCmsRecord,
  type RouteEntry,
} from "./types";

export type CachedMicroCmsRecords = Record<string, MicroCmsRecord[]>;

// TODO(案件): microCMS の全リスト API ID を列挙する。
export const MICROCMS_APIS: readonly string[] = [];

// TODO(案件): API ID と公開 surface が異なるものだけ記載する。
const SURFACE_BY_API: Readonly<Record<string, string>> = {};

const COMMON_FIELDS = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "publishedAt",
  "revisedAt",
  "title",
  "legacyBodyHtml",
  "seoTitle",
  "seoDescription",
  "noindex",
  "kind",
  "featuredImage",
]);

export function surfaceFor(api: string): string {
  return SURFACE_BY_API[api] ?? api;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function selectValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.find((entry): entry is string => typeof entry === "string") ?? "";
  return "";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function imageDimensions(value: unknown): MediaDimensions | undefined {
  const image = objectValue(value);
  const width = image?.width;
  const height = image?.height;
  return typeof width === "number" &&
    Number.isFinite(width) &&
    width > 0 &&
    typeof height === "number" &&
    Number.isFinite(height) &&
    height > 0
    ? { width, height }
    : undefined;
}

/** 既存描画契約は URL 文字列のまま保ち、寸法は隣接する imageDimensions に退避する。 */
export function normalizeMediaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeMediaValue);
  const object = objectValue(value);
  if (!object) return value;
  if (typeof object.url === "string" && ("width" in object || "height" in object)) {
    return object.url;
  }
  return normalizeObject(object);
}

function normalizeObject(object: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    normalized[key] = normalizeMediaValue(value);
    const dimensions = imageDimensions(value);
    if (dimensions) normalized[`${key}Dimensions`] = dimensions;
  }
  return normalized;
}

function customFieldGroup(value: unknown): Record<string, unknown> | undefined {
  const object = objectValue(value);
  return object && typeof object.fieldId === "string" ? object : undefined;
}

function repeatersFromRecord(record: MicroCmsRecord): LegacyDocument["repeaters"] {
  return Object.fromEntries(
    Object.entries(record)
      .filter(
        ([key, value]) =>
          !COMMON_FIELDS.has(key) &&
          Array.isArray(value) &&
          value.some((entry) => Boolean(objectValue(entry))),
      )
      .map(([key, rows]) => [
        key,
        (rows as unknown[]).flatMap((row) => {
          const object = objectValue(row);
          return object ? [normalizeObject(object)] : [];
        }),
      ]),
  );
}

function relationIndex(records: CachedMicroCmsRecords): Map<string, string> {
  return new Map(
    Object.entries(records).flatMap(([api, entries]) => entries.map((entry) => [entry.id, api])),
  );
}

function relationsFromRecord(
  record: MicroCmsRecord,
  targets: ReadonlyMap<string, string>,
): LegacyDocument["relations"] {
  return Object.entries(record).flatMap(([fieldId, value]) => {
    if (COMMON_FIELDS.has(fieldId)) return [];
    const group = customFieldGroup(value);
    const values = group
      ? Object.entries(group).filter(([nestedFieldId]) => nestedFieldId !== "fieldId")
      : [[fieldId, value] as const];
    return values.flatMap(([nestedFieldId, nestedValue]) => {
      const reference = objectValue(nestedValue);
      const targetContentId =
        reference && typeof reference.id === "string" ? reference.id : undefined;
      const toApi = targetContentId ? targets.get(targetContentId) : undefined;
      return targetContentId && toApi ? [{ fieldId: nestedFieldId, toApi, targetContentId }] : [];
    });
  });
}

function fieldsFromRecord(
  record: MicroCmsRecord,
  repeaters: LegacyDocument["repeaters"],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, value]) => {
      if (COMMON_FIELDS.has(key) || key in repeaters) return [];
      const group = customFieldGroup(value);
      if (group) {
        return Object.entries(group).flatMap(([fieldId, nestedValue]) =>
          fieldId === "fieldId" || objectValue(nestedValue)?.id
            ? []
            : [[fieldId, nestedValue]],
        );
      }
      return objectValue(value)?.id ? [] : [[key, value]];
    }),
  );
}

export function documentFromMicroCms(
  api: string,
  record: MicroCmsRecord,
  records: CachedMicroCmsRecords = { [api]: [record] },
): LegacyDocument {
  const surface = surfaceFor(api);
  const path = normalizeRoutePath(`/${surface}/${record.id}`);
  const repeaters = repeatersFromRecord(record);
  const kind = selectValue(record.kind) || undefined;
  const featuredImage = normalizeMediaValue(record.featuredImage);
  const featuredImageDimensions = imageDimensions(record.featuredImage);
  const fields = fieldsFromRecord(record, repeaters);
  return {
    source: {
      postType: api,
      status: "publish",
      ...(stringValue(record.revisedAt) || stringValue(record.updatedAt)
        ? { modifiedGmt: stringValue(record.revisedAt) || stringValue(record.updatedAt) }
        : {}),
    },
    api,
    kind,
    contentId: record.id,
    route: { legacyUrl: path, path, segments: [surface, record.id], trailingSlash: true },
    content: {
      title: stringValue(record.title),
      legacyBodyHtml: stringValue(record.legacyBodyHtml),
      excerpt: stringValue(record.excerpt),
      publishedAt: stringValue(record.publishedAt),
    },
    seo: {
      title: stringValue(record.seoTitle) || undefined,
      description: stringValue(record.seoDescription) || undefined,
      noindex: record.noindex === true,
    },
    // TODO(案件): taxonomy/select フィールドを正規化して設定する。
    taxonomies: [],
    fields: { ...normalizeObject(fields), ...(kind ? { kind } : {}) },
    repeaters,
    relations: relationsFromRecord(record, relationIndex(records)),
    ...(typeof featuredImage === "string" ? { featuredImage } : {}),
    ...(featuredImageDimensions ? { featuredImageDimensions } : {}),
  };
}

export function documentsFromMicroCms(
  records: CachedMicroCmsRecords,
  apis: readonly string[] = MICROCMS_APIS,
): LegacyDocument[] {
  const missingApis = apis.filter((api) => !Array.isArray(records[api]));
  if (missingApis.length) {
    throw new Error(`microCMS レスポンスに API がありません: ${missingApis.join(", ")}`);
  }
  const documents = apis.flatMap((api) =>
    records[api]!.map((record) => documentFromMicroCms(api, record, records)),
  );
  const duplicateIds = documents.filter(
    (document, index) =>
      documents.findIndex((candidate) => candidate.contentId === document.contentId) !== index,
  );
  if (duplicateIds.length) {
    throw new Error(
      `microCMS の contentId が API 間で重複しています: ${duplicateIds
        .map(({ contentId }) => contentId)
        .join(", ")}`,
    );
  }
  return documents;
}

export function routesFromDocuments(documents: readonly LegacyDocument[]): RouteEntry[] {
  return documents.map((document) => ({
    ...document.route,
    api: document.api,
    contentId: document.contentId,
  }));
}
