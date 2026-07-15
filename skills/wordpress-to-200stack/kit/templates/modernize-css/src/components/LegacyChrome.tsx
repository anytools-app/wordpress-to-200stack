import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  resolveLegacyChrome,
  type LegacyMetaData,
} from "../../scripts/lib/legacy-chrome-resolve.mjs";

type ChromeData = {
  legacyMeta: LegacyMetaData;
  vendorUrls: Record<string, string>;
  hrefByStylesheets: Record<string, string>;
};

let chromeDataPromise: Promise<ChromeData> | undefined;

async function optionalJson(path: string): Promise<Record<string, string>> {
  try {
    await access(path);
    return JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function chromeData(): Promise<ChromeData> {
  const project = process.cwd();
  chromeDataPromise ??= Promise.all([
    readFile(join(project, ".next-data", "legacy-meta.json"), "utf8").then((value) => JSON.parse(value) as LegacyMetaData),
    optionalJson(join(project, "public", "vendor", "manifest.json")),
    readFile(join(project, ".next-data", "css-bundles.json"), "utf8").then((value) => JSON.parse(value) as Record<string, string>),
  ]).then(([legacyMeta, vendorUrls, hrefByStylesheets]) => ({ legacyMeta, vendorUrls, hrefByStylesheets }));
  return chromeDataPromise;
}

/** Declares route-specific legacy CSS and body attributes through React. */
export async function LegacyChrome({ path }: { path: string }) {
  const chrome = resolveLegacyChrome(await chromeData(), path);
  return <>
    <link
      rel="stylesheet"
      precedence="legacy"
      href={chrome.stylesheet}
      data-legacy-stylesheet="true"
    />
    <div
      key={path}
      hidden
      data-legacy-chrome
      data-body-class={chrome.bodyClass}
      data-body-id={chrome.bodyId}
      data-stylesheet={chrome.stylesheet}
    />
  </>;
}
