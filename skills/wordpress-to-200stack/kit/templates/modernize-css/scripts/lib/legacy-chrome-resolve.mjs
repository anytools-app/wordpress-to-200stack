function decodeHtmlAttribute(value) {
  return value.replace(/&(amp|#0*38);/gi, "&");
}

export function normalizedExternalUrl(href) {
  const decoded = decodeHtmlAttribute(href);
  return decoded.startsWith("//") ? `https:${decoded}` : decoded;
}

export function normalizeLegacyPath(path) {
  return path === "/" ? path : path.replace(/\/+$/, "");
}

export function vendoredHref(vendorUrls, href) {
  return vendorUrls[href] ?? vendorUrls[normalizedExternalUrl(href)] ?? href;
}

/**
 * Matches the legacy stylesheet fallback order used by both static body
 * injection and React-rendered page chrome.
 */
export function stylesheetsFor(legacyMeta, path) {
  const normalizedPath = normalizeLegacyPath(path);
  const exact = legacyMeta.byPath[normalizedPath]?.stylesheets;
  if (exact?.length) return exact;

  const archivePath = normalizedPath.replace(/\/page\/\d+$/, "");
  const archiveStylesheets = legacyMeta.byPath[archivePath]?.stylesheets;
  if (archiveStylesheets?.length) return archiveStylesheets;

  const [surface] = normalizedPath.split("/").filter(Boolean);
  const surfaceStylesheets = surface && legacyMeta.byPath[`/${surface}`]?.stylesheets;
  return surfaceStylesheets?.length ? surfaceStylesheets : (legacyMeta.stylesheetFallbacks?.default ?? []);
}

export function stylesheetKey(stylesheets, vendorUrls) {
  return JSON.stringify(stylesheets.map((href) => vendoredHref(vendorUrls, href)));
}

export function bodyFor(legacyMeta, path) {
  return legacyMeta.byPath[normalizeLegacyPath(path)]?.body;
}

export function resolveLegacyChrome({ legacyMeta, vendorUrls, hrefByStylesheets }, path) {
  const normalizedPath = normalizeLegacyPath(path);
  const stylesheets = stylesheetsFor(legacyMeta, normalizedPath);
  const stylesheet = hrefByStylesheets[stylesheetKey(stylesheets, vendorUrls)];
  if (!stylesheet) throw new Error(`No CSS bundle generated for ${normalizedPath}`);

  const body = bodyFor(legacyMeta, normalizedPath);
  return {
    stylesheet,
    bodyClass: body?.className ?? "",
    bodyId: body?.id ?? "",
  };
}
