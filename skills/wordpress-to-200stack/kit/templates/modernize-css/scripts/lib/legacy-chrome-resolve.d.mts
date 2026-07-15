export type LegacyBodyMetadata = { className?: string; id?: string };
export type LegacyMetaData = {
  byPath: Record<string, { body?: LegacyBodyMetadata; stylesheets?: string[] }>;
  stylesheetFallbacks?: { default?: string[] };
};

export type LegacyChromeResolution = {
  stylesheet: string;
  bodyClass: string;
  bodyId: string;
};

export function normalizedExternalUrl(href: string): string;
export function normalizeLegacyPath(path: string): string;
export function vendoredHref(vendorUrls: Record<string, string>, href: string): string;
export function stylesheetsFor(legacyMeta: LegacyMetaData, path: string): string[];
export function stylesheetKey(stylesheets: string[], vendorUrls: Record<string, string>): string;
export function bodyFor(legacyMeta: LegacyMetaData, path: string): LegacyBodyMetadata | undefined;
export function resolveLegacyChrome(
  data: {
    legacyMeta: LegacyMetaData;
    vendorUrls: Record<string, string>;
    hrefByStylesheets: Record<string, string>;
  },
  path: string,
): LegacyChromeResolution;
