import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { hashBuildOutput, inspectBuildOutput, inspectSourceRevision, isValidSourceRevision, sourceRevisionMatches } from "../scorecard/index.js";

export const GATE_IDS = ["archive", "analyze", "mapping", "scf-fields", "parse", "media", "schema-import", "implement", "fidelity", "theme-crosscheck", "verify", "publish"] as const;
export type GateId = typeof GATE_IDS[number];
export type GateKind = "machine" | "approval";
export type StoredStatus = "pending" | "done" | "approved";
export type GateRecord = { status: StoredStatus; at: string; by?: string; note?: string; evidence?: string; forced?: Array<{ command: string; at: string }> } & Record<string, unknown>;
export type MigrationState = { version: 1; gates: Record<string, GateRecord>; updatedAt: string } & Record<string, unknown>;
export type EffectiveStatus = "pending" | "done" | "approved" | "n/a";
export type StatusGate = {
  id: GateId;
  index: number;
  number: string;
  kind: GateKind;
  status: EffectiveStatus;
  evidence?: string;
  record?: GateRecord;
  warnings: string[];
  stale: boolean;
  metrics?: { errors?: number; warnings?: number; overall?: string; buildHash?: string; artifactMatches?: boolean };
  command: string;
};
export type StatusResult = { root: string; state: MigrationState; gates: StatusGate[]; warnings: string[]; next?: { gate: GateId; command: string; kind: GateKind } };
export type EnforceCommand = "media-upload" | "import" | "verify" | "scorecard";
export type EnforceResult = { allowed: boolean; stateExists: boolean; missing: GateId[]; commands: string[] };

type GateDefinition = { id: GateId; number: string; kind: GateKind; evidence?: string; command: string };
const definitions: GateDefinition[] = [
  { id: "archive", number: "0", kind: "machine", evidence: "_scratch/archive/inventory.json", command: "wpkit archive <https://origin> -o _scratch/archive" },
  { id: "analyze", number: "1", kind: "machine", evidence: "_scratch/analysis/census.json", command: "wpkit analyze <export.xml> -o _scratch/analysis" },
  { id: "mapping", number: "2", kind: "approval", command: "wpkit status approve mapping --by <名前>" },
  { id: "scf-fields", number: "2.5", kind: "machine", evidence: "_scratch/analysis/scf-definitions.json", command: "wpkit analyze <export.xml> -o _scratch/analysis" },
  { id: "parse", number: "3", kind: "machine", evidence: "_scratch/ir/validation-report.json", command: "wpkit parse --config mapping.config.ts -o _scratch/ir" },
  { id: "media", number: "4", kind: "approval", evidence: "site/src/data/media-manifest.json", command: "wpkit status approve media --by <名前>" },
  { id: "schema-import", number: "5", kind: "approval", evidence: "_scratch/microcms-schema", command: "wpkit status approve schema-import --by <名前>" },
  { id: "implement", number: "6", kind: "machine", evidence: "site/out", command: "npm run build --prefix site" },
  { id: "fidelity", number: "6.5", kind: "approval", evidence: "docs/fidelity-approvals.json", command: "wpkit status approve fidelity --by <名前>" },
  { id: "theme-crosscheck", number: "6.6", kind: "approval", command: "wpkit status approve theme-crosscheck --by <名前>" },
  { id: "verify", number: "7", kind: "machine", evidence: "_scratch/scorecard/scorecard.json", command: "wpkit scorecard --config scorecard.config.json" },
  { id: "publish", number: "8", kind: "approval", command: "wpkit status approve publish --by <名前>" },
];
const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
const prerequisites: Record<EnforceCommand, GateId[]> = {
  "media-upload": ["parse"], import: ["parse", "media"], verify: ["schema-import"], scorecard: ["schema-import"],
};

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function toPath(value: string): string { return value.split(sep).join("/"); }
function now(): string { return new Date().toISOString(); }
function stateFile(root: string): string { return join(root, "migration-state.json"); }
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
async function mtime(path: string): Promise<Date | undefined> { try { return (await stat(path)).mtime; } catch { return undefined; } }

