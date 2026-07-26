import { access, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const project = resolve(import.meta.dirname, "..");
const outDirectory = join(project, "out");

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return (match?.[1] ?? match?.[2] ?? match?.[3])?.replaceAll("&amp;", "&");
}

async function filesUnder(directory) {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.name === "index.html" ? [path] : [];
  }))).flat();
}

function pathInside(root, pathname) {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, `.${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
  return candidate === resolvedRoot || candidate.startsWith(`${resolvedRoot}${sep}`)
    ? candidate
    : undefined;
}

async function fileExistence(href) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(href, "https://example.invalid").pathname); }
  catch { return { exists: false, check: "invalid-url" }; }
  if (/^(?:https?:)?\/\//i.test(href)) {
    return { exists: true, check: "remote-skipped-offline" };
  }
  for (const root of [outDirectory, join(project, "public")]) {
    const candidate = pathInside(root, pathname);
    if (!candidate) return { exists: false, check: "rejected-outside-root" };
    try { await access(candidate); return { exists: true, check: "local-file" }; }
    catch { /* 次のrootを確認 */ }
  }
  return { exists: false, check: "local-missing" };
}

async function renderedUrls(html) {
  const urls = new Set();
  for (const tag of html.match(/<(?:img|source)\b[^>]*>/gi) ?? []) {
    const src = attribute(tag, "src");
    if (src) urls.add(src);
    const srcset = attribute(tag, "srcset");
    if (srcset) {
      for (const candidate of srcset.split(",")) {
        const url = candidate.trim().split(/\s+/, 1)[0];
        if (url) urls.add(url);
      }
    }
  }
  for (const match of html.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/gi)) {
    urls.add((match[1] ?? match[2] ?? match[3]).replaceAll("&amp;", "&"));
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!attribute(tag, "rel")?.split(/\s+/).includes("stylesheet")) continue;
    const href = attribute(tag, "href");
    if (!href || /^(?:https?:)?\/\//i.test(href)) continue;
    try {
      const pathname = decodeURIComponent(new URL(href, "https://example.invalid").pathname);
      const cssPath = pathInside(outDirectory, pathname);
      if (!cssPath) continue;
      const css = await readFile(cssPath, "utf8");
      for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/gi)) {
        urls.add((match[1] ?? match[2] ?? match[3]).replaceAll("&amp;", "&"));
      }
    } catch {
      // 欠落 stylesheet は別ゲートが報告する。
    }
  }
  return urls;
}

const failures = [];
let checked = 0;
let remoteSkipped = 0;
for (const file of await filesUnder(outDirectory)) {
  const html = await readFile(file, "utf8");
  const tags = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => match[0]);
  const preloads = tags
    .filter((tag) => attribute(tag, "rel")?.split(/\s+/).includes("preload") && attribute(tag, "as") === "image")
    .map((tag) => attribute(tag, "href"))
    .filter(Boolean);
  const renderedHtml = html.replace(/<link\b[^>]*\brel=(?:"preload"|'preload')[^>]*>/gi, "");
  const rendered = await renderedUrls(renderedHtml);
  for (const href of preloads) {
    checked += 1;
    const exactRendered = rendered.has(href);
    const existence = await fileExistence(href);
    if (existence.check === "remote-skipped-offline") remoteSkipped += 1;
    if (!exactRendered || !existence.exists) {
      failures.push({
        route: relative(outDirectory, resolve(file, "..")) || "/",
        href,
        exactRendered,
        existence,
      });
    }
  }
}
console.log(JSON.stringify({
  checked,
  remoteExistencePolicy: "offline: remote URL reachability is not checked",
  remoteSkipped,
  failures,
}, null, 2));
if (failures.length) process.exitCode = 1;
