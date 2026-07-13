import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { load as loadHtml } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import pLimit from "p-limit";
import { chromium } from "playwright";

type FetchResponse = { requestedUrl: string; finalUrl: string; status: number; headers: Headers; body: Buffer; redirects: Array<{ from: string; to: string; status: number }> };
export type ArchivePageMeta = {
  url: string;
  finalUrl: string;
  status: number;
  redirects: Array<{ from: string; to: string; status: number }>;
  title?: string;
  canonical?: string;
  description?: string;
  robots?: string;
  og: { title?: string; description?: string; image?: string };
  internalLinks: string[];
  forms: Array<{ action: string; method: string; inputs: string[] }>;
};
type ArchivedPage = { response: FetchResponse; html?: string; meta: ArchivePageMeta; screenshots: boolean };
export type ArchiveOptions = {
  origin: string;
  archiveDir?: string;
  maxPages?: number;
  concurrency?: number;
  screenshots?: boolean;
  limit?: number;
  fetchImpl?: typeof fetch;
  requestDelayMs?: number;
};
export type ArchiveResult = { archiveDir: string; pages: Array<{ url: string; status: number; title?: string; screenshots: boolean }>; forms: Array<{ endpoint: string; pages: string[] }> };

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function cleanUrl(value: string, origin: URL): string | undefined {
  try {
    const url = new URL(value, origin);
    url.hash = "";
    if (url.origin !== origin.origin || url.search || url.pathname.startsWith("/wp-admin") || url.pathname.startsWith("/wp-json")) return undefined;
    return url.toString();
  } catch { return undefined; }
}
function pageDirectory(pagesDir: string, url: string): string {
  const parsed = new URL(url);
  return join(pagesDir, encodeURIComponent(parsed.pathname === "/" ? "/" : parsed.pathname));
}
function assetPath(assetsDir: string, url: string): string {
  const parsed = new URL(url);
  return join(assetsDir, encodeURIComponent(`${parsed.host}${parsed.pathname}`));
}
function values(value: unknown): unknown[] { return Array.isArray(value) ? value : value === undefined ? [] : [value]; }
function sitemapLocations(xml: string): string[] {
  try {
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml) as Record<string, unknown>;
    const root = parsed.urlset ?? parsed.sitemapindex;
    const entries = values((root as Record<string, unknown> | undefined)?.url ?? (root as Record<string, unknown> | undefined)?.sitemap);
    return entries.flatMap((entry) => values((entry as Record<string, unknown>).loc)).filter((loc): loc is string => typeof loc === "string");
  } catch { return []; }
}
function selectorContent($: ReturnType<typeof loadHtml>, selector: string): string | undefined {
  const content = $(selector).first().attr("content");
  return content?.trim() || undefined;
}
function pageMeta(response: FetchResponse, origin: URL): ArchivePageMeta {
  const html = response.body.toString("utf8");
  const $ = loadHtml(html);
  const internalLinks = new Set<string>();
  $("a[href]").each((_index, element) => {
    const found = cleanUrl($(element).attr("href") ?? "", origin);
    if (found) internalLinks.add(found);
  });
  const forms: ArchivePageMeta["forms"] = [];
  // A redirected URL stores the final response for evidence, but forms belong only to that final URL.
  if (response.redirects.length === 0) $("form").each((_index, form) => {
    let action: string;
    try { action = new URL($(form).attr("action") || response.finalUrl, response.finalUrl).toString(); }
    catch { action = $(form).attr("action") || response.finalUrl; }
    const method = ($(form).attr("method") || "get").toLowerCase();
    const inputs = $(form).find("input[name], select[name], textarea[name], button[name]").map((_inputIndex, input) => $(input).attr("name") ?? "").get().filter(Boolean);
    forms.push({ action, method, inputs });
  });
  return {
    url: response.requestedUrl, finalUrl: response.finalUrl, status: response.status, redirects: response.redirects,
    ...( $("title").first().text().trim() ? { title: $("title").first().text().trim() } : {}),
    ...( $("link[rel=canonical]").first().attr("href") ? { canonical: $("link[rel=canonical]").first().attr("href") } : {}),
    ...(selectorContent($, 'meta[name="description"]') ? { description: selectorContent($, 'meta[name="description"]') } : {}),
    ...(selectorContent($, 'meta[name="robots"]') ? { robots: selectorContent($, 'meta[name="robots"]') } : {}),
    og: { title: selectorContent($, 'meta[property="og:title"]'), description: selectorContent($, 'meta[property="og:description"]'), image: selectorContent($, 'meta[property="og:image"]') },
    internalLinks: [...internalLinks].sort(), forms,
  };
}
function assetsInHtml(html: string, pageUrl: string): string[] {
  const $ = loadHtml(html);
  const found = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value || /^data:|^javascript:/i.test(value)) return;
    try { found.add(new URL(value, pageUrl).toString()); } catch { /* ignore malformed attributes */ }
  };
  $('link[rel="stylesheet"][href]').each((_index, element) => add($(element).attr("href")));
  $("script[src]").each((_index, element) => add($(element).attr("src")));
  $("[src], [href]").each((_index, element) => {
    const value = $(element).attr("src") ?? $(element).attr("href");
    if (value?.includes("/wp-content/themes/")) add(value);
  });
  return [...found].sort();
}
function cssAssets(css: string, cssUrl: string): string[] {
  const found = new Set<string>();
  for (const match of css.matchAll(/url\(\s*(['"]?)([^'"\s)]+)\1\s*\)/gi)) {
    const value = match[2];
    if (!value || /^data:|^#/.test(value)) continue;
    try { found.add(new URL(value, cssUrl).toString()); } catch { /* ignore malformed CSS */ }
  }
  return [...found];
}

function createRequester(fetchImpl: typeof fetch, delayMs: number) {
  let previous = Promise.resolve();
  return async (requestedUrl: string): Promise<FetchResponse> => {
    let release: () => void = () => undefined;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const waitFor = previous;
    previous = turn;
    await waitFor;
    if (delayMs > 0) await delay(delayMs);
    release();
    const redirects: FetchResponse["redirects"] = [];
    let current = requestedUrl;
    for (let count = 0; count < 10; count += 1) {
      const response = await fetchImpl(current, { redirect: "manual", headers: { "user-agent": "wp-static-kit-archive/0.1" } });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        const next = new URL(location, current).toString();
        redirects.push({ from: current, to: next, status: response.status });
        current = next;
        continue;
      }
      return { requestedUrl, finalUrl: current, status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()), redirects };
    }
    throw new Error(`redirect loop: ${requestedUrl}`);
  };
}

async function saveAssets(assetUrls: string[], archiveDir: string, request: (url: string) => Promise<FetchResponse>, concurrency: number): Promise<void> {
  const assetsDir = join(archiveDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  const all = new Set(assetUrls);
  const initial = [...all];
  const css = await Promise.all(initial.map(async (url) => {
    try {
      const response = await request(url);
      if (response.status < 200 || response.status >= 300) return [];
      if (/text\/css/i.test(response.headers.get("content-type") ?? "") || url.endsWith(".css")) return cssAssets(response.body.toString("utf8"), response.finalUrl);
    } catch { /* a missing non-page asset is intentionally non-fatal */ }
    return [] as string[];
  }));
  for (const urls of css) for (const url of urls) all.add(url);
  const limit = pLimit(concurrency);
  await Promise.all([...all].map((url) => limit(async () => {
    try {
      const response = await request(url);
      if (response.status < 200 || response.status >= 300) return;
      await writeFile(assetPath(assetsDir, url), response.body);
    } catch { /* recordable page inventory remains useful when an asset is gone */ }
  })));
}

async function takeScreenshots(pages: ArchivedPage[], archiveDir: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const page of pages) {
      if (page.response.status < 200 || page.response.status >= 400) continue;
      const target = page.response.finalUrl;
      const directory = pageDirectory(join(archiveDir, "pages"), page.response.requestedUrl);
      try {
        for (const [name, viewport] of [["desktop", { width: 1280, height: 800 }], ["mobile", { width: 375, height: 812 }]] as const) {
          const browserPage = await browser.newPage({ viewport });
          await browserPage.goto(target, { waitUntil: "networkidle" });
          await browserPage.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
          await browserPage.close();
        }
        page.screenshots = true;
      } catch { page.screenshots = false; }
    }
  } finally { await browser.close(); }
}

export async function archiveSite(options: ArchiveOptions): Promise<ArchiveResult> {
  const origin = new URL(options.origin);
  const archiveDir = options.archiveDir ?? "./archive";
  const maxPages = options.maxPages ?? 2000;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const request = createRequester(options.fetchImpl ?? fetch, options.requestDelayMs ?? 100);
  await mkdir(join(archiveDir, "pages"), { recursive: true });
  const sitemapSeen = new Set<string>();
  const sitemapUrls: string[] = [];
  const visitSitemap = async (url: string): Promise<void> => {
    if (sitemapSeen.has(url)) return;
    sitemapSeen.add(url);
    try {
      const response = await request(url);
      if (response.status < 200 || response.status >= 300) return;
      for (const location of sitemapLocations(response.body.toString("utf8"))) {
        let found: URL;
        try { found = new URL(location, response.finalUrl); } catch { continue; }
        if (found.origin !== origin.origin) continue;
        if (found.pathname.endsWith(".xml")) await visitSitemap(found.toString());
        else { const clean = cleanUrl(found.toString(), origin); if (clean) sitemapUrls.push(clean); }
      }
    } catch { /* sitemap is optional */ }
  };
  await visitSitemap(new URL("/sitemap.xml", origin).toString());
  const queue = [...new Set([origin.toString(), ...sitemapUrls])];
  const queued = new Set(queue);
  const pages: ArchivedPage[] = [];
  for (let index = 0; index < queue.length && pages.length < maxPages;) {
    const batch = queue.slice(index, index + Math.min(concurrency, maxPages - pages.length));
    index += batch.length;
    const fetched = await Promise.all(batch.map(async (url) => {
      try { return await request(url); } catch { return undefined; }
    }));
    for (const response of fetched) {
      if (!response) continue;
      const contentType = response.headers.get("content-type") ?? "";
      const html = /text\/html|application\/xhtml\+xml/i.test(contentType) ? response.body.toString("utf8") : undefined;
      const meta = pageMeta(response, origin);
      pages.push({ response, html, meta, screenshots: false });
      if (html && response.status >= 200 && response.status < 400) for (const link of meta.internalLinks) {
        if (!queued.has(link) && queued.size < maxPages) { queued.add(link); queue.push(link); }
      }
    }
  }
  const archivedPages = options.limit === undefined ? pages : pages.slice(0, options.limit);
  const assetUrls = new Set<string>();
  for (const page of archivedPages) {
    const directory = pageDirectory(join(archiveDir, "pages"), page.response.requestedUrl);
    await mkdir(directory, { recursive: true });
    if (page.html !== undefined) {
      await writeFile(join(directory, "page.html"), page.html);
      for (const asset of assetsInHtml(page.html, page.response.finalUrl)) assetUrls.add(asset);
    }
    await writeFile(join(directory, "meta.json"), `${JSON.stringify(page.meta, null, 2)}\n`);
  }
  await saveAssets([...assetUrls], archiveDir, request, concurrency);
  if (options.screenshots ?? true) await takeScreenshots(archivedPages, archiveDir);
  const formsByEndpoint = new Map<string, Set<string>>();
  for (const page of archivedPages) for (const form of page.meta.forms) {
    try { if (new URL(form.action).origin === origin.origin) continue; }
    catch { continue; }
    const matching = formsByEndpoint.get(form.action) ?? new Set<string>();
    matching.add(page.meta.url); formsByEndpoint.set(form.action, matching);
  }
  const forms = [...formsByEndpoint.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([endpoint, sourcePages]) => ({ endpoint, pages: [...sourcePages].sort() }));
  const inventory = { urls: archivedPages.map((page) => ({ url: page.meta.url, status: page.meta.status, ...(page.meta.title ? { title: page.meta.title } : {}), screenshots: page.screenshots })), forms };
  await Promise.all([
    writeFile(join(archiveDir, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`),
    writeFile(join(archiveDir, "forms.json"), `${JSON.stringify(forms, null, 2)}\n`),
  ]);
  return { archiveDir, pages: inventory.urls, forms };
}
