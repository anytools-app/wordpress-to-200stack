import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";

const project = resolve(import.meta.dirname, "..");
const vendorRoot = join(project, "public", "vendor");
const legacyMetaPath = join(project, ".next-data", "legacy-meta.json");
// TODO(案件): legacy theme の外部 CSS @import を集約している CSS ファイルに変更する。
const legacyThemeBundlePath = join(project, "public", "wp-content", "themes", "YOUR_THEME", "bundle.css");
const browserUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function decodeHtmlEntities(value) {
  return value.replace(/&(amp|#0*38);/gi, "&");
}

function normalizeUrl(value, base) {
  const decoded = decodeHtmlEntities(value.trim());
  const absolute = decoded.startsWith("//") ? `https:${decoded}` : decoded;
  return new URL(absolute, base).href;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function safeSegment(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "asset";
}

function cssDirectory(url) {
  const parsed = new URL(url);
  return `${safeSegment(`${parsed.hostname}${parsed.pathname}`)}-${hash(url)}`;
}

function assetFilename(url) {
  const parsed = new URL(url);
  const name = basename(parsed.pathname) || "asset";
  const extension = extname(name);
  const stem = safeSegment(extension ? name.slice(0, -extension.length) : name);
  return `${stem}-${hash(url)}${extension}`;
}

function isFetchable(value) {
  return !/^(data:|#|blob:|about:)/i.test(value);
}

function remoteUrl(value, base) {
  if (!isFetchable(value)) return undefined;
  try {
    const url = normalizeUrl(value, base);
    return /^https?:/i.test(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

function relativeUrl(fromFile, toFile) {
  const path = relative(resolve(fromFile, ".."), toFile).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
}

const manifest = {};
const cssFiles = new Map();
const assetFiles = new Map();

async function fetchResponse(url) {
  const response = await fetch(url, { headers: { "user-agent": browserUserAgent } });
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  return response;
}

async function downloadAsset(url) {
  const existing = assetFiles.get(url);
  if (existing) return existing;
  const response = await fetchResponse(url);
  const file = join(vendorRoot, "assets", assetFilename(url));
  assetFiles.set(url, file);
  await mkdir(resolve(file, ".."), { recursive: true });
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

async function downloadCss(url) {
  const existing = cssFiles.get(url);
  if (existing) return existing;

  const file = join(vendorRoot, cssDirectory(url), "styles.css");
  cssFiles.set(url, file);
  const response = await fetchResponse(url);
  const sourceUrl = response.url || url;
  const source = await response.text();
  const rewritten = await rewriteCss(source, sourceUrl, file);
  await mkdir(resolve(file, ".."), { recursive: true });
  await writeFile(file, rewritten);
  return file;
}

async function rewriteCss(css, sourceUrl, outputFile) {
  const imports = /@import\s+(?:url\(\s*)?(["']?)([^"')\s]+)\1\s*\)?\s*([^;]*);/gi;
  let rewritten = await replaceAsync(css, imports, async (match, quote, value, media) => {
    const importedUrl = remoteUrl(value, sourceUrl);
    if (!importedUrl) return match;
    const importedFile = await downloadCss(importedUrl);
    return `@import url(${relativeUrl(outputFile, importedFile)})${media};`;
  });

  const urls = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
  rewritten = await replaceAsync(rewritten, urls, async (match, quote, value, index, input) => {
    if (/@import\s*$/i.test(input.slice(0, index))) return match;
    const assetUrl = remoteUrl(value, sourceUrl);
    if (!assetUrl) return match;
    const assetFile = await downloadAsset(assetUrl);
    return `url(${quote}${relativeUrl(outputFile, assetFile)}${quote})`;
  });
  return rewritten;
}

async function replaceAsync(value, expression, replacer) {
  const matches = [...value.matchAll(expression)];
  const replacements = await Promise.all(matches.map((match) => replacer(...match, match.index, match.input)));
  let offset = 0;
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const replacement = replacements[index];
    const start = match.index + offset;
    value = `${value.slice(0, start)}${replacement}${value.slice(start + match[0].length)}`;
    offset += replacement.length - match[0].length;
  }
  return value;
}

function bundleImports(bundle) {
  return [...bundle.matchAll(/@import\s+url\(\s*([^\s)]+)\s*\)\s*;/gi)].map((match) => decodeHtmlEntities(match[1]));
}

function replaceBundleImports(bundle, imports) {
  return bundle.replace(/@import\s+url\(\s*([^\s)]+)\s*\)\s*;/gi, (statement, value) => {
    const original = decodeHtmlEntities(value);
    const local = imports.get(original);
    return local ? `@import url(${local});` : statement;
  });
}

const legacyMeta = JSON.parse(await readFile(legacyMetaPath, "utf8"));
const bundle = await readFile(legacyThemeBundlePath, "utf8");
const stylesheetUrls = new Set(Object.values(legacyMeta.byPath).flatMap((page) => page.stylesheets ?? []).filter((href) => /^https?:|^\/\//i.test(href)));
const bundleUrls = bundleImports(bundle).filter((href) => /^https?:|^\/\//i.test(href));
const sourceUrls = [...new Set([...stylesheetUrls, ...bundleUrls])];

for (const original of sourceUrls) {
  const normalized = normalizeUrl(original);
  const file = await downloadCss(normalized);
  const local = `/${relative(join(project, "public"), file).replaceAll("\\", "/")}`;
  manifest[original] = local;
}

const bundleLocalImports = new Map(bundleUrls.map((original) => [original, manifest[original] ?? manifest[normalizeUrl(original)]]));
const rewrittenBundle = replaceBundleImports(bundle, bundleLocalImports);
if (rewrittenBundle !== bundle) await writeFile(legacyThemeBundlePath, rewrittenBundle);
await mkdir(vendorRoot, { recursive: true });
await writeFile(join(vendorRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(JSON.stringify({ stylesheets: sourceUrls.length, assets: assetFiles.size, output: "/vendor/manifest.json" }));
