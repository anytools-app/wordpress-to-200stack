import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { parseHTML } from "linkedom";

import {
  artifactBinding,
  hashTree,
  sameArtifactBinding,
  sameSourceRevision,
  sourceRevision,
  verifyBuildArtifact,
} from "./build-artifact.mjs";

const TRACKED_ATTRIBUTES = new Set(["alt", "title", "placeholder", "value", "role", "hidden"]);
const DECISION_STATUSES = new Set(["accepted", "pending", "draft", "rejected"]);
const DECISION_SEVERITIES = new Set(["Major", "Minor", "Info"]);
const ROUTE_LEDGER_EXPECTED_TYPES = new Set(["output", "redirect"]);

export function parseDocument(html) {
  return parseHTML(html).document;
}

function displayPath(value) {
  return value.split(sep).join("/");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function normalizeRoute(value, origin = "https://example.invalid") {
  let pathname = value || "/";
  try {
    pathname = new URL(value, origin).pathname;
  } catch {
    pathname = String(value).split(/[?#]/, 1)[0];
  }
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Keep malformed legacy escapes observable rather than silently rewriting them.
  }
  const absolute = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return absolute === "/" ? "/" : `/${absolute.replace(/^\/+|\/+$/g, "")}/`;
}

export function normalizeUrlIntent(value, origin = "https://example.invalid") {
  const url = normalUrl(value, origin);
  if (!url) return normalizeRoute(value, origin);
  return `${normalizeRoute(url.pathname, origin)}${url.search}${url.hash}`;
}

function urlIntentRecord(value, origin) {
  const url = normalUrl(value, origin);
  return {
    route: normalizeRoute(value, origin),
    intent: normalizeUrlIntent(value, origin),
    query: url?.search ?? "",
    fragment: url?.hash ?? "",
  };
}

export function normalizeUnicodeWhitespace(value = "") {
  return String(value).replace(/[\p{White_Space}\u200b]+/gu, " ").trim();
}

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function observationHash(observation) {
  const comparable = { ...observation };
  delete comparable.observationHash;
  delete comparable.decision;
  return createHash("sha256").update(JSON.stringify(stableValue(comparable))).digest("hex");
}

function addObservation(observations, observation) {
  observations.push({ ...observation, observationHash: observationHash(observation) });
}

function ignoredContentElement(element) {
  return ["script", "style", "template", "noscript"].includes(element?.localName?.toLowerCase());
}

export function textSurface(root) {
  const rawParts = [];
  const lexemes = [];
  const structural = [];
  let lineBreaks = 0;
  const visit = (node) => {
    if (node.nodeType === 3) {
      const raw = node.data ?? "";
      rawParts.push(raw);
      const pieces = raw.match(/[^\p{White_Space}\u200b]+/gu) ?? [];
      lexemes.push(...pieces);
      structural.push(...pieces);
      return;
    }
    if (
      node.nodeType !== 1 ||
      ignoredContentElement(node) ||
      node.hasAttribute("hidden") ||
      node.getAttribute("aria-hidden")?.toLowerCase() === "true"
    ) return;
    if (node.localName?.toLowerCase() === "br") {
      rawParts.push("\n");
      structural.push("<br>");
      lineBreaks += 1;
      return;
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  const raw = rawParts.join("");
  return {
    raw,
    normalized: normalizeUnicodeWhitespace(raw),
    lexemes,
    structural,
    lineBreaks,
  };
}

export function classifyTextDifference(archiveText, builtText) {
  const sameLexemes = JSON.stringify(archiveText.lexemes) === JSON.stringify(builtText.lexemes);
  const sameStructure = JSON.stringify(archiveText.structural) === JSON.stringify(builtText.structural);
  if (sameLexemes && !sameStructure) return { code: "line-break-delta", severity: "Minor" };
  if (sameLexemes) return { code: "whitespace-only-delta", severity: "Info" };
  const archiveSorted = [...archiveText.lexemes].sort();
  const builtSorted = [...builtText.lexemes].sort();
  if (JSON.stringify(archiveSorted) === JSON.stringify(builtSorted)) {
    return { code: "text-order-delta", severity: "Major" };
  }
  return { code: "substantive-text-delta", severity: "Major" };
}

function normalUrl(value, origin = "https://example.invalid") {
  try {
    return new URL(value, origin);
  } catch {
    return undefined;
  }
}

export function normalizeRedirectDestination(value, origin = "https://example.invalid") {
  const destination = normalUrl(value, origin);
  if (!destination) return String(value);
  const raw = String(value);
  const queryMarker = raw.indexOf("?");
  const fragmentMarker = raw.indexOf("#");
  const explicitEmptyQuery = queryMarker >= 0 && (fragmentMarker < 0 || queryMarker < fragmentMarker) && destination.search === "";
  const explicitEmptyFragment = fragmentMarker >= 0 && destination.hash === "";
  const suffix = `${destination.search}${explicitEmptyQuery ? "?" : ""}${destination.hash}${explicitEmptyFragment ? "#" : ""}`;
  const sourceOrigin = normalUrl(origin)?.origin;
  return destination.origin === sourceOrigin
    ? `${normalizeRoute(destination.pathname, origin)}${suffix}`
    : `${destination.origin}${destination.pathname}${suffix}`;
}

function pathKey(value, origin) {
  return normalUrl(value, origin)?.pathname ?? String(value);
}

function exactUrlKey(value, origin) {
  const url = normalUrl(value, origin);
  return url ? `${url.hostname.toLowerCase()}${url.pathname}` : String(value);
}

function mediaEntries(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const candidate = raw.entries && typeof raw.entries === "object" && !Array.isArray(raw.entries)
    ? raw.entries
    : raw;
  return Object.entries(candidate);
}

export function buildMediaIdentity(mediaMap = {}, mediaManifest = {}, origin = "https://example.invalid") {
  const direct = new Map();
  const reverse = new Map();
  const ambiguous = [];
  const register = (sourceValue, targetValue) => {
    if (typeof sourceValue !== "string" || typeof targetValue !== "string" || !targetValue) return;
    const sourcePath = pathKey(sourceValue, origin);
    const targetPath = pathKey(targetValue, origin);
    direct.set(exactUrlKey(sourceValue, origin), sourcePath);
    direct.set(sourcePath, sourcePath);
    const previous = reverse.get(targetPath);
    if (previous && previous !== sourcePath) {
      ambiguous.push({ targetPath, sources: [previous, sourcePath].sort() });
    } else {
      reverse.set(targetPath, sourcePath);
    }
  };
  for (const [source, record] of mediaEntries(mediaMap)) {
    const target = typeof record === "string" ? record : record?.assetUrl ?? record?.local ?? record?.url;
    register(source, target);
  }
  for (const [source, record] of mediaEntries(mediaManifest)) {
    const target = typeof record === "string" ? record : record?.local ?? record?.assetUrl ?? record?.url;
    register(source, target);
  }
  if (ambiguous.length) throw new Error(`media reverse map is ambiguous: ${JSON.stringify(ambiguous.slice(0, 5))}`);
  return {
    identity(value) {
      const url = normalUrl(value, origin);
      if (!url) return `url:${String(value)}`;
      const exact = `${url.hostname.toLowerCase()}${url.pathname}`;
      const canonical = direct.get(exact) ?? direct.get(url.pathname) ?? reverse.get(url.pathname);
      return canonical ? `media:${canonical}` : `url:${url.origin}${url.pathname}`;
    },
  };
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function fullHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizedHref(value, route, origin, internalHosts, redirects) {
  if (!value) return "";
  if (value.startsWith("#")) return `${route}${value}`;
  const url = normalUrl(value, new URL(route, origin).href);
  if (!url) return value;
  if (!/^https?:$/.test(url.protocol)) return url.href;
  if (!internalHosts.has(url.hostname.toLowerCase())) return `${url.origin}${url.pathname}${url.search}${url.hash}`;
  const routeKey = normalizeRoute(url.pathname, origin);
  const target = redirects.get(`${routeKey}${url.search}${url.hash}`)
    ?? redirects.get(`${routeKey}${url.search}`)
    ?? redirects.get(routeKey);
  const normalized = typeof target === "string" ? target : target?.route;
  if (!normalized) return `${routeKey}${url.search}${url.hash}`;
  const targetUrl = normalUrl(normalized, origin);
  if (!targetUrl) return normalized;
  const targetBase = targetUrl.origin === normalUrl(origin)?.origin
    ? normalizeRoute(targetUrl.pathname, origin)
    : `${targetUrl.origin}${targetUrl.pathname}`;
  const queryMarker = normalized.indexOf("?");
  const fragmentMarker = normalized.indexOf("#");
  const hasExplicitQuery = queryMarker >= 0 && (fragmentMarker < 0 || queryMarker < fragmentMarker);
  const hasExplicitFragment = fragmentMarker >= 0;
  return `${targetBase}${hasExplicitQuery ? targetUrl.search : url.search}${hasExplicitFragment ? targetUrl.hash : url.hash}`;
}

function contextText(element) {
  const context = element.closest("a,figure,article,li,section,header,footer,nav,main") ?? element.parentElement;
  return normalizeUnicodeWhitespace(context?.textContent ?? "");
}

export function imageRecords(root, mediaIdentity, options = {}) {
  const route = options.route ?? "/";
  const origin = options.origin ?? "https://example.invalid";
  const internalHosts = options.internalHosts ?? new Set([new URL(origin).hostname.toLowerCase()]);
  const redirects = options.redirects ?? new Map();
  const occurrences = new Map();
  return [...root.querySelectorAll("img")].map((image) => {
    const rawSrc = image.getAttribute("src") ?? "";
    const parsed = normalUrl(rawSrc, origin);
    const asset = mediaIdentity.identity(rawSrc);
    const link = normalizedHref(image.closest("a[href]")?.getAttribute("href") ?? "", route, origin, internalHosts, redirects);
    const context = contextText(image);
    const picture = image.closest("picture");
    const pictureSources = picture
      ? [...picture.querySelectorAll("source")].map((source) => ({
        srcset: source.getAttribute("srcset") ?? "",
        sizes: source.getAttribute("sizes") ?? "",
        media: source.getAttribute("media") ?? "",
        type: source.getAttribute("type") ?? "",
      }))
      : [];
    const baseIdentity = `${asset}|link:${link}|context:${shortHash(context)}`;
    const occurrence = occurrences.get(baseIdentity) ?? 0;
    occurrences.set(baseIdentity, occurrence + 1);
    return {
      identity: `${baseIdentity}|occurrence:${occurrence}`,
      asset,
      occurrence,
      link,
      context,
      src: parsed ? `${parsed.origin}${parsed.pathname}` : rawSrc,
      query: parsed
        ? Object.fromEntries([...parsed.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right)))
        : {},
      attributes: trackedAttributes(image),
      width: image.getAttribute("width") ?? "",
      height: image.getAttribute("height") ?? "",
      srcset: image.getAttribute("srcset") ?? "",
      sizes: image.getAttribute("sizes") ?? "",
      loading: image.getAttribute("loading") ?? "",
      pictureSources,
    };
  });
}

function multiset(values) {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function multisetDelta(left, right) {
  const before = multiset(left);
  const after = multiset(right);
  const missing = [];
  const added = [];
  for (const [value, count] of before) {
    if (count > (after.get(value) ?? 0)) missing.push({ value, count: count - (after.get(value) ?? 0) });
  }
  for (const [value, count] of after) {
    if (count > (before.get(value) ?? 0)) added.push({ value, count: count - (before.get(value) ?? 0) });
  }
  return { missing, added };
}

function semanticCounts(root) {
  return Object.fromEntries(
    ["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "blockquote", "table", "form"]
      .map((tag) => [tag, root.querySelectorAll(tag).length]),
  );
}

function linkRecords(root, route, origin, internalHosts, redirects) {
  return [...root.querySelectorAll("a[href]")]
    .map((element) => ({
      href: normalizedHref(element.getAttribute("href") ?? "", route, origin, internalHosts, redirects),
      rel: (element.getAttribute("rel") ?? "").split(/\s+/).filter(Boolean).sort(),
      target: element.getAttribute("target") === "_self" ? "" : element.getAttribute("target") ?? "",
      text: normalizeUnicodeWhitespace(element.textContent ?? ""),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function ctaSummary(root) {
  const hrefs = [...root.querySelectorAll("a[href]")].map((element) => element.getAttribute("href") ?? "");
  return {
    forms: root.querySelectorAll("form").length,
    controls: root.querySelectorAll("form input,form select,form textarea,form button").length,
    tel: hrefs.filter((href) => href.startsWith("tel:")).sort(),
    mailto: hrefs.filter((href) => href.startsWith("mailto:")).sort(),
    line: hrefs.filter((href) => /(?:lin\.ee|line\.me|line\.naver)/i.test(href)).sort(),
  };
}

function canonicalJsonLd(value, parentKey = "") {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalJsonLd(item));
    return parentKey === "@graph"
      ? items.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      : items;
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalJsonLd(value[key], key)]),
  );
}

export function jsonLdRecords(document) {
  const values = [];
  const errors = [];
  const scripts = [...document.querySelectorAll("script[type]")]
    .filter((script) => script.getAttribute("type")?.trim().toLowerCase() === "application/ld+json");
  for (const [index, script] of scripts.entries()) {
    try {
      values.push(canonicalJsonLd(JSON.parse(script.textContent ?? "")));
    } catch {
      errors.push({ script: index, sourceHash: fullHash(script.textContent ?? "") });
    }
  }
  values.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return { values, errors };
}

function documentMetadata(document, origin) {
  const meta = [...document.querySelectorAll("meta[name],meta[property]")]
    .map((element) => ({
      key: element.getAttribute("name") ?? element.getAttribute("property") ?? "",
      content: element.getAttribute("content") ?? "",
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const headLinks = [...document.querySelectorAll("head link[href]")]
    .map((element) => ({
      rel: (element.getAttribute("rel") ?? "").split(/\s+/).filter(Boolean).sort(),
      href: normalUrl(element.getAttribute("href") ?? "", origin)?.href ?? element.getAttribute("href") ?? "",
      type: element.getAttribute("type") ?? "",
      sizes: element.getAttribute("sizes") ?? "",
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return { title: normalizeUnicodeWhitespace(document.title), meta, headLinks };
}

export function compareImages(archiveImages, builtImages) {
  const sourceDelta = multisetDelta(
    archiveImages.map((image) => image.asset),
    builtImages.map((image) => image.asset),
  );
  const before = new Map(archiveImages.map((image) => [image.identity, image]));
  const after = new Map(builtImages.map((image) => [image.identity, image]));
  const identityDelta = {
    missing: [...before.keys()].filter((identity) => !after.has(identity)),
    added: [...after.keys()].filter((identity) => !before.has(identity)),
  };
  const attributeDiff = [];
  const deliveryDiff = [];
  for (const [identity, left] of before) {
    const right = after.get(identity);
    if (!right) continue;
    if (JSON.stringify(stableValue(left.attributes)) !== JSON.stringify(stableValue(right.attributes))) {
      attributeDiff.push({ identity, archive: left.attributes, built: right.attributes });
    }
    const archiveDelivery = { width: left.width, height: left.height, srcset: left.srcset, sizes: left.sizes, loading: left.loading, pictureSources: left.pictureSources, query: left.query };
    const builtDelivery = { width: right.width, height: right.height, srcset: right.srcset, sizes: right.sizes, loading: right.loading, pictureSources: right.pictureSources, query: right.query };
    if (JSON.stringify(stableValue(archiveDelivery)) !== JSON.stringify(stableValue(builtDelivery))) {
      deliveryDiff.push({ identity, archive: archiveDelivery, built: builtDelivery });
    }
  }
  return { sourceDelta, identityDelta, attributeDiff, deliveryDiff };
}

export function trackedAttributes(element) {
  const result = {};
  for (const attribute of [...element.attributes].sort((left, right) => left.name.localeCompare(right.name))) {
    const name = attribute.name.toLowerCase();
    if (TRACKED_ATTRIBUTES.has(name) || name.startsWith("aria-")) {
      result[name] = name === "hidden" ? true : attribute.value;
    }
  }
  if (element.localName?.toLowerCase() === "img" && !("alt" in result)) result.alt = null;
  return result;
}

function cssIdentity(element) {
  const segments = [];
  let current = element;
  while (current && current.nodeType === 1 && current.localName?.toLowerCase() !== "body") {
    const tag = current.localName?.toLowerCase() ?? "element";
    const siblings = current.parentElement
      ? [...current.parentElement.children].filter((sibling) => sibling.localName === current.localName)
      : [current];
    segments.push(`${tag}:${Math.max(0, siblings.indexOf(current))}`);
    current = current.parentElement;
  }
  return segments.reverse().join("/");
}

export function attributeRecords(root, options = {}) {
  const imageIdentityByElement = new Map();
  if (options.mediaIdentity) {
    const images = [...root.querySelectorAll("img")];
    const records = imageRecords(root, options.mediaIdentity, options);
    for (const [index, image] of images.entries()) imageIdentityByElement.set(image, records[index]?.identity);
  }
  const occurrences = new Map();
  const records = [];
  const elements = root.nodeType === 1 ? [root, ...root.querySelectorAll("*")] : [...root.querySelectorAll("*")];
  for (const element of elements) {
    if (ignoredContentElement(element)) continue;
    const attributes = trackedAttributes(element);
    if (Object.keys(attributes).length === 0) continue;
    const tag = element.localName?.toLowerCase() ?? "element";
    if (tag === "img") continue; // The media/context identity lane owns every image attribute.
    const anchor = imageIdentityByElement.get(element)
      ?? (element.getAttribute("id") ? `id:${element.getAttribute("id")}` : "")
      ?? "";
    const semanticAnchor = anchor || (element.getAttribute("name")
      ? `name:${element.getAttribute("name")}|type:${element.getAttribute("type") ?? ""}`
      : element.getAttribute("href")
        ? `href:${normalizedHref(element.getAttribute("href"), options.route ?? "/", options.origin ?? "https://example.invalid", options.internalHosts ?? new Set(), options.redirects ?? new Map())}|context:${shortHash(contextText(element))}`
        : element.getAttribute("for")
          ? `for:${element.getAttribute("for")}`
          : `path:${cssIdentity(element)}|context:${shortHash(contextText(element))}`);
    const baseIdentity = `${tag}|${semanticAnchor}`;
    const occurrence = occurrences.get(baseIdentity) ?? 0;
    occurrences.set(baseIdentity, occurrence + 1);
    records.push({ identity: `${baseIdentity}|occurrence:${occurrence}`, tag, attributes, context: contextText(element) });
  }
  return records;
}

export function compareAttributes(archiveRecords, builtRecords) {
  const before = new Map(archiveRecords.map((record) => [record.identity, record]));
  const after = new Map(builtRecords.map((record) => [record.identity, record]));
  const missing = [...before.keys()].filter((identity) => !after.has(identity));
  const added = [...after.keys()].filter((identity) => !before.has(identity));
  const differences = [];
  for (const [identity, left] of before) {
    const right = after.get(identity);
    if (!right) continue;
    if (JSON.stringify(stableValue(left.attributes)) !== JSON.stringify(stableValue(right.attributes))) {
      differences.push({ identity, archive: left.attributes, built: right.attributes });
    }
  }
  return { missing, added, differences };
}

const ARIA_IDREF_ATTRIBUTES = [
  "aria-labelledby",
  "aria-describedby",
  "aria-controls",
  "aria-owns",
  "aria-activedescendant",
  "aria-details",
  "aria-errormessage",
  "aria-flowto",
];

function interactiveRecords(root, options) {
  const occurrences = new Map();
  const idRefSelectors = ARIA_IDREF_ATTRIBUTES.map((attribute) => `[${attribute}]`).join(",");
  return [...root.querySelectorAll(`a[href],button,input:not([type="hidden"]),select,textarea,iframe,[role],${idRefSelectors}`)].map((element) => {
    const tag = element.localName?.toLowerCase() ?? "element";
    const anchor = element.getAttribute("id")
      ? `id:${element.getAttribute("id")}`
      : element.getAttribute("name")
        ? `name:${element.getAttribute("name")}|type:${element.getAttribute("type") ?? ""}`
        : element.getAttribute("href")
          ? `href:${normalizedHref(element.getAttribute("href"), options.route, options.origin, options.internalHosts, options.redirects)}|context:${shortHash(contextText(element))}`
          : `path:${cssIdentity(element)}|context:${shortHash(contextText(element))}`;
    const base = `${tag}|${anchor}`;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return { identity: `${base}|occurrence:${occurrence}`, element };
  });
}

function accessibleName(element) {
  const labelledBy = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
  const labelledText = labelledBy.map((id) => element.ownerDocument?.getElementById(id)?.textContent ?? "").join(" ");
  return [
    element.getAttribute("aria-label"),
    labelledText,
    element.textContent,
    element.querySelector("img")?.getAttribute("alt"),
    element.getAttribute("alt"),
    element.getAttribute("value"),
    element.getAttribute("title"),
  ].map((value) => normalizeUnicodeWhitespace(value ?? "")).find(Boolean) ?? "";
}

function hasFormLabel(element) {
  if (element.getAttribute("aria-label") || element.getAttribute("aria-labelledby") || element.closest("label")) return true;
  const id = element.getAttribute("id");
  if (!id || !element.ownerDocument) return false;
  return [...element.ownerDocument.querySelectorAll("label[for]")]
    .some((label) => label.getAttribute("for") === id);
}

export function newUiA11yFailures(archiveRoot, builtRoot, options) {
  const archive = new Set(interactiveRecords(archiveRoot, options).map((record) => record.identity));
  const failures = [];
  for (const record of interactiveRecords(builtRoot, options)) {
    if (archive.has(record.identity)) continue;
    const element = record.element;
    const tag = element.localName?.toLowerCase();
    const role = element.getAttribute("role");
    const inputType = tag === "input" ? (element.getAttribute("type") ?? "text").toLowerCase() : "";
    const buttonLikeInput = tag === "input" && ["button", "submit", "reset", "image"].includes(inputType);
    if ((tag === "a" || tag === "button" || buttonLikeInput || role === "button" || role === "link") && !accessibleName(element)) {
      failures.push({ identity: record.identity, rule: "interactive-accessible-name" });
    }
    if (((tag === "input" && !buttonLikeInput) || tag === "select" || tag === "textarea") && !hasFormLabel(element)) {
      failures.push({ identity: record.identity, rule: "form-control-label" });
    }
    if (tag === "iframe" && !element.getAttribute("title")) failures.push({ identity: record.identity, rule: "iframe-title" });
    for (const attribute of ARIA_IDREF_ATTRIBUTES) {
      const referencedIds = (element.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean);
      const missingIds = referencedIds.filter((id) => !element.ownerDocument?.getElementById(id));
      if (missingIds.length) failures.push({ identity: record.identity, rule: `${attribute}-target`, missingIds });
    }
  }
  return failures;
}

export function cloneWithExcludes(root, excludes = []) {
  const clone = root.cloneNode(true);
  for (const exclude of excludes) for (const node of clone.querySelectorAll(exclude)) node.remove();
  return clone;
}

function selectOne(document, selector, excludes = []) {
  const matches = document.querySelectorAll(selector);
  if (matches.length !== 1) throw new Error(`selector ${selector} must match exactly one element (actual=${matches.length})`);
  return cloneWithExcludes(matches[0], excludes);
}

export function selectSurface(document, selector, excludes = []) {
  return selectOne(document, selector, excludes);
}

function routeLedgerEntries(routeLedger) {
  if (Array.isArray(routeLedger)) return routeLedger;
  return Array.isArray(routeLedger?.routes) ? routeLedger.routes : [];
}

function routeLedgerInvalidObservations(routeLedger) {
  const observations = [];
  const entries = routeLedgerEntries(routeLedger);
  if (!Array.isArray(routeLedger) && !Array.isArray(routeLedger?.routes)) {
    observations.push({ code: "route-ledger-invalid", severity: "Blocking", scope: "route-ledger", reason: "route ledger must be an array or an object with routes array" });
    return observations;
  }
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      observations.push({ code: "route-ledger-invalid", severity: "Blocking", scope: "route-ledger", entryIndex: index, reason: "route entry must be an object" });
      return;
    }
    const routeValue = entry.path ?? entry.url;
    const route = typeof routeValue === "string" ? normalizeRoute(routeValue) : undefined;
    if (typeof routeValue !== "string") {
      observations.push({ code: "route-ledger-invalid", severity: "Blocking", scope: "route-ledger", entryIndex: index, reason: "route entry requires string path or url" });
    }
    if (entry.expected === undefined) return;
    if (!entry.expected || typeof entry.expected !== "object" || Array.isArray(entry.expected)) {
      observations.push({ code: "route-ledger-invalid", severity: "Blocking", scope: "route-ledger", entryIndex: index, route, reason: "expected must be an object when present" });
      return;
    }
    if (entry.expected.type !== undefined && !ROUTE_LEDGER_EXPECTED_TYPES.has(entry.expected.type)) {
      observations.push({ code: "route-ledger-invalid", severity: "Blocking", scope: "route-ledger", entryIndex: index, route, expectedType: entry.expected.type, reason: "expected.type must be output or redirect" });
    }
  });
  return observations;
}

function ledgerExpectedType(entry) {
  const type = entry?.expected?.type;
  return ROUTE_LEDGER_EXPECTED_TYPES.has(type) ? type : "output";
}

function stableCompare(left, right) {
  const leftText = JSON.stringify(stableValue(left));
  const rightText = JSON.stringify(stableValue(right));
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function inventoryIntentRecords(inventory, origin) {
  return inventory
    .filter((entry) => entry && typeof entry.url === "string")
    .map((entry) => ({ ...urlIntentRecord(entry.url, origin), entry }));
}

function ledgerIntentRecords(routeLedger, origin) {
  return routeLedgerEntries(routeLedger)
    .filter((entry) => entry && typeof (entry.path ?? entry.url) === "string")
    .map((entry) => ({ ...urlIntentRecord(entry.path ?? entry.url, origin), entry }));
}

function intentRecordsByRoute(records) {
  const result = new Map();
  for (const record of records) result.set(record.route, [...(result.get(record.route) ?? []), record]);
  return result;
}

function representativeIntentRecord(records, kind) {
  return [...records].sort((left, right) => {
    const baseDifference = Number(right.intent === right.route) - Number(left.intent === left.route);
    if (baseDifference) return baseDifference;
    if (kind === "inventory") {
      const statusDifference = Number(right.entry.status === 200) - Number(left.entry.status === 200);
      if (statusDifference) return statusDifference;
    } else {
      const outputDifference = Number(ledgerExpectedType(right.entry) === "output") - Number(ledgerExpectedType(left.entry) === "output");
      if (outputDifference) return outputDifference;
    }
    return left.intent === right.intent ? stableCompare(left.entry, right.entry) : left.intent < right.intent ? -1 : 1;
  })[0];
}

function uniqueStable(values) {
  const byValue = new Map();
  for (const value of values) byValue.set(JSON.stringify(stableValue(value)), stableValue(value));
  return [...byValue.values()].sort(stableCompare);
}

function urlIntentVariantObservation(route, inventoryRecords, ledgerRecords) {
  const byIntent = new Map();
  for (const record of [...inventoryRecords, ...ledgerRecords]) {
    if (!byIntent.has(record.intent)) byIntent.set(record.intent, { intent: record.intent, query: record.query, fragment: record.fragment, inventoryStatuses: [], ledgerArchiveStatuses: [], expected: [] });
    const variant = byIntent.get(record.intent);
    if (inventoryRecords.includes(record)) variant.inventoryStatuses.push(record.entry.status ?? null);
    else {
      variant.ledgerArchiveStatuses.push(record.entry.archiveStatus ?? null);
      variant.expected.push(record.entry.expected ?? null);
    }
  }
  const variants = [...byIntent.values()].map((variant) => ({
    ...variant,
    inventoryStatuses: uniqueStable(variant.inventoryStatuses),
    ledgerArchiveStatuses: uniqueStable(variant.ledgerArchiveStatuses),
    expected: uniqueStable(variant.expected),
  })).sort((left, right) => left.intent < right.intent ? -1 : left.intent > right.intent ? 1 : stableCompare(left, right));
  const hasConflictingFields = variants.some((variant) => {
    const statuses = uniqueStable([...variant.inventoryStatuses, ...variant.ledgerArchiveStatuses].filter((status) => status !== null));
    return statuses.length > 1 || variant.expected.length > 1;
  });
  if (variants.length <= 1 && !hasConflictingFields) return null;
  return { code: "url-intent-variants", severity: "Major", route, variants };
}

export function redirectMap(routeLedger, origin = "https://example.invalid") {
  const byIntent = new Map();
  for (const record of ledgerIntentRecords(routeLedger, origin).filter((record) => record.entry?.expected?.type === "redirect" && typeof record.entry.expected.destination === "string")) {
    byIntent.set(record.intent, [...(byIntent.get(record.intent) ?? []), record]);
  }
  return new Map([...byIntent.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([intent, records]) => {
    const selected = representativeIntentRecord(records, "ledger");
    return [intent, normalizeRedirectDestination(selected.entry.expected.destination, origin)];
  }));
}

function surfaceRulesFor(route, config) {
  return (config.surfaceRules ?? []).filter((rule) => {
    try {
      return new RegExp(rule.route ?? ".*").test(route);
    } catch {
      return false;
    }
  });
}

function compareLane({ observations, route, scope, archiveRoot, builtRoot, mediaIdentity, origin, internalHosts, redirects }) {
  const archiveText = textSurface(archiveRoot);
  const builtText = textSurface(builtRoot);
  if (archiveText.raw !== builtText.raw) {
    addObservation(observations, {
      ...classifyTextDifference(archiveText, builtText),
      route,
      scope,
      archiveSample: archiveText.normalized.slice(0, 240),
      builtSample: builtText.normalized.slice(0, 240),
      archiveTextHash: fullHash(archiveText.raw),
      builtTextHash: fullHash(builtText.raw),
      archiveLexemes: archiveText.lexemes.length,
      builtLexemes: builtText.lexemes.length,
      archiveLineBreaks: archiveText.lineBreaks,
      builtLineBreaks: builtText.lineBreaks,
    });
  }
  const identityOptions = { route, origin, internalHosts, redirects, mediaIdentity };
  const archiveImages = imageRecords(archiveRoot, mediaIdentity, identityOptions);
  const builtImages = imageRecords(builtRoot, mediaIdentity, identityOptions);
  const images = compareImages(archiveImages, builtImages);
  if (images.sourceDelta.missing.length || images.sourceDelta.added.length) {
    addObservation(observations, { code: "image-source-delta", severity: "Major", route, scope, ...images.sourceDelta });
  }
  if (images.identityDelta.missing.length || images.identityDelta.added.length) {
    addObservation(observations, { code: "image-identity-delta", severity: "Major", route, scope, missing: images.identityDelta.missing, added: images.identityDelta.added });
    const newImagesWithoutAlt = builtImages.filter((image) => images.identityDelta.added.includes(image.identity) && image.attributes.alt === null);
    if (newImagesWithoutAlt.length) addObservation(observations, { code: "new-ui-a11y-violation", severity: "Major", route, scope, failures: newImagesWithoutAlt.map((image) => ({ identity: image.identity, rule: "image-alt-attribute" })) });
  }
  if (images.attributeDiff.length) {
    addObservation(observations, { code: "image-content-attribute-delta", severity: "Major", route, scope, differences: images.attributeDiff });
  }
  if (images.deliveryDiff.length) {
    addObservation(observations, { code: "image-delivery-delta", severity: "Info", route, scope, differences: images.deliveryDiff });
  }
  const attributes = compareAttributes(
    attributeRecords(archiveRoot, identityOptions),
    attributeRecords(builtRoot, identityOptions),
  );
  if (attributes.missing.length || attributes.added.length) {
    addObservation(observations, { code: "attribute-element-identity-delta", severity: "Major", route, scope, missing: attributes.missing, added: attributes.added });
  }
  if (attributes.differences.length) {
    addObservation(observations, { code: "element-attribute-delta", severity: "Major", route, scope, differences: attributes.differences });
  }
  const a11yFailures = newUiA11yFailures(archiveRoot, builtRoot, identityOptions);
  if (a11yFailures.length) addObservation(observations, { code: "new-ui-a11y-violation", severity: "Major", route, scope, failures: a11yFailures });
  const archiveSemantic = semanticCounts(archiveRoot);
  const builtSemantic = semanticCounts(builtRoot);
  if (JSON.stringify(archiveSemantic) !== JSON.stringify(builtSemantic)) {
    addObservation(observations, { code: "semantic-structure-delta", severity: "Minor", route, scope, archive: archiveSemantic, built: builtSemantic });
  }
  const archiveLinks = linkRecords(archiveRoot, route, origin, internalHosts, redirects);
  const builtLinks = linkRecords(builtRoot, route, origin, internalHosts, redirects);
  if (JSON.stringify(archiveLinks) !== JSON.stringify(builtLinks)) {
    addObservation(observations, { code: "link-delta", severity: "Minor", route, scope, archive: archiveLinks, built: builtLinks });
  }
  const archiveCta = ctaSummary(archiveRoot);
  const builtCta = ctaSummary(builtRoot);
  if (JSON.stringify(archiveCta) !== JSON.stringify(builtCta)) {
    addObservation(observations, { code: "cta-delta", severity: "Major", route, scope, archive: archiveCta, built: builtCta });
  }
}

function decisionValidationReasons(decision) {
  const reasons = [];
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return ["decision must be an object"];
  if (!/^[a-f\d]{64}$/i.test(decision.observationHash ?? "")) reasons.push("observationHash must be SHA-256");
  if (!(typeof decision.route === "string" || decision.route === null)) reasons.push("route must be string or null");
  if (typeof decision.code !== "string" || !decision.code.trim()) reasons.push("code is required");
  if (!DECISION_SEVERITIES.has(decision.severity)) reasons.push("severity must be Major, Minor, or Info");
  if (!DECISION_STATUSES.has(decision.status)) reasons.push("status is invalid");
  if (typeof decision.rationale !== "string" || !decision.rationale.trim()) reasons.push("rationale is required");
  if (typeof decision.by !== "string" || !decision.by.trim()) reasons.push("by is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(decision.date ?? "")) reasons.push("date must be YYYY-MM-DD");
  else {
    const timestamp = Date.parse(`${decision.date}T00:00:00.000Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== decision.date) reasons.push("date is not a real calendar date");
  }
  const allowedKeys = new Set(["observationHash", "route", "code", "severity", "status", "rationale", "by", "date"]);
  const unknownKeys = Object.keys(decision).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) reasons.push(`unknown fields: ${unknownKeys.join(", ")}`);
  return reasons;
}

export function adjudicateDecisions(observations, ledger, options = {}) {
  if (!ledger || typeof ledger !== "object" || !Array.isArray(ledger.decisions)) {
    return { observations, failures: [{ code: "decision-invalid", severity: "Blocking", detail: "decisions array is missing" }] };
  }
  const failures = [];
  if (ledger.schemaVersion !== undefined && ledger.schemaVersion !== 1) failures.push({ code: "decision-invalid", severity: "Blocking", detail: "schemaVersion must be 1" });
  const rootUnknown = Object.keys(ledger).filter((key) => !["schemaVersion", "decisions"].includes(key));
  if (rootUnknown.length) failures.push({ code: "decision-invalid", severity: "Blocking", detail: `unknown ledger fields: ${rootUnknown.join(", ")}` });
  const candidates = [];
  for (const [index, decision] of ledger.decisions.entries()) {
    const reasons = decisionValidationReasons(decision);
    if (reasons.length) {
      failures.push({ code: "decision-invalid", severity: "Blocking", decisionIndex: index, decisionHash: decision?.observationHash ?? null, reasons });
    } else {
      candidates.push({ decision, index });
    }
  }
  const byHash = new Map();
  for (const candidate of candidates) byHash.set(candidate.decision.observationHash, [...(byHash.get(candidate.decision.observationHash) ?? []), candidate]);
  const applicable = new Map();
  for (const [hash, matching] of byHash) {
    if (matching.length > 1) {
      failures.push({ code: "decision-duplicate", severity: "Blocking", decisionHash: hash, decisionIndexes: matching.map((entry) => entry.index) });
      continue;
    }
    const [{ decision, index }] = matching;
    const matched = observations.filter((observation) => observation.observationHash === hash);
    if (matched.length === 0) {
      const deferred = typeof options.deferUnused === "function"
        ? options.deferUnused(decision)
        : Boolean(options.deferUnused);
      if (!deferred) failures.push({ code: "decision-unused", severity: "Blocking", decisionIndex: index, decisionHash: hash });
      continue;
    }
    if (matched.length !== 1) {
      failures.push({ code: "decision-mismatch", severity: "Blocking", decisionIndex: index, decisionHash: hash, detail: `hash matched ${matched.length} observations` });
      continue;
    }
    const [observation] = matched;
    const actual = { route: observation.route ?? null, code: observation.code, severity: observation.severity };
    const expected = { route: decision.route, code: decision.code, severity: decision.severity };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push({ code: "decision-mismatch", severity: "Blocking", decisionIndex: index, decisionHash: hash, expected, actual });
      continue;
    }
    if (decision.status === "accepted" && observation.severity !== "Blocking") applicable.set(hash, decision);
  }
  return {
    observations: observations.map((observation) => {
      const decision = applicable.get(observation.observationHash);
      return decision ? { ...observation, decision } : observation;
    }),
    failures,
  };
}

export function applyDecisions(observations, decisions) {
  return adjudicateDecisions(observations, decisions).observations;
}

export function archiveNon200BuiltOutputObservations(routeLedger, builtRoutes, origin = "https://example.invalid", inventory = []) {
  const built = builtRoutes instanceof Set ? builtRoutes : new Set(builtRoutes);
  const inventoryRecords = inventoryIntentRecords(inventory, origin);
  const ledgerRecords = ledgerIntentRecords(routeLedger, origin);
  const ledgerByIntent = new Map();
  for (const record of ledgerRecords) ledgerByIntent.set(record.intent, [...(ledgerByIntent.get(record.intent) ?? []), record]);
  const candidates = [];
  for (const record of inventoryRecords) {
    const ledgerRecord = representativeIntentRecord(ledgerByIntent.get(record.intent) ?? [], "ledger");
    candidates.push({
      route: record.route,
      intent: record.intent,
      query: record.query,
      fragment: record.fragment,
      archiveStatus: record.entry.status,
      expectedType: ledgerExpectedType(ledgerRecord?.entry),
      sources: ["archive-inventory", ...(ledgerRecord ? ledgerRecord.entry.sources ?? ["route-ledger"] : [])],
    });
  }
  for (const record of ledgerRecords) {
    candidates.push({
      route: record.route,
      intent: record.intent,
      query: record.query,
      fragment: record.fragment,
      archiveStatus: record.entry.archiveStatus,
      expectedType: ledgerExpectedType(record.entry),
      sources: record.entry.sources ?? ["route-ledger"],
    });
  }
  const unique = new Map();
  for (const candidate of candidates) {
    const key = JSON.stringify(stableValue({ ...candidate, sources: undefined }));
    const previous = unique.get(key);
    unique.set(key, { ...candidate, sources: [...new Set([...(previous?.sources ?? []), ...candidate.sources])].sort() });
  }
  return [...unique.values()]
    .filter((entry) => entry.expectedType === "output" && typeof entry.archiveStatus === "number" && entry.archiveStatus !== 200 && built.has(entry.route))
    .sort((left, right) => stableCompare(left, right))
    .map((entry) => ({ code: "archive-non-200-built-output", severity: "Major", ...entry, builtOutput: true }));
}

async function htmlFiles(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await htmlFiles(path, files);
    else if (entry.isFile() && entry.name === "index.html") files.push(path);
    else if (!entry.isFile()) throw new Error(`unsupported filesystem entry in build output: ${displayPath(path)}`);
  }
  return files;
}

async function outputDocuments(outDirectory, origin) {
  const result = new Map();
  for (const file of await htmlFiles(outDirectory)) {
    const directory = displayPath(relative(outDirectory, resolve(file, "..")));
    const route = normalizeRoute(directory ? `/${directory}` : "/", origin);
    result.set(route, { file, document: parseHTML(await readFile(file, "utf8")).document });
  }
  return result;
}

async function readJsonEvidence(path) {
  const source = await readFile(path);
  return {
    value: JSON.parse(source.toString("utf8")),
    digest: createHash("sha256").update(source).digest("hex"),
  };
}

function archivePathnames(route, inventoryEntry, ledgerEntry, origin) {
  const candidates = [];
  for (const value of [inventoryEntry?.url, ledgerEntry?.path, ledgerEntry?.url, route]) {
    if (typeof value !== "string") continue;
    const pathname = normalUrl(value, origin)?.pathname ?? String(value).split(/[?#]/, 1)[0];
    if (!candidates.includes(pathname)) candidates.push(pathname);
  }
  return candidates;
}

async function archiveFilePath(archiveDirectory, route, inventoryEntry, ledgerEntry, origin, filename) {
  const candidates = archivePathnames(route, inventoryEntry, ledgerEntry, origin)
    .map((pathname) => resolve(archiveDirectory, "pages", encodeURIComponent(pathname), filename));
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return candidates.at(-1) ?? resolve(archiveDirectory, "pages", encodeURIComponent(route), filename);
}

async function archiveRedirectObservation({ archiveDirectory, route, inventoryEntry, ledgerEntry, origin, redirects }) {
  const metaPath = await archiveFilePath(archiveDirectory, route, inventoryEntry, ledgerEntry, origin, "meta.json");
  let metaSource;
  try {
    metaSource = await readFile(metaPath, "utf8");
  } catch {
    return {
      code: "archive-redirect-meta-missing",
      severity: "Major",
      route,
      destination: ledgerEntry?.expected?.destination,
      archiveMeta: displayPath(relative(archiveDirectory, metaPath)),
    };
  }
  let metadata;
  try {
    metadata = JSON.parse(metaSource);
  } catch {
    return { code: "archive-redirect-meta-invalid", severity: "Major", route, archiveMeta: displayPath(relative(archiveDirectory, metaPath)), sourceHash: fullHash(metaSource) };
  }
  const ledgerIntent = typeof (ledgerEntry?.path ?? ledgerEntry?.url) === "string"
    ? normalizeUrlIntent(ledgerEntry.path ?? ledgerEntry.url, origin)
    : route;
  const chain = Array.isArray(metadata?.redirects) ? metadata.redirects : [];
  if (chain.length === 0) {
    return {
      code: "archive-200-became-redirect",
      severity: "Major",
      route,
      archiveStatus: inventoryEntry?.status ?? ledgerEntry?.archiveStatus,
      destination: ledgerEntry?.expected?.destination,
      normalizedDestination: redirects.get(ledgerIntent) ?? redirects.get(route),
    };
  }
  const last = chain.at(-1);
  const first = chain[0];
  const actualStatus = Number(first?.status);
  const expectedStatus = ledgerEntry?.expected?.status;
  const actualDestination = typeof last?.to === "string" ? normalizeRedirectDestination(last.to, origin) : null;
  const expectedDestination = redirects.get(ledgerIntent) ?? redirects.get(route);
  const statusMatches = Number.isInteger(expectedStatus)
    ? actualStatus === expectedStatus
    : actualStatus >= 300 && actualStatus < 400;
  if (chain.length > 1) {
    return {
      code: "archive-redirect-chain-delta",
      severity: "Major",
      route,
      expected: { status: Number.isInteger(expectedStatus) ? expectedStatus : "3xx", destination: expectedDestination, hops: 1 },
      archive: {
        status: Number.isFinite(actualStatus) ? actualStatus : null,
        destination: actualDestination,
        hops: chain.length,
        chain: chain.map((hop) => ({
          from: typeof hop?.from === "string" ? normalizeRedirectDestination(hop.from, origin) : null,
          to: typeof hop?.to === "string" ? normalizeRedirectDestination(hop.to, origin) : null,
          status: Number.isFinite(Number(hop?.status)) ? Number(hop.status) : null,
        })),
      },
    };
  }
  if (statusMatches && actualDestination === expectedDestination) return null;
  return {
    code: "archive-redirect-mismatch",
    severity: "Major",
    route,
    expected: { status: Number.isInteger(expectedStatus) ? expectedStatus : "3xx", destination: expectedDestination },
    archive: { status: Number.isFinite(actualStatus) ? actualStatus : null, destination: actualDestination },
  };
}

async function archiveOutputRedirectObservation({ archiveDirectory, route, inventoryEntry, ledgerEntry, origin }) {
  const metaPath = await archiveFilePath(archiveDirectory, route, inventoryEntry, ledgerEntry, origin, "meta.json");
  let metaSource;
  try {
    metaSource = await readFile(metaPath, "utf8");
  } catch {
    return null;
  }
  let metadata;
  try {
    metadata = JSON.parse(metaSource);
  } catch {
    return { code: "archive-output-meta-invalid", severity: "Major", route, archiveMeta: displayPath(relative(archiveDirectory, metaPath)), sourceHash: fullHash(metaSource) };
  }
  const chain = Array.isArray(metadata?.redirects) ? metadata.redirects : [];
  if (chain.length === 0) return null;
  const first = chain[0];
  const last = chain.at(-1);
  return {
    code: "archive-redirect-became-output",
    severity: "Major",
    route,
    archive: {
      status: Number.isFinite(Number(first?.status)) ? Number(first.status) : null,
      destination: typeof last?.to === "string" ? normalizeRedirectDestination(last.to, origin) : null,
      hops: chain.length,
    },
    archiveMeta: displayPath(relative(archiveDirectory, metaPath)),
  };
}

function summarize(observations) {
  const unresolved = observations.filter((observation) => !observation.decision);
  const count = (severity) => unresolved.filter((observation) => observation.severity === severity).length;
  return {
    total: observations.length,
    accepted: observations.length - unresolved.length,
    unresolved: unresolved.length,
    blocking: count("Blocking"),
    major: count("Major"),
    minor: count("Minor"),
    info: count("Info"),
  };
}

export async function collectArchiveBuiltAudit(options) {
  const repository = resolve(options.repository);
  const archiveDirectory = resolve(options.archiveDirectory);
  const outDirectory = resolve(options.outDirectory);
  const artifactPath = resolve(options.artifactPath);
  const inventoryPath = resolve(options.inventoryPath ?? resolve(archiveDirectory, "inventory.json"));
  const routeLedgerPath = resolve(options.routeLedgerPath);
  const mediaMapPath = options.mediaMapPath ? resolve(options.mediaMapPath) : null;
  const mediaManifestPath = options.mediaManifestPath ? resolve(options.mediaManifestPath) : null;
  const decisionsPath = resolve(options.decisionsPath);
  const config = options.config ?? {};
  const origin = config.origin ?? options.origin ?? "https://example.invalid";
  const [artifactBefore, inventoryEvidence, routeLedgerEvidence, mediaMapEvidence, mediaManifestEvidence, decisionsEvidence, archiveDigest] = await Promise.all([
    verifyBuildArtifact({ outDirectory, artifactPath, repository, verifySource: options.verifySource !== false }),
    readJsonEvidence(inventoryPath),
    readJsonEvidence(routeLedgerPath),
    mediaMapPath ? readJsonEvidence(mediaMapPath) : { value: {}, digest: null },
    mediaManifestPath ? readJsonEvidence(mediaManifestPath) : { value: {}, digest: null },
    readJsonEvidence(decisionsPath),
    hashTree(archiveDirectory),
  ]);
  const inventory = inventoryEvidence.value;
  const routeLedger = routeLedgerEvidence.value;
  const mediaMap = mediaMapEvidence.value;
  const mediaManifest = mediaManifestEvidence.value;
  const decisions = decisionsEvidence.value;
  if (!Array.isArray(inventory?.urls)) throw new Error("archive inventory.urls must be an array");
  const observations = [];
  if (!artifactBefore.matches) addObservation(observations, { code: "build-artifact-mismatch", severity: "Blocking", detail: artifactBefore.reason });
  for (const observation of routeLedgerInvalidObservations(routeLedger)) addObservation(observations, observation);
  const builtDocuments = await outputDocuments(outDirectory, origin);
  const builtRoutes = new Set(builtDocuments.keys());
  const inventoryRecords = inventoryIntentRecords(inventory.urls, origin);
  const ledgerRecords = ledgerIntentRecords(routeLedger, origin);
  const inventoryByRoute = intentRecordsByRoute(inventoryRecords);
  const ledgerByRoute = intentRecordsByRoute(ledgerRecords);
  const routeUnion = new Set([...builtRoutes, ...inventoryByRoute.keys(), ...ledgerByRoute.keys()]);
  for (const observation of archiveNon200BuiltOutputObservations(routeLedger, builtRoutes, origin, inventory.urls)) addObservation(observations, observation);
  const redirects = redirectMap(routeLedger, origin);
  const internalHosts = new Set((config.internalHosts ?? []).map((host) => String(host).toLowerCase()));
  try { internalHosts.add(new URL(origin).hostname.toLowerCase()); } catch { /* Invalid origin is surfaced when links are normalized. */ }
  let mediaIdentity;
  try {
    mediaIdentity = buildMediaIdentity(mediaMap, mediaManifest, origin);
  } catch (error) {
    addObservation(observations, { code: "media-map-ambiguity", severity: "Blocking", detail: error instanceof Error ? error.message : String(error) });
    mediaIdentity = { identity: (value) => `unresolved:${value}` };
  }
  let comparedPages = 0;
  for (const route of [...routeUnion].sort()) {
    const routeInventoryRecords = inventoryByRoute.get(route) ?? [];
    const routeLedgerRecords = ledgerByRoute.get(route) ?? [];
    const variantObservation = urlIntentVariantObservation(route, routeInventoryRecords, routeLedgerRecords);
    if (variantObservation) addObservation(observations, variantObservation);
    const inventoryEntry = representativeIntentRecord(routeInventoryRecords, "inventory")?.entry;
    const ledgerEntry = representativeIntentRecord(routeLedgerRecords, "ledger")?.entry;
    const expectedType = ledgerExpectedType(ledgerEntry);
    const archiveStatus = inventoryEntry?.status ?? ledgerEntry?.archiveStatus;
    const built = builtDocuments.get(route);
    if (expectedType === "redirect") {
      const redirectObservation = await archiveRedirectObservation({ archiveDirectory, route, inventoryEntry, ledgerEntry, origin, redirects });
      if (redirectObservation) addObservation(observations, redirectObservation);
      if (built) addObservation(observations, { code: "redirect-has-built-output", severity: "Major", route });
      continue;
    }
    if ((archiveStatus === 200 || expectedType === "output") && !built) {
      addObservation(observations, { code: "built-output-missing", severity: "Blocking", route });
      continue;
    }
    if (built && routeInventoryRecords.length === 0 && routeLedgerRecords.length === 0) {
      addObservation(observations, { code: "untracked-built-output", severity: "Major", route });
      continue;
    }
    if (built && archiveStatus === undefined) {
      addObservation(observations, { code: "archive-status-missing-built-output", severity: "Major", route });
      continue;
    }
    if (!built || archiveStatus !== 200) continue;
    const outputRedirectObservation = await archiveOutputRedirectObservation({ archiveDirectory, route, inventoryEntry, ledgerEntry, origin });
    if (outputRedirectObservation) addObservation(observations, outputRedirectObservation);
    const archivePath = await archiveFilePath(archiveDirectory, route, inventoryEntry, ledgerEntry, origin, "page.html");
    if (!(await exists(archivePath))) {
      addObservation(observations, { code: "archive-page-missing", severity: "Blocking", route, archiveFile: displayPath(relative(archiveDirectory, archivePath)) });
      continue;
    }
    const archiveDocument = parseHTML(await readFile(archivePath, "utf8")).document;
    const rules = surfaceRulesFor(route, config);
    if (config.partialSurfaceSelection && rules.length === 0) continue;
    comparedPages += 1;
    try {
      compareLane({
        observations,
        route,
        scope: "document",
        archiveRoot: cloneWithExcludes(archiveDocument.body, config.excludeSelectors ?? []),
        builtRoot: cloneWithExcludes(built.document.body, config.excludeSelectors ?? []),
        mediaIdentity,
        origin,
        internalHosts,
        redirects,
      });
    } catch (error) {
      addObservation(observations, { code: "document-exclude-selector-failed", severity: "Blocking", route, detail: error instanceof Error ? error.message : String(error) });
    }
    const archiveMeta = documentMetadata(archiveDocument, origin);
    const builtMeta = documentMetadata(built.document, origin);
    if (JSON.stringify(archiveMeta) !== JSON.stringify(builtMeta)) {
      addObservation(observations, { code: "meta-delta", severity: "Major", route, scope: "document", archive: archiveMeta, built: builtMeta });
    }
    const archiveJsonLd = jsonLdRecords(archiveDocument);
    const builtJsonLd = jsonLdRecords(built.document);
    if (builtJsonLd.errors.length) {
      addObservation(observations, { code: "json-ld-built-parse-error", severity: "Blocking", route, scope: "document", archiveErrors: archiveJsonLd.errors, builtErrors: builtJsonLd.errors });
    }
    if (archiveJsonLd.errors.length) {
      addObservation(observations, { code: "json-ld-archive-parse-error", severity: "Major", route, scope: "document", archiveErrors: archiveJsonLd.errors });
    }
    if (JSON.stringify(archiveJsonLd.values) !== JSON.stringify(builtJsonLd.values)) {
      addObservation(observations, { code: "json-ld-value-delta", severity: "Major", route, scope: "document", archive: archiveJsonLd.values, built: builtJsonLd.values });
    }
    if (rules.length === 0) {
      addObservation(observations, { code: "surface-rule-missing", severity: "Blocking", route });
      continue;
    }
    for (const rule of rules) {
      try {
        const archiveRoot = selectOne(archiveDocument, rule.archive ?? rule.archiveSelector, [...(config.excludeSelectors ?? []), ...(rule.excludeSelectors ?? [])]);
        const builtRoot = selectOne(built.document, rule.built ?? rule.builtSelector, [...(config.excludeSelectors ?? []), ...(rule.excludeSelectors ?? [])]);
        compareLane({ observations, route, scope: `surface:${rule.id}`, archiveRoot, builtRoot, mediaIdentity, origin, internalHosts, redirects });
      } catch (error) {
        addObservation(observations, { code: "surface-selector-failed", severity: "Blocking", route, surface: rule.id, detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  const coverage = { routeUnion: routeUnion.size, inventoryStatus200: inventoryRecords.filter((record) => record.entry.status === 200).length, comparedPages, outputPages: builtDocuments.size };
  if (config.partialSurfaceSelection && comparedPages === 0) {
    addObservation(observations, {
      code: "partial-selection-empty",
      severity: "Blocking",
      surfaceIds: (config.surfaceRules ?? []).map((rule) => rule.id),
    });
  }
  if (!config.partialSurfaceSelection && config.expectedCoverage && typeof config.expectedCoverage === "object") {
    for (const [field, expected] of Object.entries(config.expectedCoverage)) {
      if (!Number.isInteger(expected) || coverage[field] !== expected) addObservation(observations, { code: "coverage-mismatch", severity: "Blocking", field, expected, actual: coverage[field] });
    }
  }
  if (typeof options.beforeMutationCheck === "function") await options.beforeMutationCheck();
  const artifactAfter = await verifyBuildArtifact({ outDirectory, artifactPath, repository, verifySource: options.verifySource !== false });
  if (artifactBefore.current?.hash !== artifactAfter.current?.hash || artifactBefore.current?.fileCount !== artifactAfter.current?.fileCount || artifactBefore.current?.bytes !== artifactAfter.current?.bytes) {
    addObservation(observations, { code: "build-output-mutated-during-audit", severity: "Blocking", before: artifactBefore.current, after: artifactAfter.current, detail: artifactAfter.reason });
  }
  if (!sameArtifactBinding(artifactBefore.recorded, artifactAfter.recorded)) {
    addObservation(observations, { code: "build-artifact-mutated-during-audit", severity: "Blocking", before: artifactBinding(artifactBefore.recorded), after: artifactBinding(artifactAfter.recorded) });
  }
  if (!sameSourceRevision(artifactBefore.currentSource, artifactAfter.currentSource)) {
    addObservation(observations, { code: "source-mutated-during-audit", severity: "Blocking", before: artifactBefore.currentSource, after: artifactAfter.currentSource, detail: artifactAfter.reason });
  }
  const archiveDigestAfter = await hashTree(archiveDirectory);
  if (
    archiveDigest?.hash !== archiveDigestAfter?.hash ||
    archiveDigest?.fileCount !== archiveDigestAfter?.fileCount ||
    archiveDigest?.bytes !== archiveDigestAfter?.bytes
  ) {
    addObservation(observations, { code: "archive-mutated-during-audit", severity: "Blocking", before: archiveDigest, after: archiveDigestAfter });
  }
  const adjudicated = adjudicateDecisions(observations, decisions, { deferUnused: Boolean(config.partialSurfaceSelection) });
  const finalObservations = [...adjudicated.observations];
  for (const failure of adjudicated.failures) addObservation(finalObservations, failure);
  const summary = summarize(finalObservations);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    result: summary.unresolved === 0 ? "PASS" : "FAIL",
    summary,
    coverage,
    selection: config.partialSurfaceSelection
      ? { mode: "partial", surfaceIds: (config.surfaceRules ?? []).map((rule) => rule.id) }
      : { mode: "full", surfaceIds: (config.surfaceRules ?? []).map((rule) => rule.id) },
    binding: artifactBinding(artifactAfter.recorded),
    provenance: {
      artifact: artifactBinding(artifactAfter.recorded),
      archive: archiveDigest,
      inventoryDigest: inventoryEvidence.digest,
      routeLedgerDigest: routeLedgerEvidence.digest,
      decisionsDigest: decisionsEvidence.digest,
      mediaMapDigest: mediaMapEvidence.digest,
      mediaManifestDigest: mediaManifestEvidence.digest,
      source: sourceRevision(repository),
    },
    observations: finalObservations,
  };
}

function markdownCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

/** Renders only stable adjudication data; volatile timestamps/source state stay in the JSON report. */
export function renderArchiveBuiltAudit(report) {
  const rows = report.observations.map((observation) =>
    `| ${markdownCell(observation.decision ? "accepted" : observation.severity)} | ${markdownCell(observation.route ?? "global")} | ${markdownCell(observation.scope ?? "-")} | ${markdownCell(observation.code)} | ${markdownCell(observation.observationHash)} |`,
  );
  return [
    "# Archive-built fidelity audit",
    "",
    `- Result: **${report.result}**`,
    `- Coverage: route union ${report.coverage.routeUnion}, archive 200 ${report.coverage.inventoryStatus200}, compared ${report.coverage.comparedPages}, output ${report.coverage.outputPages}`,
    `- Unresolved: Blocking ${report.summary.blocking}, Major ${report.summary.major}, Minor ${report.summary.minor}, Info ${report.summary.info}`,
    `- Accepted by exact decision: ${report.summary.accepted}`,
    "",
    "| Status | Route | Scope | Code | Observation SHA-256 |",
    "| --- | --- | --- | --- | --- |",
    ...(rows.length ? rows : ["| PASS | - | - | No observations | - |"]),
    "",
  ].join("\n");
}
