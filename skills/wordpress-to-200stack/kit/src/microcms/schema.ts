import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ApiDef, FieldDef, MigrationConfig, TaxonomyFieldDef } from "../config.js";

type SchemaField = Record<string, unknown>;
export type MicroCmsSchema = { apiFields: SchemaField[]; customFields: SchemaField[] };

function selectItems(field: Pick<FieldDef, "options">): Array<{ id: string; value: string }> {
  return (field.options ?? []).map((value) => ({
    // microCMS requires IDs independent of the display value. A digest keeps imports deterministic.
    id: createHash("sha256").update(value).digest("hex").slice(0, 10), value,
  }));
}

/** microCMS import references custom fields by their createdAt timestamp. Derive it
 *  deterministically from the fieldId so regenerated schemas keep stable references. */
function customFieldCreatedAt(apiName: string, fieldId: string): string {
  // Keep the derived timestamp in the past (2020 + at most ~3 years) so validators never see future dates.
  const offset = Number.parseInt(createHash("sha256").update(`${apiName}/${fieldId}`).digest("hex").slice(0, 8), 16) % 94_608_000;
  return new Date(1_577_836_800_000 + offset * 1000).toISOString();
}

function taxonomyFieldSchema(field: TaxonomyFieldDef): SchemaField {
  return {
    fieldId: field.fieldId,
    name: field.label,
    kind: "select",
    description: field.description ?? null,
    required: false,
    selectItems: field.terms.map((term) => ({
      id: createHash("sha256").update(term.slug).digest("hex").slice(0, 10),
      value: term.name,
    })),
    multipleSelect: true,
    selectInitialValue: [],
  };
}

function fieldSchema(field: Pick<FieldDef, "fieldId" | "label" | "description" | "type" | "options">, required = false): SchemaField {
  const common = { fieldId: field.fieldId, name: field.label ?? field.fieldId, description: field.description ?? null, required };
  switch (field.type) {
    case "string": return { ...common, kind: "text", textSizeLimitValidation: null, patternMatchValidation: null, isUnique: false };
    case "image": return { ...common, kind: "media" };
    case "text":
    case "html": return { ...common, kind: "textArea", textSizeLimitValidation: null, patternMatchValidation: null };
    case "richText": return { ...common, kind: "richEditorV2" };
    case "number": return { ...common, kind: "number", numberSizeLimitValidation: null };
    case "boolean": return { ...common, kind: "boolean", booleanInitialValue: false };
    case "date": return { ...common, kind: "date", dateFormat: false };
    case "stringArray": return { ...common, kind: "select", selectItems: selectItems(field), multipleSelect: true, selectInitialValue: [] };
    case "select": return { ...common, kind: "select", selectItems: selectItems(field), multipleSelect: false };
  }
}

function commonFields(api: ApiDef): SchemaField[] {
  const fields: SchemaField[] = [
    fieldSchema({ fieldId: "title", type: "string", label: "タイトル", description: "記事・コンテンツのタイトル。" }, true),
    ...(api.seoFields === "none" ? [] : [
      fieldSchema({ fieldId: "seoTitle", type: "string", label: "SEOタイトル", description: "検索結果に表示するタイトル。空欄ならタイトルから自動生成します。" }),
      fieldSchema({ fieldId: "seoDescription", type: "string", label: "SEO説明文", description: "検索結果に表示する説明文(meta description)。" }),
    ]),
    fieldSchema({ fieldId: "noindex", type: "boolean", label: "検索結果に表示しない", description: "オンにすると検索エンジンにインデックスさせません(noindex)。" }),
  ];
  if (api.body !== "none") fields.splice(1, 0, fieldSchema({ fieldId: "legacyBodyHtml", type: "richText", label: "本文", description: "本文コンテンツ。" }));
  if (api.featuredImage) fields.push(fieldSchema({ fieldId: "featuredImage", type: "image", label: "アイキャッチ画像", description: "一覧や詳細ページで使うメイン画像。" }));
  if (api.kindField) {
    const postTypes = [...new Set(Array.isArray(api.from) ? api.from : [api.from])];
    fields.push(fieldSchema({ fieldId: "kind", type: "select", options: postTypes, label: "種別", description: "コンテンツの種別。既存データの区分に合わせて選択します。" }));
  }
  return fields;
}

