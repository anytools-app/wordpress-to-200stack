import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { parseHTML } from "linkedom";
import * as csstree from "css-tree";

const project = resolve(import.meta.dirname, "..");
const outRoot = join(project, "out");
const publicRoot = join(project, "public");
const reportRoot = join(project, "_scratch", "css-audit");

// TODO(案件): 移行元サイトの canonical origin とテーマの JS 配下に変更する。
const legacyOrigin = "https://example.invalid";
const legacyThemeScriptRoot = join(publicRoot, "wp-content", "themes", "YOUR_THEME");

// HTML に現れなくても、JS が実行時に付与する可能性が高いクラスの接頭辞です。
// 必要に応じてここへ追加してください。
const DYNAMIC_CLASS_PATTERNS = [
  "slick-", "lity", "mb_YTP", "ytp", "is-", "active", "open", "show", "hover",
  "current", "loaded", "loading", "fixed", "scrolled", "animated", "inview", "fadein",
  "wp-pagenavi", "circliful",
];

console.log("CSS audit: HTML を読み込み中...");

async function filesUnder(root, predicate) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return filesUnder(path, predicate);
    return predicate(path) ? [path] : [];
  }));
  return files.flat();
}

function posixPath(path) {
  return path.replaceAll("\\", "/");
}

function publicUrl(file) {
  return `/${posixPath(relative(publicRoot, file))}`;
}

function pagePath(file) {
  const path = posixPath(relative(outRoot, file));
  if (path === "index.html") return "/";
  return `/${path.slice(0, -"/index.html".length)}`;
}

