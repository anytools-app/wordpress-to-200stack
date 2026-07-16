import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import nextEnv from "@next/env";
import { parseHTML } from "linkedom";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const project = process.cwd();
const outDirectory = resolve(project, process.env.SEO_OUT_DIR ?? "out");
const archiveDirectory = resolve(project, process.env.WPKIT_ARCHIVE_DIR ?? join("_scratch", "archive-full"));
const reportDirectory = resolve(project, "_scratch", "seo-audit");
const intentionalDiffsPath = resolve(project, "docs", "seo-intentional-diffs.json");
const siteUrl = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.example.com" /* TODO(案件) */);
const OG_ITEMS = ["title", "description", "url", "image", "type", "site_name", "locale"];
const ERROR_ROUTES = new Set(["/404", "/_not-found"]);

function normalizePath(value) {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // 壊れた percent encoding は比較レポートに原文のまま残す。
  }
  const withSlash = decoded.startsWith("/") ? decoded : `/${decoded}`;
  return withSlash === "/" ? withSlash : withSlash.replace(/\/+$/, "");
}

function routeFromHtmlPath(path) {
  const directory = relative(outDirectory, resolve(path, ".."));
  return directory ? normalizePath(`/${directory.split(sep).join("/")}`) : "/";
}

async function findIndexHtml(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await findIndexHtml(path)));
    else if (entry.name === "index.html") files.push(path);
  }
  return files;
}

function firstContent(document, selector, attribute = "content") {
  const element = document.querySelector(selector);
  return element ? (attribute === "text" ? element.textContent : element.getAttribute(attribute)) : undefined;
}

function collectJsonLdTypes(value, types = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) collectJsonLdTypes(entry, types);
  } else if (value && typeof value === "object") {
    const type = value["@type"];
    if (Array.isArray(type)) {
      for (const entry of type) if (typeof entry === "string") types.add(entry);
    } else if (typeof type === "string") {
      types.add(type);
    }
    for (const entry of Object.values(value)) collectJsonLdTypes(entry, types);
  }
  return types;
}

function jsonLdOf(document) {
  const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')].map((script) =>
    script.textContent.trim(),
  );
  const types = new Set();
  const parseErrors = [];
  for (const [index, script] of scripts.entries()) {
    try {
      collectJsonLdTypes(JSON.parse(script), types);
    } catch (error) {
      parseErrors.push({ index, message: error instanceof Error ? error.message : String(error), content: script });
    }
  }
  return { exists: scripts.length > 0, types: [...types].sort(), scripts, parseErrors };
}

function metadataOf(html) {
  const { document } = parseHTML(html);
  const values = {};
  const title = firstContent(document, "title", "text")?.trim();
  if (title) values.title = title;
  for (const name of ["description", "robots"]) {
    const value = firstContent(document, `meta[name="${name}"]`);
    if (value !== undefined) values[`meta:${name}`] = value;
  }
  const canonical = firstContent(document, 'link[rel="canonical"]', "href");
  if (canonical !== undefined) values.canonical = canonical;
  for (const item of OG_ITEMS) {
    const value = firstContent(document, `meta[property="og:${item}"]`);
    if (value !== undefined) values[`og:${item}`] = value;
  }
  for (const element of document.querySelectorAll('meta[name^="twitter:"]')) {
    const name = element.getAttribute("name")?.toLowerCase();
    const value = element.getAttribute("content");
    if (name && value !== null) values[name] = value;
  }
  return { values, jsonLd: jsonLdOf(document) };
}

function urlComparisonValue(value, movedTo) {
  try {
    const url = new URL(value, "https://www.example.com");
    const path = movedTo ?? normalizePath(url.pathname);
    return `${path}${url.search}${url.hash}`;
  } catch {
    return value;
  }
}

function comparable(item, value, movedTo) {
  if ((item === "canonical" || item === "og:url") && typeof value === "string") {
    return urlComparisonValue(value, movedTo);
  }
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value;
}

