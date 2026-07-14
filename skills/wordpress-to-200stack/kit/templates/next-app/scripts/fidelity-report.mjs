import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const project = resolve(import.meta.dirname, "..");
const fidelityDir = join(project, "_scratch", "fidelity");

function finiteNumbers(values) {
  return values.filter(Number.isFinite).sort((left, right) => left - right);
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function median(values) {
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function p90(values) {
  return values.length ? values[Math.ceil(values.length * 0.9) - 1] : null;
}

function round(value) {
  return value === null ? null : Number(value.toFixed(6));
}

function metrics(records, viewport) {
  const ratios = finiteNumbers(records.map((record) => record[viewport]?.ratio));
  const heightDeltas = finiteNumbers(records.map((record) => {
    const data = record[viewport];
    return Number.isFinite(data?.heightOld) && Number.isFinite(data?.heightNew) ? data.heightNew - data.heightOld : NaN;
  }));
  return { mean: round(mean(ratios)), median: round(median(ratios)), p90: round(p90(ratios)), heightDeltaMedian: round(median(heightDeltas)) };
}

function formatRatio(value) {
  return Number.isFinite(value) ? value.toFixed(4) : "-";
}

function buildTodo(surfaces) {
  const rows = surfaces.map((surface) => {
    const worst = surface.worstUrls[0];
    const worstUrl = worst ? `${worst.path} (${formatRatio(worst.desktop.ratio)})` : "-";
    return `| ${surface.surface} | ${surface.population} | ${formatRatio(surface.desktop.p90)} | ${formatRatio(surface.mobile.p90)} | ${worstUrl} | ${surface.status} |`;
  });
  return [
    "<!-- GENERATED FILE: 手編集禁止。再生成: node scripts/fidelity-report.mjs -->",
    "# Fidelity TODO",
    "",
    "desktop p90 の高い surface から確認する。`unscanned` は比較可能な基準画像がまだない、または撮影に失敗した surface。",
    "",
    "| surface | population | p90 desktop | p90 mobile | worst URL | 状態 |",
    "| --- | ---: | ---: | ---: | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

async function main() {
  const records = JSON.parse(await readFile(join(fidelityDir, "scan.json"), "utf8"));
  if (!Array.isArray(records)) throw new Error("_scratch/fidelity/scan.json must be an array of scan records");
  const grouped = new Map();
  for (const record of records) {
    const surface = record.surface ?? "unmapped";
    const population = grouped.get(surface) ?? [];
    population.push(record);
    grouped.set(surface, population);
  }
  const surfaces = [...grouped.entries()].map(([surface, population]) => {
    const measured = population.filter((record) => record.status === "ok");
    const worstUrls = [...measured].sort((left, right) => Math.max(right.desktop.ratio, right.mobile.ratio) - Math.max(left.desktop.ratio, left.mobile.ratio)).slice(0, 5).map((record) => ({
      url: record.url,
      path: record.path,
      desktop: { ratio: record.desktop.ratio, diffPng: record.desktop.diffPng },
      mobile: { ratio: record.mobile.ratio, diffPng: record.mobile.diffPng },
    }));
    return {
      surface,
      population: population.length,
      measured: measured.length,
      desktop: metrics(measured, "desktop"),
      mobile: metrics(measured, "mobile"),
      worstUrls,
      noBaseline: population.filter((record) => record.status === "no-baseline").length,
      failed: population.filter((record) => record.status === "screenshot-failed").length,
      noNew: population.filter((record) => record.status === "no-new").length,
      status: measured.length ? "scanned" : "unscanned",
    };
  }).sort((left, right) => (right.desktop.p90 ?? -1) - (left.desktop.p90 ?? -1) || left.surface.localeCompare(right.surface));

  const report = { generatedAt: new Date().toISOString(), records: records.length, unmapped: records.filter((record) => record.surface === "unmapped").length, surfaces };
  await mkdir(fidelityDir, { recursive: true });
  await writeFile(join(fidelityDir, "surfaces-summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(project, "FIDELITY_TODO.md"), buildTodo(surfaces));
  console.log(JSON.stringify({ surfaces: surfaces.length, records: records.length, unmapped: report.unmapped }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
