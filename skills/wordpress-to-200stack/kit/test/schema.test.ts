import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import mapping from "./fixtures/mini-mapping.config.js";
import { defineMigration } from "../src/config.js";
import { generateSchema, writeSchemas } from "../src/microcms/schema.js";

const temporary: string[] = [];
async function tempDir(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "wpkit-schema-")); temporary.push(path); return path; }
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("wpkit schema gen", () => {
  it("generates the official API schema shape including repeater custom fields", async () => {
    const imageMapping = defineMigration({ ...mapping, apis: { ...mapping.apis, cars: { ...mapping.apis.cars!, repeaters: [{ fieldId: "gallery", columns: [{ metaKey: "image", fieldId: "image", type: "image" }, { metaKey: "caption", fieldId: "caption", type: "text" }] }] } } });
    const schemas = generateSchema(imageMapping);
    const cars = schemas.cars!;
    expect(Object.keys(cars)).toEqual(["apiFields", "customFields"]);
    expect(cars.apiFields.find((field) => field.fieldId === "title")).toMatchObject({ kind: "text", required: true, textSizeLimitValidation: null });
    expect(cars.apiFields.find((field) => field.fieldId === "featuredImage")).toMatchObject({ kind: "image" });
    expect(cars.apiFields.find((field) => field.fieldId === "gallery")).toMatchObject({ kind: "repeater", customFieldIds: ["gallery"], repeaterCountLimitValidation: null });
    expect(cars.customFields).toEqual([expect.objectContaining({ fieldId: "gallery", fieldOrderByColumn: [["image", "caption"]], fields: [expect.objectContaining({ kind: "image" }), expect.objectContaining({ kind: "textArea" })] })]);
    expect(cars.apiFields.find((field) => field.fieldId === "related")).toMatchObject({ kind: "relation", referencedApiEndpoint: "pages", listViewFieldId: "DEFAULT" });
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
});
