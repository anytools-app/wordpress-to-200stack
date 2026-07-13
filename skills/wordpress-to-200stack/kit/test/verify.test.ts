import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import { comparePngs, verifySite } from "../src/verify/index.js";

const temporary: string[] = [];
async function tempDir(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "wpkit-verify-")); temporary.push(path); return path; }
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function oldPage(archive: string, path: string, meta: Record<string, unknown>): Promise<void> { const directory = join(archive, "pages", encodeURIComponent(path)); await mkdir(directory, { recursive: true }); await writeFile(join(directory, "meta.json"), JSON.stringify({ url: `https://old.test${path}`, ...meta })); }

describe("wpkit verify", () => {
  it("detects missing paths, metadata differences, and broken internal assets in dist mode", async () => {
    const archive = await tempDir(); const dist = await tempDir(); const report = await tempDir();
    await writeFile(join(archive, "inventory.json"), JSON.stringify({ urls: [{ url: "https://old.test/", status: 200 }, { url: "https://old.test/missing/", status: 200 }] }));
    await oldPage(archive, "/", { title: "Old title", description: "Old description", canonical: "https://new.test/", og: { title: "Old OG", description: "Old OGD" } });
    await oldPage(archive, "/missing/", { title: "Missing" });
    await writeFile(join(dist, "index.html"), '<title>New title</title><meta name="description" content="Old description"><link rel="canonical" href="https://new.test/"><meta property="og:title" content="Old OG"><meta property="og:description" content="Old OGD"><a href="/exists/">OK</a><img src="images/good.png"><img src="/gone.png">');
    await mkdir(join(dist, "exists")); await writeFile(join(dist, "exists", "index.html"), "ok");
    await mkdir(join(dist, "images")); await writeFile(join(dist, "images", "good.png"), "ok");
    const result = await verifySite({ oldDir: archive, newTarget: dist, reportDir: report });
    expect(result.missing).toEqual([expect.objectContaining({ url: "https://old.test/missing/" })]);
    expect(result.metaMismatches).toEqual([expect.objectContaining({ detail: expect.stringContaining("title") })]);
    expect(result.brokenLinks).toEqual([expect.objectContaining({ detail: "/gone.png" })]);
  });

  it("calculates pixel differences for PNG images", () => {
    const before = new PNG({ width: 1, height: 1 }); const after = new PNG({ width: 1, height: 1 });
    before.data.set([0, 0, 0, 255]); after.data.set([255, 255, 255, 255]);
    expect(comparePngs(before, after).ratio).toBeGreaterThan(0);
  });
});
