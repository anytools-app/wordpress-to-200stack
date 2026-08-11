/* Static archive-versus-export audit. Project-specific allowances belong in fidelity-audit.config.json. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseHTML } from "linkedom";

const project = resolve(import.meta.dirname, "..");
const fidelityDir = join(project, "_scratch", "fidelity");
const defaultArchiveDir = process.env.WPKIT_ARCHIVE_DIR ? resolve(process.env.WPKIT_ARCHIVE_DIR) : join(project, "_scratch", "archive");
const defaultOutDir = process.env.WPKIT_OUT_DIR ? resolve(process.env.WPKIT_OUT_DIR) : join(project, "out");
const defaultConfig = join(project, "fidelity-audit.config.json");

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: [WPKIT_ARCHIVE_DIR=...] [WPKIT_OUT_DIR=...] [WPKIT_MEDIA_MAP=...] [WPKIT_SCORECARD=...] [WPKIT_ORIGIN=https://example.com] node scripts/fidelity-static-audit.mjs [--archive-dir path] [--out-dir path] [--media-map path] [--scorecard path] [--config path] [--evidence path]");
  process.exit(1);
}

function parseArgs(argv) {
  const options = { archiveDir: defaultArchiveDir, outDir: defaultOutDir, mediaMap: process.env.WPKIT_MEDIA_MAP ? resolve(process.env.WPKIT_MEDIA_MAP) : null, scorecard: process.env.WPKIT_SCORECARD ? resolve(process.env.WPKIT_SCORECARD) : null, config: defaultConfig, evidence: null };
  const fields = { "--archive-dir": "archiveDir", "--out-dir": "outDir", "--media-map": "mediaMap", "--scorecard": "scorecard", "--config": "config", "--evidence": "evidence" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!(flag in fields)) usage(`Unknown option: ${flag}`);
    options[fields[flag]] = resolve(argv[++index] ?? usage(`${flag} requires a path`));
  }
  return options;
}

function readJson(path, label, optional = false) {
  if (optional && !path) return {};
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new Error(`Cannot read ${label} ${path}: ${error instanceof Error ? error.message : error}`); }
}

function routeOf(value) {
  try { return normalRoute(new URL(value, process.env.WPKIT_ORIGIN ?? "https://example.invalid").pathname); } catch { return normalRoute(value); }
}
function normalRoute(value = "/") { const pathname = String(value).split(/[?#]/, 1)[0]; return pathname === "/" || !pathname ? "/" : `/${pathname.replace(/^\/+|\/+$/g, "")}/`; }
function archiveFile(root, route) { return join(root, "pages", encodeURIComponent(route), "page.html"); }
function builtFile(root, route) { return route === "/" ? join(root, "index.html") : join(root, ...route.slice(1, -1).split("/"), "index.html"); }
function clean(value = "") { return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim(); }
function normalUrl(value = "") { return value.trim().replace(/^http:\/\//i, "https://").replace(/[?#].*$/, ""); }
function basename(value = "") { return decodeURIComponent(normalUrl(value)).split("/").at(-1)?.replace(/\.[a-z0-9]{6,}\.(?:webp|avif)$/i, "").replace(/\.(?:webp|avif)$/i, "") ?? ""; }
function multisetDelta(left, right) { const count = (items) => items.reduce((map, item) => map.set(item, (map.get(item) ?? 0) + 1), new Map()); const a = count(left); const b = count(right); return { missing: [...a].filter(([key, amount]) => amount > (b.get(key) ?? 0)).map(([value, amount]) => ({ value, count: amount - (b.get(value) ?? 0) })), added: [...b].filter(([key, amount]) => amount > (a.get(key) ?? 0)).map(([value, amount]) => ({ value, count: amount - (a.get(value) ?? 0) })) }; }

function loadConfig(path) {
  if (!existsSync(path)) return { allowMissingPaths: new Set(), redirects: new Map(), textReplacements: [], intentional: {}, builtOnlyPaths: new Set() };
  const raw = readJson(path, "fidelity audit config");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("fidelity-audit.config.json: root must be an object");
  const allowed = new Set(["allowMissingPaths", "redirects", "textReplacements", "intentional", "builtOnlyPaths"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`fidelity-audit.config.json: unknown key ${key}`);
  const paths = (value, label) => { if (!Array.isArray(value ?? []) || (value ?? []).some((item) => typeof item !== "string" || !item.startsWith("/"))) throw new Error(`fidelity-audit.config.json: ${label} must be an array of absolute paths`); return new Set((value ?? []).map(normalRoute)); };
  if (raw.redirects !== undefined && (!raw.redirects || typeof raw.redirects !== "object" || Array.isArray(raw.redirects) || Object.entries(raw.redirects).some(([from, to]) => !from.startsWith("/") || typeof to !== "string" || !to.startsWith("/")))) throw new Error("fidelity-audit.config.json: redirects must be an object of absolute paths");
  if (raw.textReplacements !== undefined && (!Array.isArray(raw.textReplacements) || raw.textReplacements.some((item) => !item || typeof item !== "object" || Array.isArray(item) || typeof item.from !== "string" || !item.from || typeof item.to !== "string" || Object.keys(item).some((key) => !["from", "to"].includes(key))))) throw new Error("fidelity-audit.config.json: textReplacements must be [{ from, to }]");
  if (raw.intentional !== undefined && (!raw.intentional || typeof raw.intentional !== "object" || Array.isArray(raw.intentional) || Object.entries(raw.intentional).some(([key, value]) => !["textPaths", "semanticPaths", "linkPaths", "imagePaths", "metaPaths", "ctaPaths"].includes(key) || !Array.isArray(value) || value.some((pathValue) => typeof pathValue !== "string" || !pathValue.startsWith("/"))))) throw new Error("fidelity-audit.config.json: intentional has only *Paths arrays of absolute paths");
  return { allowMissingPaths: paths(raw.allowMissingPaths, "allowMissingPaths"), redirects: new Map(Object.entries(raw.redirects ?? {}).map(([from, to]) => [normalRoute(from), normalRoute(to)])), textReplacements: raw.textReplacements ?? [], intentional: Object.fromEntries(Object.entries(raw.intentional ?? {}).map(([key, value]) => [key, paths(value, `intentional.${key}`)])), builtOnlyPaths: paths(raw.builtOnlyPaths, "builtOnlyPaths") };
}

function contentRoot(document) { return document.querySelector("main,article,[role=main],#content,.content,body") ?? document.body; }
function textOf(root) { const chunks = []; const walk = (node) => { if (node.nodeType === 3) { const value = clean(node.data); if (value) chunks.push(value); return; } if (node.nodeType !== 1) return; const tag = node.localName?.toLowerCase(); if (["script", "style", "template", "noscript", "svg"].includes(tag) || node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return; if (tag === "br") { chunks.push("\n"); return; } for (const child of node.childNodes) walk(child); }; walk(root); return clean(chunks.join(" ")); }
function semantic(root) { return Object.fromEntries(["h1,h2,h3,h4,h5,h6", "ul", "ol", "li", "p", "blockquote", "table"].map((selector) => [selector, root.querySelectorAll(selector).length])); }
function links(document, host, redirects) { return [...document.querySelectorAll("a[href]")].map((element) => { const href = element.getAttribute("href") ?? ""; try { const url = new URL(href, `https://${host}`); const local = url.hostname === host; return `${local ? (redirects.get(normalRoute(url.pathname)) ?? normalRoute(url.pathname)) : url.href}|${(element.getAttribute("rel") ?? "").split(/\s+/).filter(Boolean).sort().join(" ")}|${element.getAttribute("target") === "_self" ? "" : element.getAttribute("target") ?? ""}`; } catch { return href; } }); }
function images(root, mediaMap) { return [...root.querySelectorAll("img")].map((element) => { const src = normalUrl(element.getAttribute("src") ?? ""); const mapped = mediaMap.get(src); return { key: `media:${basename(mapped ?? src)}`, alt: element.getAttribute("alt") ?? "", width: element.getAttribute("width") ?? "", height: element.getAttribute("height") ?? "", srcset: element.getAttribute("srcset") ?? "", sizes: element.getAttribute("sizes") ?? "", loading: element.getAttribute("loading") ?? "" }; }); }
function meta(document) { const values = {}; for (const element of document.querySelectorAll("meta[name],meta[property]")) values[element.getAttribute("name") ?? element.getAttribute("property")] = element.getAttribute("content") ?? ""; return { title: clean(document.title), description: values.description ?? "", robots: values.robots ?? "", canonical: [...document.querySelectorAll('link[rel~="canonical"]')].map((item) => normalUrl(item.getAttribute("href") ?? "")), og: Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith("og:"))), twitter: Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith("twitter:"))) }; }
function cta(root) { const hrefs = [...root.querySelectorAll("a[href]")].map((element) => element.getAttribute("href") ?? ""); return { forms: root.querySelectorAll("form").length, controls: root.querySelectorAll("form input,form select,form textarea,form button").length, tel: hrefs.filter((href) => href.startsWith("tel:")), line: hrefs.filter((href) => /(?:lin\.ee|line\.me|line\.naver)/i.test(href)) }; }
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function statusFor(config, kind, route) { return config.intentional[`${kind}Paths`]?.has(route) ? "intentional" : "action"; }
function finding(route, viewpoint, status, detail) { return { route, viewpoint, severity: status === "action" ? "medium" : "low", status, detail }; }
function markdownTable(rows, headings) { if (!rows.length) return "None."; return [`| ${headings.join(" | ")} |`, `| ${headings.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.map((cell) => String(cell).replaceAll("|", "\\|").replaceAll("\n", "<br>")).join(" | ")} |`)].join("\n"); }

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig(options.config);
  const inventory = readJson(join(options.archiveDir, "inventory.json"), "archive inventory");
  if (!Array.isArray(inventory.urls)) throw new Error("archive inventory.json.urls must be an array");
  const mediaRaw = options.mediaMap ? readJson(options.mediaMap, "media map", true) : {};
  if (!mediaRaw || typeof mediaRaw !== "object" || Array.isArray(mediaRaw)) throw new Error("media map must be an object");
  const mediaMap = new Map(Object.entries(mediaRaw).map(([source, value]) => [normalUrl(source), normalUrl(typeof value === "string" ? value : value?.assetUrl ?? "")]));
  const scorecard = options.scorecard ? readJson(options.scorecard, "scorecard", true) : {};
  const scorecardAllow = new Set(Array.isArray(scorecard?.gates) ? scorecard.gates.flatMap((gate) => gate?.id === "verify-content" && Array.isArray(gate.allowMissingUrls) ? gate.allowMissingUrls : []).map(routeOf) : []);
  const host = (() => { try { return new URL(process.env.WPKIT_ORIGIN ?? "https://example.invalid").hostname; } catch { return "example.invalid"; } })();
  const coverage = []; const targets = []; const seen = new Set();
  for (const entry of inventory.urls) {
    if (!entry || typeof entry.url !== "string") continue;
    const route = routeOf(entry.url);
    if (entry.status !== 200) { coverage.push({ route, kind: "archive-non-200", status: "info" }); continue; }
    if (seen.has(route)) { coverage.push({ route, kind: "duplicate-route", status: "info" }); continue; }
    seen.add(route);
    if (config.allowMissingPaths.has(route) || scorecardAllow.has(route)) { coverage.push({ route, kind: "allowed-missing", status: "intentional", redirect: config.redirects.get(route) ?? null }); continue; }
    const archivePath = archiveFile(options.archiveDir, route); const builtPath = builtFile(options.outDir, route);
    if (!existsSync(archivePath)) { coverage.push({ route, kind: "archive-file-missing", status: "action" }); continue; }
    if (!existsSync(builtPath)) { coverage.push({ route, kind: "built-file-missing", status: "action" }); continue; }
    targets.push({ route, archivePath, builtPath });
  }
  for (const route of config.builtOnlyPaths) if (existsSync(builtFile(options.outDir, route))) coverage.push({ route, kind: "built-only", status: "intentional" });
  const findings = [];
  for (const target of targets) {
    const originDocument = parseHTML(readFileSync(target.archivePath, "utf8")).document;
    const builtDocument = parseHTML(readFileSync(target.builtPath, "utf8")).document;
    const originRoot = contentRoot(originDocument); const builtRoot = contentRoot(builtDocument);
    const originText = textOf(originRoot); const expectedText = config.textReplacements.reduce((value, rule) => value.replaceAll(rule.from, rule.to), originText); const builtText = textOf(builtRoot);
    if (expectedText !== builtText) findings.push(finding(target.route, "text", statusFor(config, "text", target.route), { originLength: originText.length, builtLength: builtText.length, origin: expectedText.slice(0, 240), built: builtText.slice(0, 240) }));
    const originSemantic = semantic(originRoot); const builtSemantic = semantic(builtRoot);
    if (!same(originSemantic, builtSemantic)) findings.push(finding(target.route, "semantic", statusFor(config, "semantic", target.route), { origin: originSemantic, built: builtSemantic }));
    const linkDelta = multisetDelta(links(originDocument, host, config.redirects), links(builtDocument, host, config.redirects));
    if (linkDelta.missing.length || linkDelta.added.length) findings.push(finding(target.route, "links", statusFor(config, "link", target.route), linkDelta));
    const originImages = images(originRoot, mediaMap); const builtImages = images(builtRoot, mediaMap);
    if (!same(originImages, builtImages)) findings.push(finding(target.route, "images", statusFor(config, "image", target.route), { origin: originImages.slice(0, 24), built: builtImages.slice(0, 24) }));
    const originMeta = meta(originDocument); const builtMeta = meta(builtDocument);
    if (!same(originMeta, builtMeta)) findings.push(finding(target.route, "meta", statusFor(config, "meta", target.route), { origin: originMeta, built: builtMeta }));
    const originCta = cta(originRoot); const builtCta = cta(builtRoot);
    if (!same(originCta, builtCta)) findings.push(finding(target.route, "cta", statusFor(config, "cta", target.route), { origin: originCta, built: builtCta }));
  }
  const counts = { comparedPages: targets.length, archiveStatus200: inventory.urls.filter((entry) => entry?.status === 200).length, findings: { total: findings.length, action: findings.filter((item) => item.status === "action").length, intentional: findings.filter((item) => item.status === "intentional").length }, coverage: { action: coverage.filter((item) => item.status === "action").length, intentional: coverage.filter((item) => item.status === "intentional").length, info: coverage.filter((item) => item.status === "info").length } };
  const result = { generatedAt: new Date().toISOString(), inputs: { archiveDir: options.archiveDir, outDir: options.outDir, mediaMap: options.mediaMap, scorecard: options.scorecard, config: options.config }, counts, coverage, findings };
  await mkdir(fidelityDir, { recursive: true });
  const jsonPath = join(fidelityDir, "static-audit.json"); const markdownPath = join(fidelityDir, "static-audit.md");
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  const markdown = `# Archive vs built static audit\n\n- Compared pages: ${counts.comparedPages}\n- Findings: action ${counts.findings.action}, intentional ${counts.findings.intentional}\n\n## Action required\n\n${markdownTable(findings.filter((item) => item.status === "action").map((item) => [item.route, item.viewpoint, JSON.stringify(item.detail).slice(0, 300)]), ["Route", "Viewpoint", "Detail"])}\n\n## Intentional differences\n\n${markdownTable(findings.filter((item) => item.status === "intentional").map((item) => [item.route, item.viewpoint, JSON.stringify(item.detail).slice(0, 300)]), ["Route", "Viewpoint", "Detail"])}\n\n## Coverage\n\n${markdownTable(coverage.map((item) => [item.route, item.kind, item.status, item.redirect ?? ""]), ["Route", "Kind", "Status", "Redirect"])}\n`;
  writeFileSync(markdownPath, markdown);
  if (options.evidence) { await mkdir(join(options.evidence, ".."), { recursive: true }); writeFileSync(options.evidence, `${JSON.stringify(result, null, 2)}\n`); }
  console.log(JSON.stringify(counts, null, 2));
  if (counts.findings.action || counts.coverage.action) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
