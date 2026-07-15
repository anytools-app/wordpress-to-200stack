import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { load as loadHtml } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import { chromium } from "playwright";

import { createPacer, parseRetryAfter, type PacerOptions, type PacerStats } from "../core/pacer.js";

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
export type ArchiveWarning = { url: string; type: "screenshot-timeout" | "screenshot-failed"; message: string };
export type ArchiveOptions = {
  origin: string;
  archiveDir?: string;
  maxPages?: number;
  concurrency?: number;
  screenshots?: boolean;
  limit?: number;
  fetchImpl?: typeof fetch;
  /** @deprecated Use minIntervalMs. Kept for programmatic compatibility. */
  requestDelayMs?: number;
  startIntervalMs?: number;
  minIntervalMs?: number;
  adaptive?: boolean;
  pacerOptions?: Partial<Omit<PacerOptions, "startIntervalMs" | "minIntervalMs" | "maxConcurrency" | "adaptive">>;
  onPacerStats?: (stats: PacerStats) => void;
  resume?: boolean;
  screenshotTimeout?: number;
};
export type ArchiveResult = { archiveDir: string; pages: Array<{ url: string; status: number; title?: string; screenshots: boolean }>; forms: Array<{ endpoint: string; pages: string[] }>; skipped: number; screenshotFailed: number; assetExcluded: number; warnings: ArchiveWarning[] };

const ASSET_EXTENSION = /\.(?:avif|bmp|css|eot|gif|ico|jpe?g|js|map|m4a|m4v|mov|mp3|mp4|og[gv]|pdf|png|svg|tar|tgz|ttf|wav|webm|webp|woff2?|xz|zip)$/i;
function isAssetUrl(value: string, origin: URL): string | undefined {
  try {
    const url = new URL(value, origin);
    return url.origin === origin.origin && ASSET_EXTENSION.test(url.pathname) ? url.toString() : undefined;
  } catch { return undefined; }
}
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
function pageMeta(response: FetchResponse, origin: URL, assetExcluded: Set<string>): ArchivePageMeta {
  const html = response.body.toString("utf8");
  const $ = loadHtml(html);
  const internalLinks = new Set<string>();
  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href") ?? "";
    const asset = isAssetUrl(href, origin);
    if (asset) { assetExcluded.add(asset); return; }
    const found = cleanUrl(href, origin);
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

function createRequester(fetchImpl: typeof fetch, pacer: ReturnType<typeof createPacer>, now: (() => number) | undefined, onPacerStats: ((stats: PacerStats) => void) | undefined) {
  let completedRequests = 0;
  return async (requestedUrl: string): Promise<FetchResponse> => {
    const result = await pacer.run(async () => {
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
    }, (response) => ({
      ok: response.status >= 200 && response.status < 400,
      ...(response.status === 429 ? { retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), now?.()) } : {}),
    }));
    completedRequests += 1;
    if (completedRequests % 10 === 0) onPacerStats?.(pacer.stats());
    return result;
  };
}

async function saveAssets(assetUrls: string[], archiveDir: string, request: (url: string) => Promise<FetchResponse>): Promise<void> {
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
  await Promise.all([...all].map(async (url) => {
    try {
      const response = await request(url);
      if (response.status < 200 || response.status >= 300) return;
      await writeFile(assetPath(assetsDir, url), response.body);
    } catch { /* recordable page inventory remains useful when an asset is gone */ }
  }));
}

