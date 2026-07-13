import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Next.js の外(前段スクリプト)でも .env.local / .env を同じ規則で読み込む。
// これが無いと `npm run dev` 直叩きで WPKIT_IR_DIR 等が渡らない
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { dataDirectory, irDirectory, readIrDocuments, readIrRoutes, type BuildDataSource } from "../src/lib/manifest";
import { fetchMicroCmsApis } from "../src/lib/microcms";
import { hydrateDocuments } from "../src/lib/repository";
import { writeSearchIndexes } from "../src/lib/search-index";
import { searchIndexRegistry } from "../src/templates/registry";

function source(): BuildDataSource {
  const value = process.env.WPKIT_DATA_SOURCE ?? "microcms";
  if (value === "ir" || value === "microcms") return value;
  throw new Error("WPKIT_DATA_SOURCE は ir または microcms を指定してください");
}

async function main(): Promise<void> {
  const [documents, routes] = await Promise.all([readIrDocuments(irDirectory()), readIrRoutes(irDirectory())]);
  const dataSource = source();
  const cacheDir = dataDirectory();
  await mkdir(cacheDir, { recursive: true });
  await Promise.all([
    writeFile(join(cacheDir, "documents.ndjson"), documents.map((document) => JSON.stringify(document)).join("\n") + (documents.length ? "\n" : "")),
    writeFile(join(cacheDir, "routes.json"), `${JSON.stringify(routes, null, 2)}\n`),
    writeFile(join(cacheDir, "manifest.json"), `${JSON.stringify({ source: dataSource })}\n`),
  ]);
  const records = dataSource === "microcms" ? await fetchMicroCmsApis([...new Set(documents.map((document) => document.api))]) : {};
  await writeFile(join(cacheDir, "microcms.json"), `${JSON.stringify(records)}\n`);
  await writeSearchIndexes({ documents: hydrateDocuments(documents, dataSource, records), registry: searchIndexRegistry, outputDir: join(process.cwd(), "public", "data") });
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
