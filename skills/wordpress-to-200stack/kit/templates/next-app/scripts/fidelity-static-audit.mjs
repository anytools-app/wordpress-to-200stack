/* Legacy command alias. Historical flags/config fail with an explicit migration path. */
import { readFileSync } from "node:fs";

const migrationTarget = "npm run verify:archive-built -- --config <path> [--only <surface-id>] [--report <path>]";
const historicalFlags = new Set(["--archive-dir", "--out-dir", "--media-map", "--scorecard", "--evidence"]);
const legacyConfigFields = new Set(["allowMissingPaths", "redirects", "textReplacements", "intentional", "builtOnlyPaths"]);
const arguments_ = process.argv.slice(2);
const historical = arguments_.find((argument) => historicalFlags.has(argument.split("=", 1)[0]));

function configArgument(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--config") return argv[index + 1] ?? null;
    if (argv[index].startsWith("--config=")) return argv[index].slice("--config=".length) || null;
  }
  return null;
}

function legacyConfigReason(path) {
  if (!path) return null;
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // File and JSON failures belong to the current collector's existing error path.
    return null;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const fields = Object.keys(config).filter((field) => legacyConfigFields.has(field)).sort();
  if (fields.length) return `legacy fields: ${fields.join(", ")}`;
  if (Object.hasOwn(config, "schemaVersion") && config.schemaVersion !== 1) return "schemaVersion must be 1";
  return null;
}

const configPath = configArgument(arguments_);
const configReason = historical ? null : legacyConfigReason(configPath);
if (historical) {
  console.error(`fidelity-static-audit.mjs historical flag ${historical} is no longer supported. Migrate to: ${migrationTarget}`);
  process.exitCode = 2;
} else if (configReason) {
  console.error(`fidelity-static-audit.mjs legacy config schema ${configPath} (${configReason}) is no longer supported. Migrate to: ${migrationTarget}`);
  process.exitCode = 2;
} else {
  await import("./archive-built-audit.mjs");
}
