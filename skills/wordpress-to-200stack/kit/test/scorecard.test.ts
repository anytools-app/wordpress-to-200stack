import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultScorecardConfig, hashBuildOutput, initScorecardConfig, runScorecard, type ExecImplementation, type ScorecardConfig } from "../src/scorecard/index.js";

const temporary: string[] = [];
async function tempDir(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "wpkit-scorecard-")); temporary.push(path); return path; }
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function makeProject(): Promise<{ root: string; site: string; config: string }> {
  const root = await tempDir(); const site = join(root, "project"); const config = join(root, "scorecard.config.json");
  await mkdir(site, { recursive: true });
  return { root, site, config };
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
    expect(result.config.gates).toHaveLength(13);
    await expect(initScorecardConfig({ siteDir: site, configPath: config })).rejects.toThrow("既に存在");
  });
});
