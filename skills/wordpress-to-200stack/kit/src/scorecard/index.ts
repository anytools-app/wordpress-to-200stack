import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export type ScorecardAssert = { path: string; equals: string | number | boolean | null };
type ArtifactBinding = { buildHash: string; fileCount: number; bytes: number; source: SourceRevision };
export type SourceRevision = { commit: string | null; dirty: boolean | null; worktreeHash?: string };
type GateBase = { id: string; label: string; required?: boolean; bindArtifact?: boolean };
export type CommandGate = GateBase & {
  kind: "command";
  run: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  assert?: ScorecardAssert[];
};
export type FileGate = GateBase & {
  kind: "file";
  file?: string;
  assert?: ScorecardAssert[];
  allowMissingUrls?: string[];
  check?: "fidelity-approvals" | "live-review";
  approvals?: string;
  surfaces?: string;
};
export type AttestationGate = GateBase & { kind: "attestation"; file: string; key: string };
export type Gate = CommandGate | FileGate | AttestationGate;
export type ScorecardConfig = { site: string; outDir: string; artifact?: string; gates: Gate[] };
export type GateStatus = "PASS" | "FAIL" | "ATTESTED" | "NOT_RUN";
export type GateResult = {
  id: string;
  kind: Gate["kind"];
  label: string;
  required: boolean;
  status: GateStatus;
  reason?: string;
  detail?: Record<string, unknown>;
};
export type ScorecardReport = {
  generatedAt: string;
  configPath: string;
  buildHash: string | null;
  buildArtifact?: ArtifactBinding | null;
  overall: "PASS" | "FAIL";
  gates: GateResult[];
};
export type ExecImplementation = (file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
export type RunScorecardOptions = { configPath: string; outDir?: string; execImpl?: ExecImplementation };
export type RunScorecardResult = ScorecardReport & { reportDir: string; markdown: string };
export type InitScorecardOptions = { siteDir: string; configPath?: string; force?: boolean };
export type InitScorecardResult = { configPath: string; config: ScorecardConfig; warnings: string[] };

const defaultExec: ExecImplementation = (file, args, options) => new Promise((resolveExec, rejectExec) => {
  execFile(file, args, { cwd: options.cwd, env: options.env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (!error) { resolveExec({ stdout, stderr, exitCode: 0 }); return; }
    const code = (error as NodeJS.ErrnoException & { code?: string | number }).code;
    if (typeof code === "number") { resolveExec({ stdout, stderr, exitCode: code }); return; }
    rejectExec(error);
  });
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function pathFrom(base: string, value: string): string { return resolve(base, value); }
function displayPath(value: string): string { return value.split(sep).join("/"); }
function pathValue(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (part === "length" && (Array.isArray(current) || typeof current === "string")) return current.length;
    const record = asRecord(current);
    return record?.[part];
  }, value);
}
function parseStdoutJson(stdout: string): unknown | undefined {
  try { return JSON.parse(stdout); } catch { /* Fall back to the final JSON-looking line. */ }
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line && /^[{[]/.test(line)) {
      try { return JSON.parse(line); } catch { return undefined; }
    }
  }
  return undefined;
}
function assertions(value: unknown, checks: ScorecardAssert[]): { passed: boolean; results: Array<{ path: string; expected: ScorecardAssert["equals"]; actual: unknown; passed: boolean }> } {
  const results = checks.map((check) => {
    const actual = pathValue(value, check.path);
    return { path: check.path, expected: check.equals, actual, passed: actual === check.equals };
  });
  return { passed: results.every((result) => result.passed), results };
}
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")) as unknown; }
function issueReason(parts: string[]): string { return parts.filter(Boolean).join("; "); }

function invalidConfig(message: string): never { throw new Error(`scorecard.config.json が不正です: ${message}`); }
function readConfig(value: unknown): ScorecardConfig {
  const record = asRecord(value);
  if (!record || !nonEmpty(record.site) || !nonEmpty(record.outDir) || !Array.isArray(record.gates)) invalidConfig("site, outDir, gates が必要です");
  const ids = new Set<string>();
  const gates = record.gates.map((raw, index): Gate => {
    const gate = asRecord(raw);
    if (!gate || !nonEmpty(gate.id) || !nonEmpty(gate.label) || !["command", "file", "attestation"].includes(String(gate.kind))) invalidConfig(`gates[${index}] の共通項目`);
    if (ids.has(gate.id)) invalidConfig(`gate id が重複しています: ${gate.id}`);
    ids.add(gate.id);
    if (gate.required !== undefined && typeof gate.required !== "boolean") invalidConfig(`gates[${index}].required`);
    if (gate.bindArtifact !== undefined && typeof gate.bindArtifact !== "boolean") invalidConfig(`gates[${index}].bindArtifact`);
    const required = gate.required as boolean | undefined;
    const bindArtifact = gate.bindArtifact as boolean | undefined;
    const assert = gate.assert === undefined ? undefined : parseAssertions(gate.assert, index);
    if (gate.kind === "command") {
      if (!Array.isArray(gate.run) || gate.run.length === 0 || !gate.run.every(nonEmpty)) invalidConfig(`gates[${index}].run`);
      const env = gate.env === undefined ? undefined : parseEnv(gate.env, index);
      if (gate.cwd !== undefined && gate.cwd !== null && !nonEmpty(gate.cwd)) invalidConfig(`gates[${index}].cwd`);
      return { id: gate.id, label: gate.label, kind: "command", required, bindArtifact, run: gate.run, cwd: gate.cwd as string | null | undefined, env, assert };
    }
    if (gate.kind === "attestation") {
      if (!nonEmpty(gate.file) || !nonEmpty(gate.key)) invalidConfig(`gates[${index}] の file/key`);
      return { id: gate.id, label: gate.label, kind: "attestation", required, bindArtifact, file: gate.file, key: gate.key };
    }
    if (gate.check !== undefined && gate.check !== "fidelity-approvals" && gate.check !== "live-review") invalidConfig(`gates[${index}].check`);
    if (gate.check === "fidelity-approvals") {
      if (!nonEmpty(gate.approvals) || !nonEmpty(gate.surfaces)) invalidConfig(`gates[${index}] の approvals/surfaces`);
    } else if (!nonEmpty(gate.file)) invalidConfig(`gates[${index}].file`);
    if (gate.allowMissingUrls !== undefined && (!Array.isArray(gate.allowMissingUrls) || !gate.allowMissingUrls.every(nonEmpty))) invalidConfig(`gates[${index}].allowMissingUrls`);
    return { id: gate.id, label: gate.label, kind: "file", required, bindArtifact, file: gate.file as string | undefined, check: gate.check as FileGate["check"], approvals: gate.approvals as string | undefined, surfaces: gate.surfaces as string | undefined, assert, allowMissingUrls: gate.allowMissingUrls as string[] | undefined };
  });
  if (record.artifact !== undefined && !nonEmpty(record.artifact)) invalidConfig("artifact");
  return { site: record.site, outDir: record.outDir, artifact: record.artifact as string | undefined, gates };
}
function parseAssertions(value: unknown, index: number): ScorecardAssert[] {
  if (!Array.isArray(value)) invalidConfig(`gates[${index}].assert`);
  return value.map((raw, assertionIndex) => {
    const item = asRecord(raw);
    if (!item || !nonEmpty(item.path) || !("equals" in item) || !["string", "number", "boolean"].includes(typeof item.equals) && item.equals !== null) invalidConfig(`gates[${index}].assert[${assertionIndex}]`);
    return { path: item.path, equals: item.equals as ScorecardAssert["equals"] };
  });
}
function parseEnv(value: unknown, index: number): Record<string, string> {
  const record = asRecord(value);
  if (!record || Object.values(record).some((entry) => typeof entry !== "string")) invalidConfig(`gates[${index}].env`);
  return record as Record<string, string>;
}

export async function inspectBuildOutput(outDir: string): Promise<{ hash: string; fileCount: number; bytes: number } | null> {
  if (!await exists(outDir)) return null;
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) output.push(fullPath);
      else throw new Error(`unsupported filesystem entry in build output: ${displayPath(fullPath)}`);
    }
  }
  await visit(outDir);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const path of output.sort((left, right) => displayPath(relative(outDir, left)).localeCompare(displayPath(relative(outDir, right))))) {
    const relativePath = displayPath(relative(outDir, path));
    const contents = await readFile(path);
    bytes += contents.byteLength;
    const fileHash = createHash("sha256").update(contents).digest("hex");
    hash.update(relativePath).update("\0").update(fileHash);
  }
  return { hash: hash.digest("hex"), fileCount: output.length, bytes };
}

