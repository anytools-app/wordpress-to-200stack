import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { importDocuments } from "../src/microcms/import.js";
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

  it("does not send requests during dry-run and reports oversized payloads", async () => {
    const ir = await writeIr([doc({ content: { title: "x".repeat(190 * 1024), legacyBodyHtml: "", excerpt: "", publishedAt: "" }, relations: [] })]);
    const result = await importDocuments({ irDir: ir, dryRun: true, fetchImpl: async () => { throw new Error("must not fetch"); } });
    expect(result).toMatchObject({ dryRun: true, wouldUpload: 0, oversized: 1, uploaded: 0 });
  });
});