function readStateValue(value: unknown): MigrationState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.gates) || typeof value.updatedAt !== "string") throw new Error("migration-state.json が不正です");
  const gates: Record<string, GateRecord> = {};
  for (const [id, raw] of Object.entries(value.gates)) {
    if (!isRecord(raw) || !["pending", "done", "approved"].includes(String(raw.status)) || typeof raw.at !== "string") throw new Error(`migration-state.json の gates.${id} が不正です`);
    gates[id] = raw as GateRecord;
  }
  return { ...value, version: 1, gates, updatedAt: value.updatedAt } as MigrationState;
}

async function findMigrationState(cwd: string): Promise<{ root: string; state: MigrationState } | undefined> {
  let root = resolve(cwd);
  while (true) {
    const path = stateFile(root);
    if (await exists(path)) return { root, state: readStateValue(JSON.parse(await readFile(path, "utf8")) as unknown) };
    // A worktree uses a .git file; a normal checkout uses a directory. Check this
    // directory only after its ledger, so a repository-root ledger remains visible.
    if (await exists(join(root, ".git"))) return undefined;
    const parent = dirname(root);
    if (parent === root) return undefined;
    root = parent;
  }
}

export async function loadMigrationState(cwd = process.cwd()): Promise<MigrationState | undefined> {
  return (await findMigrationState(cwd))?.state;
}
export async function saveMigrationState(cwd: string, state: MigrationState): Promise<void> {
  const root = resolve(cwd); await mkdir(root, { recursive: true });
  await writeFile(stateFile(root), `${JSON.stringify(state, null, 2)}\n`);
}

async function scorecardOutput(root: string): Promise<{ siteDir: string; outDir: string; artifactPath: string; artifactConfigured: boolean; configPresent: boolean }> {
  const configPath = join(root, "scorecard.config.json");
  if (!await exists(configPath)) {
    const siteDir = join(root, "site");
    return { siteDir, outDir: join(siteDir, "out"), artifactPath: join(siteDir, "_scratch", "build-artifact.json"), artifactConfigured: false, configPresent: false };
  }
  const value = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  if (!isRecord(value) || typeof value.site !== "string" || typeof value.outDir !== "string") throw new Error("scorecard.config.json が不正です: site, outDir が必要です");
  const siteDir = resolve(root, value.site);
  return { siteDir, outDir: resolve(siteDir, value.outDir), artifactPath: resolve(siteDir, typeof value.artifact === "string" ? value.artifact : "_scratch/build-artifact.json"), artifactConfigured: typeof value.artifact === "string", configPresent: true };
}

function sourceMatchesCurrent(artifact: Record<string, unknown>, siteDir: string): boolean {
  return isValidSourceRevision(artifact.source) && sourceRevisionMatches(artifact.source, inspectSourceRevision(siteDir));
}

