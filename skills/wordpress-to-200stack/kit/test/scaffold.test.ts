import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scaffoldSite } from "../src/scaffold/index.js";

const temporary: string[] = [];
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "wpkit-scaffold-")); temporary.push(value); return value; }
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("site scaffolding", () => {
  it("assembles Astro with shared audits and content without a Next runtime", async () => {
    const outDir = join(await root(), "site");
    await scaffoldSite({ framework: "astro", outDir });
    const pkg = JSON.parse(await readFile(join(outDir, "package.json"), "utf8"));
    expect(pkg.dependencies.astro).toBeTruthy();
    expect(pkg.dependencies.next).toBeUndefined();
    expect(pkg.scripts["verify:seo"]).toBe("node scripts/verify-seo.mjs");
    expect(await readFile(join(outDir, "src/lib/content/microcms-document.ts"), "utf8")).toContain("documentsFromMicroCms");
    expect(await readFile(join(outDir, "scripts/verify-seo.mjs"), "utf8")).not.toContain("@next/env");
    expect(await readFile(join(outDir, "src/components/PreviewClient.tsx"), "utf8")).not.toContain("next/navigation");
    expect(await readFile(join(outDir, "src/lib/content/client.ts"), "utf8")).not.toContain("next:");
    expect(await readdir(outDir)).not.toContain("node_modules");
    expect(await readdir(join(outDir, "src"))).not.toContain("app");
  });

  it("retains the Next template and skips installed and built artifacts", async () => {
    const outDir = join(await root(), "site");
    await scaffoldSite({ framework: "next", outDir });
    const pkg = JSON.parse(await readFile(join(outDir, "package.json"), "utf8"));
    expect(pkg.dependencies.next).toBeTruthy();
    expect(await readdir(outDir)).not.toContain("node_modules");
    expect(await readdir(outDir)).not.toContain("tsconfig.tsbuildinfo");
    expect(await readFile(join(outDir, "scripts/verify-seo.mjs"), "utf8")).toContain("@next/env");
  });

  it("rejects existing directories, files and dangling links without changing them", async () => {
    const directory = await root();
    const outDir = join(directory, "site");
    await mkdir(outDir);
    await writeFile(join(outDir, "keep.txt"), "user content");
    await expect(scaffoldSite({ framework: "astro", outDir })).rejects.toThrow("既に存在");
    expect(await readFile(join(outDir, "keep.txt"), "utf8")).toBe("user content");
    const file = join(directory, "existing.txt");
    await writeFile(file, "keep");
    await expect(scaffoldSite({ framework: "next", outDir: file })).rejects.toThrow("既に存在");
    const link = join(directory, "link");
    await symlink(join(directory, "missing"), link);
    await expect(scaffoldSite({ framework: "astro", outDir: link })).rejects.toThrow("既に存在");
  });

  it("rejects an unsupported framework before creating output", async () => {
    const directory = await root();
    await expect(scaffoldSite({ framework: "unknown", outDir: join(directory, "site") })).rejects.toThrow("next または astro");
    expect(await readdir(directory)).toEqual([]);
  });
});
