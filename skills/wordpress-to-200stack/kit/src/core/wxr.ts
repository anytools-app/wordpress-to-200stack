import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

export const WxrMetaSchema = z.object({
  key: z.string(),
  value: z.string(),
});

export const WxrTaxonomySchema = z.object({
  taxonomy: z.string(),
  slug: z.string(),
  name: z.string(),
});

export const WxrItemSchema = z.object({
  wpId: z.number().int().nonnegative(),
  title: z.string(),
  link: z.string(),
  postType: z.string(),
  status: z.string(),
  postName: z.string(),
  postParent: z.number().int().nonnegative(),
  menuOrder: z.number().int().nonnegative(),
  postDateGmt: z.string(),
  postModifiedGmt: z.string().optional(),
  contentHtml: z.string(),
  excerpt: z.string(),
  attachmentUrl: z.string().optional(),
  mimeType: z.string().optional(),
  meta: z.array(WxrMetaSchema),
  taxonomies: z.array(WxrTaxonomySchema),
  rawXml: z.string().optional(),
});

export const WxrExportSchema = z.object({
  siteTitle: z.string(),
  baseUrl: z.string(),
  generatorVersion: z.string().optional(),
  authors: z.array(z.object({ id: z.number().int().nonnegative(), login: z.string(), displayName: z.string() })),
  items: z.array(WxrItemSchema),
  sanitizeReport: z.array(z.object({ codePoint: z.number().int().nonnegative(), count: z.number().int().positive() })),
});

export type WxrItem = z.infer<typeof WxrItemSchema>;
export type WxrExport = z.infer<typeof WxrExportSchema>;

export function sanitizeXml(input: string): {
  text: string;
  removed: Array<{ codePoint: number; count: number }>;
} {
  const counts = new Map<number, number>();
  const text = input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, (character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined) counts.set(codePoint, (counts.get(codePoint) ?? 0) + 1);
    return "";
  });

  return {
    text,
    removed: [...counts.entries()]
      .sort(([left], [right]) => left - right)
      .map(([codePoint, count]) => ({ codePoint, count })),
  };
}

type XmlRecord = Record<string, unknown>;

function asRecord(value: unknown): XmlRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as XmlRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const record = asRecord(value);
  const text = record["#text"] ?? record["__cdata"];
  return typeof text === "string" || typeof text === "number" || typeof text === "boolean" ? String(text) : "";
}

function asNonnegativeInteger(value: unknown): number {
  const numberValue = Number(asText(value));
  return Number.isInteger(numberValue) && numberValue >= 0 ? numberValue : 0;
}

function extractRawItems(xmlText: string): string[] {
  return [...xmlText.matchAll(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/g)].map((match) => match[0]);
}

function rawCdataValue(xml: string | undefined, tagName: string): string | undefined {
  if (!xml) return undefined;
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<${escapedTagName}(?:\\s[^>]*)?>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${escapedTagName}>`));
  return match?.[1];
}

function rawPostmetaValues(xml: string | undefined): Array<string | undefined> {
  if (!xml) return [];
  return [...xml.matchAll(/<wp:postmeta(?:\s[^>]*)?>([\s\S]*?)<\/wp:postmeta>/g)]
    .map((match) => rawCdataValue(match[1], "wp:meta_value"));
}

function generatorVersion(value: string): string | undefined {
  const match = value.match(/[?&]v=([^&#\s]+)/);
  return match?.[1] || value || undefined;
}

export function parseWxr(xmlText: string): WxrExport {
  const sanitized = sanitizeXml(xmlText);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    textNodeName: "#text",
    isArray: (name) => ["item", "wp:postmeta", "category", "wp:author"].includes(name),
  });
  const parsed = asRecord(parser.parse(sanitized.text));
  const channel = asRecord(asRecord(parsed.rss).channel);
  const rawItems = extractRawItems(sanitized.text);

  const items = asArray(channel.item).map((value, index) => {
    const item = asRecord(value);
    const rawItem = rawItems[index];
    const rawMetaValues = rawPostmetaValues(rawItem);
    const meta = asArray(item["wp:postmeta"]).map((value, metaIndex) => {
      const postmeta = asRecord(value);
      return {
        key: asText(postmeta["wp:meta_key"]),
        value: rawMetaValues[metaIndex] ?? asText(postmeta["wp:meta_value"]),
      };
    });
    const taxonomies = asArray(item.category).map((value) => {
      const category = asRecord(value);
      return {
        taxonomy: asText(category["@_domain"]),
        slug: asText(category["@_nicename"]),
        name: asText(value),
      };
    });

    return WxrItemSchema.parse({
      wpId: asNonnegativeInteger(item["wp:post_id"]),
      title: rawCdataValue(rawItem, "title") ?? asText(item.title),
      link: rawCdataValue(rawItem, "link") ?? asText(item.link),
      postType: rawCdataValue(rawItem, "wp:post_type") ?? asText(item["wp:post_type"]),
      status: rawCdataValue(rawItem, "wp:status") ?? asText(item["wp:status"]),
      postName: rawCdataValue(rawItem, "wp:post_name") ?? asText(item["wp:post_name"]),
      postParent: asNonnegativeInteger(item["wp:post_parent"]),
      menuOrder: asNonnegativeInteger(item["wp:menu_order"]),
      postDateGmt: asText(item["wp:post_date_gmt"]),
      postModifiedGmt: (rawCdataValue(rawItem, "wp:post_modified_gmt") ?? asText(item["wp:post_modified_gmt"])) || undefined,
      contentHtml: rawCdataValue(rawItem, "content:encoded") ?? asText(item["content:encoded"]),
      excerpt: rawCdataValue(rawItem, "excerpt:encoded") ?? asText(item["excerpt:encoded"]),
      attachmentUrl: (rawCdataValue(rawItem, "wp:attachment_url") ?? asText(item["wp:attachment_url"])) || undefined,
      mimeType: (rawCdataValue(rawItem, "wp:post_mime_type") ?? asText(item["wp:post_mime_type"])) || undefined,
      meta,
      taxonomies,
      rawXml: rawItems[index],
    });
  });

  const authors = asArray(channel["wp:author"]).map((value) => {
    const author = asRecord(value);
    return {
      id: asNonnegativeInteger(author["wp:author_id"]),
      login: asText(author["wp:author_login"]),
      displayName: asText(author["wp:author_display_name"]),
    };
  });

  return WxrExportSchema.parse({
    siteTitle: asText(channel.title),
    baseUrl: asText(channel["wp:base_blog_url"]),
    generatorVersion: generatorVersion(asText(channel.generator)),
    authors,
    items,
    sanitizeReport: sanitized.removed,
  });
}
