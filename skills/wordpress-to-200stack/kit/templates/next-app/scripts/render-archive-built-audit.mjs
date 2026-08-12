import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { renderArchiveBuiltAudit } from "./lib/archive-built-audit.mjs";

const project = resolve(import.meta.dirname, "..");
const options = {
  report: resolve(process.env.WPKIT_ARCHIVE_BUILT_REPORT ?? resolve(project, "_scratch", "fidelity", "archive-built-audit.json")),
  output: resolve(process.env.WPKIT_ARCHIVE_BUILT_MARKDOWN ?? resolve(project, "docs", "archive-built-audit.md")),
  write: false,
};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index];
  if (flag === "--report") {
    if (!argv[index + 1]) throw new Error("--report requires a path");
    options.report = resolve(argv[++index]);
  } else if (flag === "--output") {
    if (!argv[index + 1]) throw new Error("--output requires a path");
    options.output = resolve(argv[++index]);
  }
  else if (flag === "--write") options.write = true;
  else if (flag !== "--check") throw new Error(`Unknown option: ${flag}`);
}
const rendered = renderArchiveBuiltAudit(JSON.parse(await readFile(options.report, "utf8")));
if (options.write) {
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, rendered);
}
else {
  let current = "";
  try { current = await readFile(options.output, "utf8"); } catch { /* A missing tracked report is a check failure. */ }
  if (current !== rendered) {
    console.error(`archive-built Markdown is stale: ${options.output}`);
    process.exitCode = 1;
  }
}