function absoluteOriginError(item, value) {
  if (item !== "canonical" && item !== "og:url") return undefined;
  try {
    const url = new URL(value);
    return url.origin === siteUrl.origin ? undefined : `origin は ${siteUrl.origin} である必要があります`;
  } catch {
    return "絶対 URL ではありません";
  }
}

function pathMatches(pattern, path) {
  if (pattern.endsWith("/**")) return path === pattern.slice(0, -3) || path.startsWith(`${pattern.slice(0, -3)}/`);
  return pattern === path;
}

function isIntentional(entries, difference) {
  return entries.some((entry) => pathMatches(entry.path, difference.path) && entry.item === difference.item);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function loadAliases() {
  for (const path of [
    join(project, ".next-data", "legacy-meta.json"),
    join(project, "data", "build-snapshot", "legacy-meta.json"),
  ]) {
    try {
      return (await readJson(path)).legacyPathAliases ?? {};
    } catch {
      // build:data 前でも snapshot にフォールバックする。
    }
  }
  return {};
}

async function loadArchivePages() {
  const pages = new Map();
  const directory = join(archiveDirectory, "pages");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pageDirectory = join(directory, entry.name);
    try {
      const metadata = await readJson(join(pageDirectory, "meta.json"));
      if (metadata.status !== 200) continue;
      const url = metadata.url ?? metadata.finalUrl ?? metadata.canonical;
      if (!url) continue;
      pages.set(normalizePath(new URL(url, "https://www.example.com").pathname), join(pageDirectory, "page.html"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return pages;
}

async function archiveHtml(pages, path) {
  const pagePath = pages.get(normalizePath(path));
  return pagePath ? readFile(pagePath, "utf8") : undefined;
}

function differenceCounts(differences) {
  return Object.fromEntries(
    [
      ...differences.reduce(
        (counts, difference) => counts.set(difference.item, (counts.get(difference.item) ?? 0) + 1),
        new Map(),
      ),
    ].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function sitemapLocations(xml) {
  return [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((match) => match[1].trim().replaceAll("&amp;", "&"));
}

function canonicalPath(metadata) {
  const value = metadata.values.canonical;
  if (!value) return undefined;
  try {
    return normalizePath(new URL(value, siteUrl).pathname);
  } catch {
    return undefined;
  }
}

function robotsNoindex(metadata) {
  return /\bnoindex\b/i.test(metadata.values["meta:robots"] ?? "");
}

async function findXmlFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await findXmlFiles(path)));
    else if (/sitemap.*\.xml$/i.test(entry.name)) files.push(path);
  }
  return files;
}

function markdownReport(report) {
  const lines = [
    "# SEO 原本照合レポート",
    "",
    `- 結果: **${report.status}**`,
    `- 生成日時: ${report.generatedAt}`,
    `- 出力ページ: ${report.pages.total}（原本対応 ${report.pages.withArchive} / 原本なし ${report.pages.withoutArchive}）`,
    `- 非意図差分: ${report.summary.nonIntentional}`,
    `- 意図差分: ${report.summary.intentional}`,
    `- 新規追加フィールド: ${report.summary.additions}`,
    "",
    "## 項目別 mismatch",
    "",
    "| 項目 | 全件 | 非意図 | 意図 |",
    "| --- | ---: | ---: | ---: |",
  ];
  const items = new Set([
    ...Object.keys(report.summary.mismatchesByItem),
    ...Object.keys(report.summary.nonIntentionalByItem),
    ...Object.keys(report.summary.intentionalByItem),
  ]);
  for (const item of [...items].sort()) {
    lines.push(
      `| ${item} | ${report.summary.mismatchesByItem[item] ?? 0} | ${report.summary.nonIntentionalByItem[item] ?? 0} | ${report.summary.intentionalByItem[item] ?? 0} |`,
    );
  }
  lines.push("", "## sitemap", "");
  lines.push(
    `- ルート台帳（indexable）: ${report.sitemap.expectedCount}`,
    `- sitemap URL: ${report.sitemap.actualCount}`,
    `- 不足: ${report.sitemap.missing.length}`,
    `- 余分: ${report.sitemap.extra.length}`,
    `- origin 違反: ${report.sitemap.originErrors.length}`,
    `- moved URL 違反: ${report.sitemap.movedErrors.length}`,
    `- preview: sitemap 除外=${report.sitemap.preview.excluded}, noindex=${report.sitemap.preview.noindex}`,
    `- archived: 出力ルート ${report.sitemap.archived.outputRoutes}, sitemap URL ${report.sitemap.archived.sitemapUrls}`,
    `- 原本 sitemap: ${report.sitemap.archiveSitemap.status}`,
  );
  if (report.nonIntentionalDifferences.length) {
    lines.push("", "## 非意図差分", "");
    for (const difference of report.nonIntentionalDifferences) {
      lines.push(`- \`${difference.path}\` \`${difference.item}\`: ${difference.message ?? "値が不一致"}`);
    }
  }
  if (report.intentionalDifferences.length) {
    lines.push("", "## 台帳一致の意図差分", "");
    for (const difference of report.intentionalDifferences)
      lines.push(`- \`${difference.path}\` \`${difference.item}\``);
  }
  lines.push("", "## 意図差分台帳", "");
  for (const entry of report.intentionalRegistry.entries) {
    lines.push(`- \`${entry.path}\` \`${entry.item}\`: ${entry.reason}`);
  }
  if (report.newAdditions.length) {
    lines.push("", "## 新規追加（原本にない項目）", "");
    for (const addition of report.newAdditions) lines.push(`- \`${addition.path}\` \`${addition.item}\``);
  }
  if (report.pages.missingArchive.length) {
    lines.push("", "## 対応原本なし", "", ...report.pages.missingArchive.map((path) => `- \`${path}\``));
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  if (!(await stat(outDirectory)).isDirectory()) throw new Error(`out がありません: ${outDirectory}`);
  const [htmlPaths, aliases, intentionalRegistry, archivePages] = await Promise.all([
    findIndexHtml(outDirectory),
    loadAliases(),
    readJson(intentionalDiffsPath),
    loadArchivePages(),
  ]);
  const pages = await Promise.all(
    htmlPaths.map(async (htmlPath) => {
      const path = routeFromHtmlPath(htmlPath);
      const html = await readFile(htmlPath, "utf8");
      return { path, htmlPath, metadata: metadataOf(html) };
    }),
  );
  pages.sort((left, right) => left.path.localeCompare(right.path));

  const differences = [];
  const newAdditions = [];
  const missingArchive = [];
  for (const page of pages) {
    const sourcePath = aliases[page.path] ?? page.path;
    const sourceHtml = await archiveHtml(archivePages, sourcePath);
    if (!sourceHtml) {
      missingArchive.push(page.path);
      for (const [item, actual] of Object.entries(page.metadata.values))
        newAdditions.push({ path: page.path, item, actual });
      if (page.metadata.jsonLd.exists)
        newAdditions.push({ path: page.path, item: "jsonLd", actual: page.metadata.jsonLd });
      continue;
    }
    const source = metadataOf(sourceHtml);
    for (const [item, expected] of Object.entries(source.values)) {
      const actual = page.metadata.values[item];
      const normalizedExpected = comparable(item, expected, aliases[page.path] ? page.path : undefined);
      const normalizedActual = comparable(item, actual);
      if (actual === undefined || normalizedExpected !== normalizedActual) {
        differences.push({ path: page.path, sourcePath, item, expected, actual, normalizedExpected, normalizedActual });
      }
      if (actual !== undefined) {
        const message = absoluteOriginError(item, actual);
        if (message)
          differences.push({
            path: page.path,
            sourcePath,
            item: `${item}.absoluteOrigin`,
            expected: siteUrl.origin,
            actual,
            message,
          });
      }
    }
    for (const [item, actual] of Object.entries(page.metadata.values)) {
      if (!(item in source.values)) newAdditions.push({ path: page.path, item, actual });
    }
    if (source.jsonLd.exists !== page.metadata.jsonLd.exists) {
      differences.push({
        path: page.path,
        sourcePath,
        item: "jsonLd.exists",
        expected: source.jsonLd.exists,
        actual: page.metadata.jsonLd.exists,
      });
    }
    if (JSON.stringify(source.jsonLd.types) !== JSON.stringify(page.metadata.jsonLd.types)) {
      differences.push({
        path: page.path,
        sourcePath,
        item: "jsonLd.@type",
        expected: source.jsonLd.types,
        actual: page.metadata.jsonLd.types,
        sourceContent: source.jsonLd.scripts,
        actualContent: page.metadata.jsonLd.scripts,
      });
    }
    if (source.jsonLd.parseErrors.length || page.metadata.jsonLd.parseErrors.length) {
      differences.push({
        path: page.path,
        sourcePath,
        item: "jsonLd.parse",
        expected: source.jsonLd.parseErrors,
        actual: page.metadata.jsonLd.parseErrors,
      });
    }
    if (!source.jsonLd.exists && page.metadata.jsonLd.exists) {
      newAdditions.push({ path: page.path, item: "jsonLd", actual: page.metadata.jsonLd });
    }
  }

  const sitemapXml = await readFile(join(outDirectory, "sitemap.xml"), "utf8");
  const sitemapUrls = sitemapLocations(sitemapXml);
  const sitemapPaths = new Set(sitemapUrls.map((url) => normalizePath(new URL(url, siteUrl).pathname)));
  const expectedPaths = new Set(
    pages.flatMap((page) => {
      if (ERROR_ROUTES.has(page.path) || page.path === "/preview" || robotsNoindex(page.metadata)) return [];
      const canonical = canonicalPath(page.metadata);
      return canonical && canonical !== page.path ? [] : [page.path];
    }),
  );
  const excludedRoutes = pages.flatMap((page) => {
    const reasons = [];
    if (ERROR_ROUTES.has(page.path)) reasons.push("error-route");
    if (page.path === "/preview") reasons.push("preview");
    if (robotsNoindex(page.metadata)) reasons.push("noindex");
    const canonical = canonicalPath(page.metadata);
    if (canonical && canonical !== page.path) reasons.push(`canonical:${canonical}`);
    return reasons.length ? [{ path: page.path, reasons }] : [];
  });
  const missing = [...expectedPaths].filter((path) => !sitemapPaths.has(path)).sort();
  const extra = [...sitemapPaths].filter((path) => !expectedPaths.has(path)).sort();
  const originErrors = sitemapUrls.filter((url) => {
    try {
      return new URL(url).origin !== siteUrl.origin;
    } catch {
      return true;
    }
  });
  const movedErrors = Object.entries(aliases).flatMap(([currentPath, legacyPath]) => {
    const errors = [];
    if (!sitemapPaths.has(currentPath)) errors.push(`${currentPath}: 新 URL がありません`);
    if (sitemapPaths.has(legacyPath)) errors.push(`${legacyPath}: 旧 URL が残っています`);
    return errors;
  });
  const preview = pages.find((page) => page.path === "/preview");
  const previewStatus = {
    excluded: !sitemapPaths.has("/preview"),
    noindex: Boolean(preview && robotsNoindex(preview.metadata)),
  };
  const archived = {
    outputRoutes: pages.filter((page) => page.path === "/archived" || page.path.startsWith("/archived/")).length,
    sitemapUrls: [...sitemapPaths].filter((path) => path === "/archived" || path.startsWith("/archived/")).length,
  };
  const archiveSitemapFiles = await findXmlFiles(archiveDirectory);
  let archiveSitemap;
  if (archiveSitemapFiles.length) {
    const urls = sitemapLocations(await readFile(archiveSitemapFiles[0], "utf8"));
    const paths = new Set(urls.map((url) => normalizePath(new URL(url, "https://www.example.com").pathname)));
    archiveSitemap = {
      status: "found",
      path: relative(project, archiveSitemapFiles[0]),
      urlCount: urls.length,
      missingFromNew: [...paths].filter((path) => !sitemapPaths.has(path)).sort(),
      addedInNew: [...sitemapPaths].filter((path) => !paths.has(path)).sort(),
    };
  } else {
    archiveSitemap = { status: "not-found", message: "_scratch/archive-full 内に sitemap XML はありません" };
  }
  const sitemapErrors = [
    ...missing.map((path) => ({ item: "sitemap.missing", path })),
    ...extra.map((path) => ({ item: "sitemap.extra", path })),
    ...originErrors.map((url) => ({ item: "sitemap.origin", path: new URL(url, siteUrl).pathname, actual: url })),
    ...movedErrors.map((message) => ({ item: "sitemap.moved", path: "/", message })),
    ...(!previewStatus.excluded
      ? [{ item: "sitemap.preview", path: "/preview", message: "sitemap に含まれています" }]
      : []),
    ...(!previewStatus.noindex
      ? [{ item: "preview.robots", path: "/preview", message: "noindex ではありません" }]
      : []),
    ...(archived.outputRoutes || archived.sitemapUrls
      ? [{ item: "archived.exclusion", path: "/archived", actual: archived }]
      : []),
  ];

  const intentionalDifferences = differences.filter((difference) =>
    isIntentional(intentionalRegistry.entries, difference),
  );
  const nonIntentionalDifferences = [
    ...differences.filter((difference) => !isIntentional(intentionalRegistry.entries, difference)),
    ...sitemapErrors,
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    status: nonIntentionalDifferences.length ? "FAIL" : "PASS",
    config: {
      outDirectory: relative(project, outDirectory),
      archiveDirectory: relative(project, archiveDirectory),
      siteOrigin: siteUrl.origin,
      externalFetch: false,
    },
    pages: {
      total: pages.length,
      withArchive: pages.length - missingArchive.length,
      withoutArchive: missingArchive.length,
      missingArchive,
    },
    summary: {
      mismatches: differences.length,
      nonIntentional: nonIntentionalDifferences.length,
      intentional: intentionalDifferences.length,
      additions: newAdditions.length,
      mismatchesByItem: differenceCounts(differences),
      nonIntentionalByItem: differenceCounts(nonIntentionalDifferences),
      intentionalByItem: differenceCounts(intentionalDifferences),
    },
    sitemap: {
      expectedCount: expectedPaths.size,
      actualCount: sitemapUrls.length,
      missing,
      extra,
      originErrors,
      movedCount: Object.keys(aliases).length,
      movedErrors,
      preview: previewStatus,
      archived,
      excludedRoutes,
      archiveSitemap,
    },
    intentionalRegistry,
    nonIntentionalDifferences,
    intentionalDifferences,
    allDifferences: differences,
    newAdditions,
  };
  await mkdir(reportDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(reportDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(join(reportDirectory, "report.md"), markdownReport(report)),
  ]);
  console.log(`verify:seo ${report.status}`);
  console.log(
    `pages=${pages.length} archive=${report.pages.withArchive} missingArchive=${missingArchive.length} mismatches=${differences.length} intentional=${intentionalDifferences.length} nonIntentional=${nonIntentionalDifferences.length} additions=${newAdditions.length}`,
  );
  console.log(
    `sitemap expected=${expectedPaths.size} actual=${sitemapUrls.length} missing=${missing.length} extra=${extra.length} origin=${originErrors.length} movedErrors=${movedErrors.length}`,
  );
  console.log(
    `reports: ${relative(project, join(reportDirectory, "report.json"))}, ${relative(project, join(reportDirectory, "report.md"))}`,
  );
  if (nonIntentionalDifferences.length) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
