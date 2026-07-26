import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

if (!process.argv.includes("--approve")) {
  throw new Error("fixture 更新にはレビュー承認を示す --approve が必要です");
}
if (!process.env.WPKIT_ARCHIVE_DIR) {
  throw new Error("WPKIT_ARCHIVE_DIR に凍結済み archive を指定してください");
}

const project = resolve(import.meta.dirname, "..");
const archivePages = join(resolve(process.env.WPKIT_ARCHIVE_DIR), "pages");
const fixtureDirectory = join(project, "scripts", "fixtures");
const stylesheetsPath = join(fixtureDirectory, "stylesheets.json");
const existingStylesheets = JSON.parse(await readFile(stylesheetsPath, "utf8"));
const normalizedPath = (value) => value === "/" ? "/" : `${String(value).replace(/\/+$/, "")}/`;
const existingTargets = existingStylesheets.targets ?? [];
const expectedByPath = new Map(
  existingTargets
    .filter((target) => Array.isArray(target.expectedStylesheets))
    .map((target) => [normalizedPath(target.path), target.expectedStylesheets]),
);
const directForms = [];
const embeddedForms = [];
const targets = [];
const scannedPaths = new Set();

function attribute(tag, name) {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

for (const entry of await readdir(archivePages, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = join(archivePages, entry.name);
  const metaPath = join(directory, "meta.json");
  const pagePath = join(directory, "page.html");
  let meta;
  let html;
  try {
    [meta, html] = await Promise.all([
      readFile(metaPath, "utf8").then(JSON.parse),
      readFile(pagePath, "utf8"),
    ]);
  } catch (error) {
    throw new Error(
      `archive fixture の読込に失敗しました: ${metaPath} / ${pagePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (meta.status !== 200) continue;
  if (!meta.url && !meta.finalUrl) {
    throw new Error(`archive meta に url/finalUrl がありません: ${metaPath}`);
  }
  const pathname = new URL(meta.url ?? meta.finalUrl).pathname.replace(/\/+$/, "") || "/";
  const canonicalPath = normalizedPath(pathname);
  scannedPaths.add(canonicalPath);
  for (const match of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)) {
    const openingTag = match[0].match(/^<form\b[^>]*>/i)?.[0] ?? "";
    const action = attribute(openingTag, "action");
    if (!action) continue;
    const names = [...match[0].matchAll(/<(input|textarea|select)\b[^>]*>/gi)]
      .flatMap((field) => {
        const name = attribute(field[0], "name");
        return name ? [name] : [];
      });
    directForms.push({ path: canonicalPath, action, names });
  }
  for (const match of html.matchAll(/\bdata-formrun-form\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    embeddedForms.push({ path: canonicalPath, formId: match[1] ?? match[2] });
  }
  const legacyStylesheets = [...html.matchAll(/<link\b[^>]*>/gi)]
    .filter((match) => attribute(match[0], "rel")?.split(/\s+/).includes("stylesheet"))
    .flatMap((match) => {
      const href = attribute(match[0], "href");
      return href ? [href.replaceAll("&amp;", "&")] : [];
    });
  const expectedStylesheets = expectedByPath.get(canonicalPath);
  targets.push({
    path: canonicalPath,
    legacyStylesheets,
    ...(expectedStylesheets ? { expectedStylesheets } : {}),
  });
}
for (const target of existingTargets) {
  const path = normalizedPath(target.path);
  if (scannedPaths.has(path) || !Array.isArray(target.expectedStylesheets)) continue;
  targets.push({
    path,
    legacyStylesheets: target.legacyStylesheets ?? [],
    expectedStylesheets: target.expectedStylesheets,
  });
}
if (scannedPaths.size === 0) {
  throw new Error(`archive fixture の更新対象となる status=200 ページがありません: ${archivePages}`);
}

const stable = (entries) => [...entries].sort((left, right) =>
  left.path.localeCompare(right.path) ||
  JSON.stringify(left).localeCompare(JSON.stringify(right)),
);
await mkdir(fixtureDirectory, { recursive: true });
await Promise.all([
  writeFile(
    join(fixtureDirectory, "forms.json"),
    `${JSON.stringify({ directForms: stable(directForms), embeddedForms: stable(embeddedForms) }, null, 2)}\n`,
  ),
  writeFile(
    stylesheetsPath,
    `${JSON.stringify({ targets: stable(targets) }, null, 2)}\n`,
  ),
]);
