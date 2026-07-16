import rawManifest from "@/data/media-manifest.json";

type LocalMediaEntry = { local: string };
type MediaUrlOptions = { w?: number };

const manifest = rawManifest as Record<string, unknown>;
const UPLOAD_PATH = "/wp-content/uploads/";
const ABSOLUTE_URL = /^[a-z][a-z\d+.-]*:/i;
// 旧サイトのオリジン。相対 /wp-content/uploads/ を解決するためだけに使う。
const LEGACY_ORIGIN = process.env.NEXT_PUBLIC_LEGACY_ORIGIN ?? "https://example.invalid";

function localMediaPath(pathname: string): string | undefined {
  const entry = manifest[pathname];
  return entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as Partial<LocalMediaEntry>).local === "string"
    ? (entry as LocalMediaEntry).local
    : undefined;
}

function uploadPathname(value: string): string | undefined {
  try {
    const url = new URL(value, LEGACY_ORIGIN);
    return url.pathname.startsWith(UPLOAD_PATH) ? url.pathname : undefined;
  } catch {
    return undefined;
  }
}

/** Replace only manifest-backed WordPress uploads; missing entries deliberately retain the source URL. */
export function rewriteBodyMedia(html: string): string {
  const rewriteValue = (value: string): string => {
    try {
      const url = new URL(value, LEGACY_ORIGIN);
      if (url.hostname === "images.microcms-assets.io") {
        url.searchParams.set("fm", "webp");
        url.searchParams.set("q", "75");
        return url.toString();
      }
    } catch {
      return value;
    }
    const pathname = uploadPathname(value);
    return pathname ? localMediaPath(pathname) ?? value : value;
  };
  return html.replace(/\b(src|srcset)=(['"])([^'"]+)\2/gi, (_whole, attribute: string, quote: string, value: string) => {
    if (attribute.toLowerCase() === "srcset") {
      const rewritten = value.split(",").map((candidate) => {
        const match = candidate.match(/^(\s*)(\S+)([\s\S]*)$/);
        return match ? `${match[1]}${rewriteValue(match[2])}${match[3]}` : candidate;
      }).join(",");
      return `${attribute}=${quote}${rewritten}${quote}`;
    }
    return `${attribute}=${quote}${rewriteValue(value)}${quote}`;
  });
}

/**
 * Resolve a content image URL to its lightweight delivery form:
 * - microCMS assets -> append image API params (fm=webp&q=75, optional w)
 * - migrated uploads -> local /media/ webp emitted by `wpkit media transform`
 * - anything else (theme assets etc.) -> untouched
 */
export function mediaUrl(value: string | null | undefined, options?: MediaUrlOptions): string {
  if (!value) return "";

  try {
    const url = new URL(value, LEGACY_ORIGIN);
    if (url.hostname === "images.microcms-assets.io") {
      url.searchParams.set("fm", "webp");
      url.searchParams.set("q", "75");
      if (options?.w !== undefined) url.searchParams.set("w", String(options.w));
      return url.toString();
    }
    if (!url.pathname.startsWith(UPLOAD_PATH)) return value;
    const local = localMediaPath(url.pathname);
    if (local) return local;
    if (!ABSOLUTE_URL.test(value)) return value;
    const host = process.env.NEXT_PUBLIC_MEDIA_HOST?.replace(/\/$/, "");
    return host ? `${host}${url.pathname}${url.search}${url.hash}` : value;
  } catch {
    return value;
  }
}
