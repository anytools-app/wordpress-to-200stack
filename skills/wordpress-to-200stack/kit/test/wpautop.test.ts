import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { defineMigration, type MigrationConfig } from "../src/config.js";
import { parseMigration } from "../src/parse/index.js";
import { hasBlockMarkup, wpautop } from "../src/parse/wpautop.js";
import mapping from "./fixtures/mini-mapping.config.js";

const fixturePath = fileURLToPath(new URL("./fixtures/mini-wxr.xml", import.meta.url));
const firstContent = /<content:encoded><!\[CDATA\[[\s\S]*?\]\]><\/content:encoded>/;

async function parseFirstBody(
  body: string,
  config: MigrationConfig = mapping,
  transformXml: (xml: string) => string = (xml) => xml,
) {
  const fixture = await readFile(fixturePath, "utf8");
  const xml = transformXml(fixture.replace(firstContent, () => `<content:encoded><![CDATA[${body}]]></content:encoded>`));
  const result = parseMigration(config, xml);
  const document = result.documents.find((entry) => entry.source.wpId === 10);
  if (!document) throw new Error("mini WXR の wpId=10 が parse 結果にありません");
  return { document, result };
}

function applyUnlessFormatted(html: string): string {
  return hasBlockMarkup(html) ? html : wpautop(html);
}

describe("wpautop", () => {
  it("turns blank-line separators into paragraphs", () => {
    expect(wpautop("A\n\nB")).toBe("<p>A</p>\n<p>B</p>\n");
  });

  it("turns consecutive br tags into paragraphs", () => {
    expect(wpautop("A<br><br>B")).toBe("<p>A</p>\n<p>B</p>\n");
  });

  it("turns a single newline into a br inside one paragraph", () => {
    expect(wpautop("A\nB")).toBe("<p>A<br />\nB</p>\n");
  });

  it("keeps remaining line breaks when br conversion is disabled", () => {
    expect(wpautop("A\nB\n\nC", false)).toBe("<p>A\nB</p>\n<p>C</p>\n");
  });

  it("restores pre contents byte-for-byte", () => {
    const pre = "<pre data-kind=\"sample\">\r\nA\n\n\tB\rC</pre>";
    expect(wpautop(pre)).toBe(`${pre}\n`);
  });

  it("restores JavaScript replacement tokens in pre contents literally", () => {
    const pre = "<pre>$&|$`|$'|$$</pre>";
    expect(wpautop(pre)).toBe(`${pre}\n`);
  });

  it("does not wrap block elements in an outer paragraph", () => {
    expect(wpautop("Before\n\n<blockquote>Quote</blockquote>\n\nAfter")).toBe(
      "<p>Before</p>\n<blockquote><p>Quote</p></blockquote>\n<p>After</p>\n",
    );
  });

  it("matches WordPress handling for text nested in a div", () => {
    expect(wpautop("<div>\nAlpha\n</div>")).toBe("<div>\nAlpha\n</div>\n");
  });

  it("preserves newlines inside HTML elements and script contents", () => {
    expect(wpautop("<span\ndata-kind=\"sample\">A</span>")).toBe("<p><span\ndata-kind=\"sample\">A</span></p>\n");
    expect(wpautop("A\n<script>\nconst value = 1;\n</script>\nB")).toBe(
      "<p>A<br />\n<script>\nconst value = 1;\n</script><br />\nB</p>\n",
    );
  });

  it("preserves newlines inside multiline HTML comments and CDATA", () => {
    expect(wpautop("A\n\n<!-- line1\nline2 -->\n\nB")).toBe(
      "<p>A</p>\n<p><!-- line1\nline2 --></p>\n<p>B</p>\n",
    );
    expect(wpautop("A\n\n<![CDATA[line1\nline2]]>\n\nB")).toBe(
      "<p>A</p>\n<p><![CDATA[line1\nline2]]></p>\n<p>B</p>\n",
    );
  });

  it("matches WordPress splitting of malformed comments", () => {
    expect(wpautop("A\n<!-->B\nC")).toBe("<p>A<br />\n<!-->B<br />\nC</p>\n");
  });

  it("returns an empty string for empty input", () => {
    expect(wpautop("")).toBe("");
  });

  it("preserves non-ASCII whitespace that PHP PCRE does not match as whitespace", () => {
    expect(wpautop("\u00a0")).toBe("<p>\u00a0</p>\n");
    expect(wpautop("A\u00a0\nB")).toBe("<p>A\u00a0<br />\nB</p>\n");
    expect(wpautop("A\n\u00a0\nB")).toBe("<p>A<br />\n\u00a0<br />\nB</p>\n");
  });

  it("skips content that already has paragraphs or Gutenberg block markup", () => {
    const paragraph = "<p>Already formatted</p>";
    const gutenberg = "<!-- wp:paragraph -->\nRaw block\n<!-- /wp:paragraph -->";

    expect(hasBlockMarkup(paragraph)).toBe(true);
    expect(hasBlockMarkup(gutenberg)).toBe(true);
    expect(applyUnlessFormatted(paragraph)).toBe(paragraph);
    expect(applyUnlessFormatted(gutenberg)).toBe(gutenberg);
  });

  it("keeps the source single-newline and paragraph counts", () => {
    const source = "A1\nA2\nA3\n\nB1\nB2\n\nC1";
    const converted = wpautop(source);

    expect(converted.match(/<br \/>/g)).toHaveLength(3);
    expect(converted.match(/<p>/g)).toHaveLength(3);
  });
});

describe("wpautop parse integration", () => {
  it("formats raw WXR body text before rewriting legacyBodyHtml", async () => {
    const { document } = await parseFirstBody("Alpha\nBeta\n\nGamma");

    expect(document.content.legacyBodyHtml).toBe("<p>Alpha<br>\nBeta</p>\n<p>Gamma</p>\n");
  });

  it("passes raw WXR body text through when config wpautop is false", async () => {
    const config = defineMigration({ ...mapping, wpautop: false });
    const source = "Alpha\nBeta\n\nGamma";
    const { document } = await parseFirstBody(source, config);

    expect(document.content.legacyBodyHtml).toBe(source);
  });

  it("does not apply wpautop twice to an existing paragraph structure", async () => {
    const source = "<p>Already\nformatted</p>";
    const { document } = await parseFirstBody(source);

    expect(document.content.legacyBodyHtml).toBe(source);
  });

  it("does not apply wpautop to Gutenberg block content", async () => {
    const source = "<!-- wp:paragraph -->\nRaw\nline\n<!-- /wp:paragraph -->";
    const { document } = await parseFirstBody(source);

    expect(document.content.legacyBodyHtml).toBe(source);
  });

  it("decides wpautop eligibility from raw content before oEmbed expansion", async () => {
    const cachedIframe = '<iframe width="500" height="281" src="https://www.youtube.com/embed/raw-fixture-video?feature=oembed"></iframe>';
    const cachedParagraph = '<p><a href="https://youtu.be/raw-fixture-video">Cached embed</a></p>';
    const { document } = await parseFirstBody(
      "Intro\n\nhttps://youtu.be/raw-fixture-video\n\nOutro",
      mapping,
      (xml) => xml.replace(cachedIframe, cachedParagraph),
    );

    expect(document.content.legacyBodyHtml).toBe(
      '<p>Intro</p>\n<p><a href="https://youtu.be/raw-fixture-video">Cached embed</a></p>\n<p>Outro</p>\n',
    );
  });
});
