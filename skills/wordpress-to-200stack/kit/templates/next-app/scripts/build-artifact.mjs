import { resolve } from "node:path";

import { createBuildArtifact, verifyBuildArtifact } from "./lib/build-artifact.mjs";

const project = resolve(import.meta.dirname, "..");

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: node scripts/build-artifact.mjs <create|verify> [--out-dir out] [--artifact _scratch/build-artifact.json]");
  process.exit(2);
}

function parseArgs(argv) {
  const action = argv.shift() ?? usage("create or verify is required");
  if (!["create", "verify"].includes(action)) usage(`Unknown action: ${action}`);
  const options = {
    action,
    outDirectory: resolve(process.env.WPKIT_OUT_DIR ?? resolve(project, "out")),
    artifactPath: resolve(process.env.WPKIT_BUILD_ARTIFACT ?? resolve(project, "_scratch", "build-artifact.json")),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--out-dir") options.outDirectory = resolve(argv[++index] ?? usage("--out-dir requires a path"));
    else if (flag === "--artifact") options.artifactPath = resolve(argv[++index] ?? usage("--artifact requires a path"));
    else usage(`Unknown option: ${flag}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.action === "create") {
  const artifact = await createBuildArtifact({
    outDirectory: options.outDirectory,
    repository: project,
    artifactPath: options.artifactPath,
  });
  console.log(JSON.stringify({ result: "PASS", artifact }));
} else {
  const result = await verifyBuildArtifact({
    outDirectory: options.outDirectory,
    repository: project,
    artifactPath: options.artifactPath,
    verifySource: true,
  });
  console.log(JSON.stringify({ result: result.matches ? "PASS" : "FAIL", binding: result.recorded, ...result }));
  if (!result.matches) process.exitCode = 1;
}
