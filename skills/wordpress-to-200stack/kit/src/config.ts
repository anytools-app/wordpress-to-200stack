import { z } from "zod";

export const fieldTypes = ["string", "text", "html", "richText", "number", "boolean", "date", "image", "stringArray", "select"] as const;
export type FieldType = typeof fieldTypes[number];
export type FieldDef = { metaKey: string; fieldId: string; type: FieldType; label?: string; description?: string; options?: string[]; allowMissing?: boolean };
export type RepeaterDef = { fieldId: string; label?: string; description?: string; columns: FieldDef[] };
export type RelationDef = { metaKey: string; fieldId: string; toApi: string; label?: string; description?: string };
export type GroupDef = { fieldId: string; label?: string; description?: string; fieldIds: string[]; relationIds?: string[] };
export type TaxonomyFieldDef = { taxonomy: string; fieldId: string; label: string; description?: string; terms: Array<{ slug: string; name: string }> };
export type ApiDef = {
  from: string | string[];
  kindField?: string;
  label?: string;
  fields: FieldDef[];
  repeaters?: RepeaterDef[];
  relations?: RelationDef[];
  groups?: GroupDef[];
  taxonomyFields?: TaxonomyFieldDef[];
  featuredImage?: boolean;
  taxonomies?: string[];
  body?: "legacyBodyHtml" | "none";
  seoFields?: "yoast" | "none";
  /** microCMS スキーマで必須(required: true)にするフィールドID。共通フィールド(featuredImage 等)や repeater も指定可。 */
  requiredFields?: string[];
};
export type MigrationConfig = {
  wxr: string;
  site: { origin: string; mediaHost: string };
  contentIdStrategy?: "wpId" | "legacySlug";
  exclude?: { postTypes?: string[]; statuses?: string[] };
  apis: Record<string, ApiDef>;
  seo?: { yoast?: boolean };
  embeds?: { allowIframeHosts?: string[] };
  linkCheck?: { assumeExistPostTypes?: string[]; assumeExistPaths?: string[] };
};

const nonEmpty = z.string().trim().min(1);
const FieldDefSchema = z.object({
  metaKey: nonEmpty,
  fieldId: nonEmpty,
  type: z.enum(fieldTypes),
  label: z.string().optional(),
  description: z.string().optional(),
  options: z.array(nonEmpty).optional(),
  allowMissing: z.boolean().optional(),
}).strict();
const ApiDefSchema = z.object({
  from: z.union([nonEmpty, z.array(nonEmpty).min(1)]),
  kindField: nonEmpty.optional(),
  label: z.string().optional(),
  fields: z.array(FieldDefSchema),
  repeaters: z.array(z.object({ fieldId: nonEmpty, label: z.string().optional(), description: z.string().optional(), columns: z.array(FieldDefSchema).min(1) }).strict()).optional(),
  relations: z.array(z.object({ metaKey: nonEmpty, fieldId: nonEmpty, toApi: nonEmpty, label: z.string().optional(), description: z.string().optional() }).strict()).optional(),
  groups: z.array(z.object({
    fieldId: nonEmpty,
    label: z.string().optional(),
    description: z.string().optional(),
    fieldIds: z.array(nonEmpty),
    relationIds: z.array(nonEmpty).optional(),
  }).strict()).optional(),
  taxonomyFields: z.array(z.object({
    taxonomy: nonEmpty,
    fieldId: nonEmpty,
    label: z.string(),
    description: z.string().optional(),
    terms: z.array(z.object({ slug: nonEmpty, name: nonEmpty }).strict()),
  }).strict()).optional(),
  featuredImage: z.boolean().optional(),
  taxonomies: z.array(nonEmpty).optional(),
  body: z.enum(["legacyBodyHtml", "none"]).optional(),
  seoFields: z.enum(["yoast", "none"]).optional(),
  requiredFields: z.array(nonEmpty).optional(),
}).strict().superRefine((api, context) => {
  if (Array.isArray(api.from) && !api.kindField) {
    context.addIssue({ code: "custom", path: ["kindField"], message: "from に複数 post_type を指定する場合は kindField が必要です" });
  }
  const ids = [
    ...api.fields.map((field) => field.fieldId),
    ...(api.repeaters ?? []).map((repeater) => repeater.fieldId),
    ...(api.relations ?? []).map((relation) => relation.fieldId),
    ...(api.groups ?? []).map((group) => group.fieldId),
    ...(api.taxonomyFields ?? []).map((taxonomyField) => taxonomyField.fieldId),
  ];
  for (const id of new Set(ids)) {
    if (ids.filter((value) => value === id).length > 1) {
      context.addIssue({ code: "custom", message: `fieldId \"${id}\" が重複しています` });
    }
  }
  const fieldIds = new Set(api.fields.map((field) => field.fieldId));
  const relationIds = new Set((api.relations ?? []).map((relation) => relation.fieldId));
  const groupedIds = new Set<string>();
  for (const [groupIndex, group] of (api.groups ?? []).entries()) {
    for (const [fieldIndex, fieldId] of group.fieldIds.entries()) {
      if (!fieldIds.has(fieldId)) {
        context.addIssue({ code: "custom", path: ["groups", groupIndex, "fieldIds", fieldIndex], message: `fieldId \"${fieldId}\" は fields に定義されていません` });
      }
      if (groupedIds.has(fieldId)) {
        context.addIssue({ code: "custom", path: ["groups", groupIndex, "fieldIds", fieldIndex], message: `fieldId \"${fieldId}\" は複数の group に属しています` });
      }
      groupedIds.add(fieldId);
    }
    for (const [relationIndex, relationId] of (group.relationIds ?? []).entries()) {
      if (!relationIds.has(relationId)) {
        context.addIssue({ code: "custom", path: ["groups", groupIndex, "relationIds", relationIndex], message: `fieldId \"${relationId}\" は relations に定義されていません` });
      }
      if (groupedIds.has(relationId)) {
        context.addIssue({ code: "custom", path: ["groups", groupIndex, "relationIds", relationIndex], message: `fieldId \"${relationId}\" は複数の group に属しています` });
      }
      groupedIds.add(relationId);
    }
  }
});

const MigrationConfigSchema = z.object({
  wxr: nonEmpty,
  site: z.object({ origin: z.string().url(), mediaHost: z.string().url() }).strict(),
  contentIdStrategy: z.enum(["wpId", "legacySlug"]).optional(),
  exclude: z.object({ postTypes: z.array(nonEmpty).optional(), statuses: z.array(nonEmpty).optional() }).strict().optional(),
  apis: z.record(nonEmpty, ApiDefSchema).refine((apis) => Object.keys(apis).length > 0, "apis は1件以上必要です"),
  seo: z.object({ yoast: z.boolean().optional() }).strict().optional(),
  embeds: z.object({ allowIframeHosts: z.array(nonEmpty).optional() }).strict().optional(),
  linkCheck: z.object({ assumeExistPostTypes: z.array(nonEmpty).optional(), assumeExistPaths: z.array(nonEmpty).optional() }).strict().optional(),
}).strict();

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "config";
    return `${path}: ${issue.message}`;
  }).join("\n");
}

/** Validate a mapping config at module-load time with editable error messages. */
export function defineMigration(config: MigrationConfig): MigrationConfig {
  const parsed = MigrationConfigSchema.safeParse(config);
  if (!parsed.success) throw new Error(`mapping.config.ts の検証に失敗しました:\n${formatIssues(parsed.error)}`);
  return parsed.data;
}