function sourceBindingsMatch(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftSource = isRecord(left.source) ? left.source : undefined;
  const rightSource = isRecord(right.source) ? right.source : undefined;
  if (!isValidSourceRevision(leftSource) || !isValidSourceRevision(rightSource)) return false;
  return sourceRevisionMatches(leftSource, rightSource);
}
function validArtifact(value: unknown): value is Record<string, unknown> {
  const artifact = isRecord(value) ? value : undefined;
  return Boolean(
    artifact?.schemaVersion === 1 &&
    /^[a-f\d]{64}$/i.test(String(artifact.buildHash ?? "")) &&
    Number.isInteger(artifact.fileCount) &&
    (artifact.fileCount as number) > 0 &&
    Number.isInteger(artifact.bytes) &&
    (artifact.bytes as number) > 0 &&
    isValidSourceRevision(artifact.source),
  );
}
async function defaultEvidence(root: string, definition: GateDefinition): Promise<string | undefined> {
  if (definition.id !== "implement") return definition.evidence;
  const output = await scorecardOutput(root);
  return toPath(relative(root, output.outDir));
}
function recordEvidence(record: GateRecord | undefined, fallback: string | undefined): string | undefined {
  return typeof record?.evidence === "string" ? record.evidence : fallback;
}
async function machineEvidence(root: string, id: GateId, evidence: string | undefined): Promise<{ done: boolean; evidenceExists: boolean; evidenceMtime?: Date; metrics?: StatusGate["metrics"] }> {
  if (!evidence) return { done: false, evidenceExists: false };
  const path = resolve(root, evidence); const evidenceMtime = await mtime(path);
  if (!evidenceMtime) return { done: false, evidenceExists: false };
  if (id === "implement") {
    const output = await scorecardOutput(root);
    if (!output.artifactConfigured) {
      const current = await inspectBuildOutput(output.outDir);
      return { done: true, evidenceExists: true, evidenceMtime, metrics: { buildHash: current?.hash } };
    }
    try {
      const [artifactValue, current] = await Promise.all([
        readFile(output.artifactPath, "utf8").then((source) => JSON.parse(source) as unknown),
        inspectBuildOutput(output.outDir),
      ]);
      const artifact = validArtifact(artifactValue) ? artifactValue : undefined;
      const artifactMatches = Boolean(current && current.fileCount > 0 && current.bytes > 0 && artifact && artifact.buildHash === current.hash && artifact.fileCount === current.fileCount && artifact.bytes === current.bytes && sourceMatchesCurrent(artifact, output.siteDir));
      return { done: artifactMatches, evidenceExists: true, evidenceMtime, metrics: { buildHash: current?.hash, artifactMatches } };
    } catch {
      return { done: false, evidenceExists: true, evidenceMtime, metrics: { artifactMatches: false } };
    }
  }
  if (id === "parse") {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      const record = isRecord(value) ? value : {};
      const errors = Array.isArray(record.errors) ? record.errors.length : undefined;
      const warnings = Array.isArray(record.warnings) ? record.warnings.length : undefined;
      return { done: errors === 0, evidenceExists: true, evidenceMtime, metrics: { errors, warnings } };
    } catch { return { done: false, evidenceExists: true, evidenceMtime }; }
  }
  if (id === "verify") {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      const overall = isRecord(value) && typeof value.overall === "string" ? value.overall : undefined;
      const output = await scorecardOutput(root);
      const current = await inspectBuildOutput(output.outDir);
      const reportArtifact = isRecord(value) && isRecord(value.buildArtifact) ? value.buildArtifact : undefined;
      let recordedArtifact: Record<string, unknown> | undefined;
      try {
        const candidate = JSON.parse(await readFile(output.artifactPath, "utf8")) as unknown;
        recordedArtifact = validArtifact(candidate) ? candidate : undefined;
      } catch { /* Missing artifact is a stale prerequisite, not a parse crash. */ }
      const artifactMatches = output.artifactConfigured
        ? Boolean(
          current &&
          current.fileCount > 0 &&
          current.bytes > 0 &&
          reportArtifact &&
          validArtifact({ schemaVersion: 1, ...reportArtifact }) &&
          recordedArtifact &&
          reportArtifact.buildHash === current.hash &&
          reportArtifact.fileCount === current.fileCount &&
          reportArtifact.bytes === current.bytes &&
          recordedArtifact.buildHash === current.hash &&
          recordedArtifact.fileCount === current.fileCount &&
          recordedArtifact.bytes === current.bytes &&
          sourceBindingsMatch(reportArtifact, recordedArtifact) &&
          sourceMatchesCurrent(recordedArtifact, output.siteDir)
        )
        : Boolean(current && isRecord(value) && value.buildHash === current.hash);
      return { done: overall === "PASS" && artifactMatches, evidenceExists: true, evidenceMtime, metrics: { overall, buildHash: current?.hash, artifactMatches } };
    } catch { return { done: false, evidenceExists: true, evidenceMtime }; }
  }
  return { done: true, evidenceExists: true, evidenceMtime };
}

function staleAfter(record: GateRecord | undefined, evidenceMtime: Date | undefined): boolean {
  if (!record || !evidenceMtime) return false;
  const recorded = new Date(record.at).getTime();
  return Number.isFinite(recorded) && evidenceMtime.getTime() > recorded;
}

