import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

import mapping from "./fixtures/golden-mapping.config.js";
import { analyzeWxr, writeAnalysis } from "../src/analyze/index.js";
import { parseWxr } from "../src/core/wxr.js";
import { importDocuments } from "../src/microcms/import.js";
import { writeSchemas } from "../src/microcms/schema.js";
import { collectReferencedMediaUrls, transformMedia } from "../src/media/transform.js";
import { parseConfigFile } from "../src/parse/index.js";
import { runScorecard } from "../src/scorecard/index.js";
import { approveStatusGate, GATE_IDS, getStatus, initStatus } from "../src/status/index.js";
import { verifySite } from "../src/verify/index.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const expectedDir = join(fixtures, "expected");
const kitDir = fileURLToPath(new URL("../", import.meta.url));
const scratchRoot = join(kitDir, "_scratch");
await mkdir(scratchRoot, { recursive: true });
const workDir = await mkdtemp(join(scratchRoot, "wpkit-e2e-"));
const analysisDir = join(workDir, "analysis");
const irDir = join(workDir, "ir");
const schemaDir = join(workDir, "microcms-schema");
const siteDir = join(workDir, "site");
const templateDir = fileURLToPath(new URL("../templates/next-app/", import.meta.url));
const mockInjector = fileURLToPath(new URL("./microcms-mock.mjs", import.meta.url));
const readJson = async <T>(name: string): Promise<T> => JSON.parse(await readFile(join(expectedDir, name), "utf8")) as T;
const noVolatile = (value: unknown): unknown => Array.isArray(value)
  ? value.map(noVolatile)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "updatedAt" && key !== "createdAt").map(([key, child]) => [key, noVolatile(child)]))
    : value;
const hasNull = (value: unknown): boolean => value === null || (Array.isArray(value) ? value.some(hasNull) : Boolean(value && typeof value === "object" && Object.values(value).some(hasNull)));
const response = (body: unknown = {}, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const cacheKey = (url: string): string => createHash("sha1").update(url).digest("hex");
type MicroCmsCall = { method: string; url: string; body?: unknown };
let microCmsCalls: MicroCmsCall[] = [];
async function cacheImage(cacheDir: string, url: string, body: Buffer): Promise<void> {
  const key = cacheKey(url);
  await Promise.all([writeFile(join(cacheDir, `${key}.bin`), body), writeFile(join(cacheDir, `${key}.json`), JSON.stringify({ url, status: 200, contentType: "image/jpeg" }))]);
}
async function outputIndexRoutes(root: string, directory = root, routes: string[] = []): Promise<string[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await outputIndexRoutes(root, path, routes);
    else if (entry.name === "index.html") {
      const parent = relative(root, dirname(path)).split("/").filter(Boolean);
      routes.push(parent.length ? `/${parent.join("/")}/` : "/");
    }
  }
  return routes.sort();
}

afterAll(async () => { await rm(workDir, { recursive: true, force: true }); });

