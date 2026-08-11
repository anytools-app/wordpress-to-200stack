/* Browser-visible text comparison for frozen archive HTML versus the static export. */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { installCacheRoutes } from "./lib/remote-cache.mjs";
import { createCachedServer } from "./serve-cached.mjs";

const project = resolve(import.meta.dirname, "..");
const archiveDir = process.env.WPKIT_ARCHIVE_DIR ? resolve(process.env.WPKIT_ARCHIVE_DIR) : null;
const outDir = join(project, "out");
const fidelityDir = join(project, "_scratch", "fidelity");
const configPath = join(project, "fidelity-text.config.json");
const PASSTHROUGH = ["youtube.com", "ytimg.com", "googlevideo.com"];

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: WPKIT_ARCHIVE_DIR=... WPKIT_ORIGIN=https://example.com node scripts/fidelity-text.mjs [--port 8899] [--evidence <json>]");
  process.exit(1);
}

function parseArgs(argv) {
  const options = { port: 8899, evidence: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--port") { options.port = Number(argv[++index]); if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) usage("--port requires a valid port number"); }
    else if (flag === "--evidence") options.evidence = resolve(argv[++index] ?? usage("--evidence requires a JSON path"));
    else usage(`Unknown option: ${flag}`);
  }
  return options;
}

async function loadConfig() {
  if (!existsSync(configPath)) return { skipPaths: new Set(), textReplacements: [] };
  let raw;
  try { raw = JSON.parse(await readFile(configPath, "utf8")); } catch (error) { throw new Error(`fidelity-text.config.json: ${error instanceof Error ? error.message : error}`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("fidelity-text.config.json: root must be an object");
  for (const key of Object.keys(raw)) if (!["skipPaths", "textReplacements"].includes(key)) throw new Error(`fidelity-text.config.json: unknown key ${key}`);
  const skipPaths = raw.skipPaths ?? [];
  const textReplacements = raw.textReplacements ?? [];
  if (!Array.isArray(skipPaths) || skipPaths.some((path) => typeof path !== "string" || !path.startsWith("/"))) throw new Error("fidelity-text.config.json: skipPaths must be an array of absolute paths");
  if (!Array.isArray(textReplacements) || textReplacements.some((rule) => !rule || typeof rule !== "object" || Array.isArray(rule) || typeof rule.from !== "string" || !rule.from || typeof rule.to !== "string" || Object.keys(rule).some((key) => !["from", "to"].includes(key)))) throw new Error("fidelity-text.config.json: textReplacements must be [{ from, to }] with non-empty string from");
  return { skipPaths: new Set(skipPaths), textReplacements };
}

async function listen(server, port) {
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolveListen(); }); });
}

async function closeServer(server) { await new Promise((done) => server.close(() => done())); }

function encodedPath(pathname) { return encodeURIComponent(pathname === "/" ? "/" : `${pathname.replace(/\/+$/, "")}/`); }
function canonicalPath(pathname) { return pathname === "/" ? "/" : `${pathname.replace(/\/+$/, "")}/`; }

function outputFile(pathname) { return pathname === "/" ? join(outDir, "index.html") : join(outDir, ...pathname.slice(1).split("/"), "index.html"); }

function normalize(text) { return text.replace(/\s+/g, " ").trim(); }

function replaceExpected(text, replacements) { return replacements.reduce((current, rule) => current.replaceAll(rule.from, rule.to), text); }

function firstDifference(origin, built) {
  let index = 0;
  const max = Math.min(origin.length, built.length);
  while (index < max && origin[index] === built[index]) index += 1;
  const start = Math.max(0, index - 48);
  return { offset: index, origin: origin.slice(start, index + 96), built: built.slice(start, index + 96) };
}

function sessionStorageEntries() {
  if (!process.env.MEASURE_SESSION_STORAGE) return null;
  let entries;
  try { entries = JSON.parse(process.env.MEASURE_SESSION_STORAGE); } catch { throw new Error("MEASURE_SESSION_STORAGE must be a JSON object"); }
  if (!entries || typeof entries !== "object" || Array.isArray(entries) || Object.values(entries).some((value) => typeof value !== "string")) throw new Error("MEASURE_SESSION_STORAGE must be a JSON object with string values");
  return entries;
}

