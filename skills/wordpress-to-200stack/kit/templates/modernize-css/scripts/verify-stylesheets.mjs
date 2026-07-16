import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const project = resolve(import.meta.dirname, "..");
const archivePages = join(project, "_scratch", "archive-full", "pages");
const targets = ["/page-a/1", "/items/1", "/item", "/works/1", "/", "/privacy"];
const sourcesPath = join(project, "src", "app", "legacy-generated.sources.json");

function decodeHtmlAttribute(value) {
  return value.replace(/&(amp|#0*38);/gi, "&");
}

function normalizedExternalUrl(href) {
  const decoded = decodeHtmlAttribute(href);
  return decoded.startsWith("//") ? `https:${decoded}` : decoded;
}

function attribute(tag, name) {
  const value = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return value?.[1] ?? value?.[2] ?? value?.[3];
}

function stylesheetHref(href) {
  try {
    const url = new URL(href, "https://www.example.com") /* TODO(案件): 移行元オリジン */;
    if ((url.protocol === "http:" || url.protocol === "https:") && /(^|\.)example\.com$/i.test(url.hostname)) return url.pathname;
  } catch {
    // 破損した外部URLは原文の文字列のまま照合する。
  }
  return normalizedExternalUrl(href);
}

function stylesheets(html) {
  return [...html.matchAll(/<link\b[^>]*>/gi)]
    .filter((match) => attribute(match[0], "rel")?.split(/\s+/).some((value) => value.toLowerCase() === "stylesheet"))
    .map((match) => attribute(match[0], "href"))
    .filter(Boolean)
    .map((href) => stylesheetHref(decodeHtmlAttribute(href)));
}

function archiveFile(path) {
  return join(archivePages, `${encodeURIComponent(path)}`, "page.html");
}

function outputFile(path) {
  return path === "/" ? join(project, "out", "index.html") : join(project, "out", path, "index.html");
}

const sourceManifest = JSON.parse(await readFile(sourcesPath, "utf8"));
const sourceScopes = new Map(Object.entries(sourceManifest).map(([href, scope]) => [stylesheetHref(href), scope]));

const report = await Promise.all(targets.map(async (path) => {
  const [source, output] = await Promise.all([
    readFile(archiveFile(path), "utf8"),
    readFile(outputFile(path), "utf8"),
  ]);
  const expected = stylesheets(source);
  const sourceBodyTag = source.match(/<body\b[^>]*>/i)?.[0] ?? "";
  const bodyClasses = new Set((attribute(sourceBodyTag, "class") ?? "").split(/\s+/).filter(Boolean));
  const missingSources = expected.filter((href) => !sourceScopes.has(href));
  const guardMismatches = expected.flatMap((href) => {
    const guard = sourceScopes.get(href)?.guard;
    return guard && !bodyClasses.has(guard) ? [{ href, guard }] : [];
  });
  const legacyStylesheetLinks = [...output.matchAll(/<link\b[^>]*data-legacy-stylesheet[^>]*>/gi)].length;
  return {
    path,
    sourceCount: expected.length,
    listedCount: expected.length - missingSources.length,
    missingSources,
    guardMismatches,
    legacyStylesheetLinks,
    valid: missingSources.length === 0 && guardMismatches.length === 0 && legacyStylesheetLinks === 0,
  };
}));

console.table(report.map(({ path, sourceCount, listedCount, guardMismatches, legacyStylesheetLinks, valid }) => ({
  path,
  sourceCount,
  listedCount,
  guardMismatches: guardMismatches.length,
  legacyStylesheetLinks,
  valid,
})));
for (const entry of report.filter(({ valid }) => !valid)) console.error(JSON.stringify(entry, null, 2));
if (report.some((entry) => !entry.valid)) process.exitCode = 1;
