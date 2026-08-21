import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { normalizePathname } from "./lib/surfaces.mjs";

const project = resolve(import.meta.dirname, "..");
const fidelityDir = join(project, "_scratch", "fidelity");
const archiveDir = process.env.WPKIT_ARCHIVE_DIR ?? join(project, "_scratch", "archive");
const baselineRoot = process.env.WPKIT_BASELINE_DIR ?? join(archiveDir, "pages");
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

function usage(message) {
  if (message) console.error(message);
  console.error(
    "Usage: node scripts/fidelity-compare-report.mjs [--threshold <px>] [--only <surfaceId>] [--path </page/>] [--viewport desktop|mobile|both] [--out <file>] [--serve [port]] [--evidence <json>]",
  );
  process.exit(1);
}

export function parseArgs(argv) {
  const options = {
    threshold: 10,
    only: null,
    path: null,
    viewport: "both",
    out: join(fidelityDir, "compare.html"),
    serve: null,
    evidence: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--threshold") {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value < 0) usage("--threshold requires a non-negative number");
      options.threshold = value;
    } else if (flag === "--only") options.only = argv[++index] ?? usage("--only requires a surface id");
    else if (flag === "--path") options.path = normalizePathname(argv[++index] ?? usage("--path requires a pathname"));
    else if (flag === "--viewport") {
      options.viewport = argv[++index] ?? usage("--viewport requires desktop, mobile, or both");
      if (!["desktop", "mobile", "both"].includes(options.viewport))
        usage("--viewport requires desktop, mobile, or both");
    } else if (flag === "--out") options.out = resolve(argv[++index] ?? usage("--out requires a file path"));
    else if (flag === "--evidence")
      options.evidence = resolve(argv[++index] ?? usage("--evidence requires a JSON path"));
    else if (flag === "--serve") {
      const value = argv[index + 1];
      if (value && !value.startsWith("--")) index += 1;
      const port = value && !value.startsWith("--") ? Number(value) : 8961;
      if (!Number.isInteger(port) || port < 1 || port > 65535) usage("--serve requires a valid port number");
      options.serve = port;
    } else usage(`Unknown option: ${flag}`);
  }
  return options;
}

function encodedPath(pathname) {
  return encodeURIComponent(pathname === "/" ? "/" : `${pathname.replace(/\/+$/, "")}/`);
}
function imagePath(root, pathname, viewport) {
  return join(root, encodedPath(pathname), `${viewport}.png`);
}
function imageUrl(root, pathname, viewport, rootDir) {
  const directory = encodedPath(pathname);
  return `${relative(rootDir, root).split(sep).join("/")}/${encodeURIComponent(directory)}/${viewport}.png`;
}
function escapeHtml(value) {
  return String(value ?? "—")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function numeric(value) {
  return Number.isFinite(value) ? value : null;
}
function deviation(block) {
  return Math.max(Math.abs(numeric(block.dy) ?? 0), Math.abs(numeric(block.dh) ?? 0));
}
function paddedImage(source, width, height) {
  const padded = new PNG({ width, height });
  padded.data.fill(255);
  PNG.bitblt(source, padded, 0, 0, source.width, source.height, 0, 0);
  return padded;
}

export async function generateDiff(oldFile, newFile, destination) {
  const [oldBuffer, newBuffer] = await Promise.all([readFile(oldFile), readFile(newFile)]);
  const oldImage = PNG.sync.read(oldBuffer);
  const newImage = PNG.sync.read(newBuffer);
  const width = Math.max(oldImage.width, newImage.width);
  const height = Math.max(oldImage.height, newImage.height);
  const diff = new PNG({ width, height });
  pixelmatch(
    paddedImage(oldImage, width, height).data,
    paddedImage(newImage, width, height).data,
    diff.data,
    width,
    height,
    { threshold: 0.1 },
  );
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, PNG.sync.write(diff));
}

