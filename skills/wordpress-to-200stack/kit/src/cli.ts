#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { Command } from "commander";

import { analyzeWxr, writeAnalysis } from "./analyze/index.js";
import { archiveSite } from "./archive/index.js";
import { parseWxr } from "./core/wxr.js";
import { pullMedia } from "./media/pull.js";
import { pushMedia } from "./media/push.js";
import { importDocuments } from "./microcms/import.js";
import { writeSchemas } from "./microcms/schema.js";
import { loadMigrationConfig, parseConfigFile } from "./parse/index.js";
import { verifySite } from "./verify/index.js";

const program = new Command();
const count = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`0 以上の整数を指定してください: ${value}`);
  return parsed;
};
const positiveCount = (value: string): number => {
  const parsed = count(value);
  if (parsed === 0) throw new Error(`1 以上の整数を指定してください: ${value}`);
  return parsed;
};

program
  .name("wpkit")
  .description("WordPress static migration toolkit")
  .command("analyze <wxr>")
  .option("-o, --out-dir <outDir>", "analysis output directory", "./analysis")
  .action(async (wxr: string, options: { outDir: string }) => {
    const input = await readFile(wxr, "utf8");
    const exportData = parseWxr(input);
    const result = analyzeWxr(exportData);
    await writeAnalysis(result, options.outDir);
    for (const warning of result.warnings) console.error(warning);
    console.log(JSON.stringify({
      items: exportData.items.length,
      postTypes: Object.keys(result.census.postTypes).length,
      warnings: result.warnings.length,
      outDir: options.outDir,
    }));
  });

program
  .command("parse")
  .requiredOption("--config <mappingConfig>", "mapping.config.ts path")
  .option("-o, --out-dir <outDir>", "IR output directory", "./ir")
  .action(async (options: { config: string; outDir: string }) => {
    const result = await parseConfigFile(options.config, options.outDir);
    const byApi = Object.fromEntries([...new Set(result.documents.map((document) => document.api))]
      .sort()
      .map((api) => [api, result.documents.filter((document) => document.api === api).length]));
    console.log(JSON.stringify({
      apis: byApi,
      routes: result.routes.length,
      errors: result.validation.errors.length,
      warnings: result.validation.warnings.length,
      outDir: options.outDir,
    }));
    if (result.validation.errors.length > 0) process.exitCode = 1;
  });

const media = program.command("media").description("download and publish WordPress media");
media
  .command("pull")
  .requiredOption("--ir <irDir>", "parse output directory")
  .option("-o, --media <mediaDir>", "media output directory", "./media")
  .option("--concurrency <count>", "parallel downloads", positiveCount, 6)
  .option("--limit <count>", "process only the first N URLs", count)
  .option("--include-derived", "include WordPress generated image sizes")
  .action(async (options: { ir: string; media: string; concurrency: number; limit?: number; includeDerived?: boolean }) => {
    const result = await pullMedia({ irDir: options.ir, mediaDir: options.media, concurrency: options.concurrency, limit: options.limit, includeDerived: options.includeDerived });
    console.log(JSON.stringify({ ok: result.ok, missing: result.missing, invalid: result.invalid, skipped: result.skipped, mediaDir: options.media }));
  });

const schema = program.command("schema").description("generate microCMS import schemas");
schema
  .command("gen")
  .requiredOption("--config <mappingConfig>", "mapping.config.ts path")
  .option("-o, --out-dir <schemaDir>", "schema output directory", "./microcms-schema")
  .action(async (options: { config: string; outDir: string }) => {
    const { config } = await loadMigrationConfig(options.config);
    const schemas = await writeSchemas(config, options.outDir);
    console.log(JSON.stringify({ apis: Object.keys(schemas), outDir: options.outDir }));
  });

