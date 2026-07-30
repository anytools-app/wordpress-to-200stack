import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export const DEFAULT_REMOTE = {
  hosts: ["fonts.googleapis.com", "fonts.gstatic.com"],
  passthrough: ["youtube.com", "ytimg.com", "googlevideo.com"],
};
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
export const DEFAULT_STABLE_TIMEOUT_MS = 3000;

const TYPES = new Set(["scroll-computed", "form-empty-submit", "form-sdk-init", "nav-scroll-reset", "hover", "carousel"]);
const CAROUSEL_ACTIONS = new Set(["next-arrow", "prev-arrow", "dot", "drag", "autoplay-stopped"]);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const pathValue = (value) => {
  if (!nonEmpty(value) || !value.startsWith("/")) return false;
  try { return new URL(value, "http://local.invalid").origin === "http://local.invalid"; } catch { return false; }
};

function invalid(messages) {
  throw new Error(`scenarios.config.json が不正です:\n${messages.map((message) => `- ${message}`).join("\n")}`);
}

function expectValid(value, label, messages) {
  if (typeof value === "string") return;
  const item = record(value);
  if (!item) { messages.push(`${label} は文字列または expect オブジェクトにしてください`); return; }
  const keys = Object.keys(item);
  if (keys.length !== 1 || !["not", "matches", "oneOf", "contains"].includes(keys[0] ?? "")) {
    messages.push(`${label} は not / matches / oneOf / contains のいずれか1つにしてください`);
    return;
  }
  if ("matches" in item) {
    if (!nonEmpty(item.matches)) messages.push(`${label}.matches は正規表現文字列にしてください`);
    else try { new RegExp(item.matches); } catch { messages.push(`${label}.matches は有効な正規表現にしてください`); }
  }
  if ("oneOf" in item && (!Array.isArray(item.oneOf) || item.oneOf.length === 0)) messages.push(`${label}.oneOf は空でない配列にしてください`);
  if ("contains" in item && typeof item.contains !== "string") messages.push(`${label}.contains は文字列にしてください`);
}

function selector(value, label, messages, required = true) {
  if (value === undefined && !required) return;
  if (!nonEmpty(value)) messages.push(`${label} は空でない selector にしてください`);
}

function positiveCount(value, label, messages, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) messages.push(`${label} は ${minimum} 以上の整数にしてください`);
}

function validateBodyCheck(value, label, messages) {
  const item = record(value);
  if (!item) { messages.push(`${label} はオブジェクトにしてください`); return; }
  selector(item.selector, `${label}.selector`, messages);
  if (!nonEmpty(item.property)) messages.push(`${label}.property は空でない CSS property にしてください`);
  expectValid(item.expect, `${label}.expect`, messages);
}