async function readBlocks(directory) {
  let files = [];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const blocks = await Promise.all(
    files
      .filter((file) => /^blocks-.+\.json$/.test(file))
      .map(async (file) => JSON.parse(await readFile(join(directory, file), "utf8"))),
  );
  return blocks;
}
async function readScan(directory) {
  try {
    return JSON.parse(await readFile(join(directory, "scan.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
function scanFor(records, surface, pathname) {
  return records.find((record) => record.surface === surface && normalizePathname(record.path) === pathname);
}
function imageColumn(label, file, url) {
  return `<div><h3>${escapeHtml(label)}</h3><div class="image-scroll">${existsSync(file) ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(label)}">` : "<p class=missing>画像未生成</p>"}</div></div>`;
}

function renderReport(surfaces, rootDir) {
  const links = surfaces
    .map(
      (surface) =>
        `<a href="#${escapeHtml(surface.id)}">${escapeHtml(surface.surface)} <small>${escapeHtml(surface.viewport)}</small></a>`,
    )
    .join("\n");
  const sections = surfaces
    .map((surface) => {
      const meta = surface.scan?.[surface.viewport] ?? {};
      const ratio = numeric(meta.ratio) == null ? "—" : `${(meta.ratio * 100).toFixed(2)}%`;
      const deltaHeight =
        numeric(meta.heightOld) == null || numeric(meta.heightNew) == null
          ? "—"
          : `${meta.heightNew - meta.heightOld}px`;
      const rows = surface.blocks
        .map(
          (block) =>
            `<tr><td>${escapeHtml(block.id)}</td><td>${escapeHtml(block.dy)}px</td><td>${escapeHtml(block.dh)}px</td></tr>`,
        )
        .join("");
      const oldFile = imagePath(surface.baselineRoot, surface.path, surface.viewport);
      const currentFile = imagePath(surface.currentRoot, surface.path, surface.viewport);
      const diffFile = imagePath(surface.diffsRoot, surface.path, surface.viewport);
      return `<section id="${escapeHtml(surface.id)}"><h2>${escapeHtml(surface.surface)} <small>${escapeHtml(surface.path)} / ${escapeHtml(surface.viewport)}</small></h2><p class=meta>scan: ratio ${ratio} / Δh ${deltaHeight}</p><table><thead><tr><th>id</th><th>dy</th><th>dh</th></tr></thead><tbody>${rows}</tbody></table><div class=images>${imageColumn("現行サイト（凍結）", oldFile, imageUrl(surface.baselineRoot, surface.path, surface.viewport, rootDir))}${imageColumn("実装", currentFile, imageUrl(surface.currentRoot, surface.path, surface.viewport, rootDir))}${imageColumn("差分（赤=不一致）", diffFile, imageUrl(surface.diffsRoot, surface.path, surface.viewport, rootDir))}</div></section>`;
    })
    .join("\n");
  const targetCount = surfaces.reduce((count, surface) => count + surface.blocks.length, 0);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fidelity 比較レポート</title><style>body{font-family:system-ui,sans-serif;line-height:1.5;margin:2rem;color:#172033}nav{display:flex;gap:.5rem;flex-wrap:wrap}nav a{background:#edf2f7;border-radius:.35rem;padding:.3rem .55rem;color:#174ea6;text-decoration:none}section{border-top:1px solid #ccd5df;margin-top:2rem;padding-top:1.2rem}small,.meta{color:#52606d;font-size:.85em}table{border-collapse:collapse;margin:.8rem 0}th,td{border:1px solid #cbd5e1;padding:.25rem .5rem;text-align:right}th:first-child,td:first-child{text-align:left}.images{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem}.image-scroll{height:70vh;overflow:auto;border:1px solid #cbd5e1;background:#f8fafc}.image-scroll img{display:block;width:100%;height:auto}.missing{padding:1rem;color:#7f1d1d}@media(max-width:800px){.images{grid-template-columns:1fr}}</style></head><body><h1>Fidelity 比較レポート（${targetCount}件 / ${surfaces.length}面）</h1><p>閾値以上のブロック差分のみを、人が凍結基準・実装・差分画像で比較するレポートです。</p><nav>${links || "対象面はありません"}</nav>${sections}<script>for(const section of document.querySelectorAll('section')){const panes=[...section.querySelectorAll('.image-scroll')];let locked=false;for(const pane of panes)pane.addEventListener('scroll',()=>{if(locked)return;locked=true;const max=pane.scrollHeight-pane.clientHeight;const ratio=max>0?pane.scrollTop/max:0;for(const other of panes)if(other!==pane){const otherMax=other.scrollHeight-other.clientHeight;other.scrollTop=ratio*otherMax}locked=false},{passive:true})}</script></body></html>`;
}

export async function buildCompareReport(options = {}) {
  const resolvedFidelityDir = resolve(options.fidelityDir ?? fidelityDir);
  const resolvedBaselineRoot = resolve(options.baselineRoot ?? baselineRoot);
  const currentRoot = join(resolvedFidelityDir, "current");
  const diffsRoot = join(resolvedFidelityDir, "diffs");
  const out = resolve(options.out ?? join(resolvedFidelityDir, "compare.html"));
  const threshold = options.threshold ?? 10;
  const viewportNames =
    options.viewport === "desktop" || options.viewport === "mobile" ? [options.viewport] : ["desktop", "mobile"];
  const [blockFiles, scan] = await Promise.all([readBlocks(resolvedFidelityDir), readScan(resolvedFidelityDir)]);
  const surfaces = [];
  for (const entry of blockFiles) {
    const pathname = normalizePathname(entry.path);
    if (options.only && entry.surface !== options.only) continue;
    if (options.path && pathname !== normalizePathname(options.path)) continue;
    for (const viewport of viewportNames) {
      const blocks = (entry.viewports?.[viewport]?.blocks ?? []).filter(
        (block) => deviation(block) >= threshold,
      );
      if (blocks.length === 0) continue;
      const maxDeviation = Math.max(...blocks.map(deviation));
      const diff = imagePath(diffsRoot, pathname, viewport);
      const oldFile = imagePath(resolvedBaselineRoot, pathname, viewport);
      const currentFile = imagePath(currentRoot, pathname, viewport);
      if (!existsSync(diff) && existsSync(oldFile) && existsSync(currentFile))
        await generateDiff(oldFile, currentFile, diff);
      surfaces.push({
        id: `${entry.surface}-${viewport}`,
        surface: entry.surface,
        path: pathname,
        viewport,
        blocks,
        maxDeviation,
        scan: scanFor(scan, entry.surface, pathname),
        baselineRoot: resolvedBaselineRoot,
        currentRoot,
        diffsRoot,
      });
    }
  }
  surfaces.sort((left, right) => right.maxDeviation - left.maxDeviation);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, renderReport(surfaces, dirname(out)));
  return {
    out,
    targetCount: surfaces.reduce((count, surface) => count + surface.blocks.length, 0),
    surfaceCount: surfaces.length,
    surfaces: surfaces.map(({ id, surface, path, viewport, maxDeviation }) => ({
      id,
      surface,
      path,
      viewport,
      maxDeviation,
    })),
  };
}

export function createStaticServer(root = fidelityDir) {
  const resolvedRoot = resolve(root);
  return createServer(async (request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405).end("Method not allowed");
      return;
    }
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const file = resolve(resolvedRoot, `.${decodeURIComponent(url.pathname)}`);
      if (file !== resolvedRoot && !file.startsWith(`${resolvedRoot}${sep}`)) throw new Error("invalid path");
      if ((await stat(file)).isDirectory()) throw new Error("directory");
      const body = await readFile(file);
      response.writeHead(200, { "content-type": MIME_TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
    }
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await buildCompareReport(options);
  if (options.evidence) {
    await mkdir(dirname(options.evidence), { recursive: true });
    await writeFile(options.evidence, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(`Compare report: ${result.out} (${result.targetCount}件 / ${result.surfaceCount}面)`);
  if (options.serve) {
    const server = createStaticServer(options.fidelityDir ?? fidelityDir);
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(options.serve, "127.0.0.1", () => {
        server.off("error", reject);
        resolveListen();
      });
    });
    console.log(
      `Serving fidelity report on http://127.0.0.1:${options.serve}/${encodeURIComponent(
        relative(options.fidelityDir ?? fidelityDir, result.out)
          .split(sep)
          .join("/"),
      )}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
