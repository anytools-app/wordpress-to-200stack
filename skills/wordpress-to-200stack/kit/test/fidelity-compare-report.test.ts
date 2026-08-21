import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";

// @ts-expect-error Template .mjs is intentionally tested as the emitted Node artifact.
const report = await import("../templates/next-app/scripts/fidelity-compare-report.mjs");

const temporary: string[] = [];
async function tempDir(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "wpkit-fidelity-compare-")); temporary.push(path); return path; }
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function png(file: string, color: [number, number, number, number]): Promise<void> { const image = new PNG({ width: 2, height: 2 }); for (let index = 0; index < image.data.length; index += 4) image.data.set(color, index); await mkdir(dirname(file), { recursive: true }); await writeFile(file, PNG.sync.write(image)); }

describe("fidelity compare report", () => {
  it("emits only threshold-matching sections, double-encodes image directories, and generates absent diffs", async () => {
    const root = await tempDir();
    const fidelityDir = join(root, "fidelity");
    const baselineRoot = join(root, "baseline");
    const pathname = "/case/1/";
    const encoded = encodeURIComponent(pathname);
    await mkdir(fidelityDir, { recursive: true });
    await writeFile(join(fidelityDir, "blocks-case.json"), JSON.stringify({ surface: "tpl.case.detail", path: pathname, viewports: { desktop: { blocks: [{ id: "hero", dy: 12, dh: 0 }, { id: "cta", dy: 0, dh: 10 }, { id: "header", dy: 3, dh: 1 }] }, mobile: { blocks: [{ id: "small", dy: 3, dh: 1 }] } } }));
    await writeFile(join(fidelityDir, "scan.json"), JSON.stringify([{ surface: "tpl.case.detail", path: "/case/1", desktop: { ratio: 0.2, heightOld: 2, heightNew: 3 } }]));
    await png(join(baselineRoot, encoded, "desktop.png"), [255, 255, 255, 255]);
    await png(join(fidelityDir, "current", encoded, "desktop.png"), [0, 0, 0, 255]);
    const out = join(fidelityDir, "compare.html");
    const result = await report.buildCompareReport({ fidelityDir, baselineRoot, out, threshold: 10 });
    const html = await readFile(out, "utf8");
    expect(result.targetCount).toBe(2);
    expect(result.surfaceCount).toBe(1);
    expect(html).toContain("Fidelity 比較レポート（2件 / 1面）");
    expect(html).toContain('id="tpl.case.detail-desktop"');
    expect(html).not.toContain('id="tpl.case.detail-mobile"');
    expect(html.match(/<tr><td>/g)).toHaveLength(2);
    expect(html).not.toContain("header</td>");
    expect(html).toContain("%252Fcase%252F1%252F");
    expect(html).not.toContain("%2Fcase%2F1%2F");
    await expect(readFile(join(fidelityDir, "diffs", encoded, "desktop.png"))).resolves.toBeInstanceOf(Buffer);
  });

  it("counts desktop and mobile as separate surfaces for the same path", async () => {
    const root = await tempDir();
    const fidelityDir = join(root, "fidelity");
    const pathname = "/news/";
    await mkdir(fidelityDir, { recursive: true });
    await writeFile(join(fidelityDir, "blocks-news.json"), JSON.stringify({ surface: "tpl.news.archive", path: pathname, viewports: { desktop: { blocks: [{ id: "news-list", dy: 11, dh: 0 }] }, mobile: { blocks: [{ id: "news-list", dy: 0, dh: 12 }] } } }));
    const out = join(fidelityDir, "compare.html");
    const result = await report.buildCompareReport({ fidelityDir, out, threshold: 10 });
    const html = await readFile(out, "utf8");
    expect(result.targetCount).toBe(2);
    expect(result.surfaceCount).toBe(2);
    expect(html).toContain("Fidelity 比較レポート（2件 / 2面）");
  });
});
