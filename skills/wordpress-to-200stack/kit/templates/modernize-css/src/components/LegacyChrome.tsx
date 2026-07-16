import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  bodyFor,
  type LegacyMetaData,
} from "../../scripts/lib/legacy-chrome-resolve.mjs";

let legacyMetaPromise: Promise<LegacyMetaData> | undefined;

function legacyMeta(): Promise<LegacyMetaData> {
  const project = process.cwd();
  legacyMetaPromise ??= readFile(join(project, ".next-data", "legacy-meta.json"), "utf8")
    .then((value) => JSON.parse(value) as LegacyMetaData);
  return legacyMetaPromise;
}

/** Keeps legacy body attributes synchronized across client-side route changes. */
export async function LegacyChrome({ path }: { path: string }) {
  const body = bodyFor(await legacyMeta(), path);
  return <div
    key={path}
    hidden
    data-legacy-chrome
    data-body-class={body?.className ?? ""}
    data-body-id={body?.id ?? ""}
  />;
}
