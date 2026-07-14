/**
 * Path-to-surface rules shared by the fidelity scan and its reports.
 * 【案件ごとに必ず調整する】SPECIAL_STATIC_PATHS(固定ページ)・TAXONOMY_ROOTS・
 * archiveRoots の特例は移行元サイトのURL設計に合わせて書き換える(以下は実案件の例)。
 */
export const SPECIAL_STATIC_PATHS = new Set(["/company", "/contact", "/privacy"]);

const TAXONOMY_ROOTS = new Set(["category", "tag"]);

/** Decode an inventory pathname once, remove a trailing slash, and always return an absolute path. */
export function normalizePathname(pathname) {
  let normalized = pathname || "/";
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep malformed legacy percent escapes as-is. They will simply not match an exported file.
  }
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : "/";
}

function archiveRoots(routes) {
  const roots = new Map();
  for (const route of routes) {
    if (!route.api || !route.path) continue;
    const root = normalizePathname(route.path).split("/")[1];
    if (!root || root === "item") continue;
    if (!roots.has(root)) roots.set(root, route.api);
  }
  // /item is a listing for the items API; about-item detail routes share this prefix.
  roots.set("item", "items");
  return roots;
}

/**
 * Resolve a normalized path to the first matching surface rule.
 * The order deliberately mirrors the fidelity-scan design instruction.
 */
export function surfaceForPath(pathname, routes = []) {
  const path = normalizePathname(pathname);
  if (path === "/") return "top";

  const parts = path.split("/").filter(Boolean);
  const root = parts[0];
  const archives = archiveRoots(routes);
  const archiveApi = archives.get(root);
  if (archiveApi && (parts.length === 1 || (parts.length === 3 && parts[1] === "page" && /^\d+$/.test(parts[2])))) {
    return `tpl.${archiveApi}.archive`;
  }

  const route = routes.find((item) => normalizePathname(item.path) === path);
  if (route?.api) return `tpl.${route.api}.detail`;

  if (TAXONOMY_ROOTS.has(root)) return "tax.archive";
  if (SPECIAL_STATIC_PATHS.has(path)) return `fixed.${root}`;
  return "unmapped";
}
