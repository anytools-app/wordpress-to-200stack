import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { createCachedServer } from "./serve-cached.mjs";
import { installCacheRoutes } from "./lib/remote-cache.mjs";
import { artifactBinding, verifyBuildArtifact } from "./lib/build-artifact.mjs";
import { DEFAULT_VIEWPORT, evaluateExpect, formatMarkdown, formatResultsJson, mergeLiveReview, validateConfig } from "./lib/live-scenarios-core.mjs";

const project = resolve(import.meta.dirname, "..");
function usage(message) {
  if (message) console.error(message);
  console.error("Usage: node scripts/live-scenarios.mjs [--config <path>] [--json <path>] [--record] [--out-dir <dir>] [--port <n>] [--only <name>]");
  process.exitCode = 2;
}

function resolveProjectPath(path) { return isAbsolute(path) ? path : resolve(project, path); }

function parseArgs(argv) {
  const options = { config: join(project, "scenarios.config.json"), json: join(project, "_scratch", "live-scenarios", "result.json"), record: false, outDir: join(project, "out"), port: 0, only: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--record") options.record = true;
    else if (["--config", "--json", "--out-dir", "--port", "--only"].includes(flag)) {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      if (flag === "--config") options.config = resolveProjectPath(value);
      else if (flag === "--json") options.json = resolveProjectPath(value);
      else if (flag === "--out-dir") options.outDir = resolveProjectPath(value);
      else if (flag === "--only") options.only = value;
      else {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port requires an integer from 0 to 65535");
        options.port = port;
      }
    } else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

async function listen(server, port) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolveListen(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("ローカルサーバーの実ポートを取得できません");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) { await new Promise((resolveClose) => server.close(() => resolveClose())); }
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

async function stableComputed(page, selector, property, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let previous;
  let last;
  while (true) {
    last = await page.evaluate(({ selector: target, property: cssProperty }) => {
      const element = document.querySelector(target);
      if (!element) throw new Error(`selector not found: ${target}`);
      return getComputedStyle(element).getPropertyValue(cssProperty);
    }, { selector, property });
    if (last === previous) return { value: last, timedOut: false };
    if (Date.now() >= deadline) return { value: last, timedOut: true };
    previous = last;
    await wait(120);
  }
}

async function stableAttribute(page, selector, attribute, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let previous;
  let last;
  while (true) {
    last = await page.locator(selector).first().getAttribute(attribute);
    if (last === previous) return { value: last, timedOut: false };
    if (Date.now() >= deadline) return { value: last, timedOut: true };
    previous = last;
    await wait(120);
  }
}

async function stableScrollY(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let previous;
  let last;
  while (true) {
    last = await page.evaluate(() => window.scrollY);
    if (last === previous) return { value: last, timedOut: false };
    if (Date.now() >= deadline) return { value: last, timedOut: true };
    previous = last;
    await wait(120);
  }
}

async function scenarioValue(page, assertion, timeoutMs) {
  return assertion.property ? stableComputed(page, assertion.selector, assertion.property, timeoutMs) : stableAttribute(page, assertion.selector, assertion.attribute, timeoutMs);
}

function assertDetail(label, actual, expected, timedOut) {
  const result = evaluateExpect(actual, expected);
  return { pass: result.pass, detail: `${label}: ${result.detail}${timedOut ? " (安定待ちタイムアウト: 最後の値で判定)" : ""}` };
}

async function checkScrollComputed(page, scenario, timeoutMs) {
  for (const step of scenario.steps) {
    await page.evaluate((y) => window.scrollTo(0, y), step.y);
    const settled = await stableComputed(page, scenario.selector, scenario.property, timeoutMs);
    const checked = assertDetail(`scrollY=${step.y}`, settled.value, step.expect, settled.timedOut);
    if (!checked.pass) return checked;
  }
  return { pass: true, detail: `${scenario.steps.length} steps passed` };
}

async function checkFormEmptySubmit(page, scenario) {
  const submit = scenario.submitSelector ?? `${scenario.formSelector} [type=submit]`;
  await page.locator(submit).click();
  const minCount = scenario.minCount ?? 1;
  try {
    await page.waitForFunction(({ selector, minCount: minimum }) => [...document.querySelectorAll(selector)].filter((element) => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
    }).length >= minimum, { selector: scenario.errorSelector, minCount }, { timeout: 3000 });
    return { pass: true, detail: `visible errors >= ${minCount}` };
  } catch { return { pass: false, detail: `${scenario.errorSelector} の可視エラーが ${minCount} 件に達しません` }; }
}

async function checkFormSdkInit(page, scenario) {
  for (const check of scenario.checks) {
    const minCount = check.minCount ?? 1;
    try {
      await page.waitForFunction(({ selector, minCount: minimum }) => document.querySelectorAll(selector).length >= minimum, { selector: check.selector, minCount }, { timeout: 3000 });
    } catch {
      const count = await page.locator(check.selector).count();
      return { pass: false, detail: `${check.selector}: ${count} 件 (期待 ${minCount} 件以上)` };
    }
    if (check.value !== undefined) {
      const values = await page.locator(check.selector).evaluateAll((elements) => elements.map((element) => element.value));
      if (!values.every((value) => value === check.value)) return { pass: false, detail: `${check.selector}: value=${JSON.stringify(values)} (期待 ${JSON.stringify(check.value)})` };
    }
  }
  return { pass: true, detail: `${scenario.checks.length} SDK checks passed` };
}

async function waitForPath(page, expected) {
  await page.waitForURL((url) => url.pathname === expected, { timeout: 3000, waitUntil: "networkidle" });
}

async function checkNavScrollReset(page, scenario, baseUrl, timeoutMs) {
  const beforeValues = [];
  for (const route of scenario.routes) {
    await page.goto(new URL(route.from, baseUrl).href, { waitUntil: "networkidle", timeout: 25_000 });
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.evaluate((y) => window.scrollTo(0, y), route.preScrollY ?? 600);
    await page.locator(route.via).first().scrollIntoViewIfNeeded();
    const stableBefore = await stableScrollY(page, timeoutMs);
    const before = stableBefore.value;
    beforeValues.push(before);
    await page.locator(route.via).click();
    await waitForPath(page, route.to);
    await page.evaluate(async () => { await document.fonts.ready; });
    const afterNavigation = await page.evaluate(() => window.scrollY);
    if (afterNavigation !== 0) return { pass: false, detail: `${route.to}: scrollY=${afterNavigation} (期待 0)` };
    if (route.bodyCheck) {
      const settled = await stableComputed(page, route.bodyCheck.selector, route.bodyCheck.property, timeoutMs);
      const checked = assertDetail(`${route.bodyCheck.selector}.${route.bodyCheck.property}`, settled.value, route.bodyCheck.expect, settled.timedOut);
      if (!checked.pass) return checked;
    }
    await page.goBack({ waitUntil: "networkidle", timeout: 25_000 });
    try {
      await page.waitForFunction((expected) => Math.abs(window.scrollY - expected) <= 4, before, { timeout: 3000 });
    } catch {
      const restored = await page.evaluate(() => window.scrollY);
      return { pass: false, detail: `${route.from}: 戻る後 scrollY=${restored} (期待 ${before} ±4)` };
    }
  }
  return { pass: true, detail: `${scenario.routes.length} routes passed (before=${beforeValues.join(", ")})` };
}

async function checkHover(page, scenario, timeoutMs) {
  const target = scenario.target ?? scenario.selector;
  if (scenario.before !== undefined) {
    const before = await stableComputed(page, target, scenario.property, timeoutMs);
    const checked = assertDetail("hover 前", before.value, scenario.before, before.timedOut);
    if (!checked.pass) return checked;
  }
  await page.hover(scenario.selector);
  const after = await stableComputed(page, target, scenario.property, timeoutMs);
  return assertDetail("hover 後", after.value, scenario.expect, after.timedOut);
}

async function checkCarousel(page, scenario, timeoutMs) {
  const assertion = scenario.assert;
  let before;
  if (scenario.action === "autoplay-stopped") before = await scenarioValue(page, assertion, timeoutMs);
  if (scenario.action === "next-arrow" || scenario.action === "prev-arrow") {
    for (let index = 0; index < (scenario.repeat ?? 1); index += 1) await page.locator(scenario.arrowSelector).click();
  } else if (scenario.action === "dot") {
    await page.locator(scenario.dotSelector).nth(scenario.dotIndex).click();
  } else if (scenario.action === "drag") {
    const box = await page.locator(scenario.rootSelector).boundingBox();
    if (!box) return { pass: false, detail: `${scenario.rootSelector} の領域を取得できません` };
    const x = box.x + box.width / 2; const y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + scenario.dragDx, y); await page.mouse.up();
  } else await wait(scenario.waitMs ?? 4000);
  if (scenario.action !== "autoplay-stopped" && scenario.waitMs !== undefined) await wait(scenario.waitMs);
  const after = await scenarioValue(page, assertion, timeoutMs);
  if (scenario.action === "autoplay-stopped" && before.value !== after.value) return { pass: false, detail: `reduced-motion 中に値が変化: ${JSON.stringify(before.value)} → ${JSON.stringify(after.value)}` };
  return assertDetail("carousel", after.value, assertion.expect, after.timedOut || before?.timedOut);
}

