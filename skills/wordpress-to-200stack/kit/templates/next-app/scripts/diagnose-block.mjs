/* Compare a selected DOM block under identical frozen-archive and exported-page conditions. */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { installCacheRoutes } from "./lib/remote-cache.mjs";
import { createCachedServer } from "./serve-cached.mjs";

const project = resolve(import.meta.dirname, "..");
const fidelityDir = join(project, "_scratch", "fidelity");
const archiveDir = process.env.WPKIT_ARCHIVE_DIR ? resolve(process.env.WPKIT_ARCHIVE_DIR) : null;
const outDir = join(project, "out");
const VIEWPORTS = { desktop: { width: 1280, height: 800 }, mobile: { width: 375, height: 812 } };
const PROPS = ["display", "position", "float", "fontSize", "lineHeight", "marginTop", "marginBottom", "paddingTop", "paddingBottom", "height", "letterSpacing", "boxSizing"];
const PASSTHROUGH = ["youtube.com", "ytimg.com", "googlevideo.com"];

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: WPKIT_ARCHIVE_DIR=... WPKIT_ORIGIN=https://example.com node scripts/diagnose-block.mjs --path / --selector .block [--selector-origin .old] [--selector-built .new] [--viewport desktop|mobile] [--depth 3] [--max 40] [--port 8899] [--mode tree|list] [--evidence <json>]");
  process.exit(1);
}

function parseArgs(argv) {
  const options = { path: null, selector: null, selectorOrigin: null, selectorBuilt: null, viewport: "desktop", depth: 3, max: 40, port: 8899, mode: "tree", evidence: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (["--path", "--selector", "--selector-origin", "--selector-built", "--viewport", "--mode"].includes(flag)) options[{ "--path": "path", "--selector": "selector", "--selector-origin": "selectorOrigin", "--selector-built": "selectorBuilt", "--viewport": "viewport", "--mode": "mode" }[flag]] = argv[++index] ?? usage(`${flag} requires a value`);
    else if (["--depth", "--max", "--port"].includes(flag)) { const key = { "--depth": "depth", "--max": "max", "--port": "port" }[flag]; options[key] = Number(argv[++index]); if (!Number.isInteger(options[key]) || options[key] < 0 || (key === "port" && options[key] < 1) || (key === "port" && options[key] > 65535)) usage(`${flag} requires a valid integer`); }
    else if (flag === "--evidence") options.evidence = resolve(argv[++index] ?? usage("--evidence requires a JSON path"));
    else usage(`Unknown option: ${flag}`);
  }
  if (!options.path?.startsWith("/") || !options.selector) usage("--path (absolute) and --selector are required");
  if (!(options.viewport in VIEWPORTS)) usage("--viewport requires desktop or mobile");
  if (!["tree", "list"].includes(options.mode)) usage("--mode requires tree or list");
  options.selectorOrigin ??= options.selector;
  options.selectorBuilt ??= options.selector;
  return options;
}

function encodedPath(pathname) { return encodeURIComponent(pathname === "/" ? "/" : `${pathname.replace(/\/+$/, "")}/`); }
async function listen(server, port) { await new Promise((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); done(); }); }); }
async function closeServer(server) { await new Promise((done) => server.close(() => done())); }

function sessionStorageEntries() {
  if (!process.env.MEASURE_SESSION_STORAGE) return null;
  let entries; try { entries = JSON.parse(process.env.MEASURE_SESSION_STORAGE); } catch { throw new Error("MEASURE_SESSION_STORAGE must be a JSON object"); }
  if (!entries || typeof entries !== "object" || Array.isArray(entries) || Object.values(entries).some((value) => typeof value !== "string")) throw new Error("MEASURE_SESSION_STORAGE must be a JSON object with string values");
  return entries;
}

async function measurementState(context) {
  const entries = sessionStorageEntries();
  if (entries) await context.addInitScript((values) => { for (const [key, value] of Object.entries(values)) sessionStorage.setItem(key, value); }, entries);
  const css = [process.env.MEASURE_EXTRA_CSS ?? "", process.env.MEASURE_HIDE_SELECTORS ? `${process.env.MEASURE_HIDE_SELECTORS} { display: none !important; }` : ""].filter(Boolean).join("\n");
  if (css) await context.addInitScript((styleText) => { const install = () => { const style = document.createElement("style"); style.textContent = styleText; document.documentElement.appendChild(style); }; if (document.documentElement) install(); else addEventListener("DOMContentLoaded", install); }, css);
}

async function snapshot(page, selector, depth) {
  return page.evaluate(([rootSelector, maxDepth, props]) => {
    const root = document.querySelector(rootSelector);
    if (!root) return null;
    const walk = (element, level) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const entry = { tag: element.tagName.toLowerCase(), classes: [...element.classList].filter((name) => !name.includes("module_")).slice(0, 3), y: Math.round(rect.y * 100) / 100, width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100, css: Object.fromEntries(props.map((name) => [name, style[name]])), children: [] };
      if (level < maxDepth) for (const child of element.children) entry.children.push(walk(child, level + 1));
      return entry;
    };
    return walk(root, 0);
  }, [selector, depth, PROPS]);
}

