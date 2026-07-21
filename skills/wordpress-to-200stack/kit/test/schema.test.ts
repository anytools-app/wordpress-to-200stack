import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import mapping from "./fixtures/mini-mapping.config.js";
import { defineMigration } from "../src/config.js";
import { generateSchema, writeSchemas } from "../src/microcms/schema.js";

const temporary: string[] = [];
async function tempDir(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "wpkit-schema-")); temporary.push(path); return path; }
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("wpkit schema gen", () => {
  it("generates the official API schema shape including repeater custom fields", async () => {
    const imageMapping = defineMigration({ ...mapping, apis: { ...mapping.apis, cars: {
      ...mapping.apis.cars!,
      fields: [{ metaKey: "price", fieldId: "price", type: "number", description: "価格" }, { metaKey: "tag", fieldId: "tags", type: "stringArray" }],
      repeaters: [{ fieldId: "gallery", description: "画像一覧", columns: [{ metaKey: "image", fieldId: "image", type: "image" }, { metaKey: "caption", fieldId: "caption", type: "text" }], }],
      relations: [{ metaKey: "related", fieldId: "related", toApi: "pages", description: "関連ページ" }],
    } } });
    const schemas = generateSchema(imageMapping);
    const cars = schemas.cars!;
    expect(Object.keys(cars)).toEqual(["apiFields", "customFields"]);
    expect(cars.apiFields.find((field) => field.fieldId === "title")).toMatchObject({ name: "タイトル", description: "記事・コンテンツのタイトル。", kind: "text", required: true, textSizeLimitValidation: null });
    expect(cars.apiFields.find((field) => field.fieldId === "legacyBodyHtml")).toMatchObject({ kind: "richEditorV2", name: "本文", description: "本文コンテンツ。" });
    expect(cars.apiFields.map((field) => field.fieldId)).not.toEqual(expect.arrayContaining(["legacyPath", "wpId", "publishedAtLegacy"]));
    expect(cars.apiFields.find((field) => field.fieldId === "price")).toMatchObject({ description: "価格" });
    expect(cars.apiFields.find((field) => field.fieldId === "featuredImage")).toMatchObject({ name: "アイキャッチ画像", description: "一覧や詳細ページで使うメイン画像。", kind: "media" });
    const noindex = cars.apiFields.find((field) => field.fieldId === "noindex")!;
    const tags = cars.apiFields.find((field) => field.fieldId === "tags")!;
    expect(noindex).toMatchObject({ name: "検索結果に表示しない", kind: "boolean", booleanInitialValue: false });
    expect(noindex).not.toHaveProperty("initialValue");
    expect(tags).toMatchObject({ kind: "select", selectInitialValue: [] });
    expect(tags).not.toHaveProperty("initialValue");
    const repeaterField = cars.apiFields.find((field) => field.fieldId === "gallery")!;
    const customField = cars.customFields[0]!;
    expect(repeaterField).toMatchObject({ kind: "repeater", description: "画像一覧", customFieldCreatedAtList: [customField.createdAt], repeaterCountLimitValidation: null });
    expect(repeaterField).not.toHaveProperty("customFieldIds");
    expect(Object.keys(customField).sort()).toEqual(["createdAt", "fieldId", "fields", "name", "position", "updatedAt", "viewerGroup"]);
    expect(customField).toMatchObject({ fieldId: "gallery", createdAt: expect.any(String), updatedAt: expect.any(String), viewerGroup: "", fields: [expect.objectContaining({ kind: "media", idValue: expect.stringMatching(/^[a-zA-Z0-9-_]{6,12}$/) }), expect.objectContaining({ kind: "textArea", idValue: expect.stringMatching(/^[a-zA-Z0-9-_]{6,12}$/) })] });
    expect(customField.updatedAt).toBe(customField.createdAt);
    expect(new Date(String(customField.createdAt)).getTime()).toBeLessThan(Date.now());
    expect(customField.position).toEqual([(customField.fields as Array<{ idValue: string }>).map((field) => field.idValue)]);
    expect(generateSchema(imageMapping).cars!.customFields).toEqual(cars.customFields);
    expect(cars.apiFields.find((field) => field.fieldId === "related")).toMatchObject({ kind: "relation", description: "関連ページ", referencedApiEndpoint: "pages", listViewFieldId: "DEFAULT" });
  });

  it("marks configured common and repeater fields as required", () => {
    const config = defineMigration({ ...mapping, apis: { ...mapping.apis, cars: {
      ...mapping.apis.cars!, requiredFields: ["featuredImage", "gallery"],
    } } });
    const fields = generateSchema(config).cars!.apiFields;
    expect(fields.find((field) => field.fieldId === "featuredImage")).toMatchObject({ kind: "media", required: true });
    expect(fields.find((field) => field.fieldId === "gallery")).toMatchObject({ kind: "repeater", required: true });
    expect(fields.find((field) => field.fieldId === "price")).toMatchObject({ required: false });
  });

  it("does not generate the body field for body:none APIs", () => {
    const config = defineMigration({ ...mapping, apis: { ...mapping.apis, pages: { ...mapping.apis.pages!, body: "none" } } });
    expect(generateSchema(config).pages!.apiFields.map((field) => field.fieldId)).not.toContain("legacyBodyHtml");
  });

  it("accepts configured rich text fields", () => {
    const config = defineMigration({ ...mapping, apis: { ...mapping.apis, pages: { ...mapping.apis.pages!, fields: [{ metaKey: "note", fieldId: "note", type: "richText", description: "補足" }] } } });
    expect(generateSchema(config).pages!.apiFields.find((field) => field.fieldId === "note")).toMatchObject({ kind: "richEditorV2", description: "補足" });
  });

  it("generates a single custom-field group containing flat fields and a relation", () => {
    const config = defineMigration({ ...mapping, apis: { ...mapping.apis, cars: {
      ...mapping.apis.cars!,
      fields: [
        { metaKey: "price", fieldId: "price", type: "number" },
        { metaKey: "profile_visible", fieldId: "visible", type: "boolean", label: "表示" },
        { metaKey: "profile_comment", fieldId: "comment", type: "text", description: "コメント本文" },
      ],
      relations: [
        { metaKey: "related", fieldId: "related", toApi: "pages", label: "関連ページ" },
        { metaKey: "profile_author", fieldId: "author", toApi: "pages", label: "執筆者" },
      ],
      groups: [{ fieldId: "profile", label: "プロフィール", description: "執筆者情報", fieldIds: ["visible", "comment"], relationIds: ["author"] }],
    } } });
    const cars = generateSchema(config).cars!;
    const apiFieldIds = cars.apiFields.map((field) => field.fieldId);
    expect(apiFieldIds).not.toContain("visible");
    expect(apiFieldIds).not.toContain("comment");
    expect(apiFieldIds).not.toContain("author");
    expect(cars.apiFields.find((field) => field.fieldId === "related")).toMatchObject({ name: "関連ページ", kind: "relation", referencedApiEndpoint: "pages" });
    expect(cars.apiFields.find((field) => field.fieldId === "profile")).toEqual({
      fieldId: "profile", name: "プロフィール", kind: "custom", description: "執筆者情報", required: false, customFieldCreatedAt: expect.any(String),
    });
    const profile = cars.customFields.find((field) => field.fieldId === "profile")!;
    expect(profile).toMatchObject({
      createdAt: expect.any(String), updatedAt: expect.any(String), viewerGroup: "",
      position: [[expect.stringMatching(/^[a-zA-Z0-9-_]{6,12}$/), expect.stringMatching(/^[a-zA-Z0-9-_]{6,12}$/), expect.stringMatching(/^[a-zA-Z0-9-_]{6,12}$/)]],
      fields: [
        expect.objectContaining({ fieldId: "visible", name: "表示", kind: "boolean", booleanInitialValue: false, idValue: expect.stringMatching(/^[a-zA-Z0-9-_]{6,12}$/) }),
        expect.objectContaining({ fieldId: "comment", kind: "textArea", description: "コメント本文", idValue: expect.stringMatching(/^[a-zA-Z0-9-_]{6,12}$/) }),
        expect.objectContaining({ fieldId: "author", name: "執筆者", kind: "relation", description: null, referencedApiEndpoint: "pages", listViewFieldId: "DEFAULT", idValue: expect.stringMatching(/^[a-zA-Z0-9-_]{6,12}$/) }),
      ],
    });
    expect(cars.apiFields.find((field) => field.fieldId === "profile")?.customFieldCreatedAt).toBe(profile.createdAt);
    expect(profile.position).toEqual([(profile.fields as Array<{ idValue: string }>).map((field) => field.idValue)]);
  });

  it("omits SEO text fields only for seoFields:none APIs and always keeps noindex", () => {
    const config = defineMigration({ ...mapping, apis: {
      ...mapping.apis,
      cars: { ...mapping.apis.cars!, seoFields: "none" },
    } });
    const schemas = generateSchema(config);
    const carFieldIds = schemas.cars!.apiFields.map((field) => field.fieldId);
    expect(carFieldIds).not.toContain("seoTitle");
    expect(carFieldIds).not.toContain("seoDescription");
    expect(carFieldIds).toContain("noindex");
    expect(schemas.pages!.apiFields.map((field) => field.fieldId)).toEqual(expect.arrayContaining(["seoTitle", "seoDescription", "noindex"]));
  });

  it("rejects group members that are not defined by the same API", () => {
    expect(() => defineMigration({ ...mapping, apis: { ...mapping.apis, cars: {
      ...mapping.apis.cars!,
      groups: [{ fieldId: "profile", fieldIds: ["missingField"], relationIds: ["missingRelation"] }],
    } } })).toThrow(/groups\.0\.fieldIds\.0: fieldId "missingField" は fields に定義されていません[\s\S]*groups\.0\.relationIds\.0: fieldId "missingRelation" は relations に定義されていません/);
  });

  it("rejects duplicate group field IDs and members assigned to multiple groups", () => {
    expect(() => defineMigration({ ...mapping, apis: { ...mapping.apis, cars: {
      ...mapping.apis.cars!,
      groups: [{ fieldId: "price", fieldIds: ["price"] }],
    } } })).toThrow('fieldId "price" が重複しています');
    expect(() => defineMigration({ ...mapping, apis: { ...mapping.apis, cars: {
      ...mapping.apis.cars!,
      groups: [{ fieldId: "primaryGroup", fieldIds: ["price"] }, { fieldId: "secondaryGroup", fieldIds: ["price"] }],
    } } })).toThrow('fieldId "price" は複数の group に属しています');
    expect(() => defineMigration({ ...mapping, apis: { ...mapping.apis, cars: {
      ...mapping.apis.cars!,
      groups: [{ fieldId: "primaryGroup", fieldIds: [], relationIds: ["related"] }, { fieldId: "secondaryGroup", fieldIds: [], relationIds: ["related"] }],
    } } })).toThrow('fieldId "related" は複数の group に属しています');
  });

  it("writes one schema per API and the relation setup checklist", async () => {
    const output = await tempDir();
    await writeSchemas(mapping, output);
    expect(JSON.parse(await readFile(join(output, "cars.schema.json"), "utf8"))).toMatchObject({ apiFields: expect.any(Array), customFields: expect.any(Array) });
    expect(await readFile(join(output, "README.md"), "utf8")).toContain("手動設定");
  });

  it("uses deterministic ten-character IDs for configured select choices", () => {
    const config = defineMigration({ ...mapping, apis: { ...mapping.apis, pages: { ...mapping.apis.pages!, fields: [{ metaKey: "state", fieldId: "state", type: "select", options: ["open", "closed"] }] } } });
    const field = generateSchema(config).pages!.apiFields.find((value) => value.fieldId === "state")!;
    expect(field).toMatchObject({ kind: "select", multipleSelect: false, selectItems: [{ value: "open" }, { value: "closed" }] });
    expect((field.selectItems as Array<{ id: string }>).every((item) => /^[a-z0-9]{10}$/.test(item.id))).toBe(true);
  });

  it("generates multiple-select taxonomy fields using term names and slug hashes", () => {
    const config = defineMigration({ ...mapping, apis: { ...mapping.apis, cars: {
      ...mapping.apis.cars!,
      taxonomyFields: [{
        taxonomy: "post_category", fieldId: "categories", label: "カテゴリ", description: "記事の分類",
        terms: [{ slug: "news", name: "ニュース" }, { slug: "tutorial", name: "チュートリアル" }],
      }, { taxonomy: "future_category", fieldId: "futureCategories", label: "将来用カテゴリ", terms: [] }],
    } } });
    const fields = generateSchema(config).cars!.apiFields;
    expect(fields.find((field) => field.fieldId === "categories")).toEqual({
      fieldId: "categories", name: "カテゴリ", kind: "select", description: "記事の分類", required: false,
      selectItems: [
        { id: createHash("sha256").update("news").digest("hex").slice(0, 10), value: "ニュース" },
        { id: createHash("sha256").update("tutorial").digest("hex").slice(0, 10), value: "チュートリアル" },
      ],
      multipleSelect: true, selectInitialValue: [],
    });
    expect(fields.find((field) => field.fieldId === "futureCategories")).toMatchObject({ kind: "select", selectItems: [], multipleSelect: true, selectInitialValue: [] });
  });

  it("rejects taxonomy field IDs that overlap existing API fields", () => {
    expect(() => defineMigration({ ...mapping, apis: { ...mapping.apis, cars: {
      ...mapping.apis.cars!, taxonomyFields: [{ taxonomy: "brand", fieldId: "price", label: "ブランド", terms: [] }],
    } } })).toThrow('fieldId "price" が重複しています');
  });
});
