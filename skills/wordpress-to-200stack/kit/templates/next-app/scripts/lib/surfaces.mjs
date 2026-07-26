/**
 * Path-to-surface rules shared by the fidelity scan and its reports.
 * TODO(案件): SPECIAL_STATIC_PATHS・TAXONOMY_ROOTS・ARCHIVE_ROOT_APIS は移行元サイトのURL設計に合わせて調整する。
 */
// 固定ページ（microCMS を経由せず src/app/<route>/page.tsx で実装するパス）を列挙する。
export const SPECIAL_STATIC_PATHS = new Set(["/company", "/contact", "/privacy"]);

// タクソノミー一覧として扱うパス根。案件の custom taxonomy スラッグを追加する。
const TAXONOMY_ROOTS = new Set(["category", "tag"]);

// 一覧パスの根と API 名が異なる場合、または同じパス根の下に別 API の詳細ルートが同居していて routes.json からの先勝ち推定が誤る場合に指定する。
const ARCHIVE_ROOT_APIS = new Map([
  // ["news", "posts"],
]);

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
    if (!root || ARCHIVE_ROOT_APIS.has(root)) continue;
    if (!roots.has(root)) roots.set(root, route.api);
  }
  for (const [root, api] of ARCHIVE_ROOT_APIS) roots.set(root, api);
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