export async function withTimeout<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`screenshot timed out after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function takeScreenshots(pages: ArchivedPage[], archiveDir: string, timeoutMs: number, warnings: ArchiveWarning[]): Promise<number> {
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  try {
    for (let index = 0; index < pages.length; index += 50) {
      const context = await browser.newContext();
      try { for (const page of pages.slice(index, index + 50)) {
      if (page.response.status < 200 || page.response.status >= 400) continue;
      const target = page.response.finalUrl;
      const directory = pageDirectory(join(archiveDir, "pages"), page.response.requestedUrl);
      try {
        await withTimeout(async () => {
          const browserPages = [] as Array<Awaited<ReturnType<typeof context.newPage>>>;
          try { for (const [name, viewport] of [["desktop", { width: 1280, height: 800 }], ["mobile", { width: 375, height: 812 }]] as const) {
            const browserPage = await context.newPage(); browserPages.push(browserPage);
            await browserPage.setViewportSize(viewport);
            await browserPage.goto(target, { waitUntil: "networkidle" });
            await browserPage.evaluate(() => Promise.race([((globalThis as unknown) as { document: { fonts: { ready: Promise<unknown> } } }).document.fonts.ready.then(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, 5_000))])).catch(() => undefined);
            await browserPage.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
          } } finally { await Promise.all(browserPages.map((browserPage) => browserPage.close().catch(() => undefined))); }
        }, timeoutMs);
        page.screenshots = true;
      } catch (error: unknown) {
        page.screenshots = false; failed += 1;
        const timedOut = error instanceof Error && error.message.startsWith("screenshot timed out after");
        const message = error instanceof Error ? error.message : String(error);
        warnings.push({ url: page.meta.url, type: timedOut ? "screenshot-timeout" : "screenshot-failed", message });
        console.error(`warning: screenshot ${timedOut ? "timed out" : "failed"} for ${page.meta.url}: ${message}`);
      }
      } } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  return failed;
}

type InventoryEntry = { url: string; status: number; title?: string; screenshots?: boolean };
type PreviousInventory = { urls: InventoryEntry[]; forms: Array<{ endpoint: string; pages: string[] }>; warnings: ArchiveWarning[] };
async function readPreviousInventory(archiveDir: string): Promise<PreviousInventory> {
  try {
    const inventory = JSON.parse(await readFile(join(archiveDir, "inventory.json"), "utf8")) as { urls?: InventoryEntry[]; pages?: InventoryEntry[]; forms?: PreviousInventory["forms"]; warnings?: ArchiveWarning[] };
    return { urls: inventory.urls ?? inventory.pages ?? [], forms: inventory.forms ?? [], warnings: inventory.warnings ?? [] };
  } catch { return { urls: [], forms: [], warnings: [] }; }
}
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
async function existingPage(archiveDir: string, url: string, fallback: InventoryEntry): Promise<ArchivedPage | undefined> {
  const directory = pageDirectory(join(archiveDir, "pages"), url);
  if (!await exists(join(directory, "page.html"))) return undefined;
  const html = await readFile(join(directory, "page.html"), "utf8");
  const screenshots = await exists(join(directory, "desktop.png")) && await exists(join(directory, "mobile.png"));
  try {
    const meta = JSON.parse(await readFile(join(directory, "meta.json"), "utf8")) as ArchivePageMeta;
    return { response: { requestedUrl: url, finalUrl: meta.finalUrl ?? url, status: meta.status ?? fallback.status, headers: new Headers(), body: Buffer.alloc(0), redirects: meta.redirects ?? [] }, html, meta, screenshots };
  } catch {
    const meta: ArchivePageMeta = { url, finalUrl: url, status: fallback.status, redirects: [], og: {}, internalLinks: [], forms: [] };
    return { response: { requestedUrl: url, finalUrl: url, status: fallback.status, headers: new Headers(), body: Buffer.alloc(0), redirects: [] }, html, meta, screenshots };
  }
}

export async function archiveSite(options: ArchiveOptions): Promise<ArchiveResult> {
  const origin = new URL(options.origin);
  const archiveDir = options.archiveDir ?? "./archive";
  const maxPages = options.maxPages ?? 2000;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const screenshotTimeoutMs = Math.max(1, options.screenshotTimeout ?? 30) * 1000;
  const pacer = createPacer({
    ...options.pacerOptions,
    maxConcurrency: concurrency,
    minIntervalMs: Math.max(0, options.minIntervalMs ?? options.requestDelayMs ?? 100),
    startIntervalMs: Math.max(0, options.startIntervalMs ?? 1000),
    adaptive: options.adaptive ?? true,
  });
  const request = createRequester(options.fetchImpl ?? fetch, pacer, options.pacerOptions?.now, options.onPacerStats);
  await mkdir(join(archiveDir, "pages"), { recursive: true });
  const previous = options.resume ? await readPreviousInventory(archiveDir) : { urls: [], forms: [], warnings: [] };
  const previousByUrl = new Map(previous.urls.map((page) => [page.url, page]));
  const assetExcluded = new Set<string>();
  const warnings: ArchiveWarning[] = [];
  let skipped = 0;
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
        else {
          const asset = isAssetUrl(found.toString(), origin);
          if (asset) assetExcluded.add(asset);
          else { const clean = cleanUrl(found.toString(), origin); if (clean) sitemapUrls.push(clean); }
        }
      }
    } catch { /* sitemap is optional */ }
  };
  await visitSitemap(new URL("/sitemap.xml", origin).toString());
  const queue = [...new Set([origin.toString(), ...sitemapUrls, ...previous.urls.map((page) => page.url)])];
  const queued = new Set(queue);
  const results: Array<ArchivedPage | undefined> = [];
  let successfulPages = 0;
  const archivePage = async (url: string): Promise<ArchivedPage | undefined> => {
    const prior = previousByUrl.get(url) ?? { url, status: 200 };
    if (options.resume) {
      const page = await existingPage(archiveDir, url, prior);
      if (page) {
        if (page.screenshots) skipped += 1;
        return page;
      }
    }
    try {
      const response = await request(url);
      const contentType = response.headers.get("content-type") ?? "";
      const html = /text\/html|application\/xhtml\+xml/i.test(contentType) ? response.body.toString("utf8") : undefined;
      const meta = pageMeta(response, origin, assetExcluded);
      if (html && response.status >= 200 && response.status < 400) for (const link of meta.internalLinks) {
        if (!queued.has(link) && queued.size < maxPages) { queued.add(link); queue.push(link); }
      }
      return { response, html, meta, screenshots: false };
    } catch { return undefined; }
  };
  await new Promise<void>((resolve) => {
    let next = 0;
    let pending = 0;
    let settled = false;
    const finish = () => {
      if (!settled && pending === 0 && (next >= queue.length || successfulPages >= maxPages)) {
        settled = true;
        resolve();
      }
    };
    const launch = (): void => {
      while (pending < concurrency && next < queue.length && successfulPages + pending < maxPages) {
        const resultIndex = next;
        const url = queue[next];
        next += 1;
        if (!url) continue;
        pending += 1;
        void archivePage(url).then((page) => {
          results[resultIndex] = page;
          if (page) successfulPages += 1;
        }, () => undefined).finally(() => {
          pending -= 1;
          launch();
          finish();
        });
      }
      finish();
    };
    launch();
  });
  const pages = results.filter((page): page is ArchivedPage => page !== undefined);
  const archivedPages = options.limit === undefined ? pages : pages.slice(0, options.limit);
  const assetUrls = new Set<string>();
  for (const page of archivedPages) {
    const directory = pageDirectory(join(archiveDir, "pages"), page.response.requestedUrl);
    await mkdir(directory, { recursive: true });
    if (page.html !== undefined && !(options.resume && await exists(join(directory, "page.html")))) {
      await writeFile(join(directory, "page.html"), page.html);
      for (const asset of assetsInHtml(page.html, page.response.finalUrl)) assetUrls.add(asset);
    }
    if (!(options.resume && await exists(join(directory, "meta.json")))) await writeFile(join(directory, "meta.json"), `${JSON.stringify(page.meta, null, 2)}\n`);
  }
  await saveAssets([...assetUrls], archiveDir, request);
  options.onPacerStats?.(pacer.stats());
  const screenshotFailed = options.screenshots ?? true ? await takeScreenshots(archivedPages.filter((page) => !page.screenshots), archiveDir, screenshotTimeoutMs, warnings) : 0;
  const formsByEndpoint = new Map<string, Set<string>>();
  for (const page of archivedPages) for (const form of page.meta.forms) {
    try { if (new URL(form.action).origin === origin.origin) continue; }
    catch { continue; }
    const matching = formsByEndpoint.get(form.action) ?? new Set<string>();
    matching.add(page.meta.url); formsByEndpoint.set(form.action, matching);
  }
  for (const form of previous.forms) {
    const sourcePages = formsByEndpoint.get(form.endpoint) ?? new Set<string>();
    for (const page of form.pages) sourcePages.add(page);
    formsByEndpoint.set(form.endpoint, sourcePages);
  }
  const forms = [...formsByEndpoint.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([endpoint, sourcePages]) => ({ endpoint, pages: [...sourcePages].sort() }));
  const currentUrls = archivedPages.map((page) => ({ url: page.meta.url, status: page.meta.status, ...(page.meta.title ? { title: page.meta.title } : {}), screenshots: page.screenshots }));
  const urls = [...new Map([...previous.urls.map((page) => ({ ...page, screenshots: page.screenshots ?? false })), ...currentUrls].map((page) => [page.url, page])).values()].sort((left, right) => left.url.localeCompare(right.url));
  const completedUrls = new Set(currentUrls.filter((page) => page.screenshots).map((page) => page.url));
  const inventoryWarnings = [...previous.warnings.filter((warning) => !completedUrls.has(warning.url)), ...warnings];
  const inventory = { urls, forms, warnings: inventoryWarnings, summary: { skipped, screenshotFailed, assetExcluded: assetExcluded.size } };
  await Promise.all([
    writeFile(join(archiveDir, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`),
    writeFile(join(archiveDir, "forms.json"), `${JSON.stringify(forms, null, 2)}\n`),
  ]);
  return { archiveDir, pages: inventory.urls, forms: inventory.forms, skipped, screenshotFailed, assetExcluded: assetExcluded.size, warnings };
}
