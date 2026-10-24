import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import nextEnv from "@next/env";
import { parseHTML } from "linkedom";
import {
  archiveSitemapMissingErrors,
  collectEqualityErrors,
  collectExpectedValueErrors,
  collectInternalHrefErrors,
  collectRequiredFieldErrors,
  collectRetiredRouteErrors,
  collectRouteFamilyCoverageErrors,
  collectSocialImageEvidenceErrors,
  collectSocialMetadataFormatErrors,
  exactTrailingSlashErrors,
  expectedPublicPathForLookup,
  intentionalDiffMatches,
  normalizeLookupPath,
  publicPath,
  trailingSlashFor,
  validateContractConfig,
  validateIntentionalDiffRegistry,
} from "./lib/seo-contract.mjs";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const project = process.cwd();
const outDirectory = resolve(project, process.env.SEO_OUT_DIR ?? "out");
const archiveDirectory = resolve(project, process.env.WPKIT_ARCHIVE_DIR ?? join("_scratch", "archive-full"));
const reportDirectory = resolve(project, "_scratch", "seo-audit");
const intentionalDiffsPath = resolve(project, "docs", "seo-intentional-diffs.json");
const contractConfigPath = resolve(project, "seo-contract.config.json");
const siteUrl = new URL(process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "https://www.example.com" /* TODO(案件) */);
const OG_ITEMS = [
  "title",
  "description",
  "url",
  "image",
  "image:secure_url",
  "image:type",
  "image:width",
  "image:height",
  "image:alt",
  "type",
  "site_name",
  "locale",
];
const ERROR_ROUTES = new Set(["/404", "/_not-found"]);

function routeFromHtmlPath(path) {
  const directory = relative(outDirectory, resolve(path, ".."));
  return directory ? normalizeLookupPath(`/${directory.split(sep).join("/")}`) : "/";
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
  const lang = document.documentElement?.getAttribute("lang");
  if (lang) values["html:lang"] = lang;
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
  const h1Elements = [...document.querySelectorAll("h1")];
  const h1Texts = h1Elements.map((element) => element.textContent.trim().replace(/\s+/g, " "));
  values["h1:count"] = String(h1Elements.length);
  if (h1Texts.some(Boolean)) values["h1:text"] = h1Texts.join(" | ");
  const hrefs = [...document.querySelectorAll("a[href]")]
    .map((element) => element.getAttribute("href"))
    .filter((href) => typeof href === "string" && href.length > 0);
  return { values, jsonLd: jsonLdOf(document), hrefs };
}

