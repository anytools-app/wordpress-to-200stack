/* Capture and compare CSS-pruning screenshots from the current static out/. */
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const project = resolve(import.meta.dirname, "..");
const defaultOutDir = join(project, "out");
const auditDir = join(project, "_scratch", "css-audit");
const shotsDir = join(auditDir, "shots");
const reportFile = join(auditDir, "report.json");
// TODO(案件): 代表 surface と、CSS 構成が異なるページを網羅する URL に変更する。
const requiredPages = ["/"];
const viewports = {
  desktop: { width: 1280, height: 900 },
  mobile: { width: 375, height: 812 },
};
const mimeTypes = {
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2",
};

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: node scripts/css-visual-diff.mjs capture --label <name> [--out-dir <path>] [--sample <N>] | compare [--labels <a>,<b>]");
  process.exit(1);
}

function label(value) {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes(",")) usage("Labels must be non-empty file names.");
  return value;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === "compare") {
    if (rest.length === 0) return { command, labels: ["before", "after"] };
    if (rest.length === 2 && rest[0] === "--labels") {
      const labels = rest[1].split(",").map(label);
      if (labels.length === 2) return { command, labels };
    }
    usage("Invalid compare arguments.");
  }
  if (command !== "capture") usage("Invalid arguments.");

  const options = { command, outDir: defaultOutDir };
  const seen = new Set();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!value || seen.has(flag)) usage("Invalid capture arguments.");
    seen.add(flag);
    if (flag === "--label") options.label = label(value);
    else if (flag === "--out-dir") options.outDir = resolve(value);
    else if (flag === "--sample" && /^\d+$/.test(value) && Number(value) > 0) options.sample = Number(value);
    else usage("Invalid capture arguments.");
  }
  if (!options.label) usage("Capture requires --label <name>.");
  return options;
}

function imagePath(root, pathname, viewport) {
  return join(root, encodeURIComponent(pathname), `${viewport}.png`);
}

