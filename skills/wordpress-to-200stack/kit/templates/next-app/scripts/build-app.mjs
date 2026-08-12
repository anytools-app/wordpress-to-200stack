import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { createBuildArtifact } from "./lib/build-artifact.mjs";

const project = resolve(import.meta.dirname, "..");
const nextBin = join(project, "node_modules", "next", "dist", "bin", "next");
const memoryLimitMb = Number(process.env.BUILD_MEMORY_LIMIT_MB) || 0;

// build単位の鮮度を保証する。client.ts の revalidate:false は同一build内だけ凍結する。
rmSync(join(project, ".next", "cache", "fetch-cache"), { recursive: true, force: true });

const args = ["build"];
const env = { ...process.env };
if (memoryLimitMb > 0) {
  const heapCapMb = Math.min(2048, Math.max(768, Math.floor(memoryLimitMb * 0.55)));
  if (!(env.NODE_OPTIONS ?? "").includes("--max-old-space-size")) {
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --max-old-space-size=${heapCapMb}`.trim();
  }
  args.push("--webpack");
  console.log(
    `build-app: BUILD_MEMORY_LIMIT_MB=${memoryLimitMb}, webpack, heap上限=${heapCapMb}MB`,
  );
}

const result = spawnSync(process.execPath, [nextBin, ...args], {
  cwd: project,
  stdio: "inherit",
  env,
});
if (result.status !== 0) process.exit(result.status ?? 1);

const artifactPath = resolve(
  process.env.WPKIT_BUILD_ARTIFACT ?? join(project, "_scratch", "build-artifact.json"),
);
const artifact = await createBuildArtifact({
  outDirectory: resolve(process.env.WPKIT_OUT_DIR ?? join(project, "out")),
  repository: project,
  artifactPath,
});
console.log(`build-app: artifact ${artifact.buildHash} (${artifact.fileCount} files, ${artifact.bytes} bytes)`);