async function runScenario(browser, scenario, config, baseUrl) {
  const started = Date.now();
  const viewport = scenario.viewport ?? DEFAULT_VIEWPORT;
  const reducedMotion = scenario.type === "carousel" && scenario.action === "autoplay-stopped" ? "reduce" : (scenario.reducedMotion ?? "reduce");
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion });
  const blocked = [];
  let page;
  try {
    await installCacheRoutes(context, config.remote);
    // Playwright routes run newest first. This must stay after installCacheRoutes.
    await context.route("**/*", async (route) => {
      const request = route.request();
      let url;
      try { url = new URL(request.url()); } catch { await route.continue(); return; }
      const local = ["127.0.0.1", "localhost"].includes(url.hostname);
      if (!local && !["GET", "HEAD"].includes(request.method())) {
        blocked.push({ method: request.method(), url: request.url() });
        await route.abort("blockedbyclient");
        return;
      }
      await route.fallback();
    });
    page = await context.newPage();
    await page.goto(new URL(scenario.url, baseUrl).href, { waitUntil: "networkidle", timeout: 25_000 });
    await page.evaluate(async () => { await document.fonts.ready; });
    let outcome;
    if (scenario.type === "scroll-computed") outcome = await checkScrollComputed(page, scenario, config.stableTimeoutMs);
    else if (scenario.type === "form-empty-submit") outcome = await checkFormEmptySubmit(page, scenario);
    else if (scenario.type === "form-sdk-init") outcome = await checkFormSdkInit(page, scenario);
    else if (scenario.type === "nav-scroll-reset") outcome = await checkNavScrollReset(page, scenario, baseUrl, config.stableTimeoutMs);
    else if (scenario.type === "hover") outcome = await checkHover(page, scenario, config.stableTimeoutMs);
    else outcome = await checkCarousel(page, scenario, config.stableTimeoutMs);
    if (blocked.length) outcome = { pass: false, detail: `外部送信を検出したためブロック(${blocked[0].method} ${blocked[0].url})` };
    return { name: scenario.name, type: scenario.type, url: scenario.url, result: outcome.pass ? "ok" : `ng: ${outcome.detail}`, detail: outcome.detail, durationMs: Date.now() - started };
  } catch (error) {
    const detail = blocked.length ? `外部送信を検出したためブロック(${blocked[0].method} ${blocked[0].url})` : (error instanceof Error ? error.message : String(error));
    return { name: scenario.name, type: scenario.type, url: scenario.url, result: `ng: ${detail}`, detail, durationMs: Date.now() - started };
  } finally {
    await page?.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { usage(error instanceof Error ? error.message : String(error)); return; }
  if (!existsSync(options.config)) {
    console.error(`config がありません: ${options.config}\n次をコピーして案件の TODO(案件) を埋めてください:\ncp scripts/fixtures/scenarios.config.json scenarios.config.json`);
    process.exitCode = 2;
    return;
  }
  if (!existsSync(options.outDir)) {
    console.error(`out/ がありません: ${options.outDir}\nnpm run build を実行してから再試行してください。`);
    process.exitCode = 2;
    return;
  }
  let config;
  try { config = validateConfig(JSON.parse(await readFile(options.config, "utf8"))); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 2; return; }
  const scenarios = config.scenarios.filter((scenario) => !options.only || scenario.name === options.only);
  if (options.only && scenarios.length === 0) { console.error(`--only に一致する scenario がありません: ${options.only}`); process.exitCode = 2; return; }
  const server = createCachedServer({ outDir: options.outDir });
  let browser;
  try {
    const baseUrl = await listen(server, options.port);
    browser = await chromium.launch({ headless: true });
    const results = [];
    for (const scenario of scenarios) results.push(await runScenario(browser, scenario, config, baseUrl));
    await mkdir(dirname(options.json), { recursive: true });
    await writeFile(options.json, formatResultsJson(results));
    console.log(formatMarkdown(results));
    console.log(`\nJSON: ${options.json}`);
    if (options.record) {
      const recordPath = join(project, "docs", "live-review.json");
      let existing;
      try { existing = JSON.parse(await readFile(recordPath, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const verifiedArtifact = await verifyBuildArtifact({
        outDirectory: options.outDir,
        artifactPath: resolve(process.env.WPKIT_BUILD_ARTIFACT ?? join(project, "_scratch", "build-artifact.json")),
        repository: project,
        verifySource: true,
      });
      if (!verifiedArtifact.matches) throw new Error(`build artifact mismatch: ${verifiedArtifact.reason}`);
      const merged = mergeLiveReview(existing, results, artifactBinding(verifiedArtifact.recorded), today);
      await mkdir(dirname(recordPath), { recursive: true });
      await writeFile(recordPath, `${JSON.stringify(merged, null, 2)}\n`);
      if (!existing) console.warn("docs/live-review.json を新規作成しました。reviewer と findings は人が記入してください（reviewer が空のままでは scorecard は FAIL します）。");
    }
    process.exitCode = results.some((result) => result.result !== "ok") ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  } finally {
    await browser?.close().catch(() => {});
    await closeServer(server).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