program
  .command("import")
  .requiredOption("--ir <irDir>", "parse output directory")
  .option("--only <api>", "import only one API")
  .option("--source-id <wpId>", "import only one WordPress source ID", positiveCount)
  .option("--dry-run", "show counts without sending requests")
  .option("--concurrency <count>", "parallel request preparation", positiveCount, 1)
  .action(async (options: { ir: string; only?: string; sourceId?: number; dryRun?: boolean; concurrency: number }) => {
    const result = await importDocuments({ irDir: options.ir, only: options.only, sourceId: options.sourceId, dryRun: options.dryRun, concurrency: options.concurrency });
    console.log(JSON.stringify(result));
    if (result.failures.length > 0) process.exitCode = 1;
  });

media
  .command("push")
  .requiredOption("--media <mediaDir>", "media directory")
  .requiredOption("--bucket <name>", "S3/R2 bucket")
  .option("--prefix <prefix>", "object key prefix", "")
  .option("--endpoint <url>", "S3 compatible endpoint")
  .option("--dry-run", "show upload candidates without uploading")
  .action(async (options: { media: string; bucket: string; prefix: string; endpoint?: string; dryRun?: boolean }) => {
    const result = await pushMedia({ mediaDir: options.media, bucket: options.bucket, prefix: options.prefix, endpoint: options.endpoint, dryRun: options.dryRun });
    for (const key of result.uploaded) console.log(key);
    console.log(JSON.stringify({ uploads: result.uploaded.length, skipped: result.skipped.length, dryRun: result.dryRun }));
  });

program
  .command("archive <origin>")
  .option("-o, --out-dir <archiveDir>", "archive output directory", "./archive")
  .option("--max-pages <count>", "maximum number of pages", count, 2000)
  .option("--concurrency <count>", "parallel asset downloads", positiveCount, 4)
  .option("--limit <count>", "process only the first N collected URLs", count)
  .option("--screenshots", "enable Playwright screenshots", true)
  .option("--no-screenshots", "disable Playwright screenshots")
  .option("--resume", "reuse existing archived HTML and completed screenshots")
  .option("--screenshot-timeout <sec>", "timeout per page for desktop and mobile screenshots", positiveCount, 30)
  .action(async (origin: string, options: { outDir: string; maxPages: number; concurrency: number; limit?: number; screenshots: boolean; resume?: boolean; screenshotTimeout: number }) => {
    const result = await archiveSite({ origin, archiveDir: options.outDir, maxPages: options.maxPages, concurrency: options.concurrency, limit: options.limit, screenshots: options.screenshots, resume: options.resume, screenshotTimeout: options.screenshotTimeout });
    console.log(JSON.stringify({ pages: result.pages.length, forms: result.forms.length, skipped: result.skipped, screenshotFailed: result.screenshotFailed, assetExcluded: result.assetExcluded, archiveDir: result.archiveDir }));
  });

program
  .command("verify")
  .requiredOption("--old <archiveDir>", "old archive directory")
  .requiredOption("--new <baseUrlOrDistDir>", "new site base URL or dist directory")
  .option("-o, --out-dir <reportDir>", "report output directory", "./verify-report")
  .option("--screenshots", "take and compare desktop and mobile screenshots")
  .option("--threshold <ratio>", "pixel difference threshold", (value: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`0 から 1 の閾値を指定してください: ${value}`);
    return parsed;
  }, 0.02)
  .option("--limit <count>", "verify only the first N old URLs", count)
  .action(async (options: { old: string; new: string; outDir: string; screenshots?: boolean; threshold: number; limit?: number }) => {
    const result = await verifySite({ oldDir: options.old, newTarget: options.new, reportDir: options.outDir, screenshots: options.screenshots, threshold: options.threshold, limit: options.limit });
    console.log(JSON.stringify({ checked: result.checked, missing: result.missing.length, metaMismatches: result.metaMismatches.length, brokenLinks: result.brokenLinks.length, screenshotDiffs: result.screenshotDiffs.length, reportDir: result.reportDir }));
    if (result.missing.length > 0) process.exitCode = 1;
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