function outputFile(root, pathname) {
  return pathname === "/" ? join(root, "index.html") : join(root, ...pathname.slice(1).split("/"), "index.html");
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

function sortedPaths(paths) {
  return [...paths].sort((left, right) => left === "/" ? -1 : right === "/" ? 1 : left.localeCompare(right));
}

async function selectedPages(outDir, sample) {
  const [report, legacyMeta, vendorManifest] = await Promise.all([
    readFile(reportFile, "utf8").then(JSON.parse),
    readFile(join(project, ".next-data", "legacy-meta.json"), "utf8").then(JSON.parse),
    readFile(join(project, "public", "vendor", "manifest.json"), "utf8").then(JSON.parse),
  ]);
  // legacy-meta keeps the original CDN URL. The vendor manifest is the
  // generated, local-public URL that actually appears in out/.
  const stylesheetToLocal = new Map(Object.entries(vendorManifest));
  const pages = new Set(sample ? requiredPages : ["/"]);
  if (sample) {
    const groups = new Map();
    for (const [pathname, meta] of Object.entries(legacyMeta.byPath)) {
      const stylesheets = (meta.stylesheets ?? []).map((stylesheet) => stylesheetToLocal.get(stylesheet) ?? stylesheet);
      const key = JSON.stringify(stylesheets);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(pathname);
    }
    for (const paths of groups.values()) {
      sortedPaths(paths).slice(0, sample).forEach((pathname) => pages.add(pathname));
    }
  } else {
    const targetCss = new Set(report.files.filter((file) => file.unusedSelectors?.length).map((file) => file.file));
    for (const cssFile of targetCss) {
      const matching = Object.entries(legacyMeta.byPath)
        .filter(([, meta]) => meta.stylesheets?.some((stylesheet) => (stylesheetToLocal.get(stylesheet) ?? stylesheet) === cssFile))
        .map(([pathname]) => pathname)
        .sort()
        .slice(0, 2);
      matching.forEach((pathname) => pages.add(pathname));
    }
  }
  return Promise.all(sortedPaths(pages).map(async (pathname) => ({ pathname, available: await exists(outputFile(outDir, pathname)) })))
    .then((records) => records.filter((record) => record.available).map((record) => record.pathname));
}

function staticServer(outDir) {
  return createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      const candidate = normalize(join(outDir, pathname));
      if (!candidate.startsWith(`${outDir}${sep}`) && candidate !== outDir) throw new Error("Invalid path");
      let file = candidate;
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
      response.writeHead(200, { "content-type": mimeTypes[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function capture({ label, outDir, sample }) {
  const pages = await selectedPages(outDir, sample);
  const destinationRoot = join(shotsDir, label);
  const server = staticServer(outDir);
  const baseUrl = await listen(server);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const [name, viewport] of Object.entries(viewports)) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: "reduce" });
      // 検証の不変条件: 外部への実フェッチ禁止(移行元サーバーの転送量保護)。
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return route.continue();
        return route.abort();
      });
      await context.addInitScript(() => {
        for (const media of document.querySelectorAll("video, audio")) media.pause();
        window.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 16);
      });
      for (const pathname of pages) {
        const page = await context.newPage();
        try {
          await page.goto(new URL(pathname, baseUrl).href, { waitUntil: "networkidle", timeout: 30_000 });
          await page.addStyleTag({ content: "*,*::before,*::after{animation:none !important;transition:none !important;caret-color:transparent !important}" });
          await page.evaluate(async () => { await document.fonts.ready; });
          await page.waitForTimeout(400);
          const destination = imagePath(destinationRoot, pathname, name);
          await mkdir(join(destination, ".."), { recursive: true });
          await page.screenshot({ path: destination, fullPage: true, type: "png" });
        } finally {
          await page.close();
        }
      }
      await context.close();
    }
    await mkdir(shotsDir, { recursive: true });
    await writeFile(join(shotsDir, `${label}-selection.json`), `${JSON.stringify({ capturedAt: new Date().toISOString(), pages }, null, 2)}\n`);
    console.log(`Captured ${pages.length} URLs x ${Object.keys(viewports).length} viewports to ${relative(project, destinationRoot)}.`);
  } finally {
    await browser?.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

function paddedImage(source, width, height) {
  const target = new PNG({ width, height });
  target.data.fill(255);
  PNG.bitblt(source, target, 0, 0, source.width, source.height, 0, 0);
  return target;
}

async function compareImages(beforeFile, afterFile) {
  const [beforeBuffer, afterBuffer] = await Promise.all([readFile(beforeFile), readFile(afterFile)]);
  const before = PNG.sync.read(beforeBuffer);
  const after = PNG.sync.read(afterBuffer);
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const diff = new PNG({ width, height });
  const mismatchedPixels = pixelmatch(paddedImage(before, width, height).data, paddedImage(after, width, height).data, diff.data, width, height, { threshold: 0.1 });
  return { ratio: mismatchedPixels / (width * height), diff };
}

async function compare([leftLabel, rightLabel]) {
  const [leftSelection, rightSelection] = await Promise.all([
    readFile(join(shotsDir, `${leftLabel}-selection.json`), "utf8").then(JSON.parse),
    readFile(join(shotsDir, `${rightLabel}-selection.json`), "utf8").then(JSON.parse),
  ]);
  const pages = sortedPaths(leftSelection.pages.filter((pathname) => rightSelection.pages.includes(pathname)));
  const rows = [];
  for (const pathname of pages) {
    for (const viewport of Object.keys(viewports)) {
      const leftFile = imagePath(join(shotsDir, leftLabel), pathname, viewport);
      const rightFile = imagePath(join(shotsDir, rightLabel), pathname, viewport);
      if (!await exists(leftFile) || !await exists(rightFile)) {
        rows.push({ pathname, viewport, ratio: null, status: "missing screenshot" });
        continue;
      }
      const result = await compareImages(leftFile, rightFile);
      const destination = imagePath(join(shotsDir, "diffs", `${leftLabel}-vs-${rightLabel}`), pathname, viewport);
      await mkdir(join(destination, ".."), { recursive: true });
      await writeFile(destination, PNG.sync.write(result.diff));
      rows.push({ pathname, viewport, ratio: result.ratio, status: "ok" });
    }
  }
  console.log("| URL | viewport | diff rate | status |\n| --- | --- | ---: | --- |");
  for (const row of rows) console.log(`| ${row.pathname} | ${row.viewport} | ${row.ratio === null ? "-" : row.ratio.toFixed(8)} | ${row.status} |`);
  if (rows.some((row) => row.ratio !== 0)) process.exitCode = 1;
}

const options = parseArgs(process.argv.slice(2));
if (options.command === "capture") await capture(options);
else await compare(options.labels);
