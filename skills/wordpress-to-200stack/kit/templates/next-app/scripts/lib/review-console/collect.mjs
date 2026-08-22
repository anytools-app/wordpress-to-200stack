import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

import { normalizePathname } from "../surfaces.mjs";

const SITE_DIR = resolve(import.meta.dirname, "..", "..", "..");
const PANEL_DEFS = [
  ["status-board", "工程ボード(§0〜8)", "§0〜8"],
  ["scorecard-summary", "scorecard 総合 + artifact binding", "scorecard"],
  ["build-basics", "型・lint・build", "scorecard"],
  ["archive-built", "archive-built 監査(系統 c/e)", "§6.5"],
  ["fidelity-blocks", "寸法ブロック(系統 a)", "§6.5"],
  ["fidelity-pixel", "ピクセル比較(系統 b)", "§6.5"],
  ["fidelity-approvals", "fidelity 承認網羅", "§6.5"],
  ["seo", "SEO 契約", "§2.1"],
  ["routes", "ルート・301", "scorecard"],
  ["page-gates", "フォーム(T6)・stylesheet・preload", "scorecard"],
  ["verify-content", "新旧照合(wpkit verify)", "scorecard"],
  ["live-review", "実機レビュー", "§6.5"],
  ["attestations", "a11y / Lighthouse ほか", "§8.5 / §8.6"],
  ["manual-crosschecks", "テンプレ突合(§6.6)・系統(d) トークン・系統(f) 動き", "§6.6"],
];
const SCORECARD_COMMAND = "npm run wpkit -- scorecard --config scorecard.config.json";
const STATUS = new Set(["PASS", "FAIL", "NOT_RUN", "ATTESTED", "STALE", "MANUAL", "REVIEW"]);

