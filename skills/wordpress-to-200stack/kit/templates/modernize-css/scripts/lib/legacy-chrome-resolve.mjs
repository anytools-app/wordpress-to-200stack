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

/** contentId 採番後の正規 URL を、原文 HTML から採取した旧 URL の chrome へ対応付ける。 */
export function legacyMetaPath(legacyMeta, path) {
  const normalizedPath = normalizeLegacyPath(path);
  return legacyMeta.legacyPathAliases?.[normalizedPath] ?? normalizedPath;
}

export function vendoredHref(vendorUrls, href) {
  return vendorUrls[href] ?? vendorUrls[normalizedExternalUrl(href)] ?? href;
}

/** Resolves the legacy stylesheet list used to build and verify the unified CSS. */
export function stylesheetsFor(legacyMeta, path) {
  const normalizedPath = normalizeLegacyPath(path);
  const exact = legacyMeta.byPath[legacyMetaPath(legacyMeta, normalizedPath)]?.stylesheets;
  if (exact?.length) return exact;

  const archivePath = normalizedPath.replace(/\/page\/\d+$/, "");
  const archiveStylesheets = legacyMeta.byPath[archivePath]?.stylesheets;
  if (archiveStylesheets?.length) return archiveStylesheets;

  const [surface] = normalizedPath.split("/").filter(Boolean);
  const surfaceStylesheets = surface && legacyMeta.byPath[`/${surface}`]?.stylesheets;
  return surfaceStylesheets?.length ? surfaceStylesheets : (legacyMeta.stylesheetFallbacks?.default ?? []);
}

export function bodyFor(legacyMeta, path) {
  return legacyMeta.byPath[legacyMetaPath(legacyMeta, path)]?.body;
}
