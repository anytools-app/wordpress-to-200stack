import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LegacyDocument } from "./manifest";

export type SearchIndexConfig = { fields: readonly string[] };
export type SearchIndexRegistry = Record<string, SearchIndexConfig | undefined>;

function valueAt(document: LegacyDocument, key: string): unknown {
  const [scope, ...rest] = key.split(".");
  const field = rest.join(".");
  if (scope === "fields" && field) return document.fields[field];
  if (scope === "content" && field) return document.content[field as keyof LegacyDocument["content"]];
  return document.fields[key];
}

function primitive(value: unknown): string | number | boolean | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
}

/** registry で許可した値だけを public/data/<api>-index.json に書き出す。 */
export async function writeSearchIndexes(options: {
  documents: readonly LegacyDocument[];
  registry: SearchIndexRegistry;
  outputDir: string;
}): Promise<void> {
  await mkdir(options.outputDir, { recursive: true });
  for (const [api, config] of Object.entries(options.registry)) {
    if (!config || config.fields.length === 0) continue;
    const contents = options.documents.filter((document) => document.api === api).map((document) => ({
      id: document.contentId,
      path: document.route.path,
      ...Object.fromEntries(config.fields.map((field) => [field, primitive(valueAt(document, field))])),
    }));
    await writeFile(join(options.outputDir, `${api}-index.json`), `${JSON.stringify(contents)}\n`);
  }
}
