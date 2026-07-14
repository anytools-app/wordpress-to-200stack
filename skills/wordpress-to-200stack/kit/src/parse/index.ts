import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { unserialize } from "php-serialize";

import { defineMigration, type ApiDef, type FieldDef, type MigrationConfig } from "../config.js";
import { parseWxr, type WxrItem } from "../core/wxr.js";
import { normalizeRoutePath, rewriteLegacyHtml, type HtmlWarning } from "./html.js";
import { metaValues, zipRepeater } from "./repeater.js";

const DEFAULT_IFRAME_HOSTS = ["www.youtube.com", "youtube.com", "player.vimeo.com", "calendar.google.com", "www.google.com", "www.instagram.com"];
const OEMBED_HOSTS = [
  "youtube.com", "youtu.be", "vimeo.com", "instagram.com", "instagr.am", "twitter.com", "x.com", "facebook.com", "flickr.com", "soundcloud.com", "spotify.com", "tiktok.com", "wordpress.com", "wordpress.tv",
];

export type ValidationIssue = { code: string; message: string; wpId?: number; api?: string; details?: unknown; count?: number };
export type LegacyDocument = {
  source: { wpId: number; postType: string; status: string; modifiedGmt?: string };
  api: string;
  kind?: string;
  contentId: string;
  route: { legacyUrl: string; path: string; segments: string[]; trailingSlash: boolean };
  content: { title: string; legacyBodyHtml: string; excerpt: string; publishedAt: string };
  seo?: { title?: string; description?: string; noindex?: boolean };
  taxonomies: Array<{ taxonomy: string; slug: string; name: string }>;
  fields: Record<string, unknown>;
  repeaters: Record<string, Array<Record<string, unknown>>>;
  relations: Array<{ fieldId: string; toApi: string; targetWpId: number; targetContentId?: string }>;
  featuredImage?: string;
  assets: string[];
  payloadChecksum: string;
};
export type RouteEntry = LegacyDocument["route"] & { api: string; contentId: string; wpId: number; legacyUrl: string };
export type AttachmentEntry = { wpId: number; url: string; path: string; mime?: string; derivedSizes: Array<{ name: string; file: string; width?: number; height?: number }> };
export type ParseResult = {
  documents: LegacyDocument[];
  routes: RouteEntry[];
  attachments: AttachmentEntry[];
  relations: { resolved: LegacyDocument["relations"]; unresolved: Array<LegacyDocument["relations"][number] & { reason: "targetExcluded" | "targetMissing" }> };
  excluded: Array<{ wpId: number; postType: string; status: string; reason: string }>;
  validation: { errors: ValidationIssue[]; warnings: ValidationIssue[] };
};

function firstMeta(item: WxrItem, key: string): string | undefined { return metaValues(item, key)[0]; }

type OembedCache = { html: string; urls: string[]; identities: Set<string>; instagram: boolean };
type OembedExpansion = { html: string; missing: string[]; instagramEmbeds: number };

function decodedHtml(value: string): string { return value.replace(/&amp;/gi, "&"); }

function oembedIdentity(value: string): string | undefined {
  let url: URL;
  try { url = new URL(decodedHtml(value)); } catch { return undefined; }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.split("/").filter(Boolean);
  if ((host === "youtu.be" && path[0]) || (host === "youtube.com" && ["embed", "shorts", "live"].includes(path[0] ?? "") && path[1])) return `youtube:${host === "youtu.be" ? path[0] : path[1]}`;
  if (host === "youtube.com" && url.searchParams.get("v")) return `youtube:${url.searchParams.get("v")}`;
  if (host === "vimeo.com" && path[0]) return `vimeo:${path[0]}`;
  if (host === "player.vimeo.com" && path[0] === "video" && path[1]) return `vimeo:${path[1]}`;
  if (["instagram.com", "instagr.am"].includes(host) && ["p", "reel", "tv"].includes(path[0] ?? "") && path[1]) return `instagram:${path[1]}`;
  return undefined;
}

function isOembedUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return OEMBED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch { return false; }
}

