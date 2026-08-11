/* Render frozen archive HTML into deterministic fidelity-scan baselines. */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { installCacheRoutes } from "./lib/remote-cache.mjs";

const project = resolve(import.meta.dirname, "..");
const archiveDir = resolve(process.env.WPKIT_ARCHIVE_DIR ?? join(project, "_scratch", "archive"));
const baselineDir = resolve(process.env.WPKIT_BASELINE_DIR ?? join(project, "_scratch", "fidelity", "baselines"));
const fidelityDir = join(project, "_scratch", "fidelity");
const VIEWPORTS = { desktop: { width: 1280, height: 800 }, mobile: { width: 375, height: 812 } };
const PASSTHROUGH = ["youtube.com", "ytimg.com", "googlevideo.com"];

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: WPKIT_ORIGIN=https://example.com [WPKIT_ARCHIVE_DIR=...] [WPKIT_BASELINE_DIR=...] node scripts/render-archive-baselines.mjs [--force] [--evidence <json>]");
  process.exit(1);
}

function parseArgs(argv) {
  const options = { force: false, evidence: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--force") options.force = true;
    else if (flag === "--evidence") options.evidence = resolve(argv[++index] ?? usage("--evidence requires a JSON path"));
    else usage(`Unknown option: ${flag}`);
  }
  return options;
}

function encodedPath(pathname) {
  return encodeURIComponent(pathname === "/" ? "/" : `${pathname.replace(/\/+$/, "")}/`);
}

function sessionStorageEntries() {
  if (!process.env.MEASURE_SESSION_STORAGE) return null;
  let entries;
  try { entries = JSON.parse(process.env.MEASURE_SESSION_STORAGE); } catch { throw new Error("MEASURE_SESSION_STORAGE must be a JSON object"); }
  if (!entries || typeof entries !== "object" || Array.isArray(entries) || Object.values(entries).some((value) => typeof value !== "string")) throw new Error("MEASURE_SESSION_STORAGE must be a JSON object with string values");
  return entries;
}

async function installMeasurementState(context) {
  const entries = sessionStorageEntries();
  if (entries) await context.addInitScript((values) => { for (const [key, value] of Object.entries(values)) sessionStorage.setItem(key, value); }, entries);
  const css = [process.env.MEASURE_EXTRA_CSS ?? "", process.env.MEASURE_HIDE_SELECTORS ? `${process.env.MEASURE_HIDE_SELECTORS} { display: none !important; }` : ""].filter(Boolean).join("\n");
  if (css) await context.addInitScript((styleText) => {
    const install = () => { const style = document.createElement("style"); style.textContent = styleText; document.documentElement.appendChild(style); };
    if (document.documentElement) install(); else addEventListener("DOMContentLoaded", install);
  }, css);
}

async function stabilize(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    document.documentElement.style.setProperty("scroll-behavior", "auto", "important");
    const step = Math.max(1, Math.round(window.innerHeight * 0.85));
    const bottom = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    for (let y = 0; y < bottom; y += step) { window.scrollTo(0, y); await new Promise((done) => requestAnimationFrame(done)); }
    window.scrollTo(0, bottom);
    await new Promise((done) => requestAnimationFrame(done));
    window.scrollTo(0, 0);
    while (window.scrollY !== 0) { window.scrollTo(0, 0); await new Promise((done) => requestAnimationFrame(done)); }
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let origin;
  try { origin = new URL(process.env.WPKIT_ORIGIN ?? "").origin; } catch { usage("WPKIT_ORIGIN must be an absolute URL"); }
  const inventory = JSON.parse(await readFile(join(archiveDir, "inventory.json"), "utf8"));
  if (!Array.isArray(inventory.urls)) throw new Error("archive inventory.json.urls must be an array");
  const records = inventory.urls.filter((entry) => entry?.status === 200 && typeof entry.url === "string").map((entry) => {
    const sourcePathname = new URL(entry.url).pathname;
    const pathname = sourcePathname === "/" ? "/" : `${sourcePathname.replace(/\/+$/, "")}/`;
    const encoded = encodedPath(pathname);
    return { pathname, encoded, html: join(archiveDir, "pages", encoded, "page.html") };
  }).filter((record) => existsSync(record.html));
  const summary = { generatedAt: new Date().toISOString(), archiveDir, baselineDir, rendered: 0, skipped: 0, failed: [] };
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [name, viewport] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: "reduce" });
      try {
        await installMeasurementState(context);
        await installCacheRoutes(context, { hosts: [new URL(origin).hostname, "fonts.googleapis.com", "fonts.gstatic.com", "images.microcms-assets.io"], passthrough: PASSTHROUGH });
        for (const record of records) {
          const destination = join(baselineDir, record.encoded, `${name}.png`);
          if (!options.force && existsSync(destination)) { summary.skipped += 1; continue; }
          const documentUrl = new URL(record.pathname, origin).href;
          const html = await readFile(record.html, "utf8");
          await context.route(documentUrl, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
          const page = await context.newPage();
          try {
            await page.goto(documentUrl, { waitUntil: "networkidle", timeout: 25_000 });
            await stabilize(page);
            await mkdir(join(destination, ".."), { recursive: true });
            await page.screenshot({ path: destination, fullPage: true, type: "png" });
            summary.rendered += 1;
          } catch (error) {
            summary.failed.push({ path: record.pathname, viewport: name, error: error instanceof Error ? error.message : String(error) });
          } finally {
            await page.close().catch(() => {});
            await context.unroute(documentUrl).catch(() => {});
          }
        }
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  await mkdir(fidelityDir, { recursive: true });
  await writeFile(join(fidelityDir, "archive-baselines.json"), `${JSON.stringify(summary, null, 2)}\n`);
  if (options.evidence) { await mkdir(join(options.evidence, ".."), { recursive: true }); await writeFile(options.evidence, `${JSON.stringify(summary, null, 2)}\n`); }
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