const arr = (value) => Array.isArray(value) ? value : [];
const rec = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
const display = (path) => String(path).split(sep).join("/");
const cols = (...values) => values.map(([key, label, align]) => ({ key, label, align }));
const empty = (id) => {
  const [, title, section] = PANEL_DEFS.find((definition) => definition[0] === id);
  return { id, title, section, status: "NOT_RUN", summary: "証跡未実施", reason: null, command: null, evidence: [], binding: null, columns: [], rows: [], notes: [], images: [] };
};
const short = (value, limit = 200) => {
  if (value === null || value === undefined) return "—";
  let text;
  if (Array.isArray(value)) text = `配列(${value.length})${value.length ? `: ${short(value[0], 100)}` : ""}`;
  else if (typeof value === "object") {
    const entries = Object.entries(value);
    text = `オブジェクト(${entries.length}): ${entries.slice(0, 3).map(([key, item]) => `${key}=${short(item, 70)}`).join(", ")}`;
  } else text = String(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};
const bindingOf = (value) => {
  const record = rec(value);
  return rec(record?.binding) ?? rec(rec(record?.provenance)?.artifact) ?? rec(record?.recorded) ?? (typeof record?.buildHash === "string" ? record : null);
};
const sameBinding = (recorded, current) => Boolean(recorded && current && recorded.buildHash === current.hash && recorded.fileCount === current.fileCount && recorded.bytes === current.bytes);
const severityRank = { Blocking: 0, Major: 1, Minor: 2, Info: 3 };

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}
async function readJson(path) {
  try { return { value: JSON.parse(await readFile(path, "utf8")), error: null }; }
  catch (error) { return { value: null, error: error?.code === "ENOENT" ? null : `JSON を読めません: ${error.message}` }; }
}
async function firstCandidate(candidates) {
  for (const path of candidates) if (await exists(path)) return { path, candidates };
  return { path: null, candidates };
}
function encodedRelativeUrl(outDir, path) {
  return display(relative(outDir, path)).split("/").map((segment) => encodeURI(segment)).join("/");
}
function evidence(path, outDir) {
  const present = Boolean(path && existsSync(path));
  return { label: path ? display(path) : "証跡", path: path ? display(path) : "", exists: present, url: present ? encodedRelativeUrl(outDir, path) : null };
}
function missing(panel, found, command, outDir, reason = null) {
  panel.status = "NOT_RUN";
  panel.reason = reason ?? `証跡がありません。探索先: ${found.candidates.map(display).join(" / ")}`;
  panel.command = command;
  panel.evidence = found.candidates.map((path) => evidence(path, outDir));
  return panel;
}
function invalid(panel, reason, found, outDir) {
  panel.status = "FAIL";
  panel.reason = reason;
  panel.evidence = found.path ? [evidence(found.path, outDir)] : found.candidates.map((path) => evidence(path, outDir));
  return panel;
}
function gate(scorecard, ids) {
  return arr(rec(scorecard)?.gates).filter((item) => ids.includes(item?.id));
}
function attestationGates(scorecard) {
  return arr(rec(scorecard)?.gates).filter((item) => item?.kind === "attestation" || ["a11y", "lighthouse", "attestation", "attestations", "quality-attestations"].includes(item?.id));
}
function applyGateStatus(panel, gates, scoreFound, outDir) {
  if (!scoreFound.path) {
    panel.status = "NOT_RUN";
    panel.reason = "scorecard 未実行のため合否は表示しません";
    panel.command = SCORECARD_COMMAND;
    return false;
  }
  if (!gates.length) {
    panel.status = "NOT_RUN";
    panel.reason = "scorecard に対応 gate がありません。合否は表示しません";
    panel.command = SCORECARD_COMMAND;
    panel.evidence.push(evidence(scoreFound.path, outDir));
    return false;
  }
  panel.status = gates.some((item) => item?.status === "FAIL") ? "FAIL" : gates.every((item) => item?.status === "ATTESTED") ? "ATTESTED" : gates.every((item) => item?.status === "PASS" || item?.status === "ATTESTED") ? "PASS" : "NOT_RUN";
  panel.reason = gates.map((item) => item?.reason ? `${item.id}: ${item.reason}` : null).filter(Boolean).join(" / ") || null;
  panel.evidence.push(evidence(scoreFound.path, outDir));
  return true;
}
function applyBinding(panel, value, current) {
  const recorded = bindingOf(value);
  if (!recorded && !current) return;
  panel.binding = { recorded, current, matches: sameBinding(recorded, current) };
  if (recorded && current && !panel.binding.matches) {
    panel.status = "STALE";
    panel.reason = `artifact binding 不一致: buildHash ${recorded.buildHash} / ${current.hash}, fileCount ${recorded.fileCount} / ${current.fileCount}, bytes ${recorded.bytes} / ${current.bytes}`;
  }
}
function cap(panel, maxRows, fullPath) {
  if (panel.rows.length <= maxRows) return;
  const total = panel.rows.length;
  panel.rows = panel.rows.slice(0, maxRows);
  panel.notes.push(`全 ${total} 件中 ${maxRows} 件を表示(全件: ${display(fullPath)})`);
}
function archiveContent(observation) {
  const entries = Object.entries(observation).filter(([key]) => !["route", "scope", "severity", "code", "observationHash", "decision"].includes(key));
  return entries.length ? entries.map(([key, value]) => `${key}: ${short(value, 120)}`).join(" / ") : "—";
}
function seoValue(value) {
  return Array.isArray(value) ? `配列(${value.length})${value.length ? `: ${short(value[0], 100)}` : ""}` : rec(value) ? short(value, 200) : short(value, 200);
}
function reportRows(value) {
  return [...arr(value?.nonIntentionalDifferences).map((item) => ({ item, type: "非意図" })), ...arr(value?.intentionalDifferences).map((item) => ({ item, type: "意図差分" }))]
    .map(({ item, type }) => ({ cells: { item: item?.item ?? "—", path: item?.path ?? "—", expected: seoValue(item?.expected), actual: seoValue(item?.actual), type } }));
}
function formSummary(value) {
  if (!rec(value)) return "記録値なし";
  if (value.matches === true) return "matches: true";
  if (value.matches === false) {
    const expected = rec(value.expected) ?? {};
    const actual = rec(value.actual) ?? {};
    const names = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter((key) => JSON.stringify(expected[key]) !== JSON.stringify(actual[key]));
    return `matches: false${names.length ? ` / 差異: ${names.slice(0, 5).join(", ")}${names.length > 5 ? "…" : ""}` : ""}`;
  }
  return short(value);
}
function stylesheetSummary(value) {
  const targets = arr(value);
  const invalid = targets.filter((target) => target?.valid === false).map((target) => target?.path).filter(Boolean);
  return `target ${targets.length} 件 / valid:false ${invalid.length}${invalid.length ? `: ${invalid.slice(0, 5).join(", ")}${invalid.length > 5 ? "…" : ""}` : ""}`;
}
function preloadSummary(value) {
  const failures = arr(rec(value)?.failures);
  return `failures ${failures.length}${failures.length ? `: ${failures.slice(0, 3).map((item) => short(item, 80)).join(" / ")}${failures.length > 3 ? "…" : ""}` : ""}`;
}
function count(value) {
  return Array.isArray(value) ? value.length : typeof value === "number" ? value : value ? 1 : 0;
}
function verifySummary(report) {
  const entries = [];
  if (report.pages !== undefined) entries.push(`pages ${count(report.pages)}`);
  const missing = report.missing ?? report.missingUrls;
  if (missing !== undefined) entries.push(`missing ${count(missing)}`);
  if (report.metaMismatches !== undefined) entries.push(`metaMismatches ${count(report.metaMismatches)}`);
  return entries.join(" / ");
}
async function generateDiff(oldFile, newFile, destination) {
  const [oldBytes, newBytes] = await Promise.all([readFile(oldFile), readFile(newFile)]);
  const oldImage = PNG.sync.read(oldBytes); const newImage = PNG.sync.read(newBytes);
  const width = Math.max(oldImage.width, newImage.width); const height = Math.max(oldImage.height, newImage.height);
  const pad = (source) => { const image = new PNG({ width, height }); image.data.fill(255); PNG.bitblt(source, image, 0, 0, source.width, source.height, 0, 0); return image; };
  const diff = new PNG({ width, height });
  pixelmatch(pad(oldImage).data, pad(newImage).data, diff.data, width, height, { threshold: 0.1 });
  await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, PNG.sync.write(diff));
}
function pngPath(root, pathname, viewport) { return join(root, encodeURIComponent(pathname === "/" ? "/" : `${pathname.replace(/\/+$/, "")}/`), `${viewport}.png`); }
function pngUrl(file, outDir) {
  const parts = display(relative(outDir, file)).split("/");
  if (parts.length > 1) parts[parts.length - 2] = encodeURIComponent(parts[parts.length - 2]);
  return parts.map((part, index) => index === parts.length - 2 ? part : encodeURI(part)).join("/");
}

