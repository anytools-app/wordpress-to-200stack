import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { createBuildArtifact } from "./lib/build-artifact.mjs";

const project = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const astroBin = resolve(dirname(require.resolve("astro/package.json")), require("astro/package.json").bin.astro);
const result = spawnSync(process.execPath, [astroBin, "build"], { cwd: project, env: process.env, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
const artifact = await createBuildArtifact({ outDirectory: resolve(project, "out"), repository: project, artifactPath: resolve(project, "_scratch/build-artifact.json") });
console.log(`build-app: artifact ${artifact.buildHash} (${artifact.fileCount} files)`);