async function sectionMap(page, selector) {
  return page.evaluate((rootSelector) => {
    const root = document.querySelector(rootSelector); if (!root) return null;
    return [...root.querySelectorAll(":scope > *")].map((element) => { const rect = element.getBoundingClientRect(); const heading = element.querySelector("h1,h2,h3"); return { tag: element.tagName.toLowerCase(), classes: [...element.classList].slice(0, 2), height: Math.round(rect.height * 10) / 10, heading: heading?.textContent.trim().slice(0, 80) ?? "" }; });
  }, selector);
}

function diffTree(origin, built, location = "", output = []) {
  if (!origin || !built) { output.push({ path: location || "/", issue: `missing side origin=${Boolean(origin)} built=${Boolean(built)}` }); return output; }
  const cssDiff = Object.fromEntries(Object.keys(origin.css).filter((key) => origin.css[key] !== built.css[key]).map((key) => [key, `${origin.css[key]} -> ${built.css[key]}`]));
  const heightDelta = Math.round((built.height - origin.height) * 100) / 100;
  const widthDelta = Math.round((built.width - origin.width) * 100) / 100;
  if (Math.abs(heightDelta) > 0.01 || Math.abs(widthDelta) > 0.01 || Object.keys(cssDiff).length) output.push({ path: `${location}/${origin.tag}`, heightDelta, widthDelta, originHeight: origin.height, builtHeight: built.height, cssDiff });
  if (origin.children.length !== built.children.length) output.push({ path: `${location}/${origin.tag}`, issue: `child count ${origin.children.length} -> ${built.children.length}` });
  for (let index = 0; index < Math.min(origin.children.length, built.children.length); index += 1) diffTree(origin.children[index], built.children[index], `${location}/${origin.tag}[${index}]`, output);
  return output;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!archiveDir) usage("WPKIT_ARCHIVE_DIR is required");
  if (!existsSync(outDir)) throw new Error(`out/ is missing at ${outDir}; npm run build が先です`);
  let origin; try { origin = new URL(process.env.WPKIT_ORIGIN ?? "").origin; } catch { usage("WPKIT_ORIGIN must be an absolute URL"); }
  const frozenPath = join(archiveDir, "pages", encodedPath(options.path), "page.html");
  const frozen = await readFile(frozenPath, "utf8").catch(() => { throw new Error(`Frozen page.html is missing: ${frozenPath}`); });
  const server = createCachedServer();
  const browser = await chromium.launch({ headless: true });
  let result;
  try {
    await listen(server, options.port);
    const context = await browser.newContext({ viewport: VIEWPORTS[options.viewport], deviceScaleFactor: 1, reducedMotion: "reduce" });
    try {
      await measurementState(context);
      await installCacheRoutes(context, { hosts: [new URL(origin).hostname, "fonts.googleapis.com", "fonts.gstatic.com", "images.microcms-assets.io"], passthrough: PASSTHROUGH });
      const documentUrl = new URL(options.path, origin).href;
      await context.route(documentUrl, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: frozen }));
      const originPage = await context.newPage(); const builtPage = await context.newPage();
      try {
        await originPage.goto(documentUrl, { waitUntil: "networkidle", timeout: 25_000 });
        await builtPage.goto(`http://127.0.0.1:${options.port}${options.path}`, { waitUntil: "networkidle", timeout: 25_000 });
        if (options.mode === "list") result = { generatedAt: new Date().toISOString(), path: options.path, selector: options.selector, viewport: options.viewport, mode: "list", origin: await sectionMap(originPage, options.selectorOrigin), built: await sectionMap(builtPage, options.selectorBuilt) };
        else { const originTree = await snapshot(originPage, options.selectorOrigin, options.depth); const builtTree = await snapshot(builtPage, options.selectorBuilt, options.depth); const diffs = diffTree(originTree, builtTree); result = { generatedAt: new Date().toISOString(), path: options.path, selector: options.selector, selectors: { origin: options.selectorOrigin, built: options.selectorBuilt }, viewport: options.viewport, mode: "tree", diffCount: diffs.length, diffs: diffs.slice(0, options.max) }; }
      } finally { await originPage.close().catch(() => {}); await builtPage.close().catch(() => {}); await context.unroute(documentUrl).catch(() => {}); }
    } finally { await context.close(); }
  } finally { await browser.close(); await closeServer(server).catch(() => {}); }
  await mkdir(fidelityDir, { recursive: true });
  await writeFile(join(fidelityDir, "diagnose-block.json"), `${JSON.stringify(result, null, 2)}\n`);
  if (options.evidence) { await mkdir(join(options.evidence, ".."), { recursive: true }); await writeFile(options.evidence, `${JSON.stringify(result, null, 2)}\n`); }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
