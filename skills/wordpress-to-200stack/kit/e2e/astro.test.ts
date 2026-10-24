import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { scaffoldSite } from "../src/scaffold/index.js";

const kit = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "wpkit-astro-e2e-"));
const site = join(root, "site");
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
function run(command: string, args: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync(command, args, { cwd: site, encoding: "utf8", timeout: 90_000, env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1", ...extraEnv } });
  expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(0);
  return result;
}

describe("Astro static migration", () => {
  it("builds CMS routes, protects the private key, and runs shared artifact/form/URL audits", async () => {
    await scaffoldSite({ framework: "astro", outDir: site });
    await symlink(join(kit, "templates/astro-app/node_modules"), join(site, "node_modules"), "dir");
    const sourcePath = join(site, "src/lib/content/microcms-document.ts");
    await writeFile(sourcePath, (await readFile(sourcePath, "utf8")).replace("MICROCMS_APIS: readonly string[] = []", 'MICROCMS_APIS: readonly string[] = ["cars"]'));
    await writeFile(join(site, ".env"), "PUBLIC_SITE_ORIGIN=https://example.test\nMICROCMS_SERVICE_DOMAIN=golden\nMICROCMS_API_KEY=private-fixture-secret\n");
    await writeFile(join(site, "src/data/legacy-routes.json"), JSON.stringify([{ path: "/" }, { path: "/cars/assigned-first-car/" }, { path: "/cars/raw-autop/" }]));
    await writeFile(join(site, "routing-config.jsonc"), JSON.stringify({ version: 1, rules: ["/cars/assigned-first-car", "/cars/raw-autop", "/preview"].map((source, index) => ({ id: `slash-${index}`, patternSyntax: "exact", source, destination: `${source}/`, statusCode: 301 })) }));
    run("git", ["init", "-q"]);
    run("git", ["add", "."]);
    run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Astro検証用fixture"]);
    run("npm", ["run", "format"]);
    run("npm", ["run", "lint"]);
    run("npm", ["run", "typecheck"]);
    const build = run("npm", ["run", "build"], {
      MICROCMS_SERVICE_DOMAIN: "golden",
      WPKIT_E2E_CONTENTS: join(kit, "e2e/fixtures/microcms-contents.json"),
      NODE_OPTIONS: `--import ${join(kit, "e2e/microcms-mock.mjs")}`,
    });
    expect(build.stderr).toContain("intercept hit");
    const article = await readFile(join(site, "out/cars/raw-autop/index.html"), "utf8");
    expect(article).toContain("Raw autop");
    expect(article).toContain('href="https://example.test/cars/raw-autop/"');
    const privateArticle = await readFile(join(site, "out/cars/assigned-first-car/index.html"), "utf8");
    expect(privateArticle).toContain("noindex, nofollow");
    const preview = await readFile(join(site, "out/preview/index.html"), "utf8");
    expect(preview).toContain("noindex, nofollow");
    const sitemap = await readFile(join(site, "out/sitemap.xml"), "utf8");
    expect(sitemap).toContain("https://example.test/cars/raw-autop/");
    expect(sitemap).not.toContain("assigned-first-car");
    expect(sitemap).not.toContain("/preview/");
    for (const entry of await readdir(join(site, "out/_astro"))) {
      if (entry.endsWith(".js")) expect(await readFile(join(site, "out/_astro", entry), "utf8")).not.toContain("private-fixture-secret");
    }
    run("npm", ["run", "artifact:verify"]);
    run("npm", ["run", "verify:t6"]);
    run("npm", ["run", "verify:routes"]);
    // An unconfigured SEO contract must still fail closed on Astro.
    const seo = spawnSync("npm", ["run", "verify:seo"], { cwd: site, encoding: "utf8", env: process.env });
    expect(seo.status).toBe(1);
    expect(seo.stdout).toContain("verify:seo FAIL");
  });
});
