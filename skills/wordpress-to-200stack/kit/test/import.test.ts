import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { importDocuments } from "../src/microcms/import.js";
import { defineMigration, type MigrationConfig } from "../src/config.js";
import type { LegacyDocument } from "../src/parse/index.js";

const temporary: string[] = [];
async function tempDir(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "wpkit-import-")); temporary.push(path); return path; }
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
function doc(overrides: Partial<LegacyDocument> = {}): LegacyDocument {
  return {
    source: { wpId: 10, postType: "car", status: "publish" }, api: "cars", contentId: "cars-10",
    route: { legacyUrl: "https://old.test/cars/a/", path: "/cars/a", segments: ["cars", "a"], trailingSlash: true },
    content: { title: "Car", legacyBodyHtml: "<p>body</p>", excerpt: "", publishedAt: "2026-01-01" },
    seo: { title: "SEO", description: "Description", noindex: true }, taxonomies: [], fields: { price: 100 },
    repeaters: { gallery: [{ image: "https://media.test/a.jpg", caption: "A" }] },
    relations: [{ fieldId: "related", toApi: "pages", targetWpId: 20, targetContentId: "pages-20" }], assets: [], payloadChecksum: "from-parse", ...overrides,
  };
}
async function writeIr(documents: LegacyDocument[]): Promise<string> {
  const ir = await tempDir(); await writeFile(join(ir, "documents.ndjson"), `${documents.map((value) => JSON.stringify(value)).join("\n")}\n`); return ir;
}
function response(body: unknown = {}, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
const normalizationConfig: MigrationConfig = defineMigration({
  wxr: "/tmp/test.xml", site: { origin: "https://old.test", mediaHost: "https://media.test" },
  apis: { cars: { from: ["staff", "vendors"], kindField: "kind", featuredImage: true, fields: [{ metaKey: "price", fieldId: "price", type: "number" }, { metaKey: "label", fieldId: "label", type: "string" }, { metaKey: "image", fieldId: "vehicleImage", type: "image" }], repeaters: [{ fieldId: "gallery", columns: [{ metaKey: "image", fieldId: "image", type: "image" }] }] } },
});

describe("wpkit import", () => {
  it("uses PUT payloads, repeater field IDs, a second relation PATCH, and global rate waits", async () => {
    const ir = await writeIr([doc(), doc({ source: { wpId: 11, postType: "car", status: "publish" }, contentId: "cars-11", relations: [] }), doc({ source: { wpId: 20, postType: "page", status: "publish" }, api: "pages", contentId: "pages-20", relations: [] })]);
    const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = []; const sleeps: number[] = [];
    const result = await importDocuments({ irDir: ir, serviceDomain: "service", apiKey: "key", sleep: async (ms) => { sleeps.push(ms); }, fetchImpl: async (url, init) => {
      calls.push({ method: init?.method ?? "GET", url: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) });
      return calls.at(-1)?.method === "GET" ? response({ totalCount: 2 }) : response();
    } });
    expect(result).toMatchObject({ uploaded: 3, skipped: 0, failures: [] });
    expect(calls.filter((call) => call.method === "PUT")[0]?.body?.gallery).toEqual([{ fieldId: "gallery", image: "https://media.test/a.jpg", caption: "A" }]);
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ related: "pages-20" });
    expect(calls.findIndex((call) => call.method === "PATCH")).toBeGreaterThan(calls.map((call) => call.method).lastIndexOf("PUT"));
    expect(sleeps.some((milliseconds) => milliseconds >= 250)).toBe(true);
  });

  it("retries 429 responses and skips an unchanged checksum on the next run", async () => {
    const ir = await writeIr([doc({ relations: [] })]); let puts = 0;
    const mockedFetch: typeof fetch = async (_url, init) => {
      if (init?.method === "PUT") { puts += 1; return puts === 1 ? response({}, 429) : response(); }
      return response({ totalCount: 1 });
    };
    const first = await importDocuments({ irDir: ir, serviceDomain: "service", apiKey: "key", fetchImpl: mockedFetch, sleep: async () => undefined });
    const second = await importDocuments({ irDir: ir, serviceDomain: "service", apiKey: "key", fetchImpl: mockedFetch, sleep: async () => undefined });
    expect(first.uploaded).toBe(1); expect(puts).toBe(2); expect(second).toMatchObject({ skipped: 1, uploaded: 0 });
    expect(JSON.parse(await readFile(join(ir, "import-state.json"), "utf8"))).toHaveProperty("cars-10");
  });

  it("POSTs provisional IDs, persists their assigned IDs before the next POST, and skips them on rerun", async () => {
    const ir = await writeIr([
      doc({ contentIdProvisional: true, relations: [] }),
      doc({ source: { wpId: 20, postType: "page", status: "publish" }, api: "pages", contentId: "pages-20", contentIdProvisional: true, relations: [] }),
    ]);
    const methods: string[] = [];
    const mockedFetch: typeof fetch = async (url, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "POST") {
        if (String(url).endsWith("/pages")) expect(JSON.parse(await readFile(join(ir, "contentid-map.json"), "utf8"))).toMatchObject({ "cars-10": "assigned-cars" });
        return response({ id: String(url).endsWith("/cars") ? "assigned-cars" : "assigned-pages" });
      }
      return response({ totalCount: 2 });
    };
    const first = await importDocuments({ irDir: ir, serviceDomain: "service", apiKey: "key", fetchImpl: mockedFetch, sleep: async () => undefined });
    const second = await importDocuments({ irDir: ir, serviceDomain: "service", apiKey: "key", fetchImpl: mockedFetch, sleep: async () => undefined });
    expect(first).toMatchObject({ provisional: 2, wouldAutoAssign: 2, autoAssigned: 2, uploaded: 2, failures: [] });
    expect(JSON.parse(await readFile(join(ir, "contentid-map.json"), "utf8"))).toEqual({ "cars-10": "assigned-cars", "pages-20": "assigned-pages" });
    expect(JSON.parse(await readFile(join(ir, "import-state.json"), "utf8"))).toMatchObject({ "cars-10": "from-parse", "pages-20": "from-parse" });
    expect(second).toMatchObject({ provisional: 2, skipped: 2, wouldAutoAssign: 0, autoAssigned: 0, uploaded: 0 });
    expect(methods.filter((method) => method === "POST")).toHaveLength(2);
  });

  it("uses mapped IDs for provisional PUT and relation PATCH targets", async () => {
    const ir = await writeIr([
      doc({ contentIdProvisional: true, relations: [{ fieldId: "related", toApi: "pages", targetWpId: 20, targetContentId: "pages-20" }] }),
      doc({ source: { wpId: 20, postType: "page", status: "publish" }, api: "pages", contentId: "pages-20", contentIdProvisional: true, relations: [] }),
    ]);
    await writeFile(join(ir, "contentid-map.json"), JSON.stringify({ "cars-10": "assigned-cars", "pages-20": "assigned-pages" }));
    const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
    const result = await importDocuments({ irDir: ir, serviceDomain: "service", apiKey: "key", fetchImpl: async (url, init) => {
      calls.push({ method: init?.method ?? "GET", url: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) });
      return init?.method === "GET" ? response({ totalCount: 2 }) : response();
    }, sleep: async () => undefined });
    expect(result).toMatchObject({ provisional: 2, wouldAutoAssign: 0, autoAssigned: 0, uploaded: 2, failures: [] });
    expect(calls.filter((call) => call.method === "PUT").map((call) => call.url)).toEqual([
      "https://service.microcms.io/api/v1/cars/assigned-cars",
      "https://service.microcms.io/api/v1/pages/assigned-pages",
    ]);
    expect(calls.find((call) => call.method === "PATCH")).toMatchObject({ url: "https://service.microcms.io/api/v1/cars/assigned-cars", body: { related: "assigned-pages" } });
  });

  it("skips relations to an unassigned provisional target", async () => {
    const ir = await writeIr([
      doc({ relations: [{ fieldId: "related", toApi: "pages", targetWpId: 20, targetContentId: "pages-20" }] }),
      doc({ source: { wpId: 20, postType: "page", status: "publish" }, api: "pages", contentId: "pages-20", contentIdProvisional: true, relations: [] }),
    ]);
    await writeFile(join(ir, "import-state.json"), JSON.stringify({ "cars-10": "from-parse" }));
    const methods: string[] = [];
    const result = await importDocuments({ irDir: ir, sourceId: 10, serviceDomain: "service", apiKey: "key", fetchImpl: async (_url, init) => {
      methods.push(init?.method ?? "GET");
      return response({ totalCount: 1 });
    }, sleep: async () => undefined });
    expect(result).toMatchObject({ skipped: 1, failures: [] });
    expect(methods).not.toContain("PATCH");
  });

  it("reports provisional auto-assignment candidates without POSTing in dry-run", async () => {
    const ir = await writeIr([doc({ contentIdProvisional: true, relations: [] })]);
    const result = await importDocuments({ irDir: ir, dryRun: true, fetchImpl: async () => { throw new Error("must not fetch"); } });
    expect(result).toMatchObject({ provisional: 1, wouldUpload: 1, wouldAutoAssign: 1, autoAssigned: 0, uploaded: 0 });
  });

  it("does not send requests during dry-run and reports oversized payloads", async () => {
    const ir = await writeIr([doc({ content: { title: "x".repeat(190 * 1024), legacyBodyHtml: "", excerpt: "", publishedAt: "" }, relations: [] })]);
    const result = await importDocuments({ irDir: ir, dryRun: true, fetchImpl: async () => { throw new Error("must not fetch"); } });
    expect(result).toMatchObject({ dryRun: true, wouldUpload: 0, oversized: 1, uploaded: 0 });
  });

  it("normalizes select values to arrays before PUT", async () => {
    const ir = await writeIr([doc({ kind: "staff", relations: [] })]); const bodies: Record<string, unknown>[] = [];
    await importDocuments({ irDir: ir, config: normalizationConfig, serviceDomain: "service", apiKey: "key", sleep: async () => undefined, fetchImpl: async (_url, init) => {
      if (init?.method === "PUT") bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return init?.method === "GET" ? response({ totalCount: 1 }) : response();
    } });
    expect(bodies[0]?.kind).toEqual(["staff"]);
  });

  it("drops invalid number strings and reports a warning", async () => {
    const ir = await writeIr([doc({ fields: { price: "ASK" }, relations: [] })]);
    const result = await importDocuments({ irDir: ir, config: normalizationConfig, dryRun: true });
    expect(result.warnings).toContainEqual({ api: "cars", contentId: "cars-10", fieldId: "price", value: "ASK", reason: "invalidNumber" });
    expect(result.wouldUpload).toBe(1);
  });

  it("drops empty strings from payloads", async () => {
    const ir = await writeIr([doc({ fields: { label: "" }, relations: [] })]); const bodies: Record<string, unknown>[] = [];
    await importDocuments({ irDir: ir, config: normalizationConfig, serviceDomain: "service", apiKey: "key", sleep: async () => undefined, fetchImpl: async (_url, init) => {
      if (init?.method === "PUT") bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return init?.method === "GET" ? response({ totalCount: 1 }) : response();
    } });
    expect(bodies[0]).not.toHaveProperty("label");
  });

  it("replaces configured image values from --media-map and drops unmapped values with warnings", async () => {
    const ir = await writeIr([doc({ fields: { price: 100, vehicleImage: "https://media.test/direct.jpg" }, featuredImage: "https://media.test/featured.jpg", relations: [] })]);
    const mapPath = join(ir, "media-map.json");
    // A prior import using text fields must not suppress the media-field migration.
    await writeFile(join(ir, "import-state.json"), JSON.stringify({ "cars-10": "from-parse" }));
    await writeFile(mapPath, JSON.stringify({
      "https://media.test/direct.jpg": { assetUrl: "https://images.microcms-assets.io/assets/direct.jpg", uploadedAt: "2026-07-15T00:00:00.000Z" },
      "https://media.test/a.jpg": { assetUrl: "https://images.microcms-assets.io/assets/gallery.jpg", uploadedAt: "2026-07-15T00:00:00.000Z" },
    }));
    const bodies: Record<string, unknown>[] = [];
    const result = await importDocuments({ irDir: ir, config: normalizationConfig, mediaMapPath: mapPath, serviceDomain: "service", apiKey: "key", sleep: async () => undefined, fetchImpl: async (_url, init) => {
      if (init?.method === "PUT") bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return init?.method === "GET" ? response({ totalCount: 1 }) : response();
    } });
    expect(bodies[0]?.vehicleImage).toBe("https://images.microcms-assets.io/assets/direct.jpg");
    expect(bodies[0]?.featuredImage).toBeUndefined();
    expect(bodies[0]?.gallery).toEqual([{ fieldId: "gallery", image: "https://images.microcms-assets.io/assets/gallery.jpg", caption: "A" }]);
    expect(result.warnings).toContainEqual({ api: "cars", contentId: "cars-10", fieldId: "featuredImage", value: "https://media.test/featured.jpg", reason: "missingMediaMap" });
  });

  it("keeps legacy image URL payloads when --media-map is omitted", async () => {
    const ir = await writeIr([doc({ fields: { price: 100, vehicleImage: "https://media.test/direct.jpg" }, featuredImage: "https://media.test/featured.jpg", relations: [] })]);
    const bodies: Record<string, unknown>[] = [];
    await importDocuments({ irDir: ir, config: normalizationConfig, serviceDomain: "service", apiKey: "key", sleep: async () => undefined, fetchImpl: async (_url, init) => {
      if (init?.method === "PUT") bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return init?.method === "GET" ? response({ totalCount: 1 }) : response();
    } });
    expect(bodies[0]).toMatchObject({ vehicleImage: "https://media.test/direct.jpg", featuredImage: "https://media.test/featured.jpg" });
    expect((bodies[0]?.gallery as Array<Record<string, unknown>>)[0]?.image).toBe("https://media.test/a.jpg");
  });

  it("rewrites legacyBodyHtml src and srcset from --media-map while retaining and warning on missing URLs", async () => {
    const first = "https://old.test/wp-content/uploads/body.jpg";
    const second = "https://old.test/wp-content/uploads/body-300x200.jpg";
    const missing = "https://old.test/wp-content/uploads/missing.jpg";
    const ir = await writeIr([doc({ content: { title: "Car", legacyBodyHtml: `<img src="${first}" srcset="${second} 1x, ${missing} 2x"><img src="https://old.test/not-upload.jpg">`, excerpt: "", publishedAt: "2026-01-01" }, relations: [] })]);
    const mapPath = join(ir, "media-map.json");
    await writeFile(mapPath, JSON.stringify({
      [first]: { assetUrl: "https://images.microcms-assets.io/assets/body.jpg", uploadedAt: "2026-07-15T00:00:00.000Z" },
      [second]: { assetUrl: "https://images.microcms-assets.io/assets/body-300x200.jpg", uploadedAt: "2026-07-15T00:00:00.000Z" },
    }));
    const bodies: Record<string, unknown>[] = [];
    const result = await importDocuments({ irDir: ir, config: normalizationConfig, mediaMapPath: mapPath, serviceDomain: "service", apiKey: "key", sleep: async () => undefined, fetchImpl: async (_url, init) => {
      if (init?.method === "PUT") bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return init?.method === "GET" ? response({ totalCount: 1 }) : response();
    } });
    expect(bodies[0]?.legacyBodyHtml).toBe(`<img src="https://images.microcms-assets.io/assets/body.jpg" srcset="https://images.microcms-assets.io/assets/body-300x200.jpg 1x, ${missing} 2x"><img src="https://old.test/not-upload.jpg">`);
    expect(result.warnings).toContainEqual({ api: "cars", contentId: "cars-10", fieldId: "legacyBodyHtml", value: missing, reason: "missingMediaMap" });
  });
});
