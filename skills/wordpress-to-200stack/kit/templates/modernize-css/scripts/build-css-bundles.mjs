import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  buildLegacyCss,
  mergeStylesheetConfigurations,
  removeLegacyBundleOutputs,
} from "./lib/bundle-css.mjs";
import { bodyFor, stylesheetsFor, vendoredHref } from "./lib/legacy-chrome-resolve.mjs";

const project = resolve(import.meta.dirname, "..");
const dataDir = join(project, ".next-data");
const publicDir = join(project, "public");
const appDir = join(project, "src", "app");
const manifestPath = join(publicDir, "vendor", "manifest.json");
const legacyMeta = JSON.parse(await readFile(join(dataDir, "legacy-meta.json"), "utf8"));

async function vendorManifest() {
  try {
    await access(manifestPath);
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

const vendorUrls = await vendorManifest();
const configurationsByKey = new Map();
const expectedOriginals = new Set();
for (const path of Object.keys(legacyMeta.byPath)) {
  const originals = stylesheetsFor(legacyMeta, path);
  if (!originals.length) continue;
  originals.forEach((href) => expectedOriginals.add(href));
  const stylesheets = originals.map((href) => vendoredHref(vendorUrls, href));
  const key = JSON.stringify({ originals, stylesheets });
  if (!configurationsByKey.has(key)) configurationsByKey.set(key, { originals, stylesheets });
}

const sources = mergeStylesheetConfigurations([...configurationsByKey.values()]);
const mergedOriginals = new Set(sources.flatMap(({ originals }) => originals));
const missingOriginals = [...expectedOriginals].filter((href) => !mergedOriginals.has(href));
if (missingOriginals.length) {
  throw new Error(`Stylesheet sources missing from merged CSS: ${missingOriginals.join(", ")}`);
}
const scopedSources = sources.filter(({ guard }) => guard);
if (scopedSources.length !== 8) {
  throw new Error(`Expected exactly 8 surface stylesheets, got ${scopedSources.length}`);
}

const guardMismatches = [];
const sourceByOriginal = new Map(sources.flatMap((source) => source.originals.map((original) => [original, source])));
for (const path of Object.keys(legacyMeta.byPath)) {
  const bodyClasses = new Set((bodyFor(legacyMeta, path)?.className ?? "").split(/\s+/).filter(Boolean));
  for (const original of stylesheetsFor(legacyMeta, path)) {
    const source = sourceByOriginal.get(original);
    if (source?.guard && !bodyClasses.has(source.guard)) guardMismatches.push({ path, source: original, guard: source.guard });
  }
}
if (guardMismatches.length) {
  throw new Error(`Surface guard/body class mismatch: ${JSON.stringify(guardMismatches)}`);
}

function sourceManifestJson() {
  const sourceManifest = {};
  for (const source of sources) {
    for (const original of source.originals) {
      const scope = source.guard ? { guard: source.guard } : { global: true };
      if (sourceManifest[original] && JSON.stringify(sourceManifest[original]) !== JSON.stringify(scope)) {
        throw new Error(`Conflicting scope for stylesheet source: ${original}`);
      }
      sourceManifest[original] = scope;
    }
  }
  return `${JSON.stringify(sourceManifest, null, 2)}\n`;
}

async function removeOldDataManifest() {
  try {
    await unlink(join(dataDir, "css-bundles.json"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const first = await buildLegacyCss({ sourceDir: publicDir, sources });
const second = await buildLegacyCss({ sourceDir: publicDir, sources });
const manifestJson = sourceManifestJson();
if (first.css !== second.css || manifestJson !== sourceManifestJson()) {
  throw new Error("Legacy CSS generation is not idempotent");
}

await mkdir(appDir, { recursive: true });
await Promise.all([
  writeFile(join(appDir, "legacy-generated.css"), first.css),
  writeFile(join(appDir, "legacy-generated.sources.json"), manifestJson),
  removeLegacyBundleOutputs(publicDir),
  removeOldDataManifest(),
]);

console.log(JSON.stringify({
  stylesheetConfigurations: configurationsByKey.size,
  output: "src/app/legacy-generated.css",
  sourcesOutput: "src/app/legacy-generated.sources.json",
  idempotent: true,
  ...first.report,
}, null, 2));