function oembedCaches(item: WxrItem): OembedCache[] {
  return item.meta
    .filter((meta) => /^_oembed_(?!time_)/.test(meta.key) && !/^\s*\{\{unknown\}\}\s*$/i.test(meta.value))
    .map((meta) => {
      const html = meta.value;
      const urls = [...decodedHtml(html).matchAll(/https?:\/\/[^\s"'<>]+/gi)].map((match) => match[0]);
      return { html, urls, identities: new Set(urls.map(oembedIdentity).filter((identity): identity is string => Boolean(identity))), instagram: /(?:instagram\.com|instagr\.am)/i.test(html) };
    });
}

function cacheForOembedUrl(url: string, caches: readonly OembedCache[]): OembedCache | undefined {
  const identity = oembedIdentity(url);
  return caches.find((cache) => cache.urls.some((candidate) => candidate === url || decodedHtml(candidate) === decodedHtml(url)))
    ?? (identity ? caches.find((cache) => cache.identities.has(identity)) : undefined);
}

/** Reproduce WordPress oEmbed expansion from its exported postmeta cache before sanitizing the result. */
function expandOembedCache(item: WxrItem): OembedExpansion {
  const caches = oembedCaches(item);
  const missing = new Set<string>();
  let instagramEmbeds = 0;
  const replaceUrl = (url: string): string | undefined => {
    if (!isOembedUrl(url)) return undefined;
    const cache = cacheForOembedUrl(url, caches);
    if (!cache) { missing.add(url); return undefined; }
    if (cache.instagram) instagramEmbeds += 1;
    return cache.html;
  };
  // WXR content may retain either WordPress' <p> wrapper or the pre-wpautop blank-line form.
  let html = item.contentHtml.replace(/<p\b[^>]*>\s*(https?:\/\/[^\s<]+)\s*<\/p>/gi, (whole, url: string) => replaceUrl(url) ?? whole);
  html = html.replace(/(^|\r?\n\s*\r?\n)(\s*)(https?:\/\/[^\s<]+)(\s*)(?=\r?\n\s*\r?\n|$)/gim, (whole, before: string, leading: string, url: string, trailing: string) => {
    const replacement = replaceUrl(url);
    return replacement ? `${before}${leading}${replacement}${trailing}` : whole;
  });
  return { html, missing: [...missing].sort(), instagramEmbeds };
}

function routeFor(item: WxrItem): LegacyDocument["route"] {
  let rawPath = item.link;
  try { rawPath = new URL(item.link).pathname || "/"; } catch { rawPath = item.link.split(/[?#]/, 1)[0] || "/"; }
  let decoded: string;
  try { decoded = decodeURIComponent(rawPath); } catch { decoded = rawPath; }
  decoded = decoded.normalize("NFC");
  const trailingSlash = decoded.length > 1 && decoded.endsWith("/");
  const segments = decoded.split("/").filter(Boolean);
  return { legacyUrl: item.link, path: segments.length === 0 ? "/" : `/${segments.join("/")}`, segments, trailingSlash };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
  return value;
}
function checksum(value: unknown): string { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }

function originalAndReplacement(value: string, config: MigrationConfig): { original?: string; replacement: string } {
  try {
    const url = new URL(value);
    const origin = new URL(config.site.origin);
    if (url.host !== origin.host || !url.pathname.startsWith("/wp-content/uploads/")) return { replacement: value };
    const media = new URL(config.site.mediaHost);
    const replacement = new URL(url.toString());
    replacement.protocol = media.protocol;
    replacement.host = media.host;
    return { original: url.toString(), replacement: replacement.toString() };
  } catch { return { replacement: value }; }
}

function convertField(field: FieldDef, value: string, warnings: ValidationIssue[], item: WxrItem, config: MigrationConfig, assets: Set<string>, attachmentsById: Map<number, WxrItem>): unknown {
  if (field.type === "number") {
    const canonical = value.normalize("NFKC").replace(/[,_\s]/g, "");
    if (canonical !== "" && Number.isFinite(Number(canonical))) return Number(canonical);
    warnings.push({ code: "numberConversionFailed", wpId: item.wpId, message: `${field.fieldId}: 数値に変換できません`, details: { value } });
    return value;
  }
  if (field.type === "boolean") return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  if (field.type === "image") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    if (/^\d+$/.test(trimmed)) {
      const attachment = attachmentsById.get(Number(trimmed));
      if (!attachment?.attachmentUrl) {
        warnings.push({ code: "imageAttachmentMissing", wpId: item.wpId, message: `${field.fieldId}: attachment wpId=${trimmed} が見つかりません` });
        return null;
      }
      const rewritten = originalAndReplacement(attachment.attachmentUrl, config);
      if (rewritten.original) assets.add(rewritten.original);
      return rewritten.replacement;
    }
    if (!/^https?:\/\//i.test(trimmed)) return value;
    const rewritten = originalAndReplacement(trimmed, config);
    if (rewritten.original) assets.add(rewritten.original);
    return rewritten.replacement;
  }
  return value;
}

function fieldValue(field: FieldDef, item: WxrItem, warnings: ValidationIssue[], config: MigrationConfig, assets: Set<string>, attachmentsById: Map<number, WxrItem>): unknown {
  if (field.metaKey === "wp:menu_order") return convertField(field, String(item.menuOrder), warnings, item, config, assets, attachmentsById);
  const values = metaValues(item, field.metaKey);
  if (field.type === "stringArray") return values.map((value) => convertField({ ...field, type: "string" }, value, warnings, item, config, assets, attachmentsById));
  return convertField(field, values[0] ?? "", warnings, item, config, assets, attachmentsById);
}

function itemApi(item: WxrItem, config: MigrationConfig): { api: string; definition: ApiDef } | undefined {
  const entry = Object.entries(config.apis).find(([, definition]) => (Array.isArray(definition.from) ? definition.from : [definition.from]).includes(item.postType));
  return entry ? { api: entry[0], definition: entry[1] } : undefined;
}

function attachmentEntry(item: WxrItem): { entry?: AttachmentEntry; metadataError: boolean } {
  if (!item.attachmentUrl) return { metadataError: false };
  let path = item.attachmentUrl;
  try { path = new URL(item.attachmentUrl).pathname; } catch { /* retain malformed path for audit */ }
  const metadata = firstMeta(item, "_wp_attachment_metadata");
  const derivedSizes: AttachmentEntry["derivedSizes"] = [];
  if (metadata) {
    try {
      const data = unserialize(Buffer.from(metadata, "utf8")) as Record<string, unknown>;
      const sizes = data.sizes as Record<string, unknown> | undefined;
      for (const [name, raw] of Object.entries(sizes ?? {})) {
        const entry = raw as Record<string, unknown>;
        if (typeof entry.file !== "string") continue;
        derivedSizes.push({ name, file: entry.file, ...(typeof entry.width === "number" ? { width: entry.width } : {}), ...(typeof entry.height === "number" ? { height: entry.height } : {}) });
      }
    } catch { return { entry: { wpId: item.wpId, url: item.attachmentUrl, path, ...(item.mimeType ? { mime: item.mimeType } : {}), derivedSizes }, metadataError: true }; }
  }
  return { entry: { wpId: item.wpId, url: item.attachmentUrl, path, ...(item.mimeType ? { mime: item.mimeType } : {}), derivedSizes }, metadataError: false };
}

function validationMarkdown(validation: ParseResult["validation"]): string {
  const lines = ["# wpkit parse validation report", "", `- Errors: ${validation.errors.length}`, `- Warnings: ${validation.warnings.length}`, ""];
  for (const [heading, entries] of [["Errors", validation.errors], ["Warnings", validation.warnings]] as const) {
    lines.push(`## ${heading}`, "");
    if (entries.length === 0) lines.push("なし", "");
    else for (const entry of (heading === "Warnings" ? [...entries].sort((left, right) => {
      if (left.code === "unresolvedInternalLink" && right.code === "unresolvedInternalLink") return (right.count ?? 1) - (left.count ?? 1) || left.message.localeCompare(right.message);
      if (left.code === "unresolvedInternalLink") return -1;
      if (right.code === "unresolvedInternalLink") return 1;
      return 0;
    }) : entries)) lines.push(`- [${entry.code}]${entry.count === undefined ? "" : ` count=${entry.count}`}${entry.wpId === undefined ? "" : ` wpId=${entry.wpId}`} ${entry.message}`);
    lines.push("");
  }
  return lines.join("\n");
}

function aggregateInternalLinkWarnings(warnings: ValidationIssue[]): ValidationIssue[] {
  const links = new Map<string, number>();
  const other: ValidationIssue[] = [];
  for (const warning of warnings) {
    if (warning.code !== "unresolvedInternalLink") { other.push(warning); continue; }
    const url = typeof (warning.details as { url?: unknown } | undefined)?.url === "string" ? (warning.details as { url: string }).url : warning.message;
    links.set(url, (links.get(url) ?? 0) + 1);
  }
  return [
    ...[...links.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([url, count]) => ({ code: "unresolvedInternalLink", message: `台帳にない内部リンク: ${url}`, details: { url }, count })),
    ...other,
  ];
}

function ndjson(values: unknown[]): string { return values.map((value) => JSON.stringify(value)).join("\n") + (values.length > 0 ? "\n" : ""); }

export function parseMigration(config: MigrationConfig, xml: string): ParseResult {
  const exp = parseWxr(xml);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const attachments = exp.items.filter((item) => item.postType === "attachment").flatMap((item) => {
    const parsed = attachmentEntry(item);
    if (parsed.metadataError) warnings.push({ code: "attachmentMetadataUnserializeFailed", wpId: item.wpId, message: "_wp_attachment_metadata の復元に失敗しました" });
    return parsed.entry ? [parsed.entry] : [];
  });
  const attachmentsById = new Map(exp.items.filter((item) => item.postType === "attachment").map((item) => [item.wpId, item]));
  const excluded: ParseResult["excluded"] = [];
  const instagramOembed = exp.items.map((item) => ({ item, expansion: expandOembedCache(item) })).filter(({ expansion }) => expansion.instagramEmbeds > 0);
  if (instagramOembed.length > 0) {
    const embeds = instagramOembed.reduce((total, { expansion }) => total + expansion.instagramEmbeds, 0);
    warnings.push({ code: "instagramOembedMayDiffer", message: `Instagram oEmbed は ${instagramOembed.length} ページ / ${embeds} 件です。embed script は安全上除去されるため、原文と表示が異なる可能性があります`, details: { pages: instagramOembed.length, embeds } });
  }
  const candidates: Array<{ item: WxrItem; api: string; definition: ApiDef }> = [];
  const configuredMeta = new Map<string, { api: string; key: string }>();
  for (const [api, definition] of Object.entries(config.apis)) {
    for (const field of [...definition.fields, ...(definition.repeaters ?? []).flatMap((repeater) => repeater.columns)]) {
      if (field.metaKey !== "wp:menu_order" && !field.allowMissing) configuredMeta.set(`${api}:${field.metaKey}`, { api, key: field.metaKey });
    }
    for (const relation of definition.relations ?? []) configuredMeta.set(`${api}:${relation.metaKey}`, { api, key: relation.metaKey });
    if (definition.featuredImage) configuredMeta.set(`${api}:_thumbnail_id`, { api, key: "_thumbnail_id" });
  }
  for (const { api, key } of [...configuredMeta.values()].sort((a, b) => `${a.api}:${a.key}`.localeCompare(`${b.api}:${b.key}`))) {
    const definition = config.apis[api];
    const types = definition ? (Array.isArray(definition.from) ? definition.from : [definition.from]) : [];
    if (!exp.items.some((item) => types.includes(item.postType) && item.meta.some((meta) => meta.key === key))) errors.push({ code: "configuredMetaMissing", api, message: `config が参照する meta キー \"${key}\" が対象 item にありません` });
  }
  for (const item of exp.items) {
    if (item.postType === "attachment") continue;
    if (["smart-custom-fields", "acf-field", "acf-field-group", "revision"].includes(item.postType)) { excluded.push({ wpId: item.wpId, postType: item.postType, status: item.status, reason: "configuration post" }); continue; }
    if (config.exclude?.statuses?.includes(item.status)) { excluded.push({ wpId: item.wpId, postType: item.postType, status: item.status, reason: "excluded status" }); continue; }
    if (item.status !== "publish") { excluded.push({ wpId: item.wpId, postType: item.postType, status: item.status, reason: "non-publish status" }); continue; }
    if (config.exclude?.postTypes?.includes(item.postType)) { excluded.push({ wpId: item.wpId, postType: item.postType, status: item.status, reason: "excluded post_type" }); continue; }
    const mapped = itemApi(item, config);
    if (!mapped) { excluded.push({ wpId: item.wpId, postType: item.postType, status: item.status, reason: "unmapped post_type" }); continue; }
    candidates.push({ item, ...mapped });
  }
  const routes = candidates.map(({ item, api }) => ({ ...routeFor(item), api, contentId: `${api}-${item.wpId}`, wpId: item.wpId, legacyUrl: item.link }));
  const routesByPath = new Map<string, RouteEntry>();
  for (const route of routes) {
    const previous = routesByPath.get(route.path);
    if (previous) errors.push({ code: "routeCollision", wpId: route.wpId, api: route.api, message: `正規化後の path \"${route.path}\" が wpId=${previous.wpId} と衝突しています` });
    else routesByPath.set(route.path, route);
  }
  const allowIframeHosts = new Set((config.embeds?.allowIframeHosts ?? DEFAULT_IFRAME_HOSTS).map((host) => host.toLowerCase()));
  const assumedPaths = new Set(config.linkCheck?.assumeExistPaths?.map(normalizeRoutePath) ?? []);
  const assumedPostTypes = new Set(config.linkCheck?.assumeExistPostTypes ?? []);
  for (const item of exp.items) if (item.status === "publish" && assumedPostTypes.has(item.postType)) assumedPaths.add(routeFor(item).path);
  const knownRoutePaths = new Set([...routes.map((entry) => entry.path), ...assumedPaths]);
  const documents: LegacyDocument[] = candidates.map(({ item, api, definition }) => {
    const route = routeFor(item);
    const assets = new Set<string>();
    const oembed = expandOembedCache(item);
    const htmlResult = definition.body === "none" ? { html: "", assets: [], warnings: { unresolvedInternalLinks: [], removedScripts: 0, removedIframes: [] } satisfies HtmlWarning } : rewriteLegacyHtml(oembed.html, { site: config.site, routePaths: knownRoutePaths, allowIframeHosts });
    for (const asset of htmlResult.assets) assets.add(asset);
    for (const url of oembed.missing) warnings.push({ code: "oembedCacheMissing", wpId: item.wpId, api, message: `oEmbed キャッシュが見つかりません: ${url}`, details: { url } });
    for (const link of htmlResult.warnings.unresolvedInternalLinks) warnings.push({ code: "unresolvedInternalLink", wpId: item.wpId, api, message: `台帳にない内部リンク: ${link}`, details: { url: link } });
    if (htmlResult.warnings.removedScripts > 0) warnings.push({ code: "removedScripts", wpId: item.wpId, api, message: `script を ${htmlResult.warnings.removedScripts} 件除去しました` });
    for (const source of htmlResult.warnings.removedIframes) warnings.push({ code: "removedIframe", wpId: item.wpId, api, message: `許可されない iframe を除去しました: ${source}` });
    const fields = Object.fromEntries(definition.fields.map((field) => [field.fieldId, fieldValue(field, item, warnings, config, assets, attachmentsById)]));
    if (Array.isArray(definition.from) && definition.kindField) fields[definition.kindField] = item.postType;
    const repeaters: LegacyDocument["repeaters"] = {};
    for (const repeater of definition.repeaters ?? []) {
      const zipped = zipRepeater(item, repeater, (field, value) => convertField(field, value, warnings, item, config, assets, attachmentsById));
      if (zipped.error) errors.push({ code: zipped.error.code, wpId: item.wpId, api, message: `リピータ \"${repeater.fieldId}\" の列数が一致しません`, details: zipped.error.counts });
      repeaters[repeater.fieldId] = zipped.rows;
    }
    const relations = (definition.relations ?? []).flatMap((relation) => metaValues(item, relation.metaKey).flatMap((value) => {
      const trimmed = value.trim();
      if (trimmed === "" || !/^\d+$/.test(trimmed) || Number(trimmed) === 0) return [];
      const targetWpId = Number(trimmed);
      return [{ fieldId: relation.fieldId, toApi: relation.toApi, targetWpId }];
    }));
    let featuredImage: string | undefined;
    if (definition.featuredImage) {
      const id = Number(firstMeta(item, "_thumbnail_id"));
      const attachment = attachmentsById.get(id);
      if (attachment?.attachmentUrl) {
        const rewritten = originalAndReplacement(attachment.attachmentUrl, config);
        if (rewritten.original) assets.add(rewritten.original);
        featuredImage = rewritten.replacement;
      } else warnings.push({ code: "thumbnailMissingAttachment", wpId: item.wpId, api, message: `_thumbnail_id=${firstMeta(item, "_thumbnail_id") ?? ""} の attachment が見つかりません` });
    }
    const seo = config.seo?.yoast ? {
      ...(firstMeta(item, "_yoast_wpseo_title") ? { title: firstMeta(item, "_yoast_wpseo_title") } : {}),
      ...(firstMeta(item, "_yoast_wpseo_metadesc") ? { description: firstMeta(item, "_yoast_wpseo_metadesc") } : {}),
      ...(firstMeta(item, "_yoast_wpseo_meta-robots-noindex") === "1" ? { noindex: true } : {}),
    } : undefined;
    for (const value of [seo?.title, seo?.description]) if (value && /%%[^%]+%%/.test(value)) warnings.push({ code: "yoastTemplateVariable", wpId: item.wpId, api, message: `Yoast テンプレート変数を未解決のまま保持しました: ${value}` });
    const document: Omit<LegacyDocument, "payloadChecksum"> = {
      source: { wpId: item.wpId, postType: item.postType, status: item.status, ...(item.postModifiedGmt ? { modifiedGmt: item.postModifiedGmt } : {}) },
      api, ...(Array.isArray(definition.from) ? { kind: item.postType } : {}), contentId: `${api}-${item.wpId}`, route,
      content: { title: item.title, legacyBodyHtml: htmlResult.html, excerpt: item.excerpt, publishedAt: item.postDateGmt },
      ...(seo && Object.keys(seo).length > 0 ? { seo } : {}),
      taxonomies: item.taxonomies.filter((taxonomy) => definition.taxonomies?.includes(taxonomy.taxonomy) ?? false), fields, repeaters, relations,
      ...(featuredImage ? { featuredImage } : {}), assets: [...assets].sort(),
    };
    return { ...document, payloadChecksum: checksum(document) };
  });
  const contentIds = new Map(documents.map((document) => [`${document.api}:${document.source.wpId}`, document.contentId]));
  const resolved: LegacyDocument["relations"] = [];
  const unresolved: ParseResult["relations"]["unresolved"] = [];
  for (const document of documents) for (const relation of document.relations) {
    const target = contentIds.get(`${relation.toApi}:${relation.targetWpId}`);
    if (target) { relation.targetContentId = target; resolved.push(relation); }
    else {
      const reason = exp.items.some((item) => item.wpId === relation.targetWpId) ? "targetExcluded" : "targetMissing";
      unresolved.push({ ...relation, reason });
      warnings.push({ code: "unresolvedRelation", wpId: document.source.wpId, api: document.api, message: `${relation.fieldId}: wpId=${relation.targetWpId} を解決できません (${reason})`, details: { targetWpId: relation.targetWpId, reason } });
    }
  }
  // Relation target IDs are part of the emitted payload, so recalculate after the second pass.
  for (const document of documents) {
    const { payloadChecksum: _checksum, ...payload } = document;
    document.payloadChecksum = checksum(payload);
  }
  return { documents, routes, attachments, relations: { resolved, unresolved }, excluded, validation: { errors, warnings: aggregateInternalLinkWarnings(warnings) } };
}

export async function writeParseResult(result: ParseResult, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await Promise.all([
    writeFile(join(outDir, "documents.ndjson"), ndjson(result.documents)),
    writeFile(join(outDir, "routes.json"), `${JSON.stringify(result.routes, null, 2)}\n`),
    writeFile(join(outDir, "attachments.ndjson"), ndjson(result.attachments)),
    writeFile(join(outDir, "relations.json"), `${JSON.stringify(result.relations, null, 2)}\n`),
    writeFile(join(outDir, "excluded.ndjson"), ndjson(result.excluded)),
    writeFile(join(outDir, "validation-report.json"), `${JSON.stringify(result.validation, null, 2)}\n`),
    writeFile(join(outDir, "validation-report.md"), validationMarkdown(result.validation)),
  ]);
}

export async function loadMigrationConfig(configPath: string): Promise<{ config: MigrationConfig; configPath: string }> {
  const absolute = resolve(configPath);
  const module = await import(pathToFileURL(absolute).href) as { default?: MigrationConfig };
  if (!module.default) throw new Error(`${configPath}: default export の MigrationConfig が必要です`);
  return { config: defineMigration(module.default), configPath: absolute };
}

export async function parseConfigFile(configPath: string, outDir: string): Promise<ParseResult> {
  const loaded = await loadMigrationConfig(configPath);
  const wxrPath = resolve(dirname(loaded.configPath), loaded.config.wxr);
  const result = parseMigration(loaded.config, await readFile(wxrPath, "utf8"));
  await writeParseResult(result, outDir);
  return result;
}
