/*
 * Diff-first visual scan for the static export. It intentionally has no build step:
 * run after `out/` has been produced.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { normalizePathname, surfaceForPath } from "./lib/surfaces.mjs";
import { installCacheRoutes } from "./lib/remote-cache.mjs";
import { createCachedServer } from "./serve-cached.mjs";

const project = resolve(import.meta.dirname, "..");
const outDir = join(project, "out");
const fidelityDir = join(project, "_scratch", "fidelity");
// 凍結アーカイブとIRの場所(kit規約の既定。案件でディレクトリ名が違う場合は環境変数で上書き)
const archiveDir = process.env.WPKIT_ARCHIVE ?? join(project, "_scratch", "archive");
const irDir = process.env.WPKIT_IR_DIR ?? join(project, "_scratch", "ir");
const baselineRoot = join(archiveDir, "pages");
const currentRoot = join(fidelityDir, "current");
const diffsRoot = join(fidelityDir, "diffs");

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: node scripts/fidelity-scan.mjs [--limit N] [--only <surfaceId>] [--concurrency 4] [--port 8899] [--keep-diffs 50]");
  process.exit(1);
}

function parseArgs(argv) {
  const options = { limit: Infinity, only: null, concurrency: 4, port: 8899, keepDiffs: 50 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--only") options.only = argv[++index] ?? usage("--only requires a surface id");
    else if (["--limit", "--concurrency", "--port", "--keep-diffs"].includes(flag)) {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 0 || (flag === "--concurrency" && value === 0)) usage(`${flag} requires a valid integer`);
      if (flag === "--limit") options.limit = value;
      if (flag === "--concurrency") options.concurrency = value;
      if (flag === "--port") options.port = value;
      if (flag === "--keep-diffs") options.keepDiffs = value;
    } else usage(`Unknown option: ${flag}`);
  }
  return options;
}

function outputFile(pathname) {
  return pathname === "/" ? join(outDir, "index.html") : join(outDir, ...pathname.slice(1).split("/"), "index.html");
}

function encodedPath(pathname) {
  return encodeURIComponent(pathname);
}

function imagePath(root, pathname, viewport) {
  return join(root, encodedPath(pathname), `${viewport}.png`);
}

function emptyViewport(error) {
  return { ratio: null, heightOld: null, heightNew: null, diffPng: null, ...(error ? { error } : {}) };
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

function withTimeout(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function capture(context, baseUrl, pathname, destination) {
  const page = await context.newPage();
  try {
    await withTimeout((async () => {
      await page.goto(new URL(pathname, baseUrl).href, { waitUntil: "networkidle", timeout: 25_000 });
      await page.evaluate(async () => { await document.fonts.ready; });
      await mkdir(join(destination, ".."), { recursive: true });
      await page.screenshot({ path: destination, fullPage: true, type: "png" });
    })(), 30_000, pathname);
  } finally {
    await page.close().catch(() => {});
  }
}

function paddedImage(source, width, height) {
  const padded = new PNG({ width, height });
  padded.data.fill(255);
  PNG.bitblt(source, padded, 0, 0, source.width, source.height, 0, 0);
  return padded;
}

async function compareImages(oldFile, newFile, { includeDiff = false } = {}) {
  const [oldBuffer, newBuffer] = await Promise.all([readFile(oldFile), readFile(newFile)]);
  const oldImage = PNG.sync.read(oldBuffer);
  const newImage = PNG.sync.read(newBuffer);
  const width = Math.max(oldImage.width, newImage.width);
  const height = Math.max(oldImage.height, newImage.height);
  const oldPadded = paddedImage(oldImage, width, height);
  const newPadded = paddedImage(newImage, width, height);
  const diff = includeDiff ? new PNG({ width, height }) : null;
  const mismatchedPixels = pixelmatch(oldPadded.data, newPadded.data, diff?.data, width, height, { threshold: 0.1 });
  return {
    ratio: mismatchedPixels / (width * height),
    heightOld: oldImage.height,
    heightNew: newImage.height,
    ...(includeDiff ? { diff } : {}),
  };
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await mapper(values[index], index);
    }
  }));
  return results;
}

function viewports() {
  return { desktop: { width: 1280, height: 800 }, mobile: { width: 375, height: 812 } };
}

async function scanRecord(record, contexts, baseUrl) {
  const viewportResults = {};
  let captureError = null;
  for (const [name] of Object.entries(viewports())) {
    const destination = imagePath(currentRoot, record.path, name);
    try {
      await capture(contexts[name], baseUrl, record.path, destination);
      viewportResults[name] = { destination };
    } catch (error) {
      captureError = error instanceof Error ? error.message : String(error);
      viewportResults[name] = { error: captureError };
    }
  }
  if (captureError) {
    return { ...record, desktop: emptyViewport(viewportResults.desktop.error), mobile: emptyViewport(viewportResults.mobile.error), status: "screenshot-failed" };
  }

  const oldDesktop = imagePath(baselineRoot, record.path, "desktop");
  const oldMobile = imagePath(baselineRoot, record.path, "mobile");
  if (!existsSync(oldDesktop) || !existsSync(oldMobile)) {
    const currentSizes = await Promise.all(["desktop", "mobile"].map(async (name) => {
      const image = PNG.sync.read(await readFile(viewportResults[name].destination));
      return [name, image.height];
    }));
    for (const [name, heightNew] of currentSizes) viewportResults[name].heightNew = heightNew;
    return {
      ...record,
      desktop: { ...emptyViewport(), heightNew: viewportResults.desktop.heightNew },
      mobile: { ...emptyViewport(), heightNew: viewportResults.mobile.heightNew },
      status: "no-baseline",
    };
  }

  // 破損PNG(アーカイブ側スクショの一部に存在)で全体を落とさず、1件の失敗として継続する。
  try {
    const [desktop, mobile] = await Promise.all([
      compareImages(oldDesktop, viewportResults.desktop.destination),
      compareImages(oldMobile, viewportResults.mobile.destination),
    ]);
    return {
      ...record,
      desktop: { ...desktop, diffPng: null },
      mobile: { ...mobile, diffPng: null },
      status: "ok",
    };
  } catch (error) {
    console.warn(`compare failed: ${record.path}: ${error instanceof Error ? error.message : error}`);
    return { ...record, desktop: emptyViewport(), mobile: emptyViewport(), status: "screenshot-failed" };
  }
}

async function writeTopDiffs(records, keepDiffs) {
  const candidates = records.flatMap((record) => ["desktop", "mobile"].flatMap((viewport) => {
    const ratio = record[viewport]?.ratio;
    return record.status === "ok" && Number.isFinite(ratio) ? [{ record, viewport, ratio }] : [];
  })).sort((left, right) => right.ratio - left.ratio).slice(0, keepDiffs);
  await Promise.all(candidates.map(async ({ record, viewport }) => {
    const comparison = await compareImages(imagePath(baselineRoot, record.path, viewport), imagePath(currentRoot, record.path, viewport), { includeDiff: true });
    const destination = imagePath(diffsRoot, record.path, viewport);
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, PNG.sync.write(comparison.diff));
    record[viewport].diffPng = relative(project, destination).split(sep).join("/");
  }));
}

function printSummary(records) {
  const counts = Object.fromEntries(["ok", "no-baseline", "no-new", "screenshot-failed"].map((status) => [status, records.filter((record) => record.status === status).length]));
  console.log(JSON.stringify({ scanned: records.length, status: counts }, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [inventory, routes] = await Promise.all([
    readFile(join(archiveDir, "inventory.json"), "utf8").then(JSON.parse),
    readFile(join(irDir, "routes.json"), "utf8").then(JSON.parse),
  ]);
  const allRecords = inventory.urls.filter((entry) => entry.status === 200).map((entry) => {
    const path = normalizePathname(new URL(entry.url).pathname);
    return { url: entry.url, path, surface: surfaceForPath(path, routes) };
  });
  const selected = allRecords.filter((record) => existsSync(outputFile(record.path)) && (!options.only || record.surface === options.only)).slice(0, options.limit);

  const server = createCachedServer();
  let browser;
  try {
    await listen(server, options.port);
    browser = await chromium.launch({ headless: true });
    const results = [];
    for (let offset = 0; offset < selected.length; offset += 50) {
      const batch = selected.slice(offset, offset + 50);
      const contexts = Object.fromEntries(await Promise.all(Object.entries(viewports()).map(async ([name, viewport]) => {
        const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: "reduce" });
        // 原点サーバー保護: 全外部リクエストをfetch-onceキャッシュ経由に。動的埋め込み(YouTube等)だけ素通し。
        const originHost = process.env.WPKIT_ORIGIN ? new URL(process.env.WPKIT_ORIGIN).hostname : null;
        await installCacheRoutes(context, { hosts: [originHost, "fonts.googleapis.com", "fonts.gstatic.com"].filter(Boolean), passthrough: ["youtube.com", "ytimg.com", "googlevideo.com"] });
        return [name, context];
      })));
      try {
        results.push(...await mapWithConcurrency(batch, options.concurrency, (record) => scanRecord(record, contexts, `http://127.0.0.1:${options.port}/`)));
      } finally {
        await Promise.all(Object.values(contexts).map((context) => context.close()));
      }
    }
    await writeTopDiffs(results, options.keepDiffs);
    await mkdir(fidelityDir, { recursive: true });
    await writeFile(join(fidelityDir, "scan.json"), `${JSON.stringify(results, null, 2)}\n`);
    printSummary(results);
  } finally {
    await browser?.close();
    await closeServer(server).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