async function measurementState(context) {
  const entries = sessionStorageEntries();
  if (entries) await context.addInitScript((values) => { for (const [key, value] of Object.entries(values)) sessionStorage.setItem(key, value); }, entries);
  const css = [process.env.MEASURE_EXTRA_CSS ?? "", process.env.MEASURE_HIDE_SELECTORS ? `${process.env.MEASURE_HIDE_SELECTORS} { display: none !important; }` : ""].filter(Boolean).join("\n");
  if (css) await context.addInitScript((styleText) => { const install = () => { const style = document.createElement("style"); style.textContent = styleText; document.documentElement.appendChild(style); }; if (document.documentElement) install(); else addEventListener("DOMContentLoaded", install); }, css);
}

async function visibleText(page) {
  return page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode(node) {
      const element = node.parentElement;
      if (!element || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(element.tagName)) return NodeFilter.FILTER_REJECT;
      return element.checkVisibility({ checkOpacity: false }) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    } });
    const parts = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) { const value = node.textContent.replace(/\s+/g, " ").trim(); if (value) parts.push(value); }
    return parts.join("\n");
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!archiveDir) usage("WPKIT_ARCHIVE_DIR is required");
  let origin;
  try { origin = new URL(process.env.WPKIT_ORIGIN ?? "").origin; } catch { usage("WPKIT_ORIGIN must be an absolute URL"); }
  if (!existsSync(outDir)) throw new Error(`out/ is missing at ${outDir}; npm run build が先です`);
  const config = await loadConfig();
  const inventory = JSON.parse(await readFile(join(archiveDir, "inventory.json"), "utf8"));
  if (!Array.isArray(inventory.urls)) throw new Error("archive inventory.json.urls must be an array");
  const records = inventory.urls.filter((entry) => entry?.status === 200 && typeof entry.url === "string").map((entry) => canonicalPath(new URL(entry.url).pathname)).filter((pathname) => !config.skipPaths.has(pathname) && existsSync(join(archiveDir, "pages", encodedPath(pathname), "page.html")) && existsSync(outputFile(pathname)));
  const server = createCachedServer();
  const browser = await chromium.launch({ headless: true });
  const result = { generatedAt: new Date().toISOString(), compared: [], skipped: inventory.urls.length - records.length };
  try {
    await listen(server, options.port);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
    try {
      await measurementState(context);
      await installCacheRoutes(context, { hosts: [new URL(origin).hostname, "fonts.googleapis.com", "fonts.gstatic.com", "images.microcms-assets.io"], passthrough: PASSTHROUGH });
      for (const pathname of records) {
        const documentUrl = new URL(pathname, origin).href;
        const html = await readFile(join(archiveDir, "pages", encodedPath(pathname), "page.html"), "utf8");
        await context.route(documentUrl, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
        const archivePage = await context.newPage();
        const builtPage = await context.newPage();
        try {
          await archivePage.goto(documentUrl, { waitUntil: "networkidle", timeout: 25_000 });
          await builtPage.goto(`http://127.0.0.1:${options.port}${pathname}`, { waitUntil: "networkidle", timeout: 25_000 });
          const [archiveText, builtText] = await Promise.all([visibleText(archivePage), visibleText(builtPage)]);
          const expected = replaceExpected(normalize(archiveText), config.textReplacements);
          const actual = normalize(builtText);
          result.compared.push({ path: pathname, status: expected === actual ? (normalize(archiveText) === actual ? "match" : "intended") : "mismatch", originLength: archiveText.length, builtLength: builtText.length, ...(expected === actual ? {} : firstDifference(expected, actual)) });
        } catch (error) { result.compared.push({ path: pathname, status: "failed", error: error instanceof Error ? error.message : String(error) }); }
        finally { await archivePage.close().catch(() => {}); await builtPage.close().catch(() => {}); await context.unroute(documentUrl).catch(() => {}); }
      }
    } finally { await context.close(); }
  } finally { await browser.close(); await closeServer(server).catch(() => {}); }
  result.counts = Object.fromEntries(["match", "intended", "mismatch", "failed"].map((status) => [status, result.compared.filter((item) => item.status === status).length]));
  await mkdir(fidelityDir, { recursive: true });
  await writeFile(join(fidelityDir, "text.json"), `${JSON.stringify(result, null, 2)}\n`);
  if (options.evidence) { await mkdir(join(options.evidence, ".."), { recursive: true }); await writeFile(options.evidence, `${JSON.stringify(result, null, 2)}\n`); }
  console.log(JSON.stringify(result.counts, null, 2));
  if (result.counts.failed || result.counts.mismatch) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
