/* Legacy command alias. The former browser-text flags are intentionally not reinterpreted as static-DOM audit flags. */
const historicalFlags = new Set(["--port", "--evidence"]);
const historical = process.argv.slice(2).find((argument) => historicalFlags.has(argument.split("=", 1)[0]));
if (historical) {
  console.error(`fidelity-text.mjs historical flag ${historical} is no longer supported. Migrate to: npm run verify:archive-built -- --config <path> [--only <surface-id>] [--report <path>]`);
  process.exitCode = 2;
} else {
  await import("./archive-built-audit.mjs");
}
