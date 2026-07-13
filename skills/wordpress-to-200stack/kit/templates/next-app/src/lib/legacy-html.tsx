import sanitizeHtml from "sanitize-html";

const DEFAULT_IFRAME_HOSTS = ["www.youtube.com", "youtube.com", "player.vimeo.com", "calendar.google.com", "www.google.com", "www.instagram.com"];
const STRUCTURAL_TAGS = [
  "a", "abbr", "address", "article", "aside", "b", "blockquote", "br", "caption", "cite", "code", "col", "colgroup", "dd", "del", "details", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "iframe", "img", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "pre", "q", "s", "samp", "section", "small", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var",
];

function allowedHosts(override?: readonly string[]): Set<string> {
  const configured = override ?? process.env.WPKIT_IFRAME_HOSTS?.split(",").map((host) => host.trim()).filter(Boolean) ?? DEFAULT_IFRAME_HOSTS;
  return new Set(configured.map((host) => host.toLowerCase()));
}

function isAllowedIframe(src: string | undefined, hosts: Set<string>): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    return (url.protocol === "https:" || url.protocol === "http:") && hosts.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * legacyBodyHtml と CMS の構造化 HTML を表示する最終防御。
 * script/style/link・イベント属性・javascript: URL は除去しつつ、テーマ CSS が参照する class/id と構造タグは保持する。
 */
export function sanitizeLegacyHtml(html: string, iframeHosts?: readonly string[]): string {
  const hosts = allowedHosts(iframeHosts);
  return sanitizeHtml(html, {
    allowedTags: [...new Set([...sanitizeHtml.defaults.allowedTags, ...STRUCTURAL_TAGS])],
    allowedAttributes: {
      "*": ["class", "id", "role", "data-*", "aria-*"],
      a: ["href", "target", "rel", "title"],
      td: ["colspan", "rowspan", "headers"],
      th: ["colspan", "rowspan", "scope", "headers"],
      ol: ["start", "reversed", "type"],
      li: ["value"],
      iframe: ["src", "title", "width", "height", "allow", "allowfullscreen", "loading", "referrerpolicy"],
      img: ["src", "srcset", "sizes", "alt", "width", "height", "loading", "decoding", "class", "id"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { iframe: ["http", "https"] },
    exclusiveFilter(frame) {
      return frame.tag === "iframe" && !isAllowedIframe(frame.attribs.src, hosts);
    },
  });
}