function hrefToPublicFile(href, sourceFile = null) {
  if (!href || /^(?:data:|#|blob:|about:)/i.test(href)) return null;
  let pathname;
  try {
    const url = new URL(href, legacyOrigin);
    if (url.origin !== legacyOrigin) return null;
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (href.trim().startsWith("/")) return normalize(join(publicRoot, pathname));
  return sourceFile ? normalize(resolve(dirname(sourceFile), pathname)) : normalize(join(publicRoot, pathname));
}

function isAuditedCss(file) {
  const path = publicUrl(file);
  return path.startsWith("/wp-content/") || path.startsWith("/vendor/");
}

function importTargets(ast, sourceFile) {
  const targets = [];
  csstree.walk(ast, {
    visit: "Atrule",
    enter(node) {
      if (node.name.toLowerCase() !== "import" || !node.prelude) return;
      const prelude = csstree.generate(node.prelude);
      const match = prelude.match(/^(?:url\()?\s*["']?([^"'\s)]+)["']?\s*\)?/i);
      const target = match && hrefToPublicFile(match[1], sourceFile);
      if (target && isAuditedCss(target)) targets.push(target);
    },
  });
  return targets;
}

function stripPseudo(selector) {
  let result = "";
  for (let index = 0; index < selector.length;) {
    if (selector[index] !== ":") {
      result += selector[index++];
      continue;
    }
    index += selector[index + 1] === ":" ? 2 : 1;
    while (/[\w-]/.test(selector[index] ?? "")) index += 1;
    if (selector[index] !== "(") continue;
    let depth = 0;
    let quote = null;
    do {
      const char = selector[index++];
      if (quote) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = null;
      } else if (char === "'" || char === '"') quote = char;
      else if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
    } while (index < selector.length && depth > 0);
  }
  return result.replace(/\s+/g, " ").trim().replace(/^[>+~\s]+|[>+~\s]+$/g, "");
}

function selectorClasses(selector) {
  return [...selector.matchAll(/\.((?:\\.|[\w-])+)/g)].map((match) => match[1].replace(/\\(.)/g, "$1"));
}

function isDynamicSelector(selector) {
  return selectorClasses(selector).some((className) => DYNAMIC_CLASS_PATTERNS.some((pattern) => (
    className === pattern || className.startsWith(pattern)
  )));
}

function hasSourceClass(selector, sourceText) {
  return selectorClasses(selector).some((className) => sourceText.has(className));
}

function bytesForSelector(ruleBytes, selectorCount) {
  return Math.max(1, Math.round(ruleBytes / selectorCount));
}

function selectorEntries(css) {
  const ast = csstree.parse(css, { parseRulePrelude: true, positions: true });
  const entries = [];
  csstree.walk(ast, {
    visit: "Rule",
    enter(node) {
      if (!node.prelude || node.prelude.type !== "SelectorList") return;
      const selectors = node.prelude.children.toArray().map((selector) => csstree.generate(selector));
      const ruleBytes = Buffer.byteLength(csstree.generate(node));
      selectors.forEach((selector) => entries.push({ selector, estimatedBytes: bytesForSelector(ruleBytes, selectors.length) }));
    },
  });
  return { ast, entries };
}

const htmlFiles = await filesUnder(outRoot, (file) => file.endsWith("/index.html"));
const pages = await Promise.all(htmlFiles.map(async (file) => {
  const html = await readFile(file, "utf8");
  const { document } = parseHTML(html);
  const stylesheets = [...document.querySelectorAll('link[rel~="stylesheet"][href]')]
    .map((link) => hrefToPublicFile(link.getAttribute("href")))
    .filter((file) => file && isAuditedCss(file));
  return { path: pagePath(file), html, document, stylesheets };
}));
console.log(`CSS audit: ${pages.length} ページを読み込みました。`);

const sourceFiles = [
  ...(await filesUnder(join(project, "src"), (file) => /\.tsx?$/.test(file))),
  ...(await filesUnder(legacyThemeScriptRoot, (file) => file.endsWith(".js"))),
];
const sourceText = new Set();
for (const file of sourceFiles) {
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(/["'`]([^"'`\\]*(?:\\.[^"'`\\]*)*)["'`]/g)) {
    for (const token of match[1].matchAll(/[A-Za-z_-][\w-]*/g)) sourceText.add(token[0]);
  }
}

const cssToPages = new Map();
for (const page of pages) {
  for (const file of page.stylesheets) {
    if (!cssToPages.has(file)) cssToPages.set(file, new Set());
    cssToPages.get(file).add(page.path);
  }
}

const cssFiles = new Map();
async function loadCss(file, inheritedPages = new Set()) {
  if (cssFiles.has(file)) {
    const record = cssFiles.get(file);
    for (const path of inheritedPages) record.pages.add(path);
    for (const imported of record.imports) await loadCss(imported, record.pages);
    return;
  }
  let css;
  try {
    css = await readFile(file, "utf8");
  } catch (error) {
    console.warn(`CSS を読めません: ${publicUrl(file)} (${error.code ?? error.message})`);
    return;
  }
  let parsed;
  try {
    parsed = selectorEntries(css);
  } catch (error) {
    console.warn(`CSS を解析できません: ${publicUrl(file)} (${error.message})`);
    return;
  }
  const record = { file, css, pages: new Set(inheritedPages), ast: parsed.ast, selectors: parsed.entries, imports: importTargets(parsed.ast, file) };
  cssFiles.set(file, record);
  for (const imported of record.imports) await loadCss(imported, record.pages);
}

for (const [file, linkedPages] of cssToPages) await loadCss(file, linkedPages);
console.log(`CSS audit: ${cssFiles.size} CSS を解析しました。`);

function candidateNeedles(selector) {
  // セレクタに含まれる全クラスがページに存在しなければ、CSS セレクタも一致しない。
  // querySelector の前に安全に絞り込むため、ここでは HTML 文字列だけを確認する。
  const classNames = [...new Set(selectorClasses(selector))];
  if (classNames.length) return classNames;
  const id = selector.match(/#((?:\\.|[\w-])+)/)?.[1]?.replace(/\\(.)/g, "$1");
  return id ? [id] : [];
}

const fileReports = [];
const selectorRecords = [];
for (const record of cssFiles.values()) {
  for (const entry of record.selectors) {
    const normalized = stripPseudo(entry.selector);
    const status = isDynamicSelector(entry.selector) ? "dynamic"
      : hasSourceClass(entry.selector, sourceText) || !normalized ? "used"
      : "pending";
    selectorRecords.push({ ...entry, record, normalized, status, candidates: candidateNeedles(entry.selector) });
  }
}

console.log(`CSS audit: ${selectorRecords.filter((entry) => entry.status === "pending").length} セレクタを照合します。`);
for (let index = 0; index < pages.length; index += 1) {
  const page = pages[index];
  const candidates = selectorRecords.filter((entry) => entry.status === "pending" && entry.candidates.every((needle) => page.html.includes(needle)));
  if (!candidates.length) continue;
  for (const entry of candidates) {
    try {
      if (page.document.querySelector(entry.normalized)) entry.status = "used";
    } catch {
      entry.status = "unknown";
    }
  }
  if ((index + 1) % 100 === 0) console.log(`CSS audit: ${index + 1}/${pages.length} ページを照合しました。候補 ${candidates.length}`);
}
for (const entry of selectorRecords) if (entry.status === "pending") entry.status = "unused";

for (const record of [...cssFiles.values()].sort((a, b) => publicUrl(a.file).localeCompare(publicUrl(b.file)))) {
  console.log(`CSS audit: 判定中 ${publicUrl(record.file)}`);
  const counts = { used: 0, unused: 0, dynamic: 0, unknown: 0 };
  const unusedSelectors = [];
  for (const entry of selectorRecords.filter((entry) => entry.record === record)) {
    counts[entry.status] += 1;
    if (entry.status === "unused") unusedSelectors.push({ selector: entry.selector, estimatedBytes: entry.estimatedBytes });
  }
  const totalBytes = Buffer.byteLength(record.css);
  const unusedBytes = unusedSelectors.reduce((sum, entry) => sum + entry.estimatedBytes, 0);
  fileReports.push({
    file: publicUrl(record.file),
    referencedPageCount: record.pages.size,
    referencedPages: [...record.pages].sort(),
    totalRules: record.selectors.length,
    totalBytes,
    unusedEquivalentBytes: unusedBytes,
    unusedPercent: record.selectors.length ? Number((counts.unused / record.selectors.length * 100).toFixed(1)) : 0,
    ...counts,
    unusedSelectors,
  });
}

const allPublicCss = await filesUnder(join(publicRoot, "wp-content"), (file) => file.endsWith(".css"));
const linkedCss = new Set(cssFiles.keys());
const unlinkedCss = allPublicCss.filter((file) => !linkedCss.has(file)).map(publicUrl).sort();
const totals = fileReports.reduce((sum, file) => {
  for (const key of ["totalRules", "totalBytes", "unusedEquivalentBytes", "used", "unused", "dynamic", "unknown"]) sum[key] += file[key];
  return sum;
}, { cssFiles: fileReports.length, pages: pages.length, totalRules: 0, totalBytes: 0, unusedEquivalentBytes: 0, used: 0, unused: 0, dynamic: 0, unknown: 0 });

const report = {
  generatedAt: new Date().toISOString(),
  scope: { pages: pages.length, selectorUnit: "CSS selector (not CSS rule)", dynamicClassPatterns: DYNAMIC_CLASS_PATTERNS },
  totals,
  files: fileReports,
  unlinkedPublicWpContentCss: unlinkedCss,
};
const ranked = [...fileReports].sort((a, b) => b.unusedPercent - a.unusedPercent || b.unusedEquivalentBytes - a.unusedEquivalentBytes);
const markdown = [
  "# CSS 使用状況棚卸し", "",
  `生成日時: ${report.generatedAt}`, "",
  `対象ページ: ${pages.length} / 対象 CSS: ${fileReports.length} / セレクタ: ${totals.totalRules}`, "",
  `used: ${totals.used}, unused: ${totals.unused}, dynamic: ${totals.dynamic}, unknown: ${totals.unknown}`, "",
  `CSS 合計: ${totals.totalBytes} bytes / unused 相当（概算）: ${totals.unusedEquivalentBytes} bytes`, "",
  "## ファイル別サマリ", "",
  "| CSS | セレクタ | used | unused | dynamic | unknown | unused率 | unused相当 bytes | 参照ページ |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...ranked.map((file) => `| \`${file.file}\` | ${file.totalRules} | ${file.used} | ${file.unused} | ${file.dynamic} | ${file.unknown} | ${file.unusedPercent}% | ${file.unusedEquivalentBytes} | ${file.referencedPageCount} |`),
  "", "## どのページからも link されていない public/wp-content CSS", "",
  ...(unlinkedCss.length ? unlinkedCss.map((file) => `- \`${file}\``) : ["- なし"]), "",
  "## 判定上の注意", "",
  "- 集計単位は CSS ルール内の各セレクタです。unused 相当 bytes はルールの生成後バイト数をセレクタ数で按分した概算です。",
  "- dynamic と unknown は削除候補から除外しています。unknown は linkedom が解釈できないセレクタです。",
  "- unused セレクタの完全な一覧と参照ページは report.json を参照してください。", "",
].join("\n");

await mkdir(reportRoot, { recursive: true });
await writeFile(join(reportRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(reportRoot, "report.md"), markdown);
console.log(JSON.stringify({ output: "_scratch/css-audit", pages: pages.length, cssFiles: fileReports.length, ...totals }, null, 2));
process.exit(0);