function validateScenario(item, index, messages) {
  const label = `scenarios[${index}]`;
  if (!record(item)) { messages.push(`${label} はオブジェクトにしてください`); return; }
  if (!nonEmpty(item.name)) messages.push(`${label}.name は空でない文字列にしてください`);
  if (!TYPES.has(item.type)) { messages.push(`${label}.type は ${[...TYPES].join(" / ")} のいずれかにしてください`); return; }
  if (!pathValue(item.url)) messages.push(`${label}.url は / で始まるパスにしてください`);
  if (item.viewport !== undefined) {
    const viewport = record(item.viewport);
    if (!viewport || !Number.isInteger(viewport.width) || viewport.width < 1 || !Number.isInteger(viewport.height) || viewport.height < 1) messages.push(`${label}.viewport は正の width / height を指定してください`);
  }
  if (item.reducedMotion !== undefined && !["reduce", "no-preference"].includes(item.reducedMotion)) messages.push(`${label}.reducedMotion は reduce または no-preference にしてください`);

  if (item.type === "scroll-computed") {
    selector(item.selector, `${label}.selector`, messages);
    if (!nonEmpty(item.property)) messages.push(`${label}.property は空でない CSS property にしてください`);
    if (!Array.isArray(item.steps) || item.steps.length === 0) messages.push(`${label}.steps は空でない配列にしてください`);
    else item.steps.forEach((step, stepIndex) => {
      const row = record(step);
      if (!row) { messages.push(`${label}.steps[${stepIndex}] はオブジェクトにしてください`); return; }
      if (typeof row.y !== "number" || !Number.isFinite(row.y)) messages.push(`${label}.steps[${stepIndex}].y は数値にしてください`);
      expectValid(row.expect, `${label}.steps[${stepIndex}].expect`, messages);
    });
  } else if (item.type === "form-empty-submit") {
    selector(item.formSelector, `${label}.formSelector`, messages);
    selector(item.submitSelector, `${label}.submitSelector`, messages, false);
    selector(item.errorSelector, `${label}.errorSelector`, messages);
    if (item.minCount !== undefined) positiveCount(item.minCount, `${label}.minCount`, messages, 1);
  } else if (item.type === "form-sdk-init") {
    if (!Array.isArray(item.checks) || item.checks.length === 0) messages.push(`${label}.checks は空でない配列にしてください`);
    else item.checks.forEach((check, checkIndex) => {
      const row = record(check);
      if (!row) { messages.push(`${label}.checks[${checkIndex}] はオブジェクトにしてください`); return; }
      selector(row.selector, `${label}.checks[${checkIndex}].selector`, messages);
      if (row.minCount !== undefined) positiveCount(row.minCount, `${label}.checks[${checkIndex}].minCount`, messages, 1);
      if (row.value !== undefined && typeof row.value !== "string") messages.push(`${label}.checks[${checkIndex}].value は文字列にしてください`);
    });
  } else if (item.type === "nav-scroll-reset") {
    if (!Array.isArray(item.routes) || item.routes.length === 0) messages.push(`${label}.routes は空でない配列にしてください`);
    else item.routes.forEach((route, routeIndex) => {
      const row = record(route);
      if (!row) { messages.push(`${label}.routes[${routeIndex}] はオブジェクトにしてください`); return; }
      for (const key of ["from", "to"]) if (!pathValue(row[key])) messages.push(`${label}.routes[${routeIndex}].${key} は / で始まるパスにしてください`);
      selector(row.via, `${label}.routes[${routeIndex}].via`, messages);
      if (row.preScrollY !== undefined && (typeof row.preScrollY !== "number" || !Number.isFinite(row.preScrollY))) messages.push(`${label}.routes[${routeIndex}].preScrollY は数値にしてください`);
      if (row.bodyCheck !== undefined) validateBodyCheck(row.bodyCheck, `${label}.routes[${routeIndex}].bodyCheck`, messages);
    });
  } else if (item.type === "hover") {
    selector(item.selector, `${label}.selector`, messages);
    selector(item.target, `${label}.target`, messages, false);
    if (!nonEmpty(item.property)) messages.push(`${label}.property は空でない CSS property にしてください`);
    if (item.before !== undefined) expectValid(item.before, `${label}.before`, messages);
    expectValid(item.expect, `${label}.expect`, messages);
  } else if (item.type === "carousel") {
    selector(item.rootSelector, `${label}.rootSelector`, messages);
    if (!CAROUSEL_ACTIONS.has(item.action)) messages.push(`${label}.action は ${[...CAROUSEL_ACTIONS].join(" / ")} のいずれかにしてください`);
    if (["next-arrow", "prev-arrow"].includes(item.action)) selector(item.arrowSelector, `${label}.arrowSelector`, messages);
    if (item.action === "dot") { selector(item.dotSelector, `${label}.dotSelector`, messages); positiveCount(item.dotIndex, `${label}.dotIndex`, messages, 0); }
    if (item.action === "drag" && (typeof item.dragDx !== "number" || !Number.isFinite(item.dragDx))) messages.push(`${label}.dragDx は数値にしてください`);
    if (item.repeat !== undefined) positiveCount(item.repeat, `${label}.repeat`, messages, 1);
    if (item.waitMs !== undefined) positiveCount(item.waitMs, `${label}.waitMs`, messages, 0);
    const assertion = record(item.assert);
    if (!assertion) messages.push(`${label}.assert はオブジェクトにしてください`);
    else {
      selector(assertion.selector, `${label}.assert.selector`, messages);
      if ((!nonEmpty(assertion.property) && !nonEmpty(assertion.attribute)) || (nonEmpty(assertion.property) && nonEmpty(assertion.attribute))) messages.push(`${label}.assert は property または attribute の片方だけを指定してください`);
      expectValid(assertion.expect, `${label}.assert.expect`, messages);
    }
  }
}

