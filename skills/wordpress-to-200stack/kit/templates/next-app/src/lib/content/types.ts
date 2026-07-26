export type MicroCmsRecord = { id: string; [field: string]: unknown };

export type MediaDimensions = { width: number; height: number };

export type LegacyDocument = {
  source: { postType: string; status: string; modifiedGmt?: string };
  api: string;
  kind?: string;
  contentId: string;
  route: { legacyUrl: string; path: string; segments: string[]; trailingSlash: boolean };
  content: { title: string; legacyBodyHtml: string; excerpt: string; publishedAt: string };
  seo?: { title?: string; description?: string; noindex?: boolean };
  taxonomies: Array<{ taxonomy: string; slug: string; name: string }>;
  fields: Record<string, unknown>;
  repeaters: Record<string, Array<Record<string, unknown>>>;
  relations: Array<{ fieldId: string; toApi: string; targetContentId: string }>;
  featuredImage?: string;
  featuredImageDimensions?: MediaDimensions;
};

export type RouteEntry = LegacyDocument["route"] & {
  api: string;
  contentId: string;
  legacyUrl: string;
};

/** output:export + trailingSlash:true の route/href 契約へ正規化する。 */
export function withTrailingSlash(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return value;
  const suffixIndex = value.search(/[?#]/);
  const path = suffixIndex === -1 ? value : value.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? "" : value.slice(suffixIndex);
  if (path === "/" || path.endsWith("/")) return value;
  return `${path}/${suffix}`;
}

export function normalizeRoutePath(value: string): string {
  const path = value.split(/[?#]/, 1)[0] || "/";
  const absolute = path.startsWith("/") ? path : `/${path}`;
  return withTrailingSlash(absolute);
}