export async function getStatus(options: { cwd?: string } = {}): Promise<StatusResult | undefined> {
  const found = await findMigrationState(options.cwd ?? process.cwd());
  if (!found) return undefined;
  const { root, state } = found;
  const gates: StatusGate[] = [];
  for (const [index, definition] of definitions.entries()) {
    const record = state.gates[definition.id]; const fallbackEvidence = await defaultEvidence(root, definition);
    const evidence = recordEvidence(record, fallbackEvidence); const warnings: string[] = [];
    let status: EffectiveStatus = "pending"; let stale = false; let metrics: StatusGate["metrics"];
    if (definition.kind === "machine") {
      // analyze always writes scf-definitions.json, including an empty definition list.
      const result = await machineEvidence(root, definition.id, evidence);
      status = result.done ? "done" : "pending"; metrics = result.metrics;
      if ((definition.id === "implement" || definition.id === "verify") && result.evidenceExists && result.metrics?.artifactMatches === false) warnings.push(`${definition.id}: build artifact が現在の出力と一致しません`);
      if ((record?.status === "done" || record?.status === "approved") && !result.evidenceExists) warnings.push(`${definition.id}: 記録済みですが evidence がありません`);
      stale = result.done && staleAfter(record, result.evidenceMtime);
      if (stale) warnings.push(`${definition.id}: 成果物が記録より新しいため再確認してください`);
      if (definition.id === "verify" && result.done) {
        const output = await scorecardOutput(root);
        if (output.configPresent) {
          try {
            const scorecard = JSON.parse(await readFile(resolve(root, evidence!), "utf8")) as unknown;
            const recordedHash = isRecord(scorecard) && typeof scorecard.buildHash === "string" ? scorecard.buildHash : null;
            const currentHash = await hashBuildOutput(output.outDir);
            if (recordedHash !== currentHash) { stale = true; status = "pending"; warnings.push("verify: scorecard の buildHash が現在のビルド出力と一致しません"); }
          } catch { /* evidence result already determines completion */ }
        }
      }
    } else {
      status = record?.status === "approved" ? "approved" : "pending";
      if (status === "approved" && evidence && !await exists(resolve(root, evidence))) warnings.push(`${definition.id}: 承認済みですが evidence がありません`);
      const evidenceMtime = evidence ? await mtime(resolve(root, evidence)) : undefined;
      stale = status === "approved" && staleAfter(record, evidenceMtime);
      if (stale) { status = "pending"; warnings.push(`${definition.id}: 成果物が記録より新しいため再確認してください`); }
    }
    gates.push({ id: definition.id, index, number: definition.number, kind: definition.kind, status, evidence, record, warnings, stale, metrics, command: definition.command });
  }
  const nextGate = gates.find((gate) => !["done", "approved", "n/a"].includes(gate.status));
  return { root, state, gates, warnings: gates.flatMap((gate) => gate.warnings), ...(nextGate ? { next: { gate: nextGate.id, command: nextGate.command, kind: nextGate.kind } } : {}) };
}

export async function initStatus(options: { cwd?: string; force?: boolean } = {}): Promise<{ path: string; prefilled: GateId[] }> {
  const root = resolve(options.cwd ?? process.cwd()); const path = stateFile(root);
  if (await exists(path) && !options.force) throw new Error(`migration-state.json は既に存在します (--force で上書き): ${path}`);
  const created = now(); const gates: Record<string, GateRecord> = {}; const prefilled: GateId[] = [];
  for (const definition of definitions) {
    const evidence = await defaultEvidence(root, definition);
    if (definition.kind === "approval") { gates[definition.id] = { status: "pending", at: created }; continue; }
    const result = await machineEvidence(root, definition.id, evidence);
    if (result.done && result.evidenceMtime) {
      gates[definition.id] = { status: "done", at: result.evidenceMtime.toISOString(), note: "init により既存成果物から推定", ...(evidence ? { evidence } : {}) };
      prefilled.push(definition.id);
    } else gates[definition.id] = { status: "pending", at: created, ...(evidence ? { evidence } : {}) };
  }
  await saveMigrationState(root, { version: 1, gates, updatedAt: created });
  return { path, prefilled };
}

