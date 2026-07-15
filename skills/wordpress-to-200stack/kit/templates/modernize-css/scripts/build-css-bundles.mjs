import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { writeCssBundles } from "./lib/bundle-css.mjs";
import { stylesheetKey, stylesheetsFor } from "./lib/legacy-chrome-resolve.mjs";

const project = resolve(import.meta.dirname, "..");
const dataDir = join(project, ".next-data");
const publicDir = join(project, "public");
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
const bundlesByKey = new Map();

for (const path of Object.keys(legacyMeta.byPath)) {
  const originals = stylesheetsFor(legacyMeta, path);
  if (!originals.length) continue;
  const key = stylesheetKey(originals, vendorUrls);
  if (!bundlesByKey.has(key)) {
    bundlesByKey.set(key, {
      originals,
      stylesheets: JSON.parse(key),
    });
  }
}

const { hrefByStylesheets } = await writeCssBundles({
  sourceDir: publicDir,
  outputDir: publicDir,
  bundles: [...bundlesByKey.values()],
});

await mkdir(dataDir, { recursive: true });
await writeFile(
  join(dataDir, "css-bundles.json"),
  `${JSON.stringify(Object.fromEntries(hrefByStylesheets), null, 2)}\n`,
);

console.log(JSON.stringify({
  cssBundles: new Set(hrefByStylesheets.values()).size,
  stylesheetConfigurations: hrefByStylesheets.size,
  output: "/assets/css/bundles.json",
}));
