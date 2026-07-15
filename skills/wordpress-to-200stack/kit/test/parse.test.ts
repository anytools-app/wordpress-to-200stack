import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import mapping from "./fixtures/mini-mapping.config.js";
import { defineMigration } from "../src/config.js";
import { parseMigration, writeParseResult } from "../src/parse/index.js";

const fixturePath = fileURLToPath(new URL("./fixtures/mini-wxr.xml", import.meta.url));

async function parse(xmlTransform?: (xml: string) => string, config = mapping) {
  const xml = await readFile(fixturePath, "utf8");
  return parseMigration(config, xmlTransform ? xmlTransform(xml) : xml);
}

describe("wpkit parse", () => {
  it("normalizes decoded NFC routes and keeps trailing-slash data", async () => {
    const result = await parse((xml) => xml.replace("%e3%82%a2%e3%82%af%e3%83%a1/", "cafe%CC%81/"));
    expect(result.routes.find((route) => route.wpId === 10)).toMatchObject({ path: "/cars/café", segments: ["cars", "café"], trailingSlash: true });
  });

  it("creates typed fields and repeaters while retaining empty zip rows", async () => {
    const result = await parse();
    const car = result.documents.find((document) => document.source.wpId === 10);
    expect(car?.fields).toEqual({ price: 1230000, tags: ["classic", "acme"] });
    expect(car?.repeaters.gallery).toEqual([
      { image: "1", caption: "caption 1" },
      { image: "2", caption: "" },
      { image: "3", caption: "caption 3" },
    ]);
    expect(result.validation.errors).toEqual([]);
  });

  it("reports a repeater zip mismatch and a normalized route collision", async () => {
    const mismatch = await parse((xml) => xml.replace('<wp:postmeta><wp:meta_key>caption</wp:meta_key><wp:meta_value>caption 3</wp:meta_value></wp:postmeta>', ""));
    expect(mismatch.validation.errors.some((entry) => entry.code === "repeaterColumnCountMismatch")).toBe(true);
    const collision = await parse((xml) => xml.replace("<title>About</title><link>https://example.test/about/", "<title>About</title><link>https://example.test/cars/%e3%82%a2%e3%82%af%e3%83%a1/"));
    expect(collision.validation.errors.some((entry) => entry.code === "routeCollision")).toBe(true);
  });

  it("rewrites upload assets and strips only unsafe HTML", async () => {
    const car = (await parse()).documents.find((document) => document.source.wpId === 10);
    expect(car?.content.legacyBodyHtml).toContain('src="https://media.example.test/wp-content/uploads/a.jpg"');
    expect(car?.content.legacyBodyHtml).toContain('srcset="https://media.example.test/wp-content/uploads/a.jpg 1x, https://media.example.test/wp-content/uploads/a-2.jpg 2x"');
    expect(car?.content.legacyBodyHtml).toContain('loading="lazy"');
    expect(car?.content.legacyBodyHtml).toContain("<table><tr><td>x</td></tr></table>");
    expect(car?.content.legacyBodyHtml).not.toMatch(/script|video\.example|onclick/);
    expect(car?.assets).toEqual([
      "https://example.test/wp-content/uploads/a-2.jpg",
      "https://example.test/wp-content/uploads/a.jpg",
      "https://example.test/wp-content/uploads/a.pdf",
    ]);
  });

  it("reports inline style attributes by page and property without changing the HTML", async () => {
    const result = await parse((xml) => xml
      .replace("<table><tr><td>x</td></tr></table>", '<table style="font-size:32px; color:red"><tr><td style="COLOR: blue; font-size: 16px">x</td></tr></table>')
      .replace("<![CDATA[<p>About</p>]]>", '<![CDATA[<p style="color: green">About</p>]]>'));

    expect(result.inlineStyles.summary).toEqual({
      elements: 3,
      pages: 2,
      properties: [
        { property: "color", count: 3 },
        { property: "font-size", count: 2 },
      ],
    });
    expect(result.inlineStyles.pages).toEqual([
      {
        wpId: 10,
        api: "cars",
        path: "/cars/アクメ",
        elements: 2,
        properties: [
          { property: "color", count: 2 },
          { property: "font-size", count: 2 },
        ],
      },
      {
        wpId: 20,
        api: "pages",
        path: "/about",
        elements: 1,
        properties: [{ property: "color", count: 1 }],
      },
    ]);
    expect(result.documents.find((document) => document.source.wpId === 10)?.content.legacyBodyHtml).toContain('style="font-size:32px; color:red"');
    const warnings = result.validation.warnings.filter((entry) => entry.code === "inlineStyleAttributes");
    expect(warnings).toEqual([expect.objectContaining({
      count: 3,
      details: { elements: 3, pages: 2, topProperties: result.inlineStyles.summary.properties },
    })]);
  });

  it("has no inline style report or warning when the source has no style attributes", async () => {
    const result = await parse();
    expect(result.inlineStyles.summary.elements).toBe(0);
    expect(result.inlineStyles.summary.pages).toBe(0);
    expect(result.inlineStyles.pages).toEqual([]);
    expect(result.validation.warnings.some((entry) => entry.code === "inlineStyleAttributes")).toBe(false);
  });

  it("writes the inline style report", async () => {
    const result = await parse((xml) => xml.replace("<table><tr><td>x</td></tr></table>", '<table style="color:red"><tr><td>x</td></tr></table>'));
    const outDir = await mkdtemp(join(tmpdir(), "wpkit-parse-"));
    try {
      await writeParseResult(result, outDir);
      expect(JSON.parse(await readFile(join(outDir, "inline-styles.json"), "utf8"))).toEqual(result.inlineStyles);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("expands cached oEmbed HTML for naked URL paragraphs and warns when the cache is absent", async () => {
    const car = (await parse()).documents.find((document) => document.source.wpId === 10);
    const result = await parse();
    expect(car?.content.legacyBodyHtml).toContain('src="https://www.youtube.com/embed/fixture-video?feature=oembed"');
    expect(car?.content.legacyBodyHtml).toContain('src="https://www.youtube.com/embed/raw-fixture-video?feature=oembed"');
    expect(car?.content.legacyBodyHtml).toContain('loading="lazy"');
    expect(car?.content.legacyBodyHtml).toContain("https://vimeo.com/missing-video");
    expect(result.validation.warnings).toContainEqual(expect.objectContaining({ code: "oembedCacheMissing", details: { url: "https://vimeo.com/missing-video" } }));
  });

  it("resolves attachment IDs in image fields and records the original asset", async () => {
    const carApi = mapping.apis.cars!;
    const imageMapping = defineMigration({
      ...mapping,
      apis: {
        ...mapping.apis,
        cars: { ...carApi, fields: [...carApi.fields, { metaKey: "image", fieldId: "hero", type: "image" }] },
      },
    });
    const result = await parse((xml) => xml.replace('<wp:meta_key>image</wp:meta_key><wp:meta_value>1</wp:meta_value>', '<wp:meta_key>image</wp:meta_key><wp:meta_value>40</wp:meta_value>'), imageMapping);
    const car = result.documents.find((document) => document.source.wpId === 10);
    expect(car?.fields.hero).toBe("https://media.example.test/wp-content/uploads/a.jpg");
    expect(car?.assets).toContain("https://example.test/wp-content/uploads/a.jpg");
    expect(result.validation.warnings.some((entry) => entry.code === "imageAttachmentMissing")).toBe(false);
  });

  it("skips zero relations and accepts code-implemented page routes", async () => {
    const withCodePages = defineMigration({ ...mapping, linkCheck: { assumeExistPostTypes: ["page"] } });
    const result = await parse((xml) => xml.replace('<wp:postmeta><wp:meta_key>related</wp:meta_key><wp:meta_value>999</wp:meta_value></wp:postmeta>', '<wp:postmeta><wp:meta_key>related</wp:meta_key><wp:meta_value>999</wp:meta_value></wp:postmeta><wp:postmeta><wp:meta_key>related</wp:meta_key><wp:meta_value>0</wp:meta_value></wp:postmeta>'), withCodePages);
    const car = result.documents.find((document) => document.source.wpId === 10);
    expect(car?.relations.some((relation) => relation.targetWpId === 0)).toBe(false);
    expect(result.validation.warnings.filter((entry) => entry.code === "unresolvedInternalLink")).toEqual([
      expect.objectContaining({ details: { url: "/not-in-ledger/" }, count: 1 }),
    ]);
  });

  it("accepts configured exact link-check paths without treating prefixes as matches", async () => {
    const explicitPath = defineMigration({ ...mapping, linkCheck: { assumeExistPaths: ["/not-in-ledger"] } });
    const result = await parse(undefined, explicitPath);
    const urls = result.validation.warnings.filter((entry) => entry.code === "unresolvedInternalLink").map((entry) => (entry.details as { url?: string } | undefined)?.url);
    expect(urls).not.toContain("/not-in-ledger/");
    const prefixOnly = defineMigration({ ...mapping, linkCheck: { assumeExistPaths: ["/not-in"] } });
    const prefixUrls = (await parse(undefined, prefixOnly)).validation.warnings.filter((entry) => entry.code === "unresolvedInternalLink").map((entry) => (entry.details as { url?: string } | undefined)?.url);
    expect(prefixUrls).toContain("/not-in-ledger/");
  });

  it("resolves relations, reports unresolved targets, restores derived sizes, and is deterministic", async () => {
    const first = await parse();
    const second = await parse();
    const car = first.documents.find((document) => document.source.wpId === 10);
    expect(car?.relations).toEqual([
      { fieldId: "related", toApi: "pages", targetWpId: 20, targetContentId: "pages-20" },
      { fieldId: "related", toApi: "pages", targetWpId: 999 },
    ]);
    expect(first.relations.unresolved).toEqual([{ fieldId: "related", toApi: "pages", targetWpId: 999, reason: "targetMissing" }]);
    expect(first.validation.warnings.some((entry) => entry.code === "unresolvedRelation")).toBe(true);
    expect(first.attachments[0]?.derivedSizes).toEqual([{ name: "thumb", file: "a-150x150.jpg", width: 150, height: 150 }]);
    expect(car?.payloadChecksum).toBe(second.documents.find((document) => document.source.wpId === 10)?.payloadChecksum);
  });

  it("keeps emitted IR byte-for-byte identical when contentIdStrategy is omitted or wpId", async () => {
    const implicit = await parse();
    const explicit = await parse(undefined, defineMigration({ ...mapping, contentIdStrategy: "wpId" }));
    const implicitDir = await mkdtemp(join(tmpdir(), "wpkit-parse-"));
    const explicitDir = await mkdtemp(join(tmpdir(), "wpkit-parse-"));
    try {
      await Promise.all([writeParseResult(implicit, implicitDir), writeParseResult(explicit, explicitDir)]);
      for (const file of ["documents.ndjson", "routes.json", "attachments.ndjson", "relations.json", "inline-styles.json", "excluded.ndjson", "validation-report.json", "validation-report.md"]) {
        expect(await readFile(join(implicitDir, file), "utf8")).toBe(await readFile(join(explicitDir, file), "utf8"));
      }
      expect(implicit.documents.some((document) => document.contentIdProvisional)).toBe(false);
      expect(implicit.contentIds).toEqual({ strategy: "wpId", legacySlug: { adopted: 0, fallback: 0 } });
    } finally {
      await Promise.all([rm(implicitDir, { recursive: true, force: true }), rm(explicitDir, { recursive: true, force: true })]);
    }
  });

  it("uses valid legacy path tails as content IDs and resolves relations through them", async () => {
    const legacySlug = defineMigration({ ...mapping, contentIdStrategy: "legacySlug" });
    const result = await parse(undefined, legacySlug);
    const car = result.documents.find((document) => document.source.wpId === 10);
    const page = result.documents.find((document) => document.source.wpId === 20);

    expect(car?.contentId).toBe("cars-10");
    expect(car?.contentIdProvisional).toBe(true);
    expect(page?.contentId).toBe("about");
    expect(page?.contentIdProvisional).toBeUndefined();
    expect(result.routes.find((route) => route.wpId === 20)?.contentId).toBe("about");
    expect(car?.relations).toContainEqual({ fieldId: "related", toApi: "pages", targetWpId: 20, targetContentId: "about" });
    expect(result.contentIds).toEqual({ strategy: "legacySlug", legacySlug: { adopted: 1, fallback: 1 } });
  });

  it("falls back for overlong legacy slugs and duplicate slugs in the same API", async () => {
    const legacySlug = defineMigration({ ...mapping, contentIdStrategy: "legacySlug" });
    const longSlug = "a".repeat(65);
    const overlong = await parse((xml) => xml.replace("<title>About</title><link>https://example.test/about/</link>", `<title>About</title><link>https://example.test/${longSlug}/</link>`), legacySlug);
    expect(overlong.documents.find((document) => document.source.wpId === 20)?.contentId).toBe("pages-20");
    expect(overlong.documents.find((document) => document.source.wpId === 20)?.contentIdProvisional).toBe(true);
    expect(overlong.contentIds).toEqual({ strategy: "legacySlug", legacySlug: { adopted: 0, fallback: 2 } });

    const collision = await parse((xml) => xml
      .replace("<title>Second car</title><link>https://example.test/cars/second</link>", "<title>Duplicate About</title><link>https://example.test/about/</link>")
      .replace("<wp:status>draft</wp:status>", "<wp:status>publish</wp:status>")
      .replace("<wp:post_type>car</wp:post_type>\n    </item>\n    <item>\n      <title>About</title>", "<wp:post_type>page</wp:post_type>\n    </item>\n    <item>\n      <title>About</title>"), legacySlug);
    expect(collision.documents.find((document) => document.source.wpId === 11)?.contentId).toBe("about");
    expect(collision.documents.find((document) => document.source.wpId === 20)?.contentId).toBe("pages-20");
    expect(collision.documents.find((document) => document.source.wpId === 20)?.contentIdProvisional).toBe(true);
    expect(collision.validation.warnings).toContainEqual(expect.objectContaining({ code: "contentIdSlugCollision", wpId: 20, api: "pages", details: { slug: "about", previousWpId: 11, fallbackContentId: "pages-20" } }));
    expect(collision.contentIds).toEqual({ strategy: "legacySlug", legacySlug: { adopted: 1, fallback: 2 } });
  });

  it("marks relations to excluded WXR items separately", async () => {
    const result = await parse((xml) => xml.replace('<wp:meta_key>related</wp:meta_key><wp:meta_value>999</wp:meta_value>', '<wp:meta_key>related</wp:meta_key><wp:meta_value>11</wp:meta_value>'));
    expect(result.relations.unresolved).toContainEqual(expect.objectContaining({ targetWpId: 11, reason: "targetExcluded" }));
  });

  it("rejects invalid mapping configs with an editable key path", () => {
    expect(() => defineMigration({
      ...mapping,
      apis: { merged: { from: ["car", "page"], fields: [] } },
    })).toThrow(/apis\.merged\.kindField/);
  });
});
