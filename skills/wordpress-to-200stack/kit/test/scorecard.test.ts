import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultScorecardConfig, hashBuildOutput, initScorecardConfig, inspectBuildOutput, inspectSourceRevision, runScorecard, type ExecImplementation, type ScorecardConfig } from "../src/scorecard/index.js";

const temporary: string[] = [];
async function tempDir(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "wpkit-scorecard-")); temporary.push(path); return path; }
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function makeProject(): Promise<{ root: string; site: string; config: string }> {
  const root = await tempDir(); const site = join(root, "project"); const config = join(root, "scorecard.config.json");
  await mkdir(site, { recursive: true });
  return { root, site, config };
}
async function initGitSite(site: string): Promise<void> {
  execFileSync("git", ["init", "--quiet"], { cwd: site });
  await writeFile(join(site, ".gitignore"), "out/\n_scratch/\n");
  await writeFile(join(site, "source.txt"), "fixture");
  execFileSync("git", ["add", ".gitignore", "source.txt"], { cwd: site });
  execFileSync("git", ["-c", "user.name=wpkit-test", "-c", "user.email=wpkit@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: site });
}
async function writeConfig(path: string, config: ScorecardConfig): Promise<void> { await writeFile(path, JSON.stringify(config)); }
const exec = (result: { stdout?: string; stderr?: string; exitCode?: number } = {}): ExecImplementation => async () => ({ stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode ?? 0 });

describe("wpkit scorecard", () => {
  it("resolves config paths relative to the config and runs commands in site", async () => {
    const { site, config } = await makeProject();
    await mkdir(join(site, "out")); await writeFile(join(site, "out", "index.html"), "same");
    await writeConfig(config, { site: "project", outDir: "out", gates: [{ id: "command", kind: "command", label: "command", run: ["node", "check.mjs"], assert: [{ path: "ok", equals: true }] }] });
    let received: { cwd: string; env: NodeJS.ProcessEnv } | undefined;
    const result = await runScorecard({ configPath: config, execImpl: async (_file, _args, options) => { received = options; return { stdout: '{"ok":true}', stderr: "", exitCode: 0 }; } });
    expect(received?.cwd).toBe(site);
    expect(result.buildHash).not.toBeNull();
    expect(result.gates[0]?.status).toBe("PASS");
  });

  it("adjudicates command exit codes, assertions, permissive stdout parsing, and ENOENT", async () => {
    const { config } = await makeProject();
    await writeConfig(config, { site: "project", outDir: "out", gates: [
      { id: "pass", kind: "command", label: "pass", run: ["node", "a"], assert: [{ path: "length", equals: 1 }] },
      { id: "exit", kind: "command", label: "exit", run: ["node", "b"] },
      { id: "assert", kind: "command", label: "assert", run: ["node", "c"], assert: [{ path: "ok", equals: true }] },
      { id: "plain", kind: "command", label: "plain", run: ["node", "d"] },
      { id: "not-run", kind: "command", label: "not run", run: ["node", "e"] },
    ] });
    let call = 0;
    const result = await runScorecard({ configPath: config, execImpl: async () => {
      call += 1;
      if (call === 1) return { stdout: "note\n[\"x\"]", stderr: "", exitCode: 0 };
      if (call === 2) return { stdout: "{}", stderr: "", exitCode: 2 };
      if (call === 3) return { stdout: '{"ok":false}', stderr: "", exitCode: 0 };
      if (call === 4) return { stdout: "human summary only", stderr: "", exitCode: 0 };
      const error = Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" }); throw error;
    } });
    expect(result.gates.map((gate) => gate.status)).toEqual(["PASS", "FAIL", "FAIL", "PASS", "NOT_RUN"]);
    expect(result.overall).toBe("FAIL");
  });

  it("allows only declared missing URLs in verify-content", async () => {
    const { root, config } = await makeProject();
    await mkdir(join(root, "_scratch", "verify"), { recursive: true });
    await writeConfig(config, { site: "project", outDir: "out", gates: [{ id: "content", kind: "file", label: "content", file: "_scratch/verify/verify-report.json", assert: [{ path: "metaMismatches.length", equals: 0 }], allowMissingUrls: ["https://old.test/allowed/"] }] });
    await writeFile(join(root, "_scratch", "verify", "verify-report.json"), JSON.stringify({ metaMismatches: [], missing: [{ url: "https://old.test/allowed/" }] }));
    expect((await runScorecard({ configPath: config })).gates[0]?.status).toBe("PASS");
    await writeFile(join(root, "_scratch", "verify", "verify-report.json"), JSON.stringify({ metaMismatches: [], missing: [{ url: "https://old.test/outside/" }] }));
    const result = await runScorecard({ configPath: config });
    expect(result.gates[0]?.status).toBe("FAIL");
    expect(result.gates[0]?.reason).toContain("outside");
    await writeConfig(config, { site: "project", outDir: "out", gates: [{ id: "content", kind: "file", label: "content", file: "_scratch/verify/verify-report.json", assert: [{ path: "metaMismatches.length", equals: 0 }] }] });
    const implicitDeny = await runScorecard({ configPath: config });
    expect(implicitDeny.gates[0]?.status).toBe("FAIL");
    expect(implicitDeny.gates[0]?.reason).toContain("outside");
    await writeFile(join(root, "_scratch", "verify", "verify-report.json"), JSON.stringify({ metaMismatches: [] }));
    expect((await runScorecard({ configPath: config })).gates[0]?.status).toBe("PASS");
  });

  it("checks fidelity approval coverage and reports unapproved surfaces", async () => {
    const { root, config } = await makeProject();
    await mkdir(join(root, "docs"), { recursive: true }); await mkdir(join(root, "_scratch", "fidelity"), { recursive: true });
    await writeConfig(config, { site: "project", outDir: "out", gates: [{ id: "fidelity", kind: "file", label: "fidelity", check: "fidelity-approvals", approvals: "docs/fidelity-approvals.json", surfaces: "_scratch/fidelity/surfaces-summary.json" }] });
    await writeFile(join(root, "docs", "fidelity-approvals.json"), JSON.stringify({ approvals: [{ surface: "home", date: "2026-07-28", by: "reviewer" }] }));
    await writeFile(join(root, "_scratch", "fidelity", "surfaces-summary.json"), JSON.stringify({ surfaces: [{ surface: "home" }] }));
    expect((await runScorecard({ configPath: config })).gates[0]?.status).toBe("PASS");
    await writeFile(join(root, "_scratch", "fidelity", "surfaces-summary.json"), JSON.stringify({ surfaces: [{ surface: "home" }, { surface: "detail" }] }));
    const failed = await runScorecard({ configPath: config });
    expect(failed.gates[0]?.status).toBe("FAIL"); expect(failed.gates[0]?.reason).toContain("detail");
    await rm(join(root, "_scratch", "fidelity", "surfaces-summary.json"));
    expect((await runScorecard({ configPath: config })).gates[0]?.status).toBe("NOT_RUN");
  });

  it("requires fidelity measurement sources to bind to the current build artifact in strict configs", async () => {
    const { root, site, config } = await makeProject();
    await mkdir(join(site, "out")); await writeFile(join(site, "out", "index.html"), "current");
    await initGitSite(site);
    const inspected = (await inspectBuildOutput(join(site, "out")))!;
    const binding = { buildHash: inspected.hash, fileCount: inspected.fileCount, bytes: inspected.bytes, source: inspectSourceRevision(site) };
    await mkdir(join(site, "_scratch"), { recursive: true }); await writeFile(join(site, "_scratch", "build-artifact.json"), JSON.stringify({ schemaVersion: 1, generatedAt: "2026-08-11T00:00:00.000Z", ...binding }));
    await mkdir(join(root, "docs"), { recursive: true }); await mkdir(join(root, "_scratch", "fidelity"), { recursive: true });
    await writeConfig(config, { site: "project", outDir: "out", artifact: "_scratch/build-artifact.json", gates: [{ id: "fidelity", kind: "file", label: "fidelity", check: "fidelity-approvals", bindArtifact: true, approvals: "docs/fidelity-approvals.json", surfaces: "_scratch/fidelity/surfaces-summary.json" }] });
    await writeFile(join(root, "docs", "fidelity-approvals.json"), JSON.stringify({ approvals: [{ surface: "home", date: "2026-08-11", by: "reviewer", measurements: { source: "_scratch/fidelity/home.json" } }] }));
    await writeFile(join(root, "_scratch", "fidelity", "surfaces-summary.json"), JSON.stringify({ surfaces: [{ surface: "home" }] }));
    await writeFile(join(root, "_scratch", "fidelity", "home.json"), JSON.stringify({ binding }));
    expect((await runScorecard({ configPath: config })).gates[0]?.status).toBe("PASS");
    await writeFile(join(root, "_scratch", "fidelity", "home.json"), JSON.stringify({ binding, selection: { mode: "partial", surfaceIds: ["home"] } }));
    const partial = await runScorecard({ configPath: config });
    expect(partial.gates.find((gate) => gate.id === "fidelity")?.status).toBe("FAIL");
    expect(partial.gates.find((gate) => gate.id === "fidelity")?.reason).toContain("partial archive report");
    await writeFile(join(root, "_scratch", "fidelity", "home.json"), JSON.stringify({ binding, selection: { mode: "full", surfaceIds: ["home"] }, result: "FAIL", summary: { unresolved: 1 } }));
    const unresolved = await runScorecard({ configPath: config });
    expect(unresolved.gates.find((gate) => gate.id === "fidelity")?.status).toBe("FAIL");
    expect(unresolved.gates.find((gate) => gate.id === "fidelity")?.reason).toContain("未裁定0");
    await writeFile(join(root, "_scratch", "fidelity", "home.json"), JSON.stringify({ binding, selection: { mode: "full", surfaceIds: ["home"] }, result: "PASS", summary: { unresolved: 0 } }));
    expect((await runScorecard({ configPath: config })).gates.find((gate) => gate.id === "fidelity")?.status).toBe("PASS");
    await writeFile(join(root, "_scratch", "fidelity", "home.json"), JSON.stringify({ binding: { ...binding, buildHash: "a".repeat(64) } }));
    const stale = await runScorecard({ configPath: config });
    expect(stale.gates[0]?.status).toBe("FAIL");
    expect(stale.gates[0]?.reason).toContain("build binding");
  });

  it("fails the responsible gate when out mutates after artifact binding", async () => {
    const { site, config } = await makeProject();
    await mkdir(join(site, "out")); await writeFile(join(site, "out", "index.html"), "before");
    await initGitSite(site);
    const inspected = (await inspectBuildOutput(join(site, "out")))!;
    const binding = { buildHash: inspected.hash, fileCount: inspected.fileCount, bytes: inspected.bytes, source: inspectSourceRevision(site) };
    await mkdir(join(site, "_scratch")); await writeFile(join(site, "_scratch", "build-artifact.json"), JSON.stringify({ schemaVersion: 1, generatedAt: "2026-08-11T00:00:00.000Z", ...binding }));
    await writeConfig(config, { site: "project", outDir: "out", artifact: "_scratch/build-artifact.json", gates: [{ id: "mutate", kind: "command", label: "mutate", run: ["node", "mutate"] }] });
    const result = await runScorecard({ configPath: config, execImpl: async () => {
      await writeFile(join(site, "out", "index.html"), "after");
      return { stdout: "{}", stderr: "", exitCode: 0 };
    } });
    expect(result.gates[0]?.status).toBe("FAIL");
    expect(result.gates[0]?.reason).toContain("build artifact");
    expect(result.overall).toBe("FAIL");
  });

  it("fails artifact preflight even with no configured gates and passes only a valid current artifact", async () => {
    const { site, config } = await makeProject(); const out = join(site, "out"); const artifact = join(site, "_scratch", "build-artifact.json");
    await mkdir(out); await writeFile(join(out, "index.html"), "current"); await initGitSite(site);
    const inspected = (await inspectBuildOutput(out))!;
    const binding = { buildHash: inspected.hash, fileCount: inspected.fileCount, bytes: inspected.bytes, source: inspectSourceRevision(site) };
    await mkdir(join(site, "_scratch")); await writeConfig(config, { site: "project", outDir: "out", artifact: "_scratch/build-artifact.json", gates: [] });
    await writeFile(artifact, JSON.stringify({ schemaVersion: 1, generatedAt: "2026-08-11T00:00:00.000Z", ...binding }));
    expect((await runScorecard({ configPath: config })).overall).toBe("PASS");
    await writeFile(join(out, "index.html"), "stale");
    let failed = await runScorecard({ configPath: config });
    expect(failed.overall).toBe("FAIL"); expect(failed.gates[0]).toMatchObject({ id: "artifact-preflight", required: true, status: "FAIL" });
    await writeFile(join(out, "index.html"), "current");
    await writeFile(artifact, JSON.stringify({ schemaVersion: 1, generatedAt: "2026-08-11T00:00:00.000Z", ...binding, source: {} }));
    failed = await runScorecard({ configPath: config }); expect(failed.overall).toBe("FAIL");
    await rm(artifact);
    failed = await runScorecard({ configPath: config }); expect(failed.overall).toBe("FAIL");
  });

  it("accepts artifact:verify stdout binding and rejects source changes made after a dirty build", async () => {
    const { site, config } = await makeProject();
    execFileSync("git", ["init", "--quiet"], { cwd: site });
    await writeFile(join(site, ".gitignore"), "out/\n_scratch/\n"); await writeFile(join(site, "source.txt"), "committed");
    execFileSync("git", ["add", ".gitignore", "source.txt"], { cwd: site });
    execFileSync("git", ["-c", "user.name=wpkit-test", "-c", "user.email=wpkit@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: site });
    await mkdir(join(site, "out")); await writeFile(join(site, "out", "index.html"), "built"); await writeFile(join(site, "source.txt"), "dirty-before-build");
    const inspected = (await inspectBuildOutput(join(site, "out")))!;
    const binding = { buildHash: inspected.hash, fileCount: inspected.fileCount, bytes: inspected.bytes, source: inspectSourceRevision(site) };
    await mkdir(join(site, "_scratch")); await writeFile(join(site, "_scratch", "build-artifact.json"), JSON.stringify({ schemaVersion: 1, generatedAt: "2026-08-11T00:00:00.000Z", ...binding }));
    await writeConfig(config, { site: "project", outDir: "out", artifact: "_scratch/build-artifact.json", gates: [{ id: "artifact-binding", kind: "command", label: "artifact", run: ["npm", "run", "artifact:verify"], bindArtifact: true, assert: [{ path: "result", equals: "PASS" }] }] });
    const current = await runScorecard({ configPath: config, execImpl: exec({ stdout: JSON.stringify({ result: "PASS", recorded: binding }) }) });
    expect(current.gates[0]?.status).toBe("PASS");
    await writeFile(join(site, "source.txt"), "dirty-after-build");
    const stale = await runScorecard({ configPath: config, execImpl: exec({ stdout: JSON.stringify({ result: "PASS", binding, recorded: binding }) }) });
    expect(stale.gates[0]?.status).toBe("FAIL");
    expect(stale.gates[0]?.reason).toContain("source revision");
  });

  it("checks live review, renders a build mismatch warning, and distinguishes missing files", async () => {
    const { root, site, config } = await makeProject();
    await mkdir(join(root, "docs"), { recursive: true }); await mkdir(join(site, "out")); await writeFile(join(site, "out", "index.html"), "current");
    await writeConfig(config, { site: "project", outDir: "out", gates: [{ id: "review", kind: "file", label: "review", check: "live-review", file: "docs/live-review.json" }] });
    await writeFile(join(root, "docs", "live-review.json"), JSON.stringify({ date: "2026-07-28", reviewer: "reviewer", build: "old", scenarios: [{ name: "form", result: "ok" }], findings: [{ summary: "done", resolved: true }] }));
    const passed = await runScorecard({ configPath: config });
    expect(passed.gates[0]?.status).toBe("PASS"); expect(passed.markdown).toContain("レビュー対象ビルドが現行と不一致");
    await writeFile(join(root, "docs", "live-review.json"), JSON.stringify({ date: "2026-07-28", reviewer: "reviewer", scenarios: [{ name: "form", result: "ok" }], findings: [{ summary: "open", resolved: false }] }));
    expect((await runScorecard({ configPath: config })).gates[0]?.status).toBe("FAIL");
    await writeFile(join(root, "docs", "live-review.json"), JSON.stringify({ date: "2026-07-28", reviewer: "reviewer", scenarios: [{ name: "form", result: "ok" }] }));
    const missingFindings = await runScorecard({ configPath: config });
    expect(missingFindings.gates[0]?.status).toBe("FAIL"); expect(missingFindings.gates[0]?.reason).toContain("findings がありません");
    await rm(join(root, "docs", "live-review.json"));
    expect((await runScorecard({ configPath: config })).gates[0]?.status).toBe("NOT_RUN");
  });

  it("requires a full artifact binding for strict live review while keeping legacy hash-only configs readable", async () => {
    const { root, site, config } = await makeProject();
    await mkdir(join(root, "docs"), { recursive: true }); await mkdir(join(site, "out")); await writeFile(join(site, "out", "index.html"), "current");
    await initGitSite(site);
    const inspected = (await inspectBuildOutput(join(site, "out")))!;
    const binding = { buildHash: inspected.hash, fileCount: inspected.fileCount, bytes: inspected.bytes, source: inspectSourceRevision(site) };
    await mkdir(join(site, "_scratch")); await writeFile(join(site, "_scratch", "build-artifact.json"), JSON.stringify({ schemaVersion: 1, generatedAt: "2026-08-11T00:00:00.000Z", ...binding }));
    await writeConfig(config, { site: "project", outDir: "out", artifact: "_scratch/build-artifact.json", gates: [{ id: "review", kind: "file", label: "review", check: "live-review", bindArtifact: true, file: "docs/live-review.json" }] });
    const review = { date: "2026-08-11", reviewer: "reviewer", build: binding.buildHash, scenarios: [{ name: "form", result: "ok" }], findings: [{ summary: "done", resolved: true }] };
    await writeFile(join(root, "docs", "live-review.json"), JSON.stringify(review));
    expect((await runScorecard({ configPath: config })).gates[0]?.status).toBe("FAIL");
    await writeFile(join(root, "docs", "live-review.json"), JSON.stringify({ ...review, binding }));
    expect((await runScorecard({ configPath: config })).gates[0]?.status).toBe("PASS");
  });

  it("records attestations, transcribes values, and excludes optional failures from overall", async () => {
    const { root, config } = await makeProject();
    await mkdir(join(root, "docs"), { recursive: true });
    await writeConfig(config, { site: "project", outDir: "out", gates: [
      { id: "a11y", kind: "attestation", label: "a11y", file: "docs/quality-attestations.json", key: "a11y" },
      { id: "optional", kind: "command", label: "optional", required: false, run: ["node", "bad"] },
    ] });
    await writeFile(join(root, "docs", "quality-attestations.json"), JSON.stringify({ a11y: { date: "2026-07-28", by: "reviewer", values: { violations: 0 } } }));
    const result = await runScorecard({ configPath: config, execImpl: exec({ exitCode: 1 }) });
    expect(result.gates.map((gate) => gate.status)).toEqual(["ATTESTED", "FAIL"]);
    expect(result.overall).toBe("PASS"); expect(result.markdown).toContain("violations");
    await writeFile(join(root, "docs", "quality-attestations.json"), "{}");
    expect((await runScorecard({ configPath: config, execImpl: exec({ exitCode: 1 }) })).gates[0]?.status).toBe("NOT_RUN");
  });

  it("requires strict attestations to carry the current full artifact binding", async () => {
    const { root, site, config } = await makeProject();
    await mkdir(join(site, "out")); await writeFile(join(site, "out", "index.html"), "current"); await initGitSite(site);
    const inspected = (await inspectBuildOutput(join(site, "out")))!;
    const binding = { buildHash: inspected.hash, fileCount: inspected.fileCount, bytes: inspected.bytes, source: inspectSourceRevision(site) };
    await mkdir(join(site, "_scratch")); await writeFile(join(site, "_scratch", "build-artifact.json"), JSON.stringify({ schemaVersion: 1, generatedAt: "2026-08-11T00:00:00.000Z", ...binding }));
    await mkdir(join(root, "docs"));
    await writeConfig(config, { site: "project", outDir: "out", artifact: "_scratch/build-artifact.json", gates: [{ id: "attested", kind: "attestation", label: "attested", bindArtifact: true, file: "docs/attestations.json", key: "a11y" }] });
    await writeFile(join(root, "docs", "attestations.json"), JSON.stringify({ a11y: { date: "2026-08-11", by: "reviewer", values: { violations: 0 } } }));
    expect((await runScorecard({ configPath: config })).gates[0]).toMatchObject({ status: "FAIL", reason: expect.stringContaining("full build artifact binding") });
    await writeFile(join(root, "docs", "attestations.json"), JSON.stringify({ a11y: { date: "2026-08-11", by: "reviewer", binding: { ...binding, buildHash: "a".repeat(64) } } }));
    expect((await runScorecard({ configPath: config })).gates[0]?.status).toBe("FAIL");
    await writeFile(join(root, "docs", "attestations.json"), JSON.stringify({ a11y: { date: "2026-08-11", by: "reviewer", binding, values: { violations: 0 } } }));
    const matched = await runScorecard({ configPath: config });
    expect(matched.gates[0]?.status).toBe("ATTESTED");
    expect(matched.overall).toBe("PASS");
  });

  it("does not let optional or file gates named build bypass artifact preflight", async () => {
    const { root, site, config } = await makeProject();
    await mkdir(join(site, "out")); await writeFile(join(site, "out", "index.html"), "current");
    await writeFile(join(root, "evidence.json"), "{}");
    await writeConfig(config, { site: "project", outDir: "out", artifact: "_scratch/missing-artifact.json", gates: [{ id: "build", kind: "command", label: "optional fake build", required: false, run: ["node", "noop"] }] });
    let result = await runScorecard({ configPath: config, execImpl: exec() });
    expect(result.overall).toBe("FAIL");
    expect(result.gates[0]).toMatchObject({ id: "artifact-preflight", status: "FAIL", required: true });
    await writeConfig(config, { site: "project", outDir: "out", artifact: "_scratch/missing-artifact.json", gates: [{ id: "build", kind: "file", label: "file fake build", file: "evidence.json" }] });
    result = await runScorecard({ configPath: config });
    expect(result.overall).toBe("FAIL");
    expect(result.gates[0]).toMatchObject({ id: "artifact-preflight", status: "FAIL", required: true });
  });

  it("hashes build contents deterministically and writes both reports with failure reasons", async () => {
    const { root, site, config } = await makeProject(); const output = join(site, "out");
    await mkdir(join(output, "nested"), { recursive: true }); await writeFile(join(output, "nested", "a.txt"), "one");
    const first = await hashBuildOutput(output); const second = await hashBuildOutput(output);
    expect(first).toBe(second);
    await writeFile(join(output, "nested", "a.txt"), "two"); expect(await hashBuildOutput(output)).not.toBe(first);
    await writeConfig(config, { site: "project", outDir: "out", gates: [{ id: "failed", kind: "command", label: "failed gate", run: ["node", "bad"] }] });
    const result = await runScorecard({ configPath: config, execImpl: exec({ exitCode: 1 }) });
    expect(JSON.parse(await readFile(join(result.reportDir, "scorecard.json"), "utf8"))).toMatchObject({ overall: "FAIL" });
    const markdown = await readFile(join(result.reportDir, "scorecard.md"), "utf8");
    expect(markdown).toContain("## 総合判定: FAIL"); expect(markdown).toContain("exit code 1");
  });

  it("fails closed when build output contains symlinks or unsupported filesystem entries", async () => {
    const { root, site, config } = await makeProject(); const output = join(site, "out");
    await mkdir(output); await writeFile(join(root, "target.txt"), "outside"); await symlink(join(root, "target.txt"), join(output, "linked.txt"));
    await expect(inspectBuildOutput(output)).rejects.toThrow("unsupported filesystem entry in build output");
    await writeConfig(config, { site: "project", outDir: "out", gates: [] });
    await expect(runScorecard({ configPath: config })).rejects.toThrow("unsupported filesystem entry in build output");
  });

  it("uses the config directory by default and the current directory for an explicit report directory", async () => {
    const { root, config } = await makeProject();
    await writeConfig(config, { site: "project", outDir: "out", gates: [] });
    const defaultResult = await runScorecard({ configPath: config });
    expect(defaultResult.reportDir).toBe(join(root, "_scratch", "scorecard"));

    const explicitDir = join(root, "explicit-scorecard");
    const explicitResult = await runScorecard({
      configPath: config,
      outDir: relative(process.cwd(), explicitDir),
    });
    expect(explicitResult.reportDir).toBe(explicitDir);
    await expect(readFile(join(explicitDir, "scorecard.json"), "utf8")).resolves.toContain('"overall": "PASS"');
  });

  it("initializes every default gate and refuses overwrite without force", async () => {
    const { root, site } = await makeProject();
    await writeFile(join(site, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc", lint: "lint", build: "build" } }));
    const config = join(root, "scorecard.config.json");
    const result = await initScorecardConfig({ siteDir: site, configPath: config });
    expect(result.config.gates.map((gate) => gate.id)).toEqual(defaultScorecardConfig("project").gates.map((gate) => gate.id));
    expect(result.config.gates).toHaveLength(15);
    expect(result.config.gates.filter((gate) => gate.kind === "attestation")).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "a11y", bindArtifact: true }),
      expect.objectContaining({ id: "lighthouse", bindArtifact: true }),
    ]));
    await expect(initScorecardConfig({ siteDir: site, configPath: config })).rejects.toThrow("既に存在");
  });
});
