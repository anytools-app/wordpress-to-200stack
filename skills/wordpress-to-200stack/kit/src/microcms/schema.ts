import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ApiDef, FieldDef, MigrationConfig } from "../config.js";

type SchemaField = Record<string, unknown>;
export type MicroCmsSchema = { apiFields: SchemaField[]; customFields: SchemaField[] };

function selectItems(field: Pick<FieldDef, "options">): Array<{ id: string; value: string }> {
  return (field.options ?? []).map((value) => ({
    // microCMS requires IDs independent of the display value. A digest keeps imports deterministic.
    id: createHash("sha256").update(value).digest("hex").slice(0, 10), value,
  }));
}

function fieldSchema(field: Pick<FieldDef, "fieldId" | "label" | "type" | "options">, required = false): SchemaField {
  const common = { fieldId: field.fieldId, name: field.label ?? field.fieldId, description: null, required };
  switch (field.type) {
    case "string": return { ...common, kind: "text", textSizeLimitValidation: null, patternMatchValidation: null, isUnique: false };
    case "image": return { ...common, kind: "image" };
    case "text":
    case "html": return { ...common, kind: "textArea", textSizeLimitValidation: null, patternMatchValidation: null };
    case "number": return { ...common, kind: "number", numberSizeLimitValidation: null };
    case "boolean": return { ...common, kind: "boolean", initialValue: false };
    case "date": return { ...common, kind: "date", dateFormat: false };
    case "stringArray": return { ...common, kind: "select", selectItems: selectItems(field), multipleSelect: true, initialValue: [] };
    case "select": return { ...common, kind: "select", selectItems: selectItems(field), multipleSelect: false };
  }
}

function commonFields(api: ApiDef): SchemaField[] {
  const fields: SchemaField[] = [
    fieldSchema({ fieldId: "title", type: "string" }, true),
    fieldSchema({ fieldId: "legacyPath", type: "string" }),
    fieldSchema({ fieldId: "wpId", type: "number" }),
    fieldSchema({ fieldId: "publishedAtLegacy", type: "string" }),
    fieldSchema({ fieldId: "seoTitle", type: "string" }),
    fieldSchema({ fieldId: "seoDescription", type: "string" }),
    fieldSchema({ fieldId: "noindex", type: "boolean" }),
  ];
  if (api.body !== "none") fields.splice(2, 0, fieldSchema({ fieldId: "legacyBodyHtml", type: "html" }));
  if (api.featuredImage) fields.push(fieldSchema({ fieldId: "featuredImage", type: "image" }));
  if (api.kindField) {
    const postTypes = [...new Set(Array.isArray(api.from) ? api.from : [api.from])];
    fields.push(fieldSchema({ fieldId: "kind", type: "select", options: postTypes }));
  }
  return fields;
}

export function generateSchema(config: MigrationConfig): Record<string, MicroCmsSchema> {
  return Object.fromEntries(Object.entries(config.apis).map(([apiName, api]) => {
    const reserved = new Set(commonFields(api).map((field) => String(field.fieldId)));
    const apiFields: SchemaField[] = [
      ...commonFields(api),
      ...api.fields.filter((field) => !reserved.has(field.fieldId)).map((field) => fieldSchema(field)),
      ...(api.repeaters ?? []).map((repeater) => ({
        fieldId: repeater.fieldId, name: repeater.label ?? repeater.fieldId, kind: "repeater", description: null, required: false,
        repeaterCountLimitValidation: null, customFieldIds: [repeater.fieldId],
      })),
      ...(api.relations ?? []).map((relation) => ({
        fieldId: relation.fieldId, name: relation.fieldId, kind: "relation", description: null, required: false,
        listViewFieldId: "DEFAULT", referencedApiEndpoint: relation.toApi,
      })),
    ];
    const customFields = (api.repeaters ?? []).map((repeater) => ({
      fieldId: repeater.fieldId,
      name: repeater.label ?? repeater.fieldId,
      fieldOrderByColumn: [repeater.columns.map((column) => column.fieldId)],
      fields: repeater.columns.map((column) => fieldSchema(column)),
    }));
    return [apiName, { apiFields, customFields }];
  }));
}

export async function writeSchemas(config: MigrationConfig, schemaDir = "./microcms-schema"): Promise<Record<string, MicroCmsSchema>> {
  const schemas = generateSchema(config);
  await mkdir(schemaDir, { recursive: true });
  await Promise.all(Object.entries(schemas).map(([api, schema]) => writeFile(join(schemaDir, `${api}.schema.json`), `${JSON.stringify(schema, null, 2)}\n`)));
  const relationApis = Object.entries(config.apis).filter(([, api]) => (api.relations?.length ?? 0) > 0).map(([api]) => api);
  const checklist = [
    "# microCMS schema import checklist",
    "",
    "1. microCMS 管理画面で API ごとに対応する `*.schema.json` を APIスキーマのインポートから読み込む。",
    "2. relation フィールドはインポート後に参照先 API を管理画面で手動設定する（公式インポート仕様では参照先が復元されない）。",
    ...(relationApis.length ? [`3. 対象 API: ${relationApis.join(", ")}`] : []),
    "4. 画像フィールドと featuredImage は microCMS メディアの配信 URL を設定する。",
    "",
  ].join("\n");
  await writeFile(join(schemaDir, "README.md"), checklist);
  return schemas;
}