export async function hashBuildOutput(outDir: string): Promise<string | null> {
  return (await inspectBuildOutput(outDir))?.hash ?? null;
}

function artifactBinding(value: unknown): ArtifactBinding | undefined {
  const record = asRecord(value);
  if (
    !record ||
    !/^[a-f\d]{64}$/i.test(String(record.buildHash ?? "")) ||
    !Number.isInteger(record.fileCount) ||
    (record.fileCount as number) <= 0 ||
    !Number.isInteger(record.bytes) ||
    (record.bytes as number) <= 0 ||
    !isValidSourceRevision(record.source)
  ) return undefined;
  return { buildHash: record.buildHash as string, fileCount: record.fileCount as number, bytes: record.bytes as number, source: record.source };
}

function evidenceBinding(value: unknown): ArtifactBinding | undefined {
  const record = asRecord(value);
  return artifactBinding(record?.binding) ?? artifactBinding(asRecord(record?.provenance)?.artifact) ?? artifactBinding(record?.recorded) ?? artifactBinding(record);
}

function sameBinding(left: ArtifactBinding | undefined, right: ArtifactBinding | undefined): boolean {
  if (!left || !right || left.buildHash !== right.buildHash || left.fileCount !== right.fileCount || left.bytes !== right.bytes) return false;
  return sourceRevisionMatches(left.source, right.source);
}