function urlComparisonValue(value, movedTo) {
  try {
    const url = new URL(value, "https://www.example.com");
    const path = movedTo ?? normalizeLookupPath(url.pathname);
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

function publicUrlErrors(path, metadata) {
  return ["canonical", "og:url"].flatMap((item) => {
    const value = metadata.values[item];
    if (value === undefined) return [];
    const message = absoluteOriginError(item, value);
    return message ? [{ path, item: `${item}.absoluteOrigin`, expected: siteUrl.origin, actual: value, message }] : [];
  });
}

function isIntentional(entries, difference) {
  return Array.isArray(entries) && entries.some((entry) => intentionalDiffMatches(entry, difference));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function loadAliases() {
  try {
    const raw = await readJson(join(project, "src", "data", "legacy-route-aliases.json"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw).flatMap(([currentPath, legacyPath]) =>
        typeof legacyPath === "string" ? [[normalizeLookupPath(currentPath), normalizeLookupPath(legacyPath)]] : [],
      ),
    );
  } catch {
    return {};
  }
}

async function loadArchivePages() {
  const pages = new Map();
  const directory = join(archiveDirectory, "pages");
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return pages;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pageDirectory = join(directory, entry.name);
    try {
      const metadata = await readJson(join(pageDirectory, "meta.json"));
      if (metadata.status !== 200) continue;
      const url = metadata.url ?? metadata.finalUrl ?? metadata.canonical;
      if (!url) continue;
      pages.set(
        normalizeLookupPath(new URL(url, "https://www.example.com").pathname),
        join(pageDirectory, "page.html"),
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return pages;
}

async function archiveHtml(pages, path) {
  const pagePath = pages.get(normalizeLookupPath(path));
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
  return [...xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)].flatMap((urlMatch) => {
    const location = urlMatch[1].match(/<loc\b[^>]*>([\s\S]*?)<\/loc>/i)?.[1];
    return location ? [location.trim().replaceAll("&amp;", "&")] : [];
  });
}

function canonicalPath(metadata) {
  const value = metadata.values.canonical;
  if (!value) return undefined;
  try {
    return normalizeLookupPath(new URL(value, siteUrl).pathname);
  } catch {
    return undefined;
  }
}

function robotsNoindex(metadata) {
  return /\bnoindex\b/i.test(metadata.values["meta:robots"] ?? "");
}

async function findXmlFiles(directory) {
  const files = [];
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return files;
  }
  for (const entry of entries) {
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
    `- 契約エラー: ${report.summary.contractErrors}`,
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
    `- 原本 sitemap: ${report.sitemap.archiveSitemap.status}`,
    `- 原本 sitemap 未分類 retire: ${report.sitemap.archiveSitemap.unclassifiedRetireCount ?? 0}`,
    `- 原本 sitemap 分類エラー合計: ${report.sitemap.archiveSitemap.classificationErrorCount ?? 0}`,
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
  for (const entry of Array.isArray(report.intentionalRegistry?.entries) ? report.intentionalRegistry.entries : []) {
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
  const [htmlPaths, aliases, intentionalRegistry, contractConfig, archivePages] = await Promise.all([
    findIndexHtml(outDirectory),
    loadAliases(),
    readJson(intentionalDiffsPath),
    readJson(contractConfigPath),
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
  const trailingSlash = trailingSlashFor(contractConfig);
  const outputPaths = new Set(pages.map((page) => page.path));
  const contractErrors = [
    ...validateContractConfig(contractConfig).map((message) => ({ path: "/", item: "contract.config", message })),
    ...validateIntentionalDiffRegistry(intentionalRegistry).map((message) => ({
      path: "/",
      item: "intentionalRegistry.config",
      message,
    })),
    ...collectSocialImageEvidenceErrors(contractConfig),
  ];
  for (const page of pages) {
    const sourcePath = aliases[page.path] ?? page.path;
    const sourceHtml = await archiveHtml(archivePages, sourcePath);
    if (!ERROR_ROUTES.has(page.path)) {
      contractErrors.push(
        ...collectRouteFamilyCoverageErrors({ path: page.path, config: contractConfig }),
        ...exactTrailingSlashErrors({
          route: page.path,
          metadata: page.metadata,
          siteOrigin: siteUrl.origin,
          trailingSlash,
        }),
        ...collectRequiredFieldErrors({ path: page.path, metadata: page.metadata, config: contractConfig }),
        ...collectExpectedValueErrors({ path: page.path, metadata: page.metadata, config: contractConfig }),
        ...collectEqualityErrors({ path: page.path, metadata: page.metadata, config: contractConfig }),
        ...collectSocialMetadataFormatErrors({ path: page.path, metadata: page.metadata }),
        ...publicUrlErrors(page.path, page.metadata),
        ...collectInternalHrefErrors({
          sourcePath: page.path,
          hrefs: page.metadata.hrefs,
          outputPaths,
          siteOrigin: siteUrl.origin,
          trailingSlash,
        }),
      );
    }
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
  const sitemapPaths = new Set(sitemapUrls.map((url) => normalizeLookupPath(new URL(url, siteUrl).pathname)));
  const sitemapPublicPaths = new Set(sitemapUrls.map((url) => publicPath(url, siteUrl.origin)));
  const outputPublicPaths = new Set(pages.map((page) => expectedPublicPathForLookup(page.path, trailingSlash)));
  const sitemapPublicPathErrors = sitemapUrls.flatMap((url) => {
    const lookupPath = normalizeLookupPath(new URL(url, siteUrl).pathname);
    const expected = expectedPublicPathForLookup(lookupPath, trailingSlash);
    const actual = publicPath(url, siteUrl.origin);
    return actual === expected ? [] : [{ item: "sitemap.publicPath", path: lookupPath, expected, actual }];
  });
  const expectedPaths = new Set(
    pages.flatMap((page) => {
      if (ERROR_ROUTES.has(page.path) || page.path === "/preview" || robotsNoindex(page.metadata)) return [];
      const canonical = canonicalPath(page.metadata);
      return canonical && canonical === page.path ? [page.path] : [];
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
    const currentLookup = normalizeLookupPath(currentPath);
    const legacyLookup = normalizeLookupPath(legacyPath);
    if (!sitemapPaths.has(currentLookup)) errors.push(`${currentPath}: 新 URL がありません`);
    if (sitemapPaths.has(legacyLookup)) errors.push(`${legacyPath}: 旧 URL が残っています`);
    return errors;
  });
  const preview = pages.find((page) => page.path === "/preview");
  const previewStatus = {
    excluded: !sitemapPaths.has("/preview"),
    noindex: Boolean(preview && robotsNoindex(preview.metadata)),
  };
  const archiveSitemapFiles = (await findXmlFiles(archiveDirectory)).sort();
  let archiveSitemap;
  let retiredRouteErrors = [];
  let archiveSitemapLoadErrors = [];
  if (archiveSitemapFiles.length) {
    const sitemapDocuments = await Promise.all(
      archiveSitemapFiles.map(async (path) => ({ path, xml: await readFile(path, "utf8") })),
    );
    const urlsetDocuments = sitemapDocuments.filter(({ xml }) => /<urlset\b/i.test(xml));
    const urls = [...new Set(urlsetDocuments.flatMap(({ xml }) => sitemapLocations(xml)))].sort();
    const archivePublicPaths = new Set(urls.map((url) => publicPath(url, "https://www.example.com")));
    const paths = new Set(urls.map((url) => normalizeLookupPath(new URL(url, "https://www.example.com").pathname)));
    if (urlsetDocuments.length === 0) {
      archiveSitemapLoadErrors = [
        {
          item: "archiveSitemap.indexChildrenMissing",
          path: "/",
          message: "sitemap XML は見つかりましたが、保存済みurlsetがありません",
        },
      ];
    }
    retiredRouteErrors = collectRetiredRouteErrors({
      archivePaths: archivePublicPaths,
      outputPaths,
      sitemapPaths,
      outputPublicPaths,
      sitemapPublicPaths,
      aliases,
      config: contractConfig,
      trailingSlash,
    });
    archiveSitemap = {
      status: urlsetDocuments.length ? "found" : "index-only",
      paths: archiveSitemapFiles.map((path) => relative(project, path)),
      urlCount: urls.length,
      missingFromNew: [...paths].filter((path) => !sitemapPaths.has(path)).sort(),
      addedInNew: [...sitemapPaths].filter((path) => !paths.has(path)).sort(),
      urlShapeChanges: [...archivePublicPaths]
        .flatMap((source) => {
          const lookup = normalizeLookupPath(source);
          const target = expectedPublicPathForLookup(lookup, trailingSlash);
          return source !== target && outputPublicPaths.has(target) && sitemapPublicPaths.has(target)
            ? [{ source, target }]
            : [];
        })
        .sort((left, right) => left.source.localeCompare(right.source)),
      unclassifiedRetireCount: retiredRouteErrors.filter((error) => error.item === "archiveSitemap.unclassifiedRetire")
        .length,
      classificationErrorCount: retiredRouteErrors.length,
    };
  } else {
    archiveSitemap = { status: "not-found", message: "_scratch/archive-full 内に sitemap XML はありません" };
    archiveSitemapLoadErrors = archiveSitemapMissingErrors(contractConfig);
  }
  const sitemapErrors = [
    ...missing.map((path) => ({ item: "sitemap.missing", path })),
    ...extra.map((path) => ({ item: "sitemap.extra", path })),
    ...sitemapPublicPathErrors,
    ...originErrors.map((url) => ({ item: "sitemap.origin", path: new URL(url, siteUrl).pathname, actual: url })),
    ...movedErrors.map((message) => ({ item: "sitemap.moved", path: "/", message })),
    ...archiveSitemapLoadErrors,
    ...retiredRouteErrors,
    ...(!previewStatus.excluded
      ? [{ item: "sitemap.preview", path: "/preview", message: "sitemap に含まれています" }]
      : []),
    ...(!previewStatus.noindex
      ? [{ item: "preview.robots", path: "/preview", message: "noindex ではありません" }]
      : []),
    ...contractErrors,
  ];

  const intentionalEntries = Array.isArray(intentionalRegistry?.entries) ? intentionalRegistry.entries : [];
  const intentionalDifferences = differences.filter((difference) => isIntentional(intentionalEntries, difference));
  const unusedIntentionalEntries = intentionalEntries
    .filter((entry) => !differences.some((difference) => intentionalDiffMatches(entry, difference)))
    .map((entry) => ({
      path: typeof entry?.path === "string" ? entry.path : "/",
      item: "intentionalRegistry.unused",
      actual: entry?.item,
      message: "登録した意図差分に対応する観測差分がありません",
    }));
  const nonIntentionalDifferences = [
    ...differences.filter((difference) => !isIntentional(intentionalEntries, difference)),
    ...unusedIntentionalEntries,
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
      contractErrors: contractErrors.length,
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
