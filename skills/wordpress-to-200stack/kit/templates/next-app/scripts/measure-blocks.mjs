/*
 * Deterministic DOM geometry measurement for archive-vs-export fidelity work.
 * This is a measurement tool, not a gate: people apply SKILL.md §6.5.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { installCacheRoutes } from "./lib/remote-cache.mjs";
import { createCachedServer } from "./serve-cached.mjs";

const project = resolve(import.meta.dirname, "..");
const outDir = join(project, "out");
const fidelityDir = join(project, "_scratch", "fidelity");
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 375, height: 812 },
};
const PASSTHROUGH = ["youtube.com", "ytimg.com", "googlevideo.com"];

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: WPKIT_ARCHIVE_DIR=... WPKIT_ORIGIN=https://example.com node scripts/measure-blocks.mjs [--config blocks.config.json] [--only <surfaceId>] [--viewport desktop|mobile] [--port 8899] [--strict]");
  process.exit(1);
}

function parseArgs(argv) {
  const options = { config: join(project, "blocks.config.json"), only: null, viewport: null, port: 8899, strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--config") options.config = resolve(argv[++index] ?? usage("--config requires a path"));
    else if (flag === "--only") options.only = argv[++index] ?? usage("--only requires a surface id");
    else if (flag === "--viewport") {
      const viewport = argv[++index] ?? usage("--viewport requires desktop or mobile");
      if (!(viewport in VIEWPORTS)) usage("--viewport requires desktop or mobile");
      options.viewport = viewport;
    } else if (flag === "--port") {
      const port = Number(argv[++index]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) usage("--port requires a valid port number");
      options.port = port;
    } else if (flag === "--strict") options.strict = true;
    else usage(`Unknown option: ${flag}`);
  }
  return options;
}

function configError(message) {
  throw new Error(`blocks.config.json: ${message}`);
}

function requireBlock(block, location, ids) {
  if (!block || typeof block !== "object" || Array.isArray(block)) configError(`${location} must be an object`);
  for (const field of ["id", "selector", "reason"]) {
    if (typeof block[field] !== "string" || !block[field].trim()) configError(`${location}.${field} must be a non-empty string`);
  }
  if (block.id === "documentHeight") configError(`${location}.id must not be documentHeight (it is a built-in metric)`);
  if (ids.has(block.id)) configError(`${location}.id duplicates ${block.id}`);
  ids.add(block.id);
  return { id: block.id, selector: block.selector, reason: block.reason };
}

function validateConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) configError("root must be an object");
  if (!Array.isArray(raw.common)) configError("common must be an array");
  if (!Array.isArray(raw.surfaces)) configError("surfaces must be an array");
  const ids = new Set();
  const common = raw.common.map((block, index) => requireBlock(block, `common[${index}]`, ids));
  const surfaces = raw.surfaces.map((surface, index) => {
    const location = `surfaces[${index}]`;
    if (!surface || typeof surface !== "object" || Array.isArray(surface)) configError(`${location} must be an object`);
    if (typeof surface.surface !== "string" || !surface.surface.trim()) configError(`${location}.surface must be a non-empty string`);
    if (typeof surface.path !== "string" || !surface.path.startsWith("/")) configError(`${location}.path must start with /`);
    if (!Array.isArray(surface.blocks)) configError(`${location}.blocks must be an array`);
    return {
      surface: surface.surface,
      path: surface.path,
      blocks: surface.blocks.map((block, blockIndex) => requireBlock(block, `${location}.blocks[${blockIndex}]`, ids)),
    };
  });
  return { common, surfaces };
}

function encodedPath(pathname) {
  return encodeURIComponent(pathname);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function display(value) {
  return value == null ? "—" : String(value);
}

function originUrl(origin, pathname) {
  return `${origin}${pathname}`;
}

async function listen(server, port) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

async function closeServer(server) {
  await new Promise((resolveClose) => server.close(() => resolveClose()));
}

async function createContext(browser, viewport, originHost, documentUrl, html) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: "reduce" });
  // Keep exactly the same cache hosts and dynamic-media passthrough as fidelity-scan.mjs.
  await installCacheRoutes(context, {
    hosts: [originHost, "fonts.googleapis.com", "fonts.gstatic.com"].filter(Boolean),
    passthrough: PASSTHROUGH,
  });
  // Later registrations are checked first, so this document always comes from the frozen archive.
  await context.route(documentUrl, async (route) => {
    await route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
  });
  return context;
}

async function initializePage(page, url) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 25_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    const step = Math.max(1, Math.round(window.innerHeight * 0.85));
    const bottom = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    for (let y = 0; y < bottom; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
    }
    window.scrollTo(0, bottom);
    await new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
    window.scrollTo(0, 0);
    await new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
  });
}

async function measurePage(context, url, blocks) {
  const page = await context.newPage();
  try {
    await initializePage(page, url);
    return await page.evaluate((entries) => {
      const measured = entries.map(({ id, selector }) => {
        const elements = document.querySelectorAll(selector);
        const element = elements[0];
        if (!element) return { id, matchCount: 0, geometry: null };
        const rect = element.getBoundingClientRect();
        return {
          id,
          matchCount: elements.length,
          geometry: { y: rect.top + window.scrollY, height: rect.height },
        };
      });
      return { blocks: measured, documentHeight: document.documentElement.scrollHeight };
    }, blocks);
  } finally {
    await page.close().catch(() => {});
  }
}

function blockResult(block, origin, built, viewport, surface) {
  const originMetric = origin.geometry ? { y: round(origin.geometry.y), height: round(origin.geometry.height) } : null;
  const builtMetric = built.geometry ? { y: round(built.geometry.y), height: round(built.geometry.height) } : null;
  if (origin.matchCount >= 2) console.error(`warning: ${surface} ${viewport} ${block.id}: origin selector matched ${origin.matchCount} elements; measuring the first`);
  if (built.matchCount >= 2) console.error(`warning: ${surface} ${viewport} ${block.id}: built selector matched ${built.matchCount} elements; measuring the first`);
  const status = !originMetric ? "missing-origin" : !builtMetric ? "missing-built" : "ok";
  return {
    id: block.id,
    selector: block.selector,
    origin: originMetric,
    built: builtMetric,
    dy: originMetric && builtMetric ? round(builtMetric.y - originMetric.y) : null,
    dh: originMetric && builtMetric ? round(builtMetric.height - originMetric.height) : null,
    matchCount: { origin: origin.matchCount, built: built.matchCount },
    status,
  };
}

function viewportResult(blocks, originMeasured, builtMeasured, viewport, surface) {
  const originById = new Map(originMeasured.blocks.map((entry) => [entry.id, entry]));
  const builtById = new Map(builtMeasured.blocks.map((entry) => [entry.id, entry]));
  const results = blocks.map((block) => blockResult(block, originById.get(block.id), builtById.get(block.id), viewport, surface));
  const originHeight = round(originMeasured.documentHeight);
  const builtHeight = round(builtMeasured.documentHeight);
  return {
    blocks: results,
    documentHeight: { origin: originHeight, built: builtHeight, dh: round(builtHeight - originHeight) },
  };
}

function nonZeroCount(viewports) {
  return Object.values(viewports).reduce((total, viewport) => total
    + viewport.blocks.filter((block) => (Number.isFinite(block.dy) && block.dy !== 0) || (Number.isFinite(block.dh) && block.dh !== 0)).length
    + (viewport.documentHeight.dh !== 0 ? 1 : 0), 0);
}

function allStatusesOk(viewports) {
  return Object.values(viewports).every((viewport) => viewport.blocks.every((block) => block.status === "ok"));
}

function markdownReport(result) {
  const lines = [`# Block measurements: ${result.surface}`, "", `- Path: \`${result.path}\``, `- Origin source: \`${result.originSource}\``, `- Generated: ${result.generatedAt}`, ""];
  for (const [viewport, metrics] of Object.entries(result.viewports)) {
    lines.push(`## ${viewport}`, "", "| Block | Origin y | Built y | dy | Origin h | Built h | dh | Status |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
    for (const block of metrics.blocks) {
      lines.push(`| ${block.id} | ${display(block.origin?.y)} | ${display(block.built?.y)} | ${display(block.dy)} | ${display(block.origin?.height)} | ${display(block.built?.height)} | ${display(block.dh)} | ${block.status} |`);
    }
    const height = metrics.documentHeight;
    lines.push(`| documentHeight | — | — | — | ${display(height.origin)} | ${display(height.built)} | ${display(height.dh)} | ok |`, "");
  }
  lines.push(`Non-zero measurements: ${result.nonZero}`, `Pass: ${result.pass}`);
  return `${lines.join("\n")}\n`;
}

async function measureSurface({ surface, path, blocks }, contexts, origin, port, selectedViewports, sourcePath) {
  const viewports = {};
  for (const viewport of selectedViewports) {
    const context = contexts[viewport];
    const originMeasured = await measurePage(context, originUrl(origin, path), blocks);
    const builtMeasured = await measurePage(context, `http://127.0.0.1:${port}${path}`, blocks);
    viewports[viewport] = viewportResult(blocks, originMeasured, builtMeasured, viewport, surface);
  }
  const result = {
    generatedAt: new Date().toISOString(),
    surface,
    path,
    originSource: sourcePath,
    viewports,
  };
  result.nonZero = nonZeroCount(viewports);
  result.pass = result.nonZero === 0 && allStatusesOk(viewports);
  await mkdir(fidelityDir, { recursive: true });
  const jsonPath = join(fidelityDir, `blocks-${surface}.json`);
  const markdownPath = join(fidelityDir, `blocks-${surface}.md`);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`),
    writeFile(markdownPath, markdownReport(result)),
  ]);
  return { result, jsonPath, markdownPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const archiveDir = process.env.WPKIT_ARCHIVE_DIR;
  const rawOrigin = process.env.WPKIT_ORIGIN;
  if (!archiveDir || !rawOrigin) usage("WPKIT_ARCHIVE_DIR and WPKIT_ORIGIN are required");
  let origin;
  try {
    origin = new URL(rawOrigin).origin;
  } catch {
    usage("WPKIT_ORIGIN must be an absolute URL");
  }
  if (!existsSync(outDir)) throw new Error(`out/ is missing at ${outDir}; npm run build が先です`);

  let rawConfig;
  try {
    rawConfig = JSON.parse(await readFile(options.config, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read config ${options.config}: ${error instanceof Error ? error.message : error}`);
  }
  const config = validateConfig(rawConfig);
  const selected = config.surfaces.filter((entry) => !options.only || entry.surface === options.only);
  if (options.only && selected.length === 0) configError(`no surface matches --only ${options.only}`);
  const selectedViewports = options.viewport ? [options.viewport] : Object.keys(VIEWPORTS);
  const sourceInputs = await Promise.all(selected.map(async (entry) => {
    const sourcePath = join(resolve(archiveDir), "pages", encodedPath(entry.path), "page.html");
    try {
      return { sourcePath, html: await readFile(sourcePath, "utf8") };
    } catch {
      throw new Error(`Frozen page.html is missing for ${entry.surface}: ${sourcePath}`);
    }
  }));

  const server = createCachedServer();
  let browser;
  try {
    await listen(server, options.port);
    browser = await chromium.launch({ headless: true });
    const summaries = [];
    let hasMeasurementError = false;
    for (const [index, entry] of selected.entries()) {
      const input = sourceInputs[index];
      const surfaceContexts = {};
      for (const viewport of selectedViewports) {
        // A dedicated context keeps the later exact document route scoped to this surface.
        const context = await createContext(browser, VIEWPORTS[viewport], new URL(origin).hostname, originUrl(origin, entry.path), input.html);
        surfaceContexts[viewport] = context;
      }
      try {
        const measured = await measureSurface({ ...entry, blocks: [...config.common, ...entry.blocks] }, surfaceContexts, origin, options.port, selectedViewports, input.sourcePath);
        summaries.push({ surface: entry.surface, path: entry.path, nonZero: measured.result.nonZero, pass: measured.result.pass, json: measured.jsonPath, markdown: measured.markdownPath });
        if (!allStatusesOk(measured.result.viewports)) hasMeasurementError = true;
      } finally {
        await Promise.all(Object.values(surfaceContexts).map((context) => context.close()));
      }
    }
    console.log(JSON.stringify(summaries, null, 2));
    if (hasMeasurementError) process.exitCode = 1;
    else if (options.strict && summaries.some((summary) => summary.nonZero > 0)) process.exitCode = 2;
  } finally {
    await browser?.close();
    await closeServer(server).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
