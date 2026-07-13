import { z } from "zod";

export const fieldTypes = ["string", "text", "html", "number", "boolean", "date", "image", "stringArray", "select"] as const;
export type FieldType = typeof fieldTypes[number];
export type FieldDef = { metaKey: string; fieldId: string; type: FieldType; label?: string; options?: string[] };
export type RepeaterDef = { fieldId: string; label?: string; columns: FieldDef[] };
export type RelationDef = { metaKey: string; fieldId: string; toApi: string };
export type ApiDef = {
  from: string | string[];
  kindField?: string;
  label?: string;
  fields: FieldDef[];
  repeaters?: RepeaterDef[];
  relations?: RelationDef[];
  featuredImage?: boolean;
  taxonomies?: string[];
  body?: "legacyBodyHtml" | "none";
};
export type MigrationConfig = {
  wxr: string;
  site: { origin: string; mediaHost: string };
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
  options: z.array(nonEmpty).optional(),
}).strict();
const ApiDefSchema = z.object({
  from: z.union([nonEmpty, z.array(nonEmpty).min(1)]),
  kindField: nonEmpty.optional(),
  label: z.string().optional(),
  fields: z.array(FieldDefSchema),
  repeaters: z.array(z.object({ fieldId: nonEmpty, label: z.string().optional(), columns: z.array(FieldDefSchema).min(1) }).strict()).optional(),
  relations: z.array(z.object({ metaKey: nonEmpty, fieldId: nonEmpty, toApi: nonEmpty }).strict()).optional(),
  featuredImage: z.boolean().optional(),
  taxonomies: z.array(nonEmpty).optional(),
  body: z.enum(["legacyBodyHtml", "none"]).optional(),
}).strict().superRefine((api, context) => {
  if (Array.isArray(api.from) && !api.kindField) {
    context.addIssue({ code: "custom", path: ["kindField"], message: "from に複数 post_type を指定する場合は kindField が必要です" });
  }
  const ids = [
    ...api.fields.map((field) => field.fieldId),
    ...(api.repeaters ?? []).map((repeater) => repeater.fieldId),
    ...(api.relations ?? []).map((relation) => relation.fieldId),
  ];
  for (const id of new Set(ids)) {
    if (ids.filter((value) => value === id).length > 1) {
      context.addIssue({ code: "custom", message: `fieldId \"${id}\" が重複しています` });
    }
  }
});

const MigrationConfigSchema = z.object({
  wxr: nonEmpty,
  site: z.object({ origin: z.string().url(), mediaHost: z.string().url() }).strict(),
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