/** Validate and normalize a declarative live-review scenario config. */
export function validateConfig(value) {
  const config = record(value);
  const messages = [];
  if (!config) invalid(["トップレベルはオブジェクトにしてください"]);
  if (!Array.isArray(config.scenarios) || config.scenarios.length === 0) messages.push("scenarios は空でない配列にしてください");
  if (config.stableTimeoutMs !== undefined && (!Number.isInteger(config.stableTimeoutMs) || config.stableTimeoutMs < 0)) messages.push("stableTimeoutMs は0以上の整数にしてください");
  if (config.remote !== undefined) {
    const remote = record(config.remote);
    if (!remote) messages.push("remote はオブジェクトにしてください");
    else for (const key of ["hosts", "passthrough"]) if (remote[key] !== undefined && (!Array.isArray(remote[key]) || !remote[key].every(nonEmpty))) messages.push(`remote.${key} は文字列配列にしてください`);
  }
  const names = new Set();
  (Array.isArray(config.scenarios) ? config.scenarios : []).forEach((scenario, index) => {
    validateScenario(scenario, index, messages);
    if (record(scenario) && nonEmpty(scenario.name)) {
      if (names.has(scenario.name)) messages.push(`scenarios[${index}].name (${scenario.name}) は重複しています`);
      names.add(scenario.name);
    }
  });
  if (messages.length) invalid(messages);
  return {
    ...config,
    stableTimeoutMs: config.stableTimeoutMs ?? DEFAULT_STABLE_TIMEOUT_MS,
    remote: { hosts: config.remote?.hosts ?? DEFAULT_REMOTE.hosts, passthrough: config.remote?.passthrough ?? DEFAULT_REMOTE.passthrough },
  };
}

export function evaluateExpect(actual, expected) {
  let pass = false;
  let expectedDescription;
  if (typeof expected === "string") { pass = actual === expected; expectedDescription = JSON.stringify(expected); }
  else if (expected && typeof expected === "object" && "not" in expected) { pass = actual !== expected.not; expectedDescription = `not ${JSON.stringify(expected.not)}`; }
  else if (expected && typeof expected === "object" && "matches" in expected) {
    try { pass = new RegExp(expected.matches).test(String(actual)); } catch { pass = false; }
    expectedDescription = `matches /${expected.matches}/`;
  } else if (expected && typeof expected === "object" && "oneOf" in expected) { pass = Array.isArray(expected.oneOf) && expected.oneOf.includes(actual); expectedDescription = `oneOf ${JSON.stringify(expected.oneOf)}`; }
  else if (expected && typeof expected === "object" && "contains" in expected) { pass = String(actual).includes(expected.contains); expectedDescription = `contains ${JSON.stringify(expected.contains)}`; }
  else { expectedDescription = JSON.stringify(expected); }
  return { pass, detail: `actual=${JSON.stringify(actual)} expected=${expectedDescription}` };
}

function displayPath(path) { return path.split("\\").join("/"); }

/** Kept byte-for-byte compatible with scorecard's hashBuildOutput algorithm. */
export async function hashBuildOutput(outDir) {
  if (!existsSync(outDir)) return null;
  const output = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) output.push(fullPath);
    }
  }
  await visit(outDir);
  const hash = createHash("sha256");
  for (const path of output.sort((left, right) => displayPath(relative(outDir, left)).localeCompare(displayPath(relative(outDir, right))))) {
    const relativePath = displayPath(relative(outDir, path));
    const fileHash = createHash("sha256").update(await readFile(path)).digest("hex");
    hash.update(relativePath).update("\0").update(fileHash);
  }
  return hash.digest("hex");
}

export function mergeLiveReview(existing, scenarioResults, buildHash, today) {
  const current = record(existing);
  const base = current ? { ...current } : { date: today, reviewer: "", findings: [] };
  const oldScenarios = Array.isArray(base.scenarios) ? base.scenarios : [];
  const replacements = scenarioResults.map((item) => ({ name: item.name, result: item.result, type: item.type, url: item.url, recordedAt: today }));
  const byName = new Map(replacements.map((item) => [item.name, item]));
  base.scenarios = oldScenarios.map((item) => record(item) && typeof item.name === "string" && byName.has(item.name) ? byName.get(item.name) : item);
  const existingNames = new Set(oldScenarios.map((item) => record(item)?.name).filter((name) => typeof name === "string"));
  for (const replacement of replacements) if (!existingNames.has(replacement.name)) base.scenarios.push(replacement);
  base.build = buildHash;
  return base;
}

const markdownCell = (value) => String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", "<br>");
export function formatMarkdown(results) {
  const lines = ["| name | type | url | result | detail |", "| --- | --- | --- | --- | --- |"];
  for (const item of results) lines.push(`| ${markdownCell(item.name)} | ${markdownCell(item.type)} | ${markdownCell(item.url)} | ${markdownCell(item.result)} | ${markdownCell(item.detail)} |`);
  const passed = results.filter((item) => item.result === "ok").length;
  lines.push(`\n合計: ${passed}/${results.length} pass`);
  return lines.join("\n");
}

export function formatResultsJson(results) {
  return `${JSON.stringify(results.map(({ name, type, url, result, detail, durationMs }) => ({ name, type, url, result, detail, durationMs })), null, 2)}\n`;
}
