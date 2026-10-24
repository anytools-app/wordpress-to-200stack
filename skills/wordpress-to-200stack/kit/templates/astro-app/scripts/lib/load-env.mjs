import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

// CLI audits run outside Vite; keep shell variables and load the same plain env files.
export function loadEnvConfig(project) {
  const mode = process.env.NODE_ENV ?? "production";
  for (const name of [`.env.${mode}.local`, ...(mode === "test" ? [] : [".env.local"]), `.env.${mode}`, ".env"]) {
    let text;
    try { text = readFileSync(resolve(project, name), "utf8"); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const [key, value] of Object.entries(parseEnv(text))) if (process.env[key] === undefined) process.env[key] = value;
  }
}