export async function approveStatusGate(options: { gate: string; by: string; note?: string; cwd?: string }): Promise<{ gate: GateId; warnings: string[]; state: MigrationState }> {
  const definition = definitionById.get(options.gate as GateId);
  if (!definition || definition.kind !== "approval") throw new Error(`承認可能な gate は ${definitions.filter((entry) => entry.kind === "approval").map((entry) => entry.id).join(", ")} です`);
  const found = await findMigrationState(options.cwd ?? process.cwd());
  if (!found) throw new Error("migration-state.json がありません。wpkit status init で作成してください");
  const { root, state } = found;
  const before = await getStatus({ cwd: root }); if (!before) throw new Error("migration-state.json がありません。wpkit status init で作成してください");
  const warnings: string[] = [];
  const gate = before.gates.find((entry) => entry.id === definition.id)!;
  if (gate.evidence && !await exists(resolve(root, gate.evidence))) warnings.push(`${definition.id}: evidence がありません: ${gate.evidence}`);
  for (const prior of before.gates.slice(0, gate.index)) if (!(["done", "approved", "n/a"] as string[]).includes(prior.status)) warnings.push(`${definition.id}: 前工程 ${prior.id} が未通過です`);
  const previous = state.gates[definition.id] ?? { status: "pending", at: now() };
  const at = now(); state.gates[definition.id] = { ...previous, status: "approved", at, by: options.by, ...(options.note === undefined ? {} : { note: options.note }) };
  state.updatedAt = at; await saveMigrationState(root, state);
  return { gate: definition.id, warnings, state };
}

export async function enforceGate(command: EnforceCommand, options: { cwd?: string; force?: boolean } = {}): Promise<EnforceResult> {
  const status = await getStatus({ cwd: options.cwd ?? process.cwd() });
  if (!status) return { allowed: true, stateExists: false, missing: [], commands: [] };
  const missing = prerequisites[command].filter((id) => !["done", "approved", "n/a"].includes(status.gates.find((gate) => gate.id === id)?.status ?? "pending"));
  const commands = missing.map((id) => definitionById.get(id)!.command);
  if (missing.length === 0) return { allowed: true, stateExists: true, missing, commands };
  if (!options.force) return { allowed: false, stateExists: true, missing, commands };
  const at = now();
  for (const id of missing) {
    const prior = status.state.gates[id] ?? { status: "pending" as const, at };
    const forced = Array.isArray(prior.forced) ? prior.forced : [];
    status.state.gates[id] = { ...prior, forced: [...forced, { command, at }] };
  }
  status.state.updatedAt = at; await saveMigrationState(status.root, status.state);
  return { allowed: true, stateExists: true, missing, commands };
}

export function renderStatus(status: StatusResult): string {
  const lines = ["# wpkit status", "", "| # | gate | 状態 | 記録 | 主要数値 |", "| --- | --- | --- | --- | --- |"];
  for (const gate of status.gates) {
    const record = gate.record; const recordText = record ? `${record.at}${record.by ? ` / ${record.by}` : ""}` : "—";
    const metric = gate.id === "parse" ? `errors: ${gate.metrics?.errors ?? "—"}, warnings: ${gate.metrics?.warnings ?? "—"}` : gate.id === "verify" ? `overall: ${gate.metrics?.overall ?? "—"}` : "—";
    lines.push(`| ${gate.number} | ${gate.id} | ${gate.status}${gate.stale ? " (stale)" : ""} | ${recordText} | ${metric} |`);
  }
  if (status.warnings.length) lines.push("", "## 警告", "", ...status.warnings.map((warning) => `- ${warning}`));
  lines.push("", "## 次の工程", "", status.next ? `${status.next.gate}: \`${status.next.command}\`` : "すべての工程が通過しています。");
  return `${lines.join("\n")}\n`;
}
