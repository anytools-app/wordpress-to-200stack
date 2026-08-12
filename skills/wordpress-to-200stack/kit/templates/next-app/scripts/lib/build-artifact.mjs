import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

function displayPath(value) {
  return value.split(sep).join("/");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function filesUnder(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await filesUnder(path, files);
    else if (entry.isFile()) files.push(path);
    else throw new Error(`unsupported filesystem entry in build output: ${displayPath(path)}`);
  }
  return files;
}

/** Hashes both relative paths and file bytes, so renames invalidate the artifact. */
export async function hashTree(directory) {
  const root = resolve(directory);
  if (!(await exists(root))) return null;
  const files = await filesUnder(root);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const path of files.sort((left, right) =>
    displayPath(relative(root, left)).localeCompare(displayPath(relative(root, right))),
  )) {
    const contents = await readFile(path);
    const pathFromRoot = displayPath(relative(root, path));
    bytes += contents.byteLength;
    hash
      .update(pathFromRoot)
      .update("\0")
      .update(createHash("sha256").update(contents).digest("hex"));
  }
  return { algorithm: "sha256", hash: hash.digest("hex"), fileCount: files.length, bytes };
}

export async function hashFile(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export function sourceRevision(repository) {
  try {
    const textOptions = { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 };
    const binaryOptions = { cwd: repository, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 };
    const commit = execFileSync("git", ["rev-parse", "HEAD"], textOptions).trim();
    const scopePrefix = execFileSync("git", ["rev-parse", "--show-prefix"], textOptions).trim();
    const scopedFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."], binaryOptions)
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    if (scopedFiles.length === 0) throw new Error("repository scope has no tracked source files");
    const diff = execFileSync("git", ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--", "."], binaryOptions);
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", "."], binaryOptions)
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();
    const worktree = createHash("sha256").update("scope:").update(scopePrefix).update("\0").update(diff);
    for (const path of untracked) {
      worktree
        .update(path)
        .update("\0")
        .update(createHash("sha256").update(readFileSync(resolve(repository, path))).digest("hex"));
    }
    return { commit, dirty: diff.byteLength > 0 || untracked.length > 0, worktreeHash: worktree.digest("hex") };
  } catch (error) {
    return {
      commit: null,
      dirty: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function isValidSourceRevision(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value.commit ?? "") &&
    typeof value.dirty === "boolean" &&
    /^[a-f\d]{64}$/i.test(value.worktreeHash ?? "") &&
    !("error" in value),
  );
}

export function sameSourceRevision(recorded, current) {
  if (!isValidSourceRevision(recorded) || !isValidSourceRevision(current)) return false;
  if (recorded.commit !== current.commit || recorded.dirty !== current.dirty) return false;
  return recorded.worktreeHash === current.worktreeHash;
}

export function isValidArtifactBinding(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    /^[a-f\d]{64}$/i.test(value.buildHash ?? "") &&
    Number.isInteger(value.fileCount) &&
    value.fileCount > 0 &&
    Number.isInteger(value.bytes) &&
    value.bytes > 0 &&
    isValidSourceRevision(value.source),
  );
}

export function isValidBuildArtifact(value) {
  return Boolean(value?.schemaVersion === 1 && isValidArtifactBinding(value));
}

export function artifactBinding(artifact) {
  if (!isValidArtifactBinding(artifact)) return null;
  return {
    buildHash: artifact.buildHash ?? null,
    fileCount: artifact.fileCount ?? null,
    bytes: artifact.bytes ?? null,
    source: artifact.source ?? null,
  };
}

export async function createBuildArtifact({
  outDirectory,
  repository,
  artifactPath,
  generatedAt = new Date().toISOString(),
}) {
  const output = await hashTree(outDirectory);
  if (!output) throw new Error(`build output is missing: ${outDirectory}`);
  if (output.fileCount === 0 || output.bytes === 0) throw new Error(`build output is empty: ${outDirectory}`);
  const source = sourceRevision(repository);
  if (!isValidSourceRevision(source)) {
    throw new Error(`source revision is unavailable: ${source?.error ?? "invalid git revision"}`);
  }
  const artifact = {
    schemaVersion: 1,
    generatedAt,
    buildHash: output.hash,
    fileCount: output.fileCount,
    bytes: output.bytes,
    source,
  };
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

export async function readBuildArtifact(artifactPath) {
  const value = JSON.parse(await readFile(artifactPath, "utf8"));
  if (
    !isValidBuildArtifact(value)
  ) {
    throw new Error(`build artifact is invalid: ${artifactPath}`);
  }
  return value;
}

export async function verifyBuildArtifact({ outDirectory, artifactPath, repository, verifySource = false }) {
  const current = await hashTree(outDirectory);
  if (!current) {
    return { matches: false, current: null, recorded: null, reason: "build output is missing" };
  }
  if (current.fileCount === 0 || current.bytes === 0) {
    return { matches: false, current, recorded: null, reason: "build output is empty" };
  }
  let recorded;
  try {
    recorded = await readBuildArtifact(artifactPath);
  } catch (error) {
    return {
      matches: false,
      current,
      recorded: null,
      reason: `cannot read build artifact: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const outputMatches =
    recorded.buildHash === current.hash &&
    recorded.fileCount === current.fileCount &&
    recorded.bytes === current.bytes;
  const currentSource = repository ? sourceRevision(repository) : null;
  const sourceMatches =
    !verifySource ||
    sameSourceRevision(recorded.source, currentSource);
  const matches = outputMatches && sourceMatches;
  return {
    matches,
    current,
    currentSource,
    recorded,
    reason: matches
      ? undefined
      : !outputMatches
        ? "build artifact does not match the current output"
        : "build artifact source revision does not match the current source",
  };
}

export function sameArtifactBinding(left, right) {
  const leftBinding = artifactBinding(left);
  const rightBinding = artifactBinding(right);
  return Boolean(leftBinding && rightBinding && JSON.stringify(leftBinding) === JSON.stringify(rightBinding));
}
