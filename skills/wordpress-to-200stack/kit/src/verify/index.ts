import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { load as loadHtml } from "cheerio";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { chromium } from "playwright";

type OldMeta = { url: string; title?: string; description?: string; canonical?: string; robots?: string; og?: { title?: string; description?: string } };
type Issue = { url: string; detail: string };
export type VerifyOptions = { oldDir: string; newTarget: string; reportDir?: string; screenshots?: boolean; threshold?: number; limit?: number; fetchImpl?: typeof fetch };
export type VerifyResult = { checked: number; missing: Issue[]; metaMismatches: Issue[]; brokenLinks: Issue[]; screenshotDiffs: Array<Issue & { ratio: number }>; reportDir: string };

function archivePageDir(oldDir: string, oldUrl: string): string { return join(oldDir, "pages", encodeURIComponent(new URL(oldUrl).pathname || "/")); }
function normalizeMeta(value: string | undefined): string { return (value ?? "").replace(/\s+/g, " ").trim(); }
function htmlMeta(html: string): Record<string, string | undefined> {
  const $ = loadHtml(html);
  const content = (selector: string) => $(selector).first().attr("content");
  return { title: $("title").first().text(), description: content('meta[name="description"]'), canonical: $('link[rel="canonical"]').first().attr("href"), robots: content('meta[name="robots"]'), "og:title": content('meta[property="og:title"]'), "og:description": content('meta[property="og:description"]') };
}
function isUrlTarget(value: string): boolean { return /^https?:\/\//i.test(value); }
function cleanPath(pathname: string): string { return pathname === "/" ? "/" : pathname.replace(/\/+$/, "") || "/"; }
function distFile(distDir: string, pathname: string, page = true): string {
  // Next.js の静的出力は percent-encoded セグメントをデコード済みのディレクトリ名で書き出すため、
  // 照合前にデコードして揃える(デコード不能な不正エンコードは原文のまま扱う)
  let decoded = cleanPath(pathname);
  try { decoded = decodeURIComponent(decoded); } catch { /* 不正な % はそのまま */ }
  const safe = decoded.replace(/^\/+/, "");
  const target = page && !extname(safe) ? join(distDir, safe, "index.html") : join(distDir, safe || "index.html");
  if (relative(resolve(distDir), resolve(target)).startsWith("..")) throw new Error(`unsafe path: ${pathname}`);
  return target;
}
async function exists(path: string): Promise<boolean> { try { return (await stat(path)).isFile(); } catch { return false; } }
async function fetchHtml(fetchImpl: typeof fetch, url: string): Promise<{ exists: boolean; html?: string }> {
  let response = await fetchImpl(url, { method: "HEAD", redirect: "follow" });
  if (response.status === 405 || response.status === 501) response = await fetchImpl(url, { method: "GET", redirect: "follow" });
  if (!response.ok) return { exists: false };
  if (response.headers.get("content-type")?.includes("text/html")) return { exists: true, html: await response.text() };
  const get = await fetchImpl(url, { method: "GET", redirect: "follow" });
  return { exists: get.ok, ...(get.ok ? { html: await get.text() } : {}) };
}
function targetUrl(base: string, oldUrl: string): string { const old = new URL(oldUrl); return new URL(`${old.pathname}${old.search}`, base.endsWith("/") ? base : `${base}/`).toString(); }
function isCheckable(value: string): boolean { return Boolean(value) && !/^(#|data:|javascript:|mailto:|tel:)/i.test(value); }
function comparePngs(before: PNG, after: PNG): { ratio: number; diff: PNG } {
  const width = Math.max(before.width, after.width); const height = Math.max(before.height, after.height);
  const left = new PNG({ width, height }); const right = new PNG({ width, height }); const diff = new PNG({ width, height });
  before.bitblt(left, 0, 0, before.width, before.height, 0, 0); after.bitblt(right, 0, 0, after.width, after.height, 0, 0);
  const changed = pixelmatch(left.data, right.data, diff.data, width, height, { threshold: 0.1 });
  return { ratio: changed / (width * height), diff };
}
export { comparePngs };

async function screenshot(target: string, output: string, viewport: { width: number; height: number }): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try { const page = await browser.newPage({ viewport }); await page.goto(target, { waitUntil: "networkidle" }); await page.screenshot({ path: output, fullPage: true }); await page.close(); }
  finally { await browser.close(); }
}
function markdown(result: VerifyResult): string {
  const lines = ["# wpkit verify report", "", "## Summary", "", `- Checked: ${result.checked}`, `- Missing URLs: ${result.missing.length}`, `- Meta mismatches: ${result.metaMismatches.length}`, `- Broken links/images: ${result.brokenLinks.length}`, `- Screenshot diffs: ${result.screenshotDiffs.length}`, ""];
  for (const [title, issues] of [["Missing URLs", result.missing], ["Meta mismatches", result.metaMismatches], ["Broken links/images", result.brokenLinks], ["Screenshot diffs", result.screenshotDiffs]] as const) { lines.push(`## ${title}`, ""); if (!issues.length) lines.push("なし", ""); else for (const issue of issues) lines.push(`- ${issue.url}: ${issue.detail}`, ""); }
  return lines.join("\n");
}

export async function verifySite(options: VerifyOptions): Promise<VerifyResult> {
  const reportDir = options.reportDir ?? "./verify-report"; const threshold = options.threshold ?? 0.02; const fetchImpl = options.fetchImpl ?? fetch;
  const inventory = JSON.parse(await readFile(join(options.oldDir, "inventory.json"), "utf8")) as { urls?: Array<{ url: string; status: number }> };
  const oldUrls = (inventory.urls ?? []).filter((item) => item.status === 200).slice(0, options.limit);
  const urlMode = isUrlTarget(options.newTarget); const result: VerifyResult = { checked: oldUrls.length, missing: [], metaMismatches: [], brokenLinks: [], screenshotDiffs: [], reportDir };
  await mkdir(reportDir, { recursive: true });
  for (const item of oldUrls) {
    const pageDir = archivePageDir(options.oldDir, item.url); let oldMeta: OldMeta;
    try { oldMeta = JSON.parse(await readFile(join(pageDir, "meta.json"), "utf8")) as OldMeta; } catch { result.missing.push({ url: item.url, detail: "旧 archive の meta.json がありません" }); continue; }
    const oldPath = new URL(item.url).pathname; const newPageUrl = urlMode ? targetUrl(options.newTarget, item.url) : undefined;
    const newPath = urlMode ? undefined : distFile(options.newTarget, oldPath);
    let html: string | undefined;
    if (urlMode) { const found = await fetchHtml(fetchImpl, newPageUrl!); if (!found.exists) { result.missing.push({ url: item.url, detail: newPageUrl! }); continue; } html = found.html; }
    else { if (!await exists(newPath!)) { result.missing.push({ url: item.url, detail: newPath! }); continue; } html = await readFile(newPath!, "utf8"); }
    if (!html) continue;
    const before: Record<string, string | undefined> = { title: oldMeta.title, description: oldMeta.description, canonical: oldMeta.canonical, robots: oldMeta.robots, "og:title": oldMeta.og?.title, "og:description": oldMeta.og?.description };
    const after = htmlMeta(html);
    for (const key of Object.keys(before)) if (normalizeMeta(before[key]) !== normalizeMeta(after[key])) result.metaMismatches.push({ url: item.url, detail: `${key}: ${JSON.stringify(before[key] ?? "")} -> ${JSON.stringify(after[key] ?? "")}` });
    const $ = loadHtml(html);
    const refs = $("a[href], img[src]").map((_index, element) => ({ tag: element.tagName, value: $(element).attr(element.tagName === "img" ? "src" : "href") ?? "" })).get();
    for (const ref of refs) {
      if (!isCheckable(ref.value)) continue;
      if (urlMode) {
        let resolved: URL; try { resolved = new URL(ref.value, newPageUrl!); } catch { result.brokenLinks.push({ url: item.url, detail: ref.value }); continue; }
        const base = new URL(options.newTarget); if (resolved.origin !== base.origin) continue;
        const found = await fetchHtml(fetchImpl, resolved.toString()); if (!found.exists) result.brokenLinks.push({ url: item.url, detail: ref.value });
      } else {
        let resolved: URL;
        try { resolved = new URL(ref.value, new URL(oldPath.endsWith("/") ? oldPath : `${oldPath}/`, "https://wpkit.local")); }
        catch { result.brokenLinks.push({ url: item.url, detail: ref.value }); continue; }
        if (/^https?:\/\//i.test(ref.value) && resolved.origin !== new URL(item.url).origin) continue; // external media hosts are already rewritten or intentionally external.
        const page = ref.tag === "a"; const target = distFile(options.newTarget, decodeURIComponent(resolved.pathname), page);
        if (!await exists(target)) result.brokenLinks.push({ url: item.url, detail: ref.value });
      }
    }
    if (options.screenshots) {
      for (const [name, viewport] of [["desktop", { width: 1280, height: 800 }], ["mobile", { width: 375, height: 812 }]] as const) {
        const oldPng = join(pageDir, `${name}.png`); if (!await exists(oldPng)) continue;
        const newPng = join(reportDir, `${encodeURIComponent(oldPath)}.${name}.png`);
        try {
          await screenshot(urlMode ? newPageUrl! : pathToFileURL(newPath!).toString(), newPng, viewport);
          const compared = comparePngs(PNG.sync.read(await readFile(oldPng)), PNG.sync.read(await readFile(newPng)));
          if (compared.ratio > threshold) { const diffPath = join(reportDir, `${encodeURIComponent(oldPath)}.${name}.diff.png`); await writeFile(diffPath, PNG.sync.write(compared.diff)); result.screenshotDiffs.push({ url: item.url, detail: diffPath, ratio: compared.ratio }); }
        } catch (error: unknown) { result.screenshotDiffs.push({ url: item.url, detail: `${name} screenshot failed: ${error instanceof Error ? error.message : String(error)}`, ratio: 1 }); }
      }
    }
  }
  await Promise.all([writeFile(join(reportDir, "verify-report.json"), `${JSON.stringify(result, null, 2)}\n`), writeFile(join(reportDir, "verify-report.md"), markdown(result))]);
  return result;
}