describe("golden migration E2E (steps 1-8)", () => {
  it("1. analyzes the WXR into the checked-in census and SCF expectation", async () => {
    const wxr = parseWxr(await readFile(join(fixtures, "golden-wxr.xml"), "utf8"));
    const result = analyzeWxr(wxr);
    await writeAnalysis(result, analysisDir);
    const [expectedCensus, expectedScf] = await Promise.all([readJson("census.json"), readJson("scf-definitions.json")]);
    expect(result.census).toEqual(expectedCensus);
    expect(result.scfDefinitions).toEqual(expectedScf);
    expect(JSON.parse(await readFile(join(analysisDir, "census.json"), "utf8"))).toEqual(expectedCensus);
    expect(JSON.parse(await readFile(join(analysisDir, "scf-definitions.json"), "utf8"))).toEqual(expectedScf);
  });

  it("2. parses the config, validates routes, and applies wpautop to raw text", async () => {
    const result = await parseConfigFile(join(fixtures, "golden-mapping.config.ts"), irDir);
    const expected = await readJson<{ routes: number; rawAutop: { paragraphs: number; breaks: number } }>("parse.json");
    const validation = JSON.parse(await readFile(join(irDir, "validation-report.json"), "utf8")) as { errors: unknown[] };
    const raw = result.documents.find((document) => document.source.wpId === 12)!;
    expect(validation.errors).toHaveLength(0);
    expect(JSON.parse(await readFile(join(irDir, "routes.json"), "utf8"))).toHaveLength(expected.routes);
    expect({ routes: result.routes.length, rawAutop: { paragraphs: (raw.content.legacyBodyHtml.match(/<p[ >]/g) ?? []).length, breaks: (raw.content.legacyBodyHtml.match(/<br ?\/?>(?!<)/g) ?? []).length } }).toEqual(expected);
  });

  it("3. writes deterministic microCMS schemas matching the checked-in field expectation", async () => {
    const schemas = await writeSchemas(mapping, schemaDir);
    const expected = await readJson<Record<string, unknown>>("schema.json");
    expect(noVolatile(schemas)).toEqual(noVolatile(expected));
    for (const api of Object.keys(schemas)) expect(noVolatile(JSON.parse(await readFile(join(schemaDir, `${api}.schema.json`), "utf8")))).toEqual(noVolatile((expected as Record<string, unknown>)[api]));
  });

  it("4. imports through an injected microCMS mock including PATCH fallback and provisional IDs", async () => {
    const calls: MicroCmsCall[] = [];
    const result = await importDocuments({ irDir, config: mapping, serviceDomain: "golden", apiKey: "test", concurrency: 1, sleep: async () => undefined, fetchImpl: async (_url, init) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(_url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (method === "POST") return response({ id: "assigned-first-car" });
      if (method === "PUT") return response({ message: "Content already exists" }, 400);
      if (method === "GET") return response({ totalCount: 3 });
      return response();
    } });
    const expected = await readJson<{ total: number; uploaded: number; provisional: number; autoAssigned: number; routes: number }>("import.json");
    expect({ total: result.total, uploaded: result.uploaded, provisional: result.provisional, autoAssigned: result.autoAssigned, routes: JSON.parse(await readFile(join(irDir, "routes.json"), "utf8")).length }).toEqual(expected);
    expect(result.failures).toEqual([]);
    expect(calls.some((call) => call.method === "POST")).toBe(true);
    expect(calls.filter((call) => call.method === "PATCH")).not.toHaveLength(0);
    expect(calls.filter((call) => call.body).every((call) => !hasNull(call.body))).toBe(true);
    await expect(stat(join(irDir, "import-state.json"))).resolves.toBeDefined();
    await expect(stat(join(irDir, "contentid-map.json"))).resolves.toBeDefined();
    microCmsCalls = calls;
  });

  it("5. transforms every referenced image from a pre-filled remote cache", async () => {
    const cacheDir = join(workDir, "remote-cache");
    const outDir = join(workDir, "site", "public", "media");
    const manifestPath = join(workDir, "site", "src", "data", "media-manifest.json");
    await mkdir(cacheDir, { recursive: true });
    const documents = (await readFile(join(irDir, "documents.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as object);
    const urls = collectReferencedMediaUrls(documents);
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#336699" } }).jpeg().toBuffer();
    await Promise.all(urls.map((url) => cacheImage(cacheDir, url, image)));
    const result = await transformMedia({ irDir, cacheDir, outDir, manifestPath });
    const expected = await readJson<{ missing: number; entries: number }>("media.json");
    expect({ missing: result.manifest.missing.length, entries: Object.keys(result.entries).length }).toEqual(expected);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(result.manifest);
  });

  it("6. verifies all archived URLs against the static dist fixture", async () => {
    const result = await verifySite({ oldDir: join(fixtures, "archive"), newTarget: join(fixtures, "expected-out"), reportDir: join(workDir, "verify-report") });
    expect(result.missing).toEqual([]);
    expect(result.metaMismatches).toEqual([]);
    expect(result.brokenLinks).toEqual([]);
  });

  it("7. derives the exact twelve status gates from E2E evidence", async () => {
    await Promise.all([
      cp(analysisDir, join(workDir, "_scratch", "analysis"), { recursive: true }),
      cp(irDir, join(workDir, "_scratch", "ir"), { recursive: true }),
      cp(schemaDir, join(workDir, "_scratch", "microcms-schema"), { recursive: true }),
      cp(join(fixtures, "archive"), join(workDir, "_scratch", "archive"), { recursive: true }),
    ]);
    await initStatus({ cwd: workDir });
    for (const gate of ["mapping", "media", "schema-import"] as const) await approveStatusGate({ cwd: workDir, gate, by: "golden-e2e" });
    const status = await getStatus({ cwd: workDir });
    const expected = await readJson<Record<string, string>>("status.json");
    expect(GATE_IDS).toHaveLength(12);
    expect(Object.fromEntries(status!.gates.map((gate) => [gate.id, gate.status]))).toEqual(expected);
  });

  it("8. builds the configured template through a worker-injected microCMS mock, then verifies, scores, and finalizes status", async () => {
    const fixtureContents = await readJson<Record<string, Array<Record<string, unknown>>>>("../microcms-contents.json");
    const [documents, contentIdMap] = await Promise.all([
      readFile(join(irDir, "documents.ndjson"), "utf8").then((source) => source.trim().split("\n").map((line) => JSON.parse(line) as { api: string; contentId: string; content: { title: string; publishedAt: string } })),
      readFile(join(irDir, "contentid-map.json"), "utf8").then((source) => JSON.parse(source) as Record<string, string>),
    ]);
    const uploaded = microCmsCalls.filter((call) => call.body && (call.method === "POST" || call.method === "PUT"));
    const relationPatches = microCmsCalls.filter((call) => call.method === "PATCH" && call.body && Object.keys(call.body as Record<string, unknown>).length === 1);
    const expectedContents: Record<string, Array<Record<string, unknown>>> = {};
    for (const call of uploaded) {
      const body = call.body as Record<string, unknown>;
      const document = documents.find((item) => item.content.title === body.title);
      expect(document, `captured upload has no IR document for ${String(body.title)}`).toBeDefined();
      const id = contentIdMap[document!.contentId] ?? document!.contentId;
      const relation = relationPatches.find((patch) => patch.url.endsWith(`/${encodeURIComponent(id)}`));
      const timestamp = document!.content.publishedAt.replace(" ", "T").replace(/$/, ".000Z");
      const records = expectedContents[document!.api] ?? (expectedContents[document!.api] = []);
      records.push({ id, createdAt: timestamp, updatedAt: timestamp, ...body, ...(relation?.body as Record<string, unknown> | undefined) });
    }
    expect(fixtureContents).toEqual(expectedContents);

    await cp(templateDir, siteDir, {
      recursive: true,
      filter: (source) => !source.split("/").some((part) => ["node_modules", ".next", "out", "_scratch"].includes(part)),
    });
    await symlink(join(templateDir, "node_modules"), join(siteDir, "node_modules"), "dir");
    const documentPath = join(siteDir, "src", "lib", "content", "microcms-document.ts");
    const source = await readFile(documentPath, "utf8");
    await writeFile(documentPath, source.replace("export const MICROCMS_APIS: readonly string[] = [];", "export const MICROCMS_APIS: readonly string[] = [\"cars\", \"pages\"];"));
    await writeFile(join(siteDir, "src", "data", "legacy-routes.json"), JSON.stringify([
      { path: "/" },
      { path: "/about/" },
      { path: "/cars/raw-autop/" },
    ], null, 2));
    const nextConfigPath = join(siteDir, "next.config.ts");
    await writeFile(nextConfigPath, (await readFile(nextConfigPath, "utf8")).replace("const nextConfig: NextConfig = {", `const nextConfig: NextConfig = {\n  turbopack: { root: ${JSON.stringify(kitDir)} },`));
    await mkdir(join(siteDir, "src", "app", "[...path]"), { recursive: true });
    await writeFile(join(siteDir, "src", "app", "[...path]", "page.tsx"), `import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ContentRepository } from "@/lib/repository";
import { templateFor } from "@/templates/registry";
export const dynamicParams = false;
type Props = { params: Promise<{ path: string[] }> };
async function documentFor(path: string[]) { return (await ContentRepository.load()).findByRoute(path); }
export async function generateStaticParams() { return (await ContentRepository.load()).allRoutes().map((route) => ({ path: route.segments })); }
export async function generateMetadata({ params }: Props): Promise<Metadata> { const document = await documentFor((await params).path); return document ? { title: document.seo?.title || document.content.title, description: document.seo?.description || document.content.excerpt || undefined, alternates: { canonical: document.route.path }, robots: document.seo?.noindex ? { index: false, follow: false } : undefined } : {}; }
export default async function Page({ params }: Props) { const document = await documentFor((await params).path); if (!document) return notFound(); const Template = templateFor(document.api, document.kind); return <Template document={document} />; }
`);
    await mkdir(join(siteDir, "src", "app", "about"), { recursive: true });
    await writeFile(join(siteDir, "src", "app", "about", "page.tsx"), `import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ContentRepository } from "@/lib/repository";
import { templateFor } from "@/templates/registry";
async function about() { return (await ContentRepository.load()).findByContentId("about"); }
export async function generateMetadata(): Promise<Metadata> { const document = await about(); return document ? { title: document.seo?.title || document.content.title, alternates: { canonical: "/about/" } } : {}; }
export default async function About() { const document = await about(); if (!document) return notFound(); const Template = templateFor(document.api, document.kind); return <Template document={document} />; }
`);
    const copiedFidelityConfig = JSON.parse(await readFile(join(siteDir, "fidelity-audit.config.json"), "utf8")) as Record<string, unknown>;
    expect(copiedFidelityConfig).toMatchObject({ archiveDirectory: "../_scratch/archive", inventory: "../_scratch/archive/inventory.json", mediaMap: "../_scratch/media-map.json" });
    const fidelityAuditConfig = {
      ...copiedFidelityConfig,
      origin: "https://example.test",
      internalHosts: ["example.test"],
      surfaceRules: [{ id: "golden-document", route: "^/", archive: "body", built: "body" }],
    };
    await writeFile(join(siteDir, "fidelity-audit.config.json"), JSON.stringify(fidelityAuditConfig, null, 2));
    for (const args of [["init", "--quiet"], ["add", "."]]) {
      const git = spawnSync("git", args, { cwd: siteDir, encoding: "utf8" });
      expect(git.status, `${git.stdout ?? ""}\n${git.stderr ?? ""}`).toBe(0);
    }
    const commit = spawnSync("git", ["-c", "user.name=wpkit-e2e", "-c", "user.email=wpkit@example.invalid", "commit", "--quiet", "-m", "golden site fixture"], { cwd: siteDir, encoding: "utf8" });
    expect(commit.status, `${commit.stdout ?? ""}\n${commit.stderr ?? ""}`).toBe(0);

    const contentsPath = join(fixtures, "microcms-contents.json");
    const build = spawnSync(process.execPath, ["scripts/build-app.mjs"], {
      cwd: siteDir,
      encoding: "utf8",
      timeout: 300_000,
      env: {
        ...process.env,
        MICROCMS_SERVICE_DOMAIN: "golden",
        MICROCMS_API_KEY: "golden-key",
        NEXT_PUBLIC_SITE_ORIGIN: "https://example.test",
        WPKIT_E2E_CONTENTS: contentsPath,
        NODE_OPTIONS: `--import ${mockInjector}`,
      },
    });
    const buildLog = `${build.stdout ?? ""}\n${build.stderr ?? ""}`;
    expect(build.error).toBeUndefined();
    expect(build.status, buildLog).toBe(0);
    await expect(stat(join(siteDir, "out", "index.html"))).resolves.toBeDefined();
    expect(buildLog).toMatch(/\[wpkit-e2e\] intercept hit pid=\d+ ipc=true api=/);
    const buildArtifact = JSON.parse(await readFile(join(siteDir, "_scratch", "build-artifact.json"), "utf8")) as { buildHash: string; fileCount: number; bytes: number; source: unknown };
    const buildBinding = { buildHash: buildArtifact.buildHash, fileCount: buildArtifact.fileCount, bytes: buildArtifact.bytes, source: buildArtifact.source };

    const parityArchive = join(workDir, "_scratch", "archive");
    const parityRoutes = await outputIndexRoutes(join(siteDir, "out"));
    for (const route of parityRoutes) {
      const builtPath = route === "/" ? join(siteDir, "out", "index.html") : join(siteDir, "out", ...route.slice(1, -1).split("/"), "index.html");
      const archivePage = join(parityArchive, "pages", encodeURIComponent(route), "page.html");
      await mkdir(dirname(archivePage), { recursive: true });
      await writeFile(archivePage, await readFile(builtPath));
    }
    await writeFile(join(parityArchive, "inventory.json"), JSON.stringify({ urls: parityRoutes.map((route) => ({ url: `https://example.test${route}`, status: 200 })) }, null, 2));
    await mkdir(join(siteDir, "_scratch", "fidelity"), { recursive: true });
    await writeFile(join(workDir, "_scratch", "media-map.json"), "{}\n");

    const verification = await verifySite({ oldDir: join(fixtures, "archive"), newTarget: join(siteDir, "out"), reportDir: join(workDir, "_scratch", "verify-site") });
    expect(verification.missing).toEqual([]);
    expect(verification.metaMismatches).toEqual([]);
    expect(verification.brokenLinks).toEqual([]);

    await Promise.all([
      cp(join(fixtures, "golden-scorecard.config.json"), join(workDir, "scorecard.config.json")),
      mkdir(join(workDir, "docs"), { recursive: true }),
      mkdir(join(workDir, "_scratch", "fidelity"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(workDir, "docs", "fidelity-approvals.json"), JSON.stringify({ approvals: [{ surface: "/", date: "2020-01-05", by: "golden-e2e", measurements: { source: "site/_scratch/fidelity/archive-built-audit.json" } }, { surface: "/about/", date: "2020-01-05", by: "golden-e2e", measurements: { source: "site/_scratch/fidelity/archive-built-audit.json" } }, { surface: "/cars/raw-autop/", date: "2020-01-05", by: "golden-e2e", measurements: { source: "site/_scratch/fidelity/archive-built-audit.json" } }] }, null, 2)),
      writeFile(join(workDir, "_scratch", "fidelity", "surfaces-summary.json"), JSON.stringify({ surfaces: [{ surface: "/" }, { surface: "/about/" }, { surface: "/cars/raw-autop/" }] }, null, 2)),
      writeFile(join(workDir, "docs", "quality-attestations.json"), JSON.stringify({ "static-export": { date: "2020-01-05", by: "golden-e2e", binding: buildBinding, values: { network: false } } }, null, 2)),
    ]);
    const scorecardPath = join(workDir, "scorecard.config.json");
    const scorecard = await runScorecard({ configPath: scorecardPath });
    expect(scorecard.overall, JSON.stringify(scorecard.gates, null, 2)).toBe("PASS");

    const mutationPath = join(siteDir, "out", "index.html");
    const originalOutput = await readFile(mutationPath, "utf8");
    const mutatedOutput = originalOutput
      .replace(/<body([^>]*)>/i, '<body$1 title="golden-e2e-mutation">')
      .replace(/<\/main>/i, "golden fidelity mutation</main>");
    expect(mutatedOutput).not.toBe(originalOutput);
    await writeFile(mutationPath, mutatedOutput);
    try {
      const rebound = spawnSync(process.execPath, ["scripts/build-artifact.mjs", "create"], { cwd: siteDir, encoding: "utf8" });
      expect(rebound.status, `${rebound.stdout ?? ""}\n${rebound.stderr ?? ""}`).toBe(0);
      const audit = spawnSync("npm", ["run", "verify:archive-built"], { cwd: siteDir, encoding: "utf8" });
      expect(audit.status, `${audit.stdout ?? ""}\n${audit.stderr ?? ""}`).toBe(1);
      const mutationReport = JSON.parse(await readFile(join(siteDir, "_scratch", "fidelity", "archive-built-audit.json"), "utf8")) as { result: string; observations: Array<{ code: string }> };
      expect(mutationReport.result).toBe("FAIL");
      expect(mutationReport.observations.map((observation) => observation.code)).toEqual(expect.arrayContaining(["substantive-text-delta", "attribute-element-identity-delta"]));
      const mutatedScorecard = await runScorecard({ configPath: scorecardPath });
      expect(mutatedScorecard.overall).toBe("FAIL");
      expect(mutatedScorecard.gates.find((gate) => gate.id === "archive-built")?.status).toBe("FAIL");
    } finally {
      await writeFile(mutationPath, originalOutput);
      const restoredArtifact = spawnSync(process.execPath, ["scripts/build-artifact.mjs", "create"], { cwd: siteDir, encoding: "utf8" });
      expect(restoredArtifact.status, `${restoredArtifact.stdout ?? ""}\n${restoredArtifact.stderr ?? ""}`).toBe(0);
    }
    const restoredScorecard = await runScorecard({ configPath: scorecardPath });
    expect(restoredScorecard.overall, JSON.stringify(restoredScorecard.gates, null, 2)).toBe("PASS");

    await initStatus({ cwd: workDir, force: true });
    for (const gate of ["mapping", "media", "schema-import", "fidelity", "theme-crosscheck"] as const) await approveStatusGate({ cwd: workDir, gate, by: "golden-e2e" });
    const final = await getStatus({ cwd: workDir });
    expect(Object.fromEntries(final!.gates.map((gate) => [gate.id, gate.status]))).toEqual(await readJson("status-final.json"));
  }, 300_000);
});
