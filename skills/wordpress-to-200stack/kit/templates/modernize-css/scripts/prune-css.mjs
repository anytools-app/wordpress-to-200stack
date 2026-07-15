/*
 * Remove only selectors that Phase 2a classified as unused. This script is
 * deliberately not wired into a build: run it after reviewing its dry-run log.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as csstree from "css-tree";

const project = resolve(import.meta.dirname, "..");
const publicDir = join(project, "public");
const auditDir = join(project, "_scratch", "css-audit");
const reportFile = join(auditDir, "report.json");
const dryRun = process.argv.slice(2).includes("--dry-run");

if (process.argv.slice(2).some((argument) => argument !== "--dry-run")) {
  console.error("Usage: node scripts/prune-css.mjs [--dry-run]");
  process.exit(1);
}

function normalizeSelector(selector) {
  return csstree.generate(csstree.parse(selector, { context: "selector" }));
}

function isKeyframes(name) {
  return name.toLowerCase().endsWith("keyframes");
}

function pruneStylesheet(source, unusedSelectors) {
  const ast = csstree.parse(source, { parseRulePrelude: true });
  const removedSelectors = [];
  let removedRules = 0;
  let keyframesDepth = 0;

  csstree.walk(ast, {
    enter(node, item, list) {
      if (node.type === "Atrule" && isKeyframes(node.name)) {
        keyframesDepth += 1;
        return;
      }
      if (keyframesDepth || node.type !== "Rule" || node.prelude?.type !== "SelectorList") return;

      for (let selectorItem = node.prelude.children.head; selectorItem;) {
        const nextItem = selectorItem.next;
        const selector = csstree.generate(selectorItem.data);
        if (unusedSelectors.has(normalizeSelector(selector))) {
          removedSelectors.push(selector);
          node.prelude.children.remove(selectorItem);
        }
        selectorItem = nextItem;
      }
      if (node.prelude.children.isEmpty) {
        list.remove(item);
        removedRules += 1;
      }
    },
    leave(node, item, list) {
      if (node.type === "Atrule" && isKeyframes(node.name)) {
        keyframesDepth -= 1;
        return;
      }
      // Other at-rules remain intact. @media is the sole exception because an
      // empty media block has no effect once its style rules have been removed.
      if (node.type === "Atrule" && node.name.toLowerCase() === "media" && node.block?.children?.isEmpty) {
        list.remove(item);
      }
    },
  });

  return { css: csstree.generate(ast), removedSelectors, removedRules };
}

const report = JSON.parse(await readFile(reportFile, "utf8"));
const files = [];

for (const record of report.files) {
  if (!record.unusedSelectors?.length) continue;
  // report.json stores public URLs (for example /vendor/...); CSS itself is
  // deliberately read and, on a non-dry run, written under public/.
  const file = resolve(publicDir, `.${record.file}`);
  if (!file.startsWith(`${publicDir}/`)) throw new Error(`Invalid public CSS path: ${record.file}`);
  const source = await readFile(file, "utf8");
  const unusedSelectors = new Set(record.unusedSelectors.map(({ selector }) => normalizeSelector(selector)));
  const result = pruneStylesheet(source, unusedSelectors);
  const beforeBytes = Buffer.byteLength(source);
  const afterBytes = Buffer.byteLength(result.css);

  if (!dryRun && result.removedSelectors.length) await writeFile(file, result.css);
  files.push({
    file: record.file,
    removedSelectors: result.removedSelectors,
    removedRules: result.removedRules,
    beforeBytes,
    afterBytes,
    bytesRemoved: beforeBytes - afterBytes,
  });
}

const totals = files.reduce((sum, file) => ({
  files: sum.files + 1,
  removedSelectors: sum.removedSelectors + file.removedSelectors.length,
  removedRules: sum.removedRules + file.removedRules,
  beforeBytes: sum.beforeBytes + file.beforeBytes,
  afterBytes: sum.afterBytes + file.afterBytes,
  bytesRemoved: sum.bytesRemoved + file.bytesRemoved,
}), { files: 0, removedSelectors: 0, removedRules: 0, beforeBytes: 0, afterBytes: 0, bytesRemoved: 0 });

const log = { generatedAt: new Date().toISOString(), dryRun, totals, files };
await mkdir(auditDir, { recursive: true });
await writeFile(join(auditDir, "prune-log.json"), `${JSON.stringify(log, null, 2)}\n`);
console.log(JSON.stringify(log, null, 2));
