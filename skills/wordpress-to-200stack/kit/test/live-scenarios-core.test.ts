import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hashBuildOutput as scorecardHashBuildOutput } from "../src/scorecard/index.js";

// @ts-expect-error Template .mjs is intentionally tested as the emitted Node artifact.
const core = await import("../templates/next-app/scripts/lib/live-scenarios-core.mjs");

const temporary: string[] = [];
async function tempDir(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "wpkit-live-scenarios-")); temporary.push(path); return path; }
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("live-scenarios core", () => {
  it("uses the same build hash as scorecard", async () => {
    const out = join(await tempDir(), "out");
    await mkdir(join(out, "nested"), { recursive: true });
    await Promise.all([writeFile(join(out, "index.html"), "home"), writeFile(join(out, "nested", "asset.css"), "body{}")]);
    expect(await core.hashBuildOutput(out)).toBe(await scorecardHashBuildOutput(out));
  });

  it("preserves human live-review fields while replacing matching scenarios", () => {
    const existing = {
      date: "2026-07-30", reviewer: "reviewer", findings: [{ summary: "manual", resolved: true }], custom: { keep: true },
      scenarios: [{ name: "automated", result: "ng: old", note: "discarded with replacement" }, { name: "manual", result: "ok", note: "keep" }],
    };
    const merged = core.mergeLiveReview(existing, [{ name: "automated", type: "hover", url: "/", result: "ok" }, { name: "new", type: "carousel", url: "/gallery/", result: "ng: failed" }], "hash", "2026-07-31");
    expect(merged).toMatchObject({ date: "2026-07-30", reviewer: "reviewer", findings: existing.findings, custom: existing.custom, build: "hash" });
    expect(merged.scenarios).toEqual([
      { name: "automated", type: "hover", url: "/", result: "ok", recordedAt: "2026-07-31" },
      existing.scenarios[1],
      { name: "new", type: "carousel", url: "/gallery/", result: "ng: failed", recordedAt: "2026-07-31" },
    ]);
    expect(core.mergeLiveReview(undefined, [{ name: "first", type: "hover", url: "/", result: "ok" }], "hash", "2026-07-31")).toMatchObject({ date: "2026-07-31", reviewer: "", findings: [], build: "hash" });
  });

  it("evaluates all supported expectation forms", () => {
    expect(core.evaluateExpect("same", "same").pass).toBe(true);
    expect(core.evaluateExpect("same", { not: "other" }).pass).toBe(true);
    expect(core.evaluateExpect("translateX(0px)", { matches: "translateX\\(0px\\)" }).pass).toBe(true);
    expect(core.evaluateExpect("b", { oneOf: ["a", "b"] }).pass).toBe(true);
    expect(core.evaluateExpect("translateX(0px)", { contains: "0px" }).pass).toBe(true);
  });

  it("accepts the fixture and rejects required-field, duplicate-name, and unknown-type errors", async () => {
    const fixturePath = resolve(import.meta.dirname, "..", "templates", "next-app", "scripts", "fixtures", "scenarios.config.json");
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    expect(core.validateConfig(fixture).scenarios).toHaveLength(6);
    expect(() => core.validateConfig({ scenarios: [{ name: "missing", type: "hover", url: "/" }] })).toThrow("scenarios[0].selector");
    const hover = { name: "same", type: "hover", url: "/", selector: ".trigger", property: "opacity", expect: "1" };
    expect(() => core.validateConfig({ scenarios: [hover, { ...hover }] })).toThrow("重複");
    expect(() => core.validateConfig({ scenarios: [{ name: "unknown", type: "not-a-type", url: "/" }] })).toThrow("type");
  });
});
