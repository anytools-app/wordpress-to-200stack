import * as cheerio from "cheerio";

export type HtmlWarning = {
  unresolvedInternalLinks: string[];
  removedScripts: number;
  removedIframes: string[];
};
export type RewriteHtmlContext = {
  site: { origin: string; mediaHost: string };
  routePaths: Set<string>;
  allowIframeHosts: Set<string>;
};

function parsedUrl(value: string, origin: string): URL | undefined {
  try { return new URL(value, origin); } catch { return undefined; }
}

function isUpload(url: URL, origin: URL): boolean {
  return url.host === origin.host && url.pathname.startsWith("/wp-content/uploads/");
}

function mediaUrl(url: URL, mediaHost: URL): string {
  const replacement = new URL(url.toString());
  replacement.protocol = mediaHost.protocol;
  replacement.host = mediaHost.host;
  return replacement.toString();
}

function rewriteSrcset(value: string, origin: URL, mediaHost: URL, assets: Set<string>): string {
  return value.split(",").map((candidate) => {
    const trimmed = candidate.trim();
    const [urlText, ...descriptor] = trimmed.split(/\s+/);
    if (!urlText) return candidate;
    const url = parsedUrl(urlText, origin.toString());
    if (!url || !isUpload(url, origin)) return trimmed;
    assets.add(url.toString());
    return [mediaUrl(url, mediaHost), ...descriptor].join(" ");
  }).join(", ");
}

export function normalizeRoutePath(value: string): string {
  let pathname = value;
  try { pathname = new URL(value, "https://wpkit.invalid").pathname; } catch { /* treat it as a path */ }
  try { pathname = decodeURIComponent(pathname); } catch { /* retain malformed escapes */ }
  const segments = pathname.normalize("NFC").split("/").filter(Boolean);
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

export function rewriteLegacyHtml(html: string, context: RewriteHtmlContext): { html: string; assets: string[]; warnings: HtmlWarning } {
  const origin = new URL(context.site.origin);
  const mediaHost = new URL(context.site.mediaHost);
  const $ = cheerio.load(html, undefined, false);
  const assets = new Set<string>();
  const warnings: HtmlWarning = { unresolvedInternalLinks: [], removedScripts: 0, removedIframes: [] };

  $("img").each((_, element) => {
    const image = $(element);
    const source = image.attr("src");
    if (source) {
      const url = parsedUrl(source, origin.toString());
      if (url && isUpload(url, origin)) {
        assets.add(url.toString());
        image.attr("src", mediaUrl(url, mediaHost));
      }
    }
    const srcset = image.attr("srcset");
    if (srcset) image.attr("srcset", rewriteSrcset(srcset, origin, mediaHost, assets));
  });

  $("a[href]").each((_, element) => {
    const anchor = $(element);
    const href = anchor.attr("href");
    if (!href) return;
    if (/^\s*javascript:/i.test(href)) { anchor.removeAttr("href"); return; }
    const url = parsedUrl(href, origin.toString());
    if (!url || url.host !== origin.host) return;
    if (isUpload(url, origin)) {
      assets.add(url.toString());
      anchor.attr("href", mediaUrl(url, mediaHost));
      return;
    }
    if (context.routePaths.has(normalizeRoutePath(url.toString()))) return;
    warnings.unresolvedInternalLinks.push(href);
  });

  $("script").each((_, element) => { warnings.removedScripts += 1; $(element).remove(); });
  $("iframe").each((_, element) => {
    const frame = $(element);
    const source = frame.attr("src");
    const host = source ? parsedUrl(source, origin.toString())?.host.toLowerCase() : undefined;
    if (host && context.allowIframeHosts.has(host)) frame.attr("loading", "lazy");
    else { warnings.removedIframes.push(source ?? "(srcなし)"); frame.remove(); }
  });
  $("*").each((_, element) => {
    const attribs = "attribs" in element ? element.attribs : undefined;
    for (const attribute of Object.keys(attribs ?? {})) {
      if (/^on/i.test(attribute)) $(element).removeAttr(attribute);
    }
  });
  // htmlparser2 inserts a tbody for an authored table without one.  Undo only
  // that implicit wrapper so untouched WordPress table markup remains stable.
  const output = html.includes("<tbody") ? $.html() : $.html().replace(/<table([^>]*)><tbody>([\s\S]*?)<\/tbody><\/table>/gi, "<table$1>$2</table>");
  return { html: output, assets: [...assets].sort(), warnings };
}