export function generateSchema(config: MigrationConfig): Record<string, MicroCmsSchema> {
  return Object.fromEntries(Object.entries(config.apis).map(([apiName, api]) => {
    const reserved = new Set(commonFields(api).map((field) => String(field.fieldId)));
    const grouped = new Set((api.groups ?? []).flatMap((group) => [...group.fieldIds, ...(group.relationIds ?? [])]));
    const fieldsById = new Map(api.fields.map((field) => [field.fieldId, field]));
    const relationsById = new Map((api.relations ?? []).map((relation) => [relation.fieldId, relation]));
    const relationSchema = (relation: NonNullable<ApiDef["relations"]>[number], description: string | null = relation.description ?? null): SchemaField => ({
      fieldId: relation.fieldId, name: relation.label ?? relation.fieldId, kind: "relation", description, required: false,
      listViewFieldId: "DEFAULT", referencedApiEndpoint: relation.toApi,
    });
    const apiFields: SchemaField[] = [
      ...commonFields(api),
      ...api.fields.filter((field) => !reserved.has(field.fieldId) && !grouped.has(field.fieldId)).map((field) => fieldSchema(field)),
      ...(api.repeaters ?? []).map((repeater) => ({
        fieldId: repeater.fieldId, name: repeater.label ?? repeater.fieldId, kind: "repeater", description: repeater.description ?? null, required: false,
        repeaterCountLimitValidation: null, customFieldCreatedAtList: [customFieldCreatedAt(apiName, repeater.fieldId)],
      })),
      ...(api.relations ?? []).filter((relation) => !grouped.has(relation.fieldId)).map((relation) => relationSchema(relation)),
      ...(api.groups ?? []).map((group) => ({
        fieldId: group.fieldId, name: group.label ?? group.fieldId, kind: "custom", description: group.description ?? null, required: false,
        customFieldCreatedAt: customFieldCreatedAt(apiName, group.fieldId),
      })),
      ...(api.taxonomyFields ?? []).map((taxonomyField) => taxonomyFieldSchema(taxonomyField)),
    ].map((field) => (api.requiredFields?.includes(String(field.fieldId)) ? { ...field, required: true } : field));
    // position は fieldId ではなく、カスタムフィールド内各フィールドの idValue(^[a-zA-Z0-9-_]{6,12}$)を並べる。
    const subFieldIdValue = (ownerFieldId: string, fieldId: string): string =>
      createHash("sha256").update(`${apiName}/${ownerFieldId}/${fieldId}`).digest("hex").slice(0, 10);
    const customFields = [
      ...(api.repeaters ?? []).map((repeater) => {
        const columns = repeater.columns.map((column) => ({
          ...fieldSchema(column),
          idValue: subFieldIdValue(repeater.fieldId, column.fieldId),
        }));
        return {
          createdAt: customFieldCreatedAt(apiName, repeater.fieldId),
          fieldId: repeater.fieldId,
          name: repeater.label ?? repeater.fieldId,
          fields: columns,
          position: [columns.map((column) => column.idValue)],
          updatedAt: customFieldCreatedAt(apiName, repeater.fieldId),
          viewerGroup: "",
        };
      }),
      ...(api.groups ?? []).map((group) => {
        const members = [
          ...group.fieldIds.map((fieldId) => fieldSchema(fieldsById.get(fieldId)!)),
          ...(group.relationIds ?? []).map((relationId) => relationSchema(relationsById.get(relationId)!, null)),
        ].map((member) => ({ ...member, idValue: subFieldIdValue(group.fieldId, String(member.fieldId)) }));
        return {
          createdAt: customFieldCreatedAt(apiName, group.fieldId),
          fieldId: group.fieldId,
          name: group.label ?? group.fieldId,
          fields: members,
          position: [members.map((member) => member.idValue)],
          updatedAt: customFieldCreatedAt(apiName, group.fieldId),
          viewerGroup: "",
        };
      }),
    ];
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