export function inspectSourceRevision(cwd: string): SourceRevision {
  try {
    const textOptions = { cwd, encoding: "utf8" as const, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 };
    const binaryOptions = { cwd, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 };
    const scopePrefix = execFileSync("git", ["rev-parse", "--show-prefix"], textOptions).trim();
    const scopedFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."], binaryOptions).toString("utf8").split("\0").filter(Boolean);
    if (scopedFiles.length === 0) throw new Error("repository scope has no tracked source files");
    const diff = execFileSync("git", ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--", "."], binaryOptions);
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", "."], binaryOptions)
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();
    const worktree = createHash("sha256").update("scope:").update(scopePrefix).update("\0").update(diff);
    for (const path of untracked) {
      worktree.update(path).update("\0").update(createHash("sha256").update(readFileSync(resolve(cwd, path))).digest("hex"));
    }
    return {
      commit: execFileSync("git", ["rev-parse", "HEAD"], textOptions).trim(),
      dirty: diff.byteLength > 0 || untracked.length > 0,
      worktreeHash: worktree.digest("hex"),
    };
  } catch { return { commit: null, dirty: null }; }
}

export function sourceRevisionMatches(recorded: unknown, current: unknown): boolean {
  const left = asRecord(recorded); const right = asRecord(current);
  if (!isValidSourceRevision(left) || !isValidSourceRevision(right)) return false;
  return left.commit === right.commit && left.dirty === right.dirty && left.worktreeHash === right.worktreeHash;
}

export function isValidSourceRevision(value: unknown): value is SourceRevision & { commit: string; dirty: boolean; worktreeHash: string } {
  const record = asRecord(value);
  return Boolean(
    record &&
    /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(String(record.commit ?? "")) &&
    typeof record.dirty === "boolean" &&
    /^[a-f\d]{64}$/i.test(String(record.worktreeHash ?? "")) &&
    !("error" in record),
  );
}

async function verifyArtifactFile(artifactPath: string, outDir: string, repository: string): Promise<{ binding?: ArtifactBinding; reason?: string }> {
  if (!await exists(artifactPath)) return { reason: `build artifact がありません: ${displayPath(artifactPath)}` };
  try {
    const artifact = asRecord(await readJson(artifactPath));
    const binding = artifact?.schemaVersion === 1 ? artifactBinding(artifact) : undefined;
    if (!binding) return { reason: `build artifact が不正です: ${displayPath(artifactPath)}` };
    const current = await inspectBuildOutput(outDir);
    if (!current) return { binding, reason: `ビルド出力がありません: ${displayPath(outDir)}` };
    if (current.fileCount === 0 || current.bytes === 0) return { binding, reason: `ビルド出力が空です: ${displayPath(outDir)}` };
    if (binding.buildHash !== current.hash || binding.fileCount !== current.fileCount || binding.bytes !== current.bytes) {
      return { binding, reason: "build artifact が現在のビルド出力と一致しません" };
    }
    const currentSource = inspectSourceRevision(repository);
    if (!sourceRevisionMatches(binding.source, currentSource)) return { binding, reason: "build artifact の source revision が現在のソースと一致しません" };
    return { binding };
  } catch (error) {
    return { reason: `build artifact を読めません: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function failGate(result: GateResult, reason: string): GateResult {
  return { ...result, status: "FAIL", reason: issueReason([result.reason ?? "", reason]) };
}

async function commandResult(gate: CommandGate, siteDir: string, execImpl: ExecImplementation): Promise<GateResult> {
  const required = gate.required !== false;
  const cwd = gate.cwd === undefined || gate.cwd === null ? siteDir : resolve(siteDir, gate.cwd);
  try {
    const [file, ...args] = gate.run;
    if (!file) throw new Error("run が空です");
    const result = await execImpl(file, args, { cwd, env: { ...process.env, ...gate.env } });
    const parsed = parseStdoutJson(result.stdout);
    const checks = gate.assert ?? [];
    const assertionResult = checks.length === 0 ? undefined : parsed === undefined ? undefined : assertions(parsed, checks);
    const reasons: string[] = [];
    if (result.exitCode !== 0) reasons.push(`exit code ${result.exitCode}`);
    if (checks.length > 0 && parsed === undefined) reasons.push("assert に必要な stdout JSON を取得できません");
    if (assertionResult && !assertionResult.passed) reasons.push(`assert 不成立: ${assertionResult.results.filter((item) => !item.passed).map((item) => `${item.path}=${JSON.stringify(item.actual)} (期待 ${JSON.stringify(item.expected)})`).join(", ")}`);
    return { id: gate.id, kind: gate.kind, label: gate.label, required, status: reasons.length ? "FAIL" : "PASS", reason: reasons.length ? issueReason(reasons) : undefined, detail: { cwd, exitCode: result.exitCode, ...(parsed === undefined ? {} : { stdoutJson: parsed }), ...(result.stderr ? { stderr: result.stderr } : {}), ...(checks.length ? { assertions: assertionResult?.results ?? [] } : {}) } };
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "ENOENT" || /ENOENT/.test(message)) return { id: gate.id, kind: gate.kind, label: gate.label, required, status: "NOT_RUN", reason: `コマンドを起動できません: ${message}`, detail: { cwd, code: "ENOENT" } };
    throw error;
  }
}

async function genericFileResult(gate: FileGate, configDir: string): Promise<GateResult> {
  const required = gate.required !== false;
  const file = pathFrom(configDir, gate.file!);
  if (!await exists(file)) return { id: gate.id, kind: gate.kind, label: gate.label, required, status: "NOT_RUN", reason: `結果ファイルがありません: ${displayPath(file)}`, detail: { file } };
  try {
    const value = await readJson(file);
    const check = assertions(value, gate.assert ?? []);
    const missing = asRecord(value)?.missing;
    const allowMissingUrls = gate.allowMissingUrls ?? [];
    const unexpectedMissing = Array.isArray(missing) ? missing.filter((entry) => {
      const url = asRecord(entry)?.url;
      return typeof url !== "string" || !allowMissingUrls.includes(url);
    }) : gate.allowMissingUrls !== undefined ? ["missing 配列がありません"] : [];
    const reasons: string[] = [];
    if (!check.passed) reasons.push(`assert 不成立: ${check.results.filter((item) => !item.passed).map((item) => `${item.path}=${JSON.stringify(item.actual)} (期待 ${JSON.stringify(item.expected)})`).join(", ")}`);
    if (unexpectedMissing.length) reasons.push(`許可されていない missing: ${unexpectedMissing.map((entry) => typeof entry === "string" ? entry : String(asRecord(entry)?.url ?? "不明")).join(", ")}`);
    return { id: gate.id, kind: gate.kind, label: gate.label, required, status: reasons.length ? "FAIL" : "PASS", reason: reasons.length ? issueReason(reasons) : undefined, detail: { file, evidenceJson: value, assertions: check.results, unexpectedMissingUrls: unexpectedMissing.map((entry) => typeof entry === "string" ? entry : asRecord(entry)?.url) } };
  } catch (error: unknown) {
    return { id: gate.id, kind: gate.kind, label: gate.label, required, status: "FAIL", reason: `結果ファイルを読めません: ${error instanceof Error ? error.message : String(error)}`, detail: { file } };
  }
}

async function fidelityResult(gate: FileGate, configDir: string, buildArtifact?: ArtifactBinding): Promise<GateResult> {
  const required = gate.required !== false;
  const approvalsFile = pathFrom(configDir, gate.approvals!);
  const surfacesFile = pathFrom(configDir, gate.surfaces!);
  if (!await exists(approvalsFile) || !await exists(surfacesFile)) return { id: gate.id, kind: gate.kind, label: gate.label, required, status: "NOT_RUN", reason: `必要な台帳または surface summary がありません: ${!await exists(approvalsFile) ? displayPath(approvalsFile) : displayPath(surfacesFile)}`, detail: { approvalsFile, surfacesFile } };
  try {
    const approvalRecords = asRecord(await readJson(approvalsFile))?.approvals;
    const surfaceRecords = asRecord(await readJson(surfacesFile))?.surfaces;
    if (!Array.isArray(approvalRecords) || !Array.isArray(surfaceRecords)) throw new Error("approvals または surfaces 配列がありません");
    const validApprovals = approvalRecords.filter((record) => {
      const item = asRecord(record);
      return nonEmpty(item?.surface) && nonEmpty(item?.date) && nonEmpty(item?.by);
    });
    const approved = new Set(validApprovals.map((record) => asRecord(record)!.surface as string));
    const missing = surfaceRecords.map((record) => asRecord(record)?.surface).filter(nonEmpty).filter((surface) => !approved.has(surface));
    const malformed = surfaceRecords.some((record) => !nonEmpty(asRecord(record)?.surface));
    const bindingFailures: string[] = [];
    if (gate.bindArtifact) {
      if (!buildArtifact) bindingFailures.push("scorecard の build artifact binding がありません");
      for (const record of validApprovals) {
        const item = asRecord(record)!;
        const measurements = asRecord(item.measurements);
        if (!measurements || !nonEmpty(measurements.source)) {
          bindingFailures.push(`${String(item.surface)}: measurements.source がありません`);
          continue;
        }
        const source = pathFrom(configDir, measurements.source);
        if (!await exists(source)) {
          bindingFailures.push(`${String(item.surface)}: measurement source がありません: ${displayPath(source)}`);
          continue;
        }
        try {
          const sourceValue = await readJson(source);
          const sourceRecord = asRecord(sourceValue);
          if (sourceRecord && "selection" in sourceRecord) {
            if (asRecord(sourceRecord.selection)?.mode !== "full") {
              bindingFailures.push(`${String(item.surface)}: partial archive report は公開判定の measurement source に使えません`);
              continue;
            }
            if (sourceRecord.result !== "PASS" || asRecord(sourceRecord.summary)?.unresolved !== 0) {
              bindingFailures.push(`${String(item.surface)}: full archive report がPASSまたは未裁定0ではありません`);
              continue;
            }
          }
          const sourceBinding = evidenceBinding(sourceValue);
          if (!sameBinding(sourceBinding, buildArtifact)) bindingFailures.push(`${String(item.surface)}: measurement source の build binding が一致しません`);
        } catch (error) {
          bindingFailures.push(`${String(item.surface)}: measurement source を読めません: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const reasons = [
      malformed ? "surfaces に surface がない項目があります" : "",
      missing.length ? `未承認 surface: ${missing.join(", ")}` : "",
      ...bindingFailures,
    ].filter(Boolean);
    return { id: gate.id, kind: gate.kind, label: gate.label, required, status: reasons.length ? "FAIL" : "PASS", reason: reasons.length ? issueReason(reasons) : undefined, detail: { approvalsFile, surfacesFile, missingSurfaces: missing, bindingFailures } };
  } catch (error: unknown) {
    return { id: gate.id, kind: gate.kind, label: gate.label, required, status: "FAIL", reason: `fidelity 台帳を読めません: ${error instanceof Error ? error.message : String(error)}`, detail: { approvalsFile, surfacesFile } };
  }
}

async function liveReviewResult(gate: FileGate, configDir: string, buildHash: string | null, buildArtifact?: ArtifactBinding): Promise<GateResult> {
  const required = gate.required !== false;
  const file = pathFrom(configDir, gate.file!);
  if (!await exists(file)) return { id: gate.id, kind: gate.kind, label: gate.label, required, status: "NOT_RUN", reason: `実機レビュー台帳がありません: ${displayPath(file)}`, detail: { file } };
  try {
    const value = asRecord(await readJson(file));
    const scenarios = value?.scenarios;
    const findings = value?.findings;
    const reasons: string[] = [];
    if (!nonEmpty(value?.date)) reasons.push("date がありません");
    if (!nonEmpty(value?.reviewer)) reasons.push("reviewer がありません");
    if (!Array.isArray(scenarios) || scenarios.length === 0) reasons.push("scenarios がありません");
    else if (scenarios.some((scenario) => asRecord(scenario)?.result !== "ok")) reasons.push("ok でない scenario があります");
    if (!Array.isArray(findings)) reasons.push(findings === undefined ? "findings がありません" : "findings が配列ではありません");
    else if (findings.some((finding) => asRecord(finding)?.resolved !== true)) reasons.push("未解消 finding があります");
    const reviewBinding = evidenceBinding(value);
    const reviewBuild = nonEmpty(value?.build) ? value.build : reviewBinding?.buildHash;
    const buildMatches = reviewBuild === undefined || buildHash === null ? null : reviewBuild === buildHash;
    if (gate.bindArtifact && (!buildArtifact || !sameBinding(reviewBinding, buildArtifact))) reasons.push("レビュー対象の full build artifact binding が scorecard artifact と一致しません");
    return { id: gate.id, kind: gate.kind, label: gate.label, required, status: reasons.length ? "FAIL" : "PASS", reason: reasons.length ? issueReason(reasons) : undefined, detail: { file, date: value?.date, reviewer: value?.reviewer, scenarios, findings, reviewBuild, reviewBinding, currentBuild: buildHash, buildMatches } };
  } catch (error: unknown) {
    return { id: gate.id, kind: gate.kind, label: gate.label, required, status: "FAIL", reason: `実機レビュー台帳を読めません: ${error instanceof Error ? error.message : String(error)}`, detail: { file } };
  }
}

async function fileResult(gate: FileGate, configDir: string, buildHash: string | null, buildArtifact?: ArtifactBinding): Promise<GateResult> {
  if (gate.check === "fidelity-approvals") return fidelityResult(gate, configDir, buildArtifact);
  if (gate.check === "live-review") return liveReviewResult(gate, configDir, buildHash, buildArtifact);
  return genericFileResult(gate, configDir);
}

async function attestationResult(gate: AttestationGate, configDir: string, buildArtifact?: ArtifactBinding): Promise<GateResult> {
  const required = gate.required !== false;
  const file = pathFrom(configDir, gate.file);
  if (!await exists(file)) return { id: gate.id, kind: gate.kind, label: gate.label, required, status: "NOT_RUN", reason: `attestation 台帳がありません: ${displayPath(file)}`, detail: { file, key: gate.key } };
  try {
    const value = asRecord(await readJson(file));
    const record = asRecord(value?.[gate.key]);
    if (!record) return { id: gate.id, kind: gate.kind, label: gate.label, required, status: "NOT_RUN", reason: `attestation がありません: ${gate.key}`, detail: { file, key: gate.key } };
    if (!nonEmpty(record.date) || !nonEmpty(record.by)) return { id: gate.id, kind: gate.kind, label: gate.label, required, status: "FAIL", reason: "attestation の date または by がありません", detail: { file, key: gate.key, record } };
    const recordBinding = evidenceBinding(record);
    if (gate.bindArtifact && (!buildArtifact || !sameBinding(recordBinding, buildArtifact))) {
      return { id: gate.id, kind: gate.kind, label: gate.label, required, status: "FAIL", reason: "attestation の full build artifact binding が scorecard artifact と一致しません", detail: { file, key: gate.key, recordBinding } };
    }
    return { id: gate.id, kind: gate.kind, label: gate.label, required, status: "ATTESTED", detail: { file, key: gate.key, date: record.date, by: record.by, values: record.values, note: record.note, recordBinding } };
  } catch (error: unknown) {
    return { id: gate.id, kind: gate.kind, label: gate.label, required, status: "FAIL", reason: `attestation 台帳を読めません: ${error instanceof Error ? error.message : String(error)}`, detail: { file, key: gate.key } };
  }
}

function markdownEscape(value: string): string { return value.replaceAll("|", "\\|").replaceAll("\n", "<br>"); }
function markdownDetail(gate: GateResult): string {
  const detail = gate.detail ?? {};
  const values = detail.values;
  const parts: string[] = [];
  if (gate.status === "ATTESTED") parts.push(`記録日: ${String(detail.date ?? "")}`);
  if (values !== undefined) parts.push(`values: \`${markdownEscape(JSON.stringify(values))}\``);
  if (gate.reason) parts.push(gate.reason);
  if (gate.kind === "file" && detail.buildMatches === false) parts.push(`警告: レビュー対象ビルドが現行と不一致 (review: ${String(detail.reviewBuild)}, current: ${String(detail.currentBuild)})`);
  if (gate.kind === "file" && detail.buildMatches === true) parts.push("レビュー対象ビルドは現行と一致");
  if (gate.kind === "command" && typeof detail.exitCode === "number") parts.push(`exit code: ${detail.exitCode}`);
  return markdownEscape(parts.join("; ") || "-");
}
export function renderScorecardMarkdown(report: ScorecardReport): string {
  const build = report.buildHash ? report.buildHash.slice(0, 12) : "ビルド出力なし";
  const rows = report.gates.map((gate) => `| ${markdownEscape(gate.label)}${gate.required ? "" : " (任意)"} | ${gate.status === "ATTESTED" ? `ATTESTED (${String(gate.detail?.date ?? "")})` : gate.status} | ${markdownDetail(gate)} |`);
  return ["# wpkit scorecard", "", `- 生成日時: ${report.generatedAt}`, `- ビルド出力ハッシュ: ${build}`, "", "| ゲート | 判定 | 主要数値・理由 |", "| --- | --- | --- |", ...rows, "", `## 総合判定: ${report.overall}`, ""].join("\n");
}

export async function runScorecard(options: RunScorecardOptions): Promise<RunScorecardResult> {
  const configPath = resolve(options.configPath);
  const configDir = dirname(configPath);
  const config = readConfig(await readJson(configPath));
  const siteDir = pathFrom(configDir, config.site);
  const outputDirectory = pathFrom(siteDir, config.outDir);
  const artifactPath = config.artifact ? pathFrom(siteDir, config.artifact) : undefined;
  let frozenArtifact: ArtifactBinding | undefined;
  let artifactInitializationReason: string | undefined;
  const hasRequiredCommandBuild = config.gates.some((gate) => gate.id === "build" && gate.kind === "command" && gate.required !== false);
  if (artifactPath && !hasRequiredCommandBuild) {
    const verified = await verifyArtifactFile(artifactPath, outputDirectory, siteDir);
    frozenArtifact = verified.binding;
    artifactInitializationReason = verified.reason;
  }
  const execImpl = options.execImpl ?? defaultExec;
  const gates: GateResult[] = [];
  if (artifactInitializationReason) {
    gates.push({ id: "artifact-preflight", kind: "file", label: "build artifact preflight", required: true, status: "FAIL", reason: artifactInitializationReason });
  }
  for (const gate of config.gates) {
    let result: GateResult;
    if (artifactInitializationReason) {
      result = { id: gate.id, kind: gate.kind, label: gate.label, required: gate.required !== false, status: "FAIL", reason: artifactInitializationReason };
      gates.push(result);
      continue;
    }
    if (frozenArtifact && artifactPath) {
      const before = await verifyArtifactFile(artifactPath, outputDirectory, siteDir);
      if (before.reason || !sameBinding(before.binding, frozenArtifact)) {
        result = { id: gate.id, kind: gate.kind, label: gate.label, required: gate.required !== false, status: "FAIL", reason: before.reason ?? "gate 実行前に build artifact binding が変わりました" };
        gates.push(result);
        continue;
      }
    }
    if (gate.kind === "command") result = await commandResult(gate, siteDir, execImpl);
    else if (gate.kind === "file") result = await fileResult(gate, configDir, frozenArtifact?.buildHash ?? await hashBuildOutput(outputDirectory), frozenArtifact);
    else result = await attestationResult(gate, configDir, frozenArtifact);

    if (artifactPath && gate.id === "build" && result.status === "PASS") {
      const created = await verifyArtifactFile(artifactPath, outputDirectory, siteDir);
      if (!created.binding || created.reason) result = failGate(result, created.reason ?? "build artifact binding を確立できません");
      else frozenArtifact = created.binding;
    }
    if (gate.bindArtifact) {
      if (!frozenArtifact) result = failGate(result, "scorecard の build artifact binding がありません");
      else if (gate.kind === "command") {
        const binding = evidenceBinding(result.detail?.stdoutJson);
        if (!sameBinding(binding, frozenArtifact)) result = failGate(result, "command evidence の build artifact binding が一致しません");
      } else if (gate.kind === "file" && !gate.check) {
        const binding = evidenceBinding(result.detail?.evidenceJson);
        if (!sameBinding(binding, frozenArtifact)) result = failGate(result, "file evidence の build artifact binding が一致しません");
      }
    }
    if (frozenArtifact && artifactPath) {
      const after = await verifyArtifactFile(artifactPath, outputDirectory, siteDir);
      if (after.reason || !sameBinding(after.binding, frozenArtifact)) result = failGate(result, after.reason ?? "gate 実行後に build artifact binding が変わりました");
    }
    gates.push(result);
  }
  const overall = gates.every((gate) => !gate.required || gate.status === "PASS" || gate.status === "ATTESTED") ? "PASS" : "FAIL";
  const buildHash = frozenArtifact?.buildHash ?? await hashBuildOutput(outputDirectory);
  const report: ScorecardReport = { generatedAt: new Date().toISOString(), configPath, buildHash, ...(config.artifact ? { buildArtifact: frozenArtifact ?? null } : {}), overall, gates };
  const reportDir = options.outDir ? resolve(options.outDir) : resolve(configDir, "_scratch/scorecard");
  const markdown = renderScorecardMarkdown(report);
  await mkdir(reportDir, { recursive: true });
  await Promise.all([writeFile(join(reportDir, "scorecard.json"), `${JSON.stringify(report, null, 2)}\n`), writeFile(join(reportDir, "scorecard.md"), markdown)]);
  return { ...report, reportDir, markdown };
}

export function defaultScorecardConfig(site: string): ScorecardConfig {
  return {
    site,
    outDir: "out",
    artifact: "_scratch/build-artifact.json",
    gates: [
      { id: "typecheck", kind: "command", label: "型チェック", run: ["npm", "run", "typecheck"] },
      { id: "lint", kind: "command", label: "lint", run: ["npm", "run", "lint"] },
      { id: "build", kind: "command", label: "build", run: ["npm", "run", "build"] },
      { id: "artifact-binding", kind: "command", label: "build artifact", run: ["npm", "run", "artifact:verify"], bindArtifact: true, assert: [{ path: "result", equals: "PASS" }] },
      { id: "archive-built", kind: "command", label: "archive-built 忠実性", run: ["npm", "run", "verify:archive-built"], bindArtifact: true, assert: [{ path: "result", equals: "PASS" }, { path: "summary.unresolved", equals: 0 }] },
      { id: "form-parity", kind: "command", label: "フォーム一致 (T6)", run: ["node", "scripts/verify-t6.mjs"], assert: [{ path: "matches", equals: true }] },
      { id: "routes", kind: "command", label: "ルート・301", run: ["node", "scripts/verify-routes.mjs"], assert: [{ path: "unreachable.length", equals: 0 }, { path: "duplicateOutputPaths.length", equals: 0 }, { path: "canonicalCollisions.length", equals: 0 }, { path: "non301Rules.length", equals: 0 }] },
      { id: "seo", kind: "command", label: "SEO", run: ["node", "scripts/verify-seo.mjs"] },
      { id: "stylesheets", kind: "command", label: "stylesheet 構成", run: ["node", "scripts/verify-stylesheets.mjs"] },
      { id: "webvitals-preload", kind: "command", label: "Web Vitals preload", run: ["node", "scripts/verify-webvitals-preload.mjs"], assert: [{ path: "failures.length", equals: 0 }] },
      { id: "verify-content", kind: "file", label: "新旧照合 (wpkit verify)", file: "_scratch/verify/verify-report.json", assert: [{ path: "metaMismatches.length", equals: 0 }], allowMissingUrls: [] },
      { id: "fidelity-approvals", kind: "file", label: "fidelity 承認網羅", check: "fidelity-approvals", bindArtifact: true, approvals: "docs/fidelity-approvals.json", surfaces: "_scratch/fidelity/surfaces-summary.json" },
      { id: "live-review", kind: "file", label: "実機レビュー", check: "live-review", bindArtifact: true, file: "docs/live-review.json" },
      { id: "a11y", kind: "attestation", label: "アクセシビリティ (axe 手動計測)", bindArtifact: true, file: "docs/quality-attestations.json", key: "a11y" },
      { id: "lighthouse", kind: "attestation", label: "Lighthouse (手動計測)", bindArtifact: true, file: "docs/quality-attestations.json", key: "lighthouse" },
    ],
  };
}

export async function initScorecardConfig(options: InitScorecardOptions): Promise<InitScorecardResult> {
  const siteDir = resolve(options.siteDir);
  const configPath = resolve(options.configPath ?? join(dirname(siteDir), "scorecard.config.json"));
  if (await exists(configPath) && !options.force) throw new Error(`config は既に存在します (--force で上書き): ${configPath}`);
  const configDir = dirname(configPath);
  const site = displayPath(relative(configDir, siteDir) || ".");
  const config = defaultScorecardConfig(site);
  const warnings: string[] = [];
  let scripts: Record<string, unknown> = {};
  try { scripts = asRecord(asRecord(await readJson(join(siteDir, "package.json")))?.scripts) ?? {}; } catch { warnings.push(`package.json がありません: ${displayPath(join(siteDir, "package.json"))}`); }
  for (const name of ["typecheck", "lint", "build", "artifact:verify", "verify:archive-built"]) if (typeof scripts[name] !== "string") warnings.push(`package.json に ${name} script がありません`);
  for (const script of ["build-artifact.mjs", "archive-built-audit.mjs", "verify-t6.mjs", "verify-routes.mjs", "verify-seo.mjs", "verify-stylesheets.mjs", "verify-webvitals-preload.mjs"]) if (!await exists(join(siteDir, "scripts", script))) warnings.push(`scripts/${script} がありません`);
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { configPath, config, warnings };
}