export async function inspectBuildOutput(outDir) {
  if (!(await exists(outDir))) return null;
  const files = [];
  async function walk(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await walk(path); else if (entry.isFile()) files.push(path); } }
  await walk(outDir);
  const hash = createHash("sha256"); let bytes = 0;
  for (const file of files.sort((left, right) => display(relative(outDir, left)).localeCompare(display(relative(outDir, right))))) {
    const content = await readFile(file); bytes += content.byteLength;
    hash.update(display(relative(outDir, file))).update("\0").update(createHash("sha256").update(content).digest("hex"));
  }
  return { hash: hash.digest("hex"), fileCount: files.length, bytes };
}

export async function collectReviewData(options = {}) {
  const siteDir = resolve(options.siteDir ?? SITE_DIR);
  const root = resolve(options.root ?? dirname(siteDir));
  const configPath = resolve(options.config ?? join(root, "scorecard.config.json"));
  const configDir = dirname(configPath);
  const outDir = dirname(resolve(options.out ?? join(siteDir, "_scratch", "review", "index.html")));
  const maxRows = options.maxRows ?? 2000; const threshold = options.threshold ?? 10;
  const find = (path) => firstCandidate([join(configDir, path), join(siteDir, path)]);
  const configRead = await readJson(configPath); const config = rec(configRead.value) ?? {};
  const configuredSite = typeof config.site === "string" ? resolve(configDir, config.site) : siteDir;
  const outRel = typeof config.outDir === "string" ? config.outDir : "out";
  const buildOut = await firstCandidate([join(configuredSite, outRel), join(siteDir, outRel)]);
  const current = buildOut.path ? await inspectBuildOutput(buildOut.path) : null;
  const paths = {
    score: await find("_scratch/scorecard/scorecard.json"), status: await find("migration-state.json"), artifact: await find(typeof config.artifact === "string" ? config.artifact : "_scratch/build-artifact.json"),
    archive: await find("_scratch/fidelity/archive-built-audit.json"), scan: await find("_scratch/fidelity/scan.json"), approvals: await find("docs/fidelity-approvals.json"), surfaces: await find("_scratch/fidelity/surfaces-summary.json"),
    seo: await find("_scratch/seo-audit/report.json"), verify: await find("_scratch/verify/verify-report.json"), live: await find("docs/live-review.json"), scenarios: await find("_scratch/live-scenarios/result.json"), attest: await find("docs/quality-attestations.json"),
  };
  const scoreRead = paths.score.path ? await readJson(paths.score.path) : { value: null, error: null };
  const score = rec(scoreRead.value); const panels = PANEL_DEFS.map(([id]) => empty(id)); const get = (id) => panels.find((panel) => panel.id === id);

  { const panel = get("status-board"); if (!paths.status.path) missing(panel, paths.status, "npm run wpkit -- status init", outDir); else { const result = await readJson(paths.status.path); const state = rec(result.value); const gates = rec(state?.gates); if (result.error || !gates) invalid(panel, result.error ?? "migration-state.json の gates がありません", paths.status, outDir); else { const entries = Object.entries(gates); const incomplete = entries.filter(([, value]) => !["done", "approved"].includes(value?.status)).map(([id]) => id); panel.status = incomplete.length ? "NOT_RUN" : "PASS"; panel.summary = `${entries.length} gate 中 ${entries.length - incomplete.length} 通過${incomplete.length ? ` (未通過: ${incomplete.join(", ")})` : ""}`; panel.evidence = [evidence(paths.status.path, outDir)]; panel.columns = cols(["id", "工程"], ["status", "状態"], ["at", "記録時刻"]); panel.rows = entries.map(([id, value]) => ({ cells: { id, status: value?.status ?? "—", at: value?.at ?? "—" } })); } } }
  { const panel = get("scorecard-summary"); const artifactRead = paths.artifact.path ? await readJson(paths.artifact.path) : { value: null, error: null }; const artifact = bindingOf(artifactRead.value); if (!paths.score.path) missing(panel, paths.score, SCORECARD_COMMAND, outDir); else if (scoreRead.error || !score || typeof score.overall !== "string" || !Array.isArray(score.gates)) invalid(panel, scoreRead.error ?? "scorecard.json の overall または gates が不正です", paths.score, outDir); else if (artifactRead.error || (paths.artifact.path && !artifact)) { invalid(panel, artifactRead.error ?? "build artifact の binding が不正です", paths.artifact, outDir); panel.evidence = [evidence(paths.score.path, outDir), evidence(paths.artifact.path, outDir)]; } else { panel.status = score.overall === "FAIL" ? "FAIL" : "PASS"; panel.summary = `総合 ${score.overall}`; panel.evidence = [evidence(paths.score.path, outDir), ...(paths.artifact.path ? [evidence(paths.artifact.path, outDir)] : [])]; panel.columns = cols(["id", "gate"], ["status", "状態"], ["reason", "理由"]); panel.rows = arr(score.gates).map((item) => ({ cells: { id: item?.id ?? "—", status: item?.status ?? "—", reason: item?.reason ?? "—" } })); applyBinding(panel, score.buildArtifact ?? artifact, current); } }
  { const panel = get("build-basics"); const gates = gate(score, ["typecheck", "lint", "build"]); applyGateStatus(panel, gates, paths.score, outDir); panel.summary = gates.length ? `${gates.length} gate` : panel.summary; panel.columns = cols(["id", "gate"], ["status", "状態"], ["reason", "理由"]); panel.rows = gates.map((item) => ({ cells: { id: item.id, status: item.status, reason: item.reason ?? "—" } })); }
  { const panel = get("archive-built"); if (!paths.archive.path) missing(panel, paths.archive, "npm run verify:archive-built", outDir); else { const result = await readJson(paths.archive.path); const report = rec(result.value); if (result.error || !report || !["PASS", "FAIL"].includes(report.result) || !rec(report.summary) || !rec(report.coverage) || !Array.isArray(report.observations)) invalid(panel, result.error ?? "archive-built report の result / summary / coverage / observations が不正です", paths.archive, outDir); else { const gates = gate(score, ["archive-built"]); if (gates.length) applyGateStatus(panel, gates, paths.score, outDir); else panel.status = report.result === "FAIL" ? "FAIL" : "PASS"; const summary = report.summary; const coverage = report.coverage; panel.summary = `Blocking ${summary.blocking ?? 0} / Major ${summary.major ?? 0} / Minor ${summary.minor ?? 0} / Info ${summary.info ?? 0} / accepted ${summary.accepted ?? 0} / unresolved ${summary.unresolved ?? 0}; coverage routeUnion ${coverage.routeUnion ?? "—"} / inventoryStatus200 ${coverage.inventoryStatus200 ?? "—"} / comparedPages ${coverage.comparedPages ?? "—"} / outputPages ${coverage.outputPages ?? "—"}`; panel.evidence = [...panel.evidence, evidence(paths.archive.path, outDir)]; panel.columns = cols(["severity", "severity"], ["code", "code"], ["route", "route"], ["scope", "scope"], ["decision", "decision"], ["content", "内容"]); panel.rows = report.observations.map((raw) => { const observation = rec(raw) ?? {}; const severity = observation.severity ?? "Info"; const decision = rec(observation.decision); const accepted = decision ? "accepted" : "—"; const hash = typeof observation.observationHash === "string" ? observation.observationHash : null; return { cells: { severity, code: observation.code ?? "—", route: observation.route ?? "—", scope: observation.scope ?? "—", decision: accepted, content: archiveContent(observation) }, severity, hash, decision: accepted, copy: hash ? JSON.stringify({ observationHash: hash, route: observation.route ?? null, code: observation.code ?? null, severity }) : null }; }).sort((left, right) => (severityRank[left.severity] ?? 4) - (severityRank[right.severity] ?? 4) || String(left.cells.route).localeCompare(String(right.cells.route))); cap(panel, maxRows, paths.archive.path); applyBinding(panel, report, current); } } }

  const fidelityDirs = [join(configDir, "_scratch/fidelity"), join(siteDir, "_scratch/fidelity")]; const fidelityDir = fidelityDirs.find(existsSync) ?? fidelityDirs[0];
  const baselineRoot = process.env.WPKIT_BASELINE_DIR ?? join(fidelityDir, "..", "archive", "pages"); const assetRoots = [baselineRoot, join(fidelityDir, "current"), join(fidelityDir, "diffs")];
  const blockFiles = existsSync(fidelityDir) ? (await readdir(fidelityDir)).filter((name) => /^blocks-.+\.json$/.test(name)).map((name) => join(fidelityDir, name)) : [];
  { const panel = get("fidelity-blocks"); if (!blockFiles.length) missing(panel, { candidates: fidelityDirs.map((directory) => join(directory, "blocks-*.json")) }, "node scripts/measure-blocks.mjs", outDir); else { panel.evidence = blockFiles.map((file) => evidence(file, outDir)); panel.columns = cols(["surface", "面"], ["path", "path"], ["viewport", "viewport"], ["id", "block"], ["dy", "dy"], ["dh", "dh"]); for (const file of blockFiles) { const result = await readJson(file); const report = rec(result.value); if (result.error || !report) { panel.status = "FAIL"; panel.reason = result.error ?? "blocks JSON が不正です"; continue; } if ((options.only && report.surface !== options.only) || (options.path && normalizePathname(report.path) !== normalizePathname(options.path))) continue; for (const [viewport, data] of Object.entries(rec(report.viewports) ?? {})) { if (options.viewport && options.viewport !== "both" && viewport !== options.viewport) continue; for (const block of arr(data?.blocks)) { if (Math.max(Math.abs(Number(block?.dy) || 0), Math.abs(Number(block?.dh) || 0)) >= threshold) panel.rows.push({ cells: { surface: report.surface ?? "—", path: report.path ?? "—", viewport, id: block?.id ?? "—", dy: block?.dy ?? 0, dh: block?.dh ?? 0 } }); } } } if (panel.status !== "FAIL") { panel.status = panel.rows.length ? "REVIEW" : "PASS"; panel.reason = panel.rows.length ? `閾値 ${threshold}px 以上の差分が残っています。承認状況は fidelity-approvals パネルを参照` : null; } panel.summary = `閾値 ${threshold}px 以上 ${panel.rows.length} 件`; cap(panel, maxRows, blockFiles.length === 1 ? blockFiles[0] : join(fidelityDir, "blocks-*.json")); } }
  { const panel = get("fidelity-pixel"); if (!blockFiles.length) missing(panel, { candidates: fidelityDirs.map((directory) => join(directory, "blocks-*.json")) }, "node scripts/fidelity-scan.mjs", outDir); else { panel.evidence = [...blockFiles.map((file) => evidence(file, outDir)), ...(paths.scan.path ? [evidence(paths.scan.path, outDir)] : paths.scan.candidates.map((path) => evidence(path, outDir)))]; const scanRead = paths.scan.path ? await readJson(paths.scan.path) : { value: [], error: null }; if (scanRead.error) invalid(panel, scanRead.error, paths.scan, outDir); const scans = arr(scanRead.value); panel.columns = cols(["surface", "面"], ["path", "path"], ["viewport", "viewport"], ["deviation", "最大差"]); for (const file of blockFiles) { const result = await readJson(file); const report = rec(result.value); if (result.error || !report) { panel.status = "FAIL"; panel.reason = result.error ?? "blocks JSON が不正です"; continue; } if ((options.only && report.surface !== options.only) || (options.path && normalizePathname(report.path) !== normalizePathname(options.path))) continue; for (const [viewport, data] of Object.entries(rec(report.viewports) ?? {})) { if (options.viewport && options.viewport !== "both" && viewport !== options.viewport) continue; const blocks = arr(data?.blocks).filter((block) => Math.max(Math.abs(Number(block?.dy) || 0), Math.abs(Number(block?.dh) || 0)) >= threshold); if (!blocks.length) continue; const pathname = normalizePathname(report.path); const sourcePath = report.path ?? "—"; const oldFile = pngPath(baselineRoot, pathname, viewport); const newFile = pngPath(join(fidelityDir, "current"), pathname, viewport); const diffFile = pngPath(join(fidelityDir, "diffs"), pathname, viewport); if (!existsSync(diffFile) && existsSync(oldFile) && existsSync(newFile)) await generateDiff(oldFile, newFile, diffFile); const deviation = Math.max(...blocks.map((block) => Math.max(Math.abs(Number(block?.dy) || 0), Math.abs(Number(block?.dh) || 0)))); panel.rows.push({ cells: { surface: report.surface ?? "—", path: sourcePath, viewport, deviation } }); panel.images.push({ id: `${report.surface}-${viewport}`, surface: report.surface, path: sourcePath, viewport, maxDeviation: deviation, scan: scans.find((item) => item?.surface === report.surface && normalizePathname(item?.path) === pathname)?.[viewport] ?? null, baseline: { path: oldFile, url: pngUrl(oldFile, outDir), exists: existsSync(oldFile) }, current: { path: newFile, url: pngUrl(newFile, outDir), exists: existsSync(newFile) }, diff: { path: diffFile, url: pngUrl(diffFile, outDir), exists: existsSync(diffFile) } }); } } panel.rows.sort((left, right) => right.cells.deviation - left.cells.deviation); panel.images.sort((left, right) => right.maxDeviation - left.maxDeviation); if (panel.status !== "FAIL") { panel.status = panel.rows.length ? "REVIEW" : "PASS"; panel.reason = panel.rows.length ? `閾値 ${threshold}px 以上の差分が残っています。承認状況は fidelity-approvals パネルを参照` : null; } panel.summary = `閾値 ${threshold}px 以上 ${panel.rows.length} 面`; cap(panel, maxRows, blockFiles.length === 1 ? blockFiles[0] : join(fidelityDir, "blocks-*.json")); } }
  { const panel = get("seo"); const gates = gate(score, ["seo", "verify-seo"]); if (!paths.seo.path) missing(panel, paths.seo, "npm run verify:seo", outDir); else { const result = await readJson(paths.seo.path); const report = rec(result.value); if (result.error || !report || !rec(report.summary) || !Array.isArray(report.nonIntentionalDifferences) || !Array.isArray(report.intentionalDifferences)) invalid(panel, result.error ?? "SEO report の summary / 差分配列が不正です", paths.seo, outDir); else { if (gates.length) applyGateStatus(panel, gates, paths.score, outDir); else { panel.status = STATUS.has(report.status) ? report.status : "NOT_RUN"; if (!report.status) { panel.reason = "scorecard 未実行のため合否は表示しません"; panel.command = SCORECARD_COMMAND; } } const summary = report.summary; panel.summary = `mismatches ${summary.mismatches ?? 0} / nonIntentional ${summary.nonIntentional ?? 0} / intentional ${summary.intentional ?? 0}`; panel.evidence = [...panel.evidence, evidence(paths.seo.path, outDir)]; panel.columns = cols(["item", "item"], ["path", "path"], ["expected", "expected"], ["actual", "actual"], ["type", "区分"]); panel.rows = reportRows(report); if (!panel.rows.length) panel.rows = [{ cells: { item: "表示できる項目が無い", path: "—", expected: "—", actual: "—", type: "—" } }]; } } }
  { const panel = get("routes"); const gates = gate(score, ["routes", "verify-routes"]); applyGateStatus(panel, gates, paths.score, outDir); const source = rec(rec(gates[0]?.detail)?.stdoutJson); const routeKeys = ["unreachable", "duplicateOutputPaths", "canonicalCollisions", "non301Rules"]; panel.columns = cols(["category", "検査項目"], ["count", "件数"], ["items", "内容"]); panel.rows = routeKeys.map((key) => { const values = arr(source?.[key]); return { cells: { category: key, count: values.length, items: values.length ? short(values, 200) : "—" } }; }); if (gates.length) panel.summary = panel.rows.map((row) => `${row.cells.category} ${row.cells.count}`).join(" / "); }
  { const panel = get("page-gates"); const gates = gate(score, ["form-parity", "t6", "stylesheets", "webvitals-preload", "verify-t6", "verify-stylesheets", "verify-webvitals-preload"]); applyGateStatus(panel, gates, paths.score, outDir); panel.columns = cols(["gate", "gate"], ["status", "状態"], ["summary", "記録値"]); panel.rows = gates.map((item) => { const value = rec(item.detail)?.stdoutJson ?? rec(item.detail)?.evidenceJson; const description = ["form-parity", "t6", "verify-t6"].includes(item.id) ? formSummary(value) : ["stylesheets", "verify-stylesheets"].includes(item.id) ? stylesheetSummary(value) : ["webvitals-preload", "verify-webvitals-preload"].includes(item.id) ? preloadSummary(value) : short(value); return { cells: { gate: item.id, status: item.status, summary: description } }; }); if (gates.length) panel.summary = `${gates.length} gate(PASS ${gates.filter((item) => item.status === "PASS").length} / FAIL ${gates.filter((item) => item.status === "FAIL").length})`; }
  { const panel = get("verify-content"); const gates = gate(score, ["verify-content"]); if (gates.length) { applyGateStatus(panel, gates, paths.score, outDir); const report = rec(rec(gates[0].detail)?.evidenceJson); panel.columns = cols(["item", "項目"], ["value", "値"]); panel.rows = report ? Object.entries(report).filter(([key]) => key !== "binding").map(([item, value]) => ({ cells: { item, value: short(value) } })) : []; if (report) panel.summary = verifySummary(report) || `${panel.rows.length} 項目`; } else if (!paths.verify.path) missing(panel, paths.verify, "npm run wpkit -- verify --old ../_scratch/archive --new ../site/out -o ../_scratch/verify", outDir); else { const result = await readJson(paths.verify.path); if (result.error || !rec(result.value)) invalid(panel, result.error ?? "verify report が不正です", paths.verify, outDir); else { panel.status = "NOT_RUN"; panel.reason = "scorecard 未実行のため合否は表示しません"; panel.command = SCORECARD_COMMAND; panel.summary = verifySummary(result.value) || "scorecard 未実行"; panel.evidence = [evidence(paths.verify.path, outDir)]; } } }
  { const panel = get("fidelity-approvals"); if (!paths.approvals.path) missing(panel, paths.approvals, SCORECARD_COMMAND, outDir); else { const result = await readJson(paths.approvals.path); const approvalsFile = rec(result.value); const surfaceRead = paths.surfaces.path ? await readJson(paths.surfaces.path) : { value: null, error: null }; if (result.error || !approvalsFile || surfaceRead.error) invalid(panel, result.error ?? surfaceRead.error ?? "fidelity approvals が不正です", result.error ? paths.approvals : paths.surfaces, outDir); else { const surfaces = arr(surfaceRead.value?.surfaces ?? surfaceRead.value); const approvals = arr(approvalsFile.approvals); applyGateStatus(panel, gate(score, ["fidelity-approvals"]), paths.score, outDir); panel.summary = `${approvals.length} 承認 / ${surfaces.length} 面`; panel.evidence = [...panel.evidence, evidence(paths.approvals.path, outDir), ...(paths.surfaces.path ? [evidence(paths.surfaces.path, outDir)] : [])]; panel.columns = cols(["surface", "surface"], ["approved", "承認"], ["by", "承認者"], ["date", "日付"]); panel.rows = (surfaces.length ? surfaces.map((surface) => { const id = surface?.surface ?? surface?.id ?? surface; const approval = approvals.find((item) => (item?.surface ?? item?.id) === id); return { cells: { surface: id ?? "—", approved: approval ? "yes" : "no", by: approval?.by ?? approval?.reviewer ?? "—", date: approval?.date ?? "—" } }; }) : approvals.map((approval) => ({ cells: { surface: approval?.surface ?? "—", approved: "yes", by: approval?.by ?? approval?.reviewer ?? "—", date: approval?.date ?? "—" } }))); applyBinding(panel, approvalsFile, current); } } }
  { const panel = get("live-review"); if (!paths.live.path) missing(panel, paths.live, "npm run live-scenarios", outDir); else { const result = await readJson(paths.live.path); const review = rec(result.value); const scenariosRead = paths.scenarios.path ? await readJson(paths.scenarios.path) : { value: null, error: null }; if (result.error || !review || scenariosRead.error) invalid(panel, result.error ?? scenariosRead.error ?? "live-review が不正です", result.error ? paths.live : paths.scenarios, outDir); else { const reviewed = arr(review.scenarios); const automatic = arr(rec(scenariosRead.value)?.scenarios ?? rec(scenariosRead.value)?.results ?? scenariosRead.value); const scenarioOutcome = new Map(); for (const item of [...reviewed, ...automatic]) scenarioOutcome.set(String(item?.name ?? item?.id ?? ""), ["fail", "failed", "failure", "error"].includes(String(item?.result ?? item?.status ?? "").toLowerCase())); const failedScenarios = [...scenarioOutcome.values()].filter(Boolean); const unresolvedFindings = arr(review.findings).filter((item) => item?.resolved !== true); applyGateStatus(panel, gate(score, ["live-review"]), paths.score, outDir); panel.summary = `reviewer ${review.reviewer ?? "未記入"} / date ${review.date ?? "日付未記入"} / シナリオ失敗 ${failedScenarios.length} 件 / 未解決 finding ${unresolvedFindings.length} 件`; panel.evidence = [...panel.evidence, evidence(paths.live.path, outDir), ...(paths.scenarios.path ? [evidence(paths.scenarios.path, outDir)] : [])]; panel.columns = cols(["kind", "種別"], ["name", "項目"], ["result", "結果"]); panel.rows = [...reviewed.map((item) => ({ cells: { kind: "review", name: item?.name ?? "—", result: item?.result ?? "—" } })), ...automatic.map((item) => ({ cells: { kind: "scenario", name: item?.name ?? item?.id ?? "—", result: item?.result ?? item?.status ?? "—" } })), ...arr(review.findings).map((item) => ({ cells: { kind: "finding", name: item?.summary ?? "—", result: item?.resolved ? "resolved" : "open" } }))]; panel.notes.push("確認用: スクロール連動 / カルーセル / フォーム全経路 / 遷移 / ホバー・ライトボックス"); applyBinding(panel, review, current); } } }
  { const panel = get("attestations"); if (!paths.attest.path) missing(panel, paths.attest, null, outDir, "証跡がありません。docs/quality-attestations.json に a11y / Lighthouse 等の計測結果を記録してください。"); else { const result = await readJson(paths.attest.path); const attestations = rec(result.value); if (result.error || !attestations) invalid(panel, result.error ?? "quality attestations が不正です", paths.attest, outDir); else { applyGateStatus(panel, attestationGates(score), paths.score, outDir); panel.summary = `${Object.keys(attestations).length} attestation`; panel.evidence = [...panel.evidence, evidence(paths.attest.path, outDir)]; panel.columns = cols(["id", "項目"], ["by", "記録者"], ["date", "日付"]); panel.rows = Object.entries(attestations).map(([id, value]) => ({ cells: { id, by: value?.by ?? "—", date: value?.date ?? "—" } })); } } }
  { const panel = get("manual-crosschecks"); if (!paths.status.path) missing(panel, paths.status, "wpkit status approve theme-crosscheck --by <名前>", outDir); else { const result = await readJson(paths.status.path); const state = rec(result.value); const gates = rec(state?.gates); if (result.error || !gates) invalid(panel, result.error ?? "migration-state.json が不正です", paths.status, outDir); else { const crosscheck = gates["theme-crosscheck"]; panel.status = "MANUAL"; panel.summary = crosscheck?.status === "approved" ? "承認記録あり（自動 PASS にはしません）" : "承認記録なし"; panel.evidence = [evidence(paths.status.path, outDir)]; panel.columns = cols(["gate", "gate"], ["status", "状態"], ["at", "記録時刻"]); panel.rows = [{ cells: { gate: "theme-crosscheck", status: crosscheck?.status ?? "未記録", at: crosscheck?.at ?? "—" } }]; } } }
  const scoreBinding = bindingOf(score?.buildArtifact); const warnings = [];
  if (scoreBinding && current && !sameBinding(scoreBinding, current)) warnings.push("scorecard の build artifact binding が現在の出力と一致しません。");
  return { root, siteDir, generatedAt: new Date().toISOString(), warnings, artifact: { recorded: scoreBinding, current, matches: sameBinding(scoreBinding, current), outDir: buildOut.path }, assetRoots, panels };
}
