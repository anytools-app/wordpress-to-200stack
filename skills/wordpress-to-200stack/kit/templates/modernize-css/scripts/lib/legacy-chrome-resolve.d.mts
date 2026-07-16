export type LegacyBodyMetadata = { className?: string; id?: string };
export type LegacyMetaData = {
  byPath: Record<string, { body?: LegacyBodyMetadata; stylesheets?: string[] }>;
  legacyPathAliases?: Record<string, string>;
  stylesheetFallbacks?: { default?: string[] };
};

export function normalizedExternalUrl(href: string): string;
export function normalizeLegacyPath(path: string): string;
export function legacyMetaPath(legacyMeta: LegacyMetaData, path: string): string;
export function vendoredHref(vendorUrls: Record<string, string>, href: string): string;
export function stylesheetsFor(legacyMeta: LegacyMetaData, path: string): string[];
export function bodyFor(legacyMeta: LegacyMetaData, path: string): LegacyBodyMetadata | undefined;
