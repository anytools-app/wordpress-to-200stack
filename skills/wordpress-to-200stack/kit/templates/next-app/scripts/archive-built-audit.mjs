import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import { collectArchiveBuiltAudit } from "./lib/archive-built-audit.mjs";

const project = resolve(import.meta.dirname, "..");

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: node scripts/archive-built-audit.mjs [--config fidelity-audit.config.json] [--only <surface-id>] [--report path]");
  process.exit(2);
}

function parseArgs(argv) {
  const options = { config: resolve(project, "fidelity-audit.config.json"), report: null, only: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--config") options.config = resolve(argv[++index] ?? usage("--config requires a path"));
    else if (flag.startsWith("--config=")) options.config = resolve(flag.slice("--config=".length) || usage("--config requires a path"));
    else if (flag === "--report") options.report = resolve(argv[++index] ?? usage("--report requires a path"));
    else if (flag === "--only") options.only = argv[++index] ?? usage("--only requires a surface id");
    else usage(`Unknown option: ${flag}`);
  }
  return options;
}

function configPath(base, value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty path`);
  return resolve(base, value);
}

function validateConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("fidelity audit config must be an object");
  if (raw.schemaVersion !== 1) throw new Error("fidelity audit config schemaVersion must be 1");
  const allowed = new Set(["schemaVersion", "repository", "archiveDirectory", "inventory", "outDirectory", "artifact", "routeLedger", "mediaMap", "mediaManifest", "decisions", "report", "origin", "internalHosts", "excludeSelectors", "surfaceRules", "expectedCoverage"]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`fidelity audit config has unknown fields: ${unknown.join(", ")}`);
  try { new URL(raw.origin); } catch { throw new Error("fidelity audit config origin must be an absolute URL"); }
  if (!Array.isArray(raw.internalHosts) || raw.internalHosts.some((host) => typeof host !== "string" || !host)) throw new Error("fidelity audit config internalHosts must be an array of hosts");
  if (!Array.isArray(raw.excludeSelectors) || raw.excludeSelectors.some((selector) => typeof selector !== "string" || !selector)) throw new Error("fidelity audit config excludeSelectors must be an array of selectors");
  if (!Array.isArray(raw.surfaceRules) || raw.surfaceRules.length === 0) throw new Error("fidelity audit config surfaceRules must be a non-empty array");
  const surfaceIds = new Set();
  for (const [index, rule] of raw.surfaceRules.entries()) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule) || typeof rule.id !== "string" || !rule.id || typeof rule.route !== "string" || typeof (rule.archive ?? rule.archiveSelector) !== "string" || typeof (rule.built ?? rule.builtSelector) !== "string") {
      throw new Error(`fidelity audit config surfaceRules[${index}] is invalid`);
    }
    if (surfaceIds.has(rule.id)) throw new Error(`fidelity audit config surfaceRules has duplicate id: ${rule.id}`);
    surfaceIds.add(rule.id);
    try { new RegExp(rule.route); } catch { throw new Error(`fidelity audit config surfaceRules[${index}].route is invalid`); }
  }
  if (raw.expectedCoverage !== undefined && (!raw.expectedCoverage || typeof raw.expectedCoverage !== "object" || Array.isArray(raw.expectedCoverage) || Object.values(raw.expectedCoverage).some((value) => !Number.isInteger(value) || value < 0))) throw new Error("fidelity audit config expectedCoverage must contain non-negative integers");
  return raw;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const raw = validateConfig(JSON.parse(await readFile(options.config, "utf8")));
  const base = dirname(options.config);
  const surfaceRules = options.only ? raw.surfaceRules.filter((rule) => rule.id === options.only) : raw.surfaceRules;
  if (options.only && surfaceRules.length === 0) throw new Error(`no surface rule matches --only ${options.only}`);
  const config = { ...raw, surfaceRules, partialSurfaceSelection: options.only !== null };
  const configuredReportPath = configPath(base, raw.report, "report");
  const reportExtension = extname(configuredReportPath);
  const reportStem = basename(configuredReportPath, reportExtension);
  const safeSurfaceId = options.only?.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const reportPath = options.report ?? (safeSurfaceId
    ? join(dirname(configuredReportPath), `${reportStem}.${safeSurfaceId}.partial${reportExtension || ".json"}`)
    : configuredReportPath);
  const archiveDirectory = process.env.WPKIT_ARCHIVE_DIR
    ? resolve(process.env.WPKIT_ARCHIVE_DIR)
    : configPath(base, raw.archiveDirectory, "archiveDirectory");
  const inventoryPath = process.env.WPKIT_INVENTORY
    ? resolve(process.env.WPKIT_INVENTORY)
    : process.env.WPKIT_ARCHIVE_DIR
      ? resolve(archiveDirectory, "inventory.json")
      : configPath(base, raw.inventory, "inventory");
  const report = await collectArchiveBuiltAudit({
    repository: configPath(base, raw.repository ?? ".", "repository"),
    archiveDirectory,
    outDirectory: resolve(process.env.WPKIT_OUT_DIR ?? configPath(base, raw.outDirectory, "outDirectory")),
    artifactPath: resolve(process.env.WPKIT_BUILD_ARTIFACT ?? configPath(base, raw.artifact, "artifact")),
    inventoryPath,
    routeLedgerPath: configPath(base, raw.routeLedger, "routeLedger"),
    mediaMapPath: raw.mediaMap ? resolve(process.env.WPKIT_MEDIA_MAP ?? configPath(base, raw.mediaMap, "mediaMap")) : null,
    mediaManifestPath: raw.mediaManifest ? configPath(base, raw.mediaManifest, "mediaManifest") : null,
    decisionsPath: configPath(base, raw.decisions, "decisions"),
    config,
  });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ result: report.result, summary: report.summary, coverage: report.coverage, selection: report.selection, report: reportPath, binding: report.binding }));
  if (report.result !== "PASS") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 2;
});
