import { mkdtemp, mkdir, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { approveStatusGate, enforceGate, getStatus, initStatus, loadMigrationState, saveMigrationState, type MigrationState } from "../src/status/index.js";

const temporary: string[] = [];
async function tempDir(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "wpkit-status-")); temporary.push(path); return path; }
async function json(path: string, value: unknown): Promise<void> { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
async function fixture(root: string): Promise<void> {
  await json(join(root, "_scratch/archive/inventory.json"), {});
  await json(join(root, "_scratch/analysis/census.json"), {});
  await json(join(root, "_scratch/analysis/scf-definitions.json"), []);
  await json(join(root, "_scratch/ir/validation-report.json"), { errors: [], warnings: [{ code: "example" }] });
}
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("wpkit status", () => {
  it("prefills completed machine gates and leaves approvals pending", async () => {
    const root = await tempDir(); await fixture(root);
    const result = await initStatus({ cwd: root }); const state = await loadMigrationState(root);
    expect(result.prefilled).toEqual(expect.arrayContaining(["archive", "analyze", "scf-fields", "parse"]));
    expect(state?.gates.parse).toMatchObject({ status: "done", evidence: "_scratch/ir/validation-report.json", note: "init により既存成果物から推定" });
    expect(state?.gates.mapping?.status).toBe("pending"); expect(state?.gates.media?.status).toBe("pending");
  });

  it("derives machine status from evidence, including parse errors and scorecard failures", async () => {
    const root = await tempDir(); await fixture(root); await json(join(root, "_scratch/scorecard/scorecard.json"), { overall: "FAIL" });
    await initStatus({ cwd: root }); let status = await getStatus({ cwd: root });
    expect(status?.gates.find((gate) => gate.id === "parse")?.status).toBe("done");
    expect(status?.gates.find((gate) => gate.id === "verify")?.status).toBe("pending");
    await json(join(root, "_scratch/ir/validation-report.json"), { errors: [{ code: "broken" }], warnings: [] });
    status = await getStatus({ cwd: root }); expect(status?.gates.find((gate) => gate.id === "parse")?.status).toBe("pending");
  });

  it("warns for missing recorded evidence and stale evidence", async () => {
    const root = await tempDir(); await fixture(root); await initStatus({ cwd: root });
    await unlink(join(root, "_scratch/archive/inventory.json"));
    let status = await getStatus({ cwd: root }); const archive = status?.gates.find((gate) => gate.id === "archive");
    expect(archive?.status).toBe("pending"); expect(archive?.warnings.join(" ")).toContain("evidence がありません");
    await json(join(root, "_scratch/archive/inventory.json"), {});
    const state = await loadMigrationState(root) as MigrationState;
    state.gates.archive!.at = "2000-01-01T00:00:00.000Z"; await saveMigrationState(root, state);
    await utimes(join(root, "_scratch/archive/inventory.json"), new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
    status = await getStatus({ cwd: root }); expect(status?.gates.find((gate) => gate.id === "archive")?.stale).toBe(true);
  });

  it("records approvals, rejects non-approval gates, and warns when flow order is skipped", async () => {
    const root = await tempDir(); await initStatus({ cwd: root });
    const result = await approveStatusGate({ cwd: root, gate: "media", by: "reviewer", note: "missing checked" });
    expect(result.warnings.join(" ")).toContain("前工程"); expect(result.state.gates.media).toMatchObject({ status: "approved", by: "reviewer", note: "missing checked" });
    await expect(approveStatusGate({ cwd: root, gate: "parse", by: "reviewer" })).rejects.toThrow("承認可能な gate");
    await expect(approveStatusGate({ cwd: root, gate: "unknown", by: "reviewer" })).rejects.toThrow("承認可能な gate");
  });

  it("enforces prerequisites only when a ledger exists and records force bypasses", async () => {
    const root = await tempDir();
    expect(await enforceGate("media-upload", { cwd: root })).toMatchObject({ allowed: true, stateExists: false });
    await initStatus({ cwd: root });
    expect(await enforceGate("media-upload", { cwd: root })).toMatchObject({ allowed: false, missing: ["parse"] });
    expect(await enforceGate("import", { cwd: root })).toMatchObject({ allowed: false, missing: ["parse", "media"] });
    expect(await enforceGate("media-upload", { cwd: root, force: true })).toMatchObject({ allowed: true, missing: ["parse"] });
    expect((await loadMigrationState(root))?.gates.parse?.forced).toHaveLength(1);
  });

  it("finds a parent ledger from wp-static-kit and writes force records to that root", async () => {
    const root = await tempDir(); const kit = join(root, "wp-static-kit"); await mkdir(kit);
    await initStatus({ cwd: root });
    const status = await getStatus({ cwd: kit });
    expect(status?.root).toBe(root);
    expect(await enforceGate("media-upload", { cwd: kit })).toMatchObject({ allowed: false, stateExists: true, missing: ["parse"] });
    expect(await enforceGate("media-upload", { cwd: kit, force: true })).toMatchObject({ allowed: true, stateExists: true });
    const value = JSON.parse(await readFile(join(root, "migration-state.json"), "utf8")) as { gates: { parse: { forced?: Array<{ command: string }> } } };
    expect(value.gates.parse.forced).toEqual([expect.objectContaining({ command: "media-upload" })]);
  });

  it("does not search above a .git boundary", async () => {
    const parent = await tempDir(); const root = join(parent, "repository"); const nested = join(root, "nested");
    await mkdir(join(root, ".git"), { recursive: true }); await mkdir(nested, { recursive: true });
    await initStatus({ cwd: parent });
    expect(await getStatus({ cwd: nested })).toBeUndefined();
    expect(await enforceGate("media-upload", { cwd: nested })).toMatchObject({ allowed: true, stateExists: false });
  });

  it("preserves unknown top-level and gate record keys across a write", async () => {
    const root = await tempDir(); await initStatus({ cwd: root });
    const state = await loadMigrationState(root) as MigrationState;
    Object.assign(state, { futureTopLevel: { retained: true } }); Object.assign(state.gates.mapping!, { futureGateKey: "retained" });
    await saveMigrationState(root, state); await approveStatusGate({ cwd: root, gate: "mapping", by: "reviewer" });
    const value = JSON.parse(await readFile(join(root, "migration-state.json"), "utf8")) as { futureTopLevel?: { retained?: boolean }; gates: { mapping: { futureGateKey?: string } } };
    expect(value.futureTopLevel?.retained).toBe(true); expect(value.gates.mapping.futureGateKey).toBe("retained");
  });

  it("derives the first incomplete fixed-order gate as next", async () => {
    const root = await tempDir(); await fixture(root); await initStatus({ cwd: root });
    let status = await getStatus({ cwd: root });
    expect(status?.gates.map((gate) => gate.number)).toEqual(["0", "1", "2", "2.5", "3", "4", "5", "6", "6.5", "6.6", "7", "8"]);
    expect(status?.next).toMatchObject({ gate: "mapping" });
    await approveStatusGate({ cwd: root, gate: "mapping", by: "reviewer" });
    status = await getStatus({ cwd: root }); expect(status?.next).toMatchObject({ gate: "media" });
  });
});
