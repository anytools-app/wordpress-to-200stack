import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error Template .mjs is intentionally tested as the emitted Node artifact.
import * as archiveAuditModule from "../templates/next-app/scripts/lib/archive-built-audit.mjs";
// @ts-expect-error Template .mjs is intentionally tested as the emitted Node artifact.
import * as buildArtifactModule from "../templates/next-app/scripts/lib/build-artifact.mjs";

const {
  adjudicateDecisions,
  archiveNon200BuiltOutputObservations,
  attributeRecords,
  buildMediaIdentity,
  classifyTextDifference,
  collectArchiveBuiltAudit,
  compareAttributes,
  compareImages,
  imageRecords,
  jsonLdRecords,
  newUiA11yFailures,
  normalizedHref,
  observationHash,
  parseDocument,
  redirectMap,
  textSurface,
  trackedAttributes,
} = archiveAuditModule;
const { createBuildArtifact, hashTree, readBuildArtifact, sourceRevision, verifyBuildArtifact } = buildArtifactModule;

const temporary: string[] = [];
async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "wpkit-archive-built-"));
  temporary.push(path);
  return path;
}
async function initGitFixture(root: string, ignore = ["out/", "archive/", "artifact.json", "routes.json", "decisions.json", "audit.config.json", "*.partial.json"].join("\n")): Promise<void> {
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  await writeFile(join(root, ".gitignore"), `${ignore}\n`);
  execFileSync("git", ["add", ".gitignore"], { cwd: root });
  execFileSync("git", ["-c", "user.name=wpkit-test", "-c", "user.email=wpkit@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: root });
}
async function cleanAuditFixture(): Promise<{ root: string; archive: string; out: string; artifactPath: string; inventoryPath: string; ledgerPath: string; decisionsPath: string }> {
  const root = await tempDir(); const archive = join(root, "archive"); const out = join(root, "out");
  const artifactPath = join(root, "artifact.json"); const inventoryPath = join(archive, "inventory.json");
  const ledgerPath = join(root, "routes.json"); const decisionsPath = join(root, "decisions.json");
  await mkdir(join(archive, "pages", encodeURIComponent("/one/")), { recursive: true });
  await mkdir(join(out, "one"), { recursive: true });
  const html = "<html><head><title>One</title></head><body><main>same</main></body></html>";
  await writeFile(join(archive, "pages", encodeURIComponent("/one/"), "page.html"), html);
  await writeFile(join(out, "one", "index.html"), html);
  await writeFile(inventoryPath, JSON.stringify({ urls: [{ url: "https://old.test/one/", status: 200 }] }));
  await writeFile(ledgerPath, JSON.stringify([{ path: "/one/", expected: { type: "output" } }]));
  await writeFile(decisionsPath, JSON.stringify({ schemaVersion: 1, decisions: [] }));
  await initGitFixture(root);
  await writeFile(join(root, "source.txt"), "before audit");
  execFileSync("git", ["add", "source.txt"], { cwd: root });
  execFileSync("git", ["-c", "user.name=wpkit-test", "-c", "user.email=wpkit@example.invalid", "commit", "--quiet", "-m", "source fixture"], { cwd: root });
  await createBuildArtifact({ outDirectory: out, repository: root, artifactPath });
  return { root, archive, out, artifactPath, inventoryPath, ledgerPath, decisionsPath };
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function surface(html: string) {
  return parseDocument(html).querySelector("main")!;
}

function body(html: string) {
  return parseDocument(`<html><body>${html}</body></html>`).body;
}

describe("generic archive-built fidelity gate", () => {
  it("classifies exact whitespace, br, order, and substantive deltas without merging words", () => {
    expect(classifyTextDifference(textSurface(surface("<main>A  1</main>")), textSurface(surface("<main>A\n1</main>")))).toEqual({ code: "whitespace-only-delta", severity: "Info" });
    expect(classifyTextDifference(textSurface(surface("<main>A<br>1</main>")), textSurface(surface("<main>A 1</main>")))).toEqual({ code: "line-break-delta", severity: "Minor" });
    expect(classifyTextDifference(textSurface(surface("<main>A B</main>")), textSurface(surface("<main>B A</main>")))).toEqual({ code: "text-order-delta", severity: "Major" });
    expect(classifyTextDifference(textSurface(surface("<main>A 1</main>")), textSurface(surface("<main>A1</main>")))).toEqual({ code: "substantive-text-delta", severity: "Major" });
    expect(textSurface(surface('<main>visible<span hidden>hidden</span><span aria-hidden="true">aria hidden</span></main>')).normalized).toBe("visible");
  });

  it("tracks alt, every aria attribute, title, placeholder, value, role, and hidden", () => {
    const element = parseDocument('<button alt="legacy" aria-label="open" aria-expanded="false" title="tip" placeholder="find" value="go" role="switch" hidden></button>').querySelector("button")!;
    expect(trackedAttributes(element)).toEqual({
      alt: "legacy",
      "aria-expanded": "false",
      "aria-label": "open",
      hidden: true,
      placeholder: "find",
      role: "switch",
      title: "tip",
      value: "go",
    });
  });

  it("detects common chrome attribute changes by stable element identity", () => {
    const archive = body('<header><button id="menu" aria-label="メニュー" aria-expanded="false"></button></header><main></main>');
    const built = body('<header><button id="menu" aria-label="Menu" aria-expanded="true"></button></header><main></main>');
    const result = compareAttributes(attributeRecords(archive), attributeRecords(built));
    expect(result.missing).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0]).toMatchObject({ archive: { "aria-label": "メニュー" }, built: { "aria-label": "Menu" } });
  });

  it("keeps SVG title/text and SVG tracked attributes in strict parity", () => {
    const archive = body('<svg id="brand-icon" aria-label="Legacy mark" role="img" title="Legacy title"><title>Legacy icon</title><text>Legacy text</text></svg>');
    const built = body('<svg id="brand-icon" aria-label="Built mark" role="presentation" title="Built title"><title>Built icon</title><text>Built text</text></svg>');
    expect(classifyTextDifference(textSurface(archive), textSurface(built))).toEqual({ code: "substantive-text-delta", severity: "Major" });
    const attributes = compareAttributes(attributeRecords(archive), attributeRecords(built));
    expect(attributes.missing).toEqual([]);
    expect(attributes.added).toEqual([]);
    expect(attributes.differences).toEqual([
      expect.objectContaining({
        archive: { "aria-label": "Legacy mark", role: "img", title: "Legacy title" },
        built: { "aria-label": "Built mark", role: "presentation", title: "Built title" },
      }),
    ]);
  });

  it("includes images outside the tracked surface and detects same-asset attribute swaps by context", () => {
    const identity = buildMediaIdentity(
      { "https://old.test/shared.jpg": { assetUrl: "https://cdn.test/shared.webp" } },
      {},
      "https://old.test",
    );
    const archive = body('<main></main><aside><article>Featured<img src="https://old.test/shared.jpg" alt="featured"></article><article>Related<img src="https://old.test/shared.jpg" alt="related"></article></aside>');
    const built = body('<main></main><aside><article>Featured<img src="https://cdn.test/shared.webp" alt="related"></article><article>Related<img src="https://cdn.test/shared.webp" alt="featured"></article></aside>');
    const result = compareImages(
      imageRecords(archive, identity, { origin: "https://old.test", route: "/" }),
      imageRecords(built, identity, { origin: "https://old.test", route: "/" }),
    );
    expect(result.sourceDelta).toEqual({ missing: [], added: [] });
    expect(result.identityDelta).toEqual({ missing: [], added: [] });
    expect(result.attributeDiff).toHaveLength(2);
  });

  it("binds picture source delivery to the child image identity", () => {
    const identity = buildMediaIdentity({}, {}, "https://old.test");
    const archive = body('<picture><source srcset="/wide-legacy.webp 2x" sizes="100vw" media="(min-width: 60rem)" type="image/webp"><img src="/fallback.jpg" alt="hero"></picture>');
    const built = body('<picture><source srcset="/wide-built.webp 2x" sizes="50vw" media="(min-width: 60rem)" type="image/avif"><img src="/fallback.jpg" alt="hero"></picture>');
    const result = compareImages(
      imageRecords(archive, identity, { origin: "https://old.test", route: "/" }),
      imageRecords(built, identity, { origin: "https://old.test", route: "/" }),
    );
    expect(result.sourceDelta).toEqual({ missing: [], added: [] });
    expect(result.identityDelta).toEqual({ missing: [], added: [] });
    expect(result.deliveryDiff).toEqual([
      expect.objectContaining({
        archive: expect.objectContaining({ pictureSources: [{ srcset: "/wide-legacy.webp 2x", sizes: "100vw", media: "(min-width: 60rem)", type: "image/webp" }] }),
        built: expect.objectContaining({ pictureSources: [{ srcset: "/wide-built.webp 2x", sizes: "50vw", media: "(min-width: 60rem)", type: "image/avif" }] }),
      }),
    ]);
  });

  it("keeps existing attributes in strict parity while applying current a11y checks only to new UI", () => {
    const archive = body('<main><button id="existing" aria-label="original"></button></main>');
    const validBuilt = body('<main><button id="existing" aria-label="original"></button><button id="new">New action</button></main>');
    const invalidBuilt = body('<main><button id="existing" aria-label="original"></button><button id="new"></button><input id="email"><iframe></iframe><button id="labelled" aria-labelledby="missing"></button><button id="refs" aria-describedby="missing-description" aria-controls="missing-control" aria-owns="missing-owned" aria-activedescendant="missing-active" aria-details="missing-details" aria-errormessage="missing-error" aria-flowto="missing-flow">References</button><div id="generic-ref" aria-describedby="missing-generic"></div></main>');
    const options = { route: "/", origin: "https://old.test", internalHosts: new Set(["old.test"]), redirects: new Map() };
    expect(newUiA11yFailures(archive, validBuilt, options)).toEqual([]);
    expect(newUiA11yFailures(archive, invalidBuilt, options)).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "interactive-accessible-name" }),
      expect.objectContaining({ rule: "form-control-label" }),
      expect.objectContaining({ rule: "iframe-title" }),
      expect.objectContaining({ rule: "aria-labelledby-target" }),
      expect.objectContaining({ rule: "aria-describedby-target" }),
      expect.objectContaining({ rule: "aria-controls-target" }),
      expect.objectContaining({ rule: "aria-owns-target" }),
      expect.objectContaining({ rule: "aria-activedescendant-target" }),
      expect.objectContaining({ rule: "aria-details-target" }),
      expect.objectContaining({ rule: "aria-errormessage-target" }),
      expect.objectContaining({ rule: "aria-flowto-target" }),
      expect.objectContaining({ identity: expect.stringContaining("div|id:generic-ref"), rule: "aria-describedby-target", missingIds: ["missing-generic"] }),
    ]));
    const specialId = 'field:part[0].value"quoted';
    const labelledBuilt = body(`<main><label for='${specialId}'>Value</label><input id='${specialId}'></main>`);
    expect(newUiA11yFailures(body("<main></main>"), labelledBuilt, options)).toEqual([]);
  });

  it("preserves query and fragment identities, including redirect destinations", () => {
    const redirects = redirectMap({ routes: [{ path: "/legacy/", expected: { type: "redirect", destination: "/current/?mode=full#section" } }] }, "https://old.test");
    const hosts = new Set(["old.test"]);
    expect(redirects.get("/legacy/")).toBe("/current/?mode=full#section");
    expect(normalizedHref("/x/?a=1#id", "/from/", "https://old.test", hosts, redirects)).toBe("/x/?a=1#id");
    expect(normalizedHref("#local", "/from/", "https://old.test", hosts, redirects)).toBe("/from/#local");
    expect(normalizedHref("/legacy/", "/from/", "https://old.test", hosts, redirects)).toBe("/current/?mode=full#section");
    const inherited = redirectMap({ routes: [{ path: "/legacy/", expected: { type: "redirect", destination: "/current/" } }] }, "https://old.test");
    expect(normalizedHref("/legacy/?from=source#old", "/from/", "https://old.test", hosts, inherited)).toBe("/current/?from=source#old");
    const queryOnly = redirectMap({ routes: [{ path: "/legacy/", expected: { type: "redirect", destination: "/current/?fixed=1" } }] }, "https://old.test");
    expect(normalizedHref("/legacy/?from=source#old", "/from/", "https://old.test", hosts, queryOnly)).toBe("/current/?fixed=1#old");
    const intentSpecific = redirectMap({ routes: [
      { path: "/legacy/", expected: { type: "redirect", destination: "/current/" } },
      { path: "/legacy/?preview=1", expected: { type: "redirect", destination: "/preview/" } },
    ] }, "https://old.test");
    expect(intentSpecific).toEqual(new Map([["/legacy/", "/current/"], ["/legacy/?preview=1", "/preview/"]]));
    expect(normalizedHref("/legacy/?preview=1#old", "/from/", "https://old.test", hosts, intentSpecific)).toBe("/preview/?preview=1#old");
    const explicitlyCleared = redirectMap({ routes: [{ path: "/legacy/", expected: { type: "redirect", destination: "/current/?#" } }] }, "https://old.test");
    expect(normalizedHref("/legacy/?from=source#old", "/from/", "https://old.test", hosts, explicitlyCleared)).toBe("/current/");
    expect(normalizedHref("mailto:test@example.invalid", "/from/", "https://old.test", hosts, redirects)).toBe("mailto:test@example.invalid");
  });

  it("compares complete JSON-LD values while canonicalizing key, graph, and script order", () => {
    const first = parseDocument('<html><head><script type="application/ld+json">{"@graph":[{"name":"B","@type":"Person"},{"@type":"Person","name":"A"}],"@context":"https://schema.org"}</script><script type="application/ld+json">{"url":"/a","@type":"WebSite"}</script></head></html>');
    const reordered = parseDocument('<html><head><script type="APPLICATION/LD+JSON">{"@type":"WebSite","url":"/a"}</script><script type=" application/ld+json ">{"@context":"https://schema.org","@graph":[{"name":"A","@type":"Person"},{"@type":"Person","name":"B"}]}</script></head></html>');
    expect(jsonLdRecords(first)).toEqual(jsonLdRecords(reordered));
    const changed = parseDocument('<html><head><script type="application/ld+json">{"@graph":[{"@type":"Person","name":"A"},{"@type":"Person","name":"Changed"}],"@context":"https://schema.org"}</script><script type="application/ld+json">{"url":"/a","@type":"WebSite"}</script></head></html>');
    expect(jsonLdRecords(changed).values).not.toEqual(jsonLdRecords(first).values);
    expect(jsonLdRecords(parseDocument('<script type="application/ld+json">{broken</script>')).errors).toHaveLength(1);
  });

  it("observes archive non-200 routes that unexpectedly have built output", () => {
    expect(archiveNon200BuiltOutputObservations(
      { routes: [{ path: "/archive/page/2/", archiveStatus: 404, expected: { type: "output" } }] },
      new Set(["/archive/page/2/"]),
    )).toEqual([
      expect.objectContaining({ code: "archive-non-200-built-output", severity: "Major", route: "/archive/page/2/", archiveStatus: 404, builtOutput: true }),
    ]);
    expect(archiveNon200BuiltOutputObservations(
      [],
      new Set(["/inventory-only/"]),
      "https://old.test",
      [{ url: "https://old.test/inventory-only/", status: 404 }],
    )).toEqual([
      expect.objectContaining({ code: "archive-non-200-built-output", route: "/inventory-only/", archiveStatus: 404 }),
    ]);
    expect(archiveNon200BuiltOutputObservations(
      { routes: [{ path: "/silent-skip/", archiveStatus: 404, expected: { type: "typo" } }] },
      new Set(["/silent-skip/"]),
    )).toEqual([
      expect.objectContaining({ code: "archive-non-200-built-output", route: "/silent-skip/", archiveStatus: 404, expectedType: "output" }),
    ]);
  });

  it("fails closed on invalid route ledger entries instead of silently dropping them", async () => {
    const { root, archive, out, artifactPath, inventoryPath, ledgerPath, decisionsPath } = await cleanAuditFixture();
    await writeFile(ledgerPath, JSON.stringify({ routes: [
      { path: "/one/", expected: { type: "typo" } },
      { expected: { type: "output" } },
      "not an entry",
    ] }));
    const report = await collectArchiveBuiltAudit({
      repository: root,
      archiveDirectory: archive,
      outDirectory: out,
      artifactPath,
      inventoryPath,
      routeLedgerPath: ledgerPath,
      decisionsPath,
      config: { origin: "https://old.test", surfaceRules: [{ id: "one", route: "^/one/$", archive: "main", built: "main" }] },
    });
    expect(report.result).toBe("FAIL");
    expect(report.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "route-ledger-invalid", severity: "Blocking", route: "/one/", expectedType: "typo" }),
      expect.objectContaining({ code: "route-ledger-invalid", severity: "Blocking", entryIndex: 1, reason: "route entry requires string path or url" }),
      expect.objectContaining({ code: "route-ledger-invalid", severity: "Blocking", entryIndex: 2, reason: "route entry must be an object" }),
    ]));
    await writeFile(ledgerPath, JSON.stringify({ entries: [{ path: "/one/" }] }));
    const invalidTopLevel = await collectArchiveBuiltAudit({
      repository: root,
      archiveDirectory: archive,
      outDirectory: out,
      artifactPath,
      inventoryPath,
      routeLedgerPath: ledgerPath,
      decisionsPath,
      config: { origin: "https://old.test", surfaceRules: [{ id: "one", route: "^/one/$", archive: "main", built: "main" }] },
    });
    expect(invalidTopLevel.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "route-ledger-invalid", severity: "Blocking", reason: "route ledger must be an array or an object with routes array" }),
    ]));
  });

  it("rejects symlinks and unsupported filesystem entries while hashing build and archive trees", async () => {
    const root = await tempDir(); const out = join(root, "out"); const archive = join(root, "archive");
    await mkdir(out); await writeFile(join(root, "target.txt"), "outside"); await symlink(join(root, "target.txt"), join(out, "linked.txt"));
    await expect(hashTree(out)).rejects.toThrow("unsupported filesystem entry in build output");
    await mkdir(archive); await symlink(join(root, "target.txt"), join(archive, "linked.txt"));
    await expect(hashTree(archive)).rejects.toThrow("unsupported filesystem entry in build output");
  });

  it("observes build output, build artifact, and archive mutations during audit", async () => {
    for (const [code, mutate] of [
      ["build-output-mutated-during-audit", async (fixture: Awaited<ReturnType<typeof cleanAuditFixture>>) => {
        await writeFile(join(fixture.out, "one", "index.html"), "<html><body><main>mutated output</main></body></html>");
      }],
      ["build-artifact-mutated-during-audit", async (fixture: Awaited<ReturnType<typeof cleanAuditFixture>>) => {
        const artifact = JSON.parse(await readFile(fixture.artifactPath, "utf8"));
        await writeFile(fixture.artifactPath, JSON.stringify({ ...artifact, buildHash: "a".repeat(64) }));
      }],
      ["source-mutated-during-audit", async (fixture: Awaited<ReturnType<typeof cleanAuditFixture>>) => {
        await writeFile(join(fixture.root, "source.txt"), "after audit started");
      }],
      ["archive-mutated-during-audit", async (fixture: Awaited<ReturnType<typeof cleanAuditFixture>>) => {
        await writeFile(join(fixture.archive, "pages", encodeURIComponent("/one/"), "page.html"), "<html><body><main>mutated archive</main></body></html>");
      }],
    ] as const) {
      const fixture = await cleanAuditFixture();
      const report = await collectArchiveBuiltAudit({
        repository: fixture.root,
        archiveDirectory: fixture.archive,
        outDirectory: fixture.out,
        artifactPath: fixture.artifactPath,
        inventoryPath: fixture.inventoryPath,
        routeLedgerPath: fixture.ledgerPath,
        decisionsPath: fixture.decisionsPath,
        config: { origin: "https://old.test", surfaceRules: [{ id: "one", route: "^/one/$", archive: "main", built: "main" }] },
        beforeMutationCheck: () => mutate(fixture),
      });
      expect(report.result, code).toBe("FAIL");
      expect(report.observations, code).toEqual(expect.arrayContaining([expect.objectContaining({ code, severity: "Blocking" })]));
      if (code === "build-artifact-mutated-during-audit" || code === "source-mutated-during-audit") {
        expect(report.observations.some((observation: { code: string }) => observation.code === "build-output-mutated-during-audit")).toBe(false);
      }
      if (code === "source-mutated-during-audit") {
        expect(report.observations.some((observation: { code: string }) => observation.code === "build-artifact-mutated-during-audit")).toBe(false);
      }
    }
  });

  it("preserves query/hash URL intents without changing the base body representative", async () => {
    const root = await tempDir(); const archive = join(root, "archive"); const out = join(root, "out");
    const artifactPath = join(root, "artifact.json"); const inventoryPath = join(archive, "inventory.json");
    const ledgerPath = join(root, "routes.json"); const decisionsPath = join(root, "decisions.json");
    await mkdir(join(archive, "pages", encodeURIComponent("/foo/")), { recursive: true });
    await mkdir(join(out, "foo"), { recursive: true });
    const html = "<html><head><title>Foo</title></head><body><main>base body</main></body></html>";
    await writeFile(join(archive, "pages", encodeURIComponent("/foo/"), "page.html"), html);
    await writeFile(join(out, "foo", "index.html"), html);
    const ledgerEntries = [
      { path: "/foo/?preview=1", archiveStatus: 404, expected: { type: "output" } },
      { path: "/foo/", archiveStatus: 200, expected: { type: "output" } },
    ];
    await writeFile(ledgerPath, JSON.stringify(ledgerEntries));
    await writeFile(decisionsPath, JSON.stringify({ schemaVersion: 1, decisions: [] }));
    await initGitFixture(root);
    await createBuildArtifact({ outDirectory: out, repository: root, artifactPath });
    const entries = [
      { url: "https://old.test/foo/?preview=1", status: 404 },
      { url: "https://old.test/foo/", status: 200 },
    ];
    const collect = () => collectArchiveBuiltAudit({
      repository: root,
      archiveDirectory: archive,
      outDirectory: out,
      artifactPath,
      inventoryPath,
      routeLedgerPath: ledgerPath,
      decisionsPath,
      config: { origin: "https://old.test", surfaceRules: [{ id: "foo", route: "^/foo/$", archive: "main", built: "main" }] },
    });
    await writeFile(inventoryPath, JSON.stringify({ urls: entries }));
    const first = await collect();
    await writeFile(inventoryPath, JSON.stringify({ urls: [...entries].reverse() }));
    await writeFile(ledgerPath, JSON.stringify([...ledgerEntries].reverse()));
    const reordered = await collect();
    expect(reordered.observations).toEqual(first.observations);
    expect(first.coverage).toMatchObject({ routeUnion: 1, inventoryStatus200: 1, comparedPages: 1, outputPages: 1 });
    expect(first.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "archive-non-200-built-output", route: "/foo/", intent: "/foo/?preview=1", query: "?preview=1", archiveStatus: 404 }),
      expect.objectContaining({
        code: "url-intent-variants",
        route: "/foo/",
        severity: "Major",
        variants: [
          expect.objectContaining({ intent: "/foo/", query: "", inventoryStatuses: [200], ledgerArchiveStatuses: [200], expected: [{ type: "output" }] }),
          expect.objectContaining({ intent: "/foo/?preview=1", query: "?preview=1", inventoryStatuses: [404], ledgerArchiveStatuses: [404], expected: [{ type: "output" }] }),
        ],
      }),
    ]));
    expect(first.observations.some((observation: { code: string }) => observation.code.includes("text-delta"))).toBe(false);
  });

  it("requires exact hash, route, code, and severity and blocks invalid, unused, duplicate, and mismatch decisions", () => {
    const base = { code: "element-attribute-delta", severity: "Major", route: "/", detail: { field: "aria-label" } };
    const observation = { ...base, observationHash: observationHash(base) };
    const decision = { observationHash: observation.observationHash, route: "/", code: base.code, severity: base.severity, status: "accepted", rationale: "approved existing UI change", by: "reviewer", date: "2026-08-11" };
    expect(adjudicateDecisions([observation], { decisions: [decision] }).observations[0]?.decision).toEqual(decision);
    for (const key of ["observationHash", "route", "code", "severity", "status", "rationale", "by", "date"]) {
      const invalid: Record<string, unknown> = { ...decision }; delete invalid[key];
      expect(adjudicateDecisions([observation], { decisions: [invalid] }).failures[0]?.code, key).toBe("decision-invalid");
    }
    expect(adjudicateDecisions([observation], { decisions: [{ ...decision, date: "2026-02-31" }] }).failures[0]?.code).toBe("decision-invalid");
    expect(adjudicateDecisions([observation], { decisions: [{ ...decision, extra: true }] }).failures[0]?.code).toBe("decision-invalid");
    expect(adjudicateDecisions([observation], { decisions: [decision], extra: true }).failures[0]?.code).toBe("decision-invalid");
    expect(adjudicateDecisions([observation], { decisions: [{ ...decision, observationHash: "a".repeat(64) }] }).failures[0]?.code).toBe("decision-unused");
    expect(adjudicateDecisions([observation], { decisions: [decision, decision] }).failures[0]?.code).toBe("decision-duplicate");
    for (const mismatch of [{ route: "/other/" }, { code: "other-code" }, { severity: "Minor" }]) {
      expect(adjudicateDecisions([observation], { decisions: [{ ...decision, ...mismatch }] }).failures[0]?.code).toBe("decision-mismatch");
    }
  });

  it("never suppresses Blocking observations", () => {
    const base = { code: "build-artifact-mismatch", severity: "Blocking", route: null };
    const observation = { ...base, observationHash: observationHash(base) };
    const result = adjudicateDecisions([observation], { decisions: [{ observationHash: observation.observationHash, route: null, code: base.code, severity: "Major", status: "accepted", rationale: "not allowed", by: "reviewer", date: "2026-08-11" }] });
    expect(result.observations[0]?.decision).toBeUndefined();
    expect(result.failures[0]?.code).toBe("decision-mismatch");
  });

  it("defers every unmatched decision until a full run, including another surface on the same route", () => {
    const currentBase = { code: "substantive-text-delta", severity: "Major", route: "/shared/", scope: "surface:one" };
    const current = { ...currentBase, observationHash: observationHash(currentBase) };
    const otherBase = { code: "substantive-text-delta", severity: "Major", route: "/shared/", scope: "surface:two" };
    const other = { ...otherBase, observationHash: observationHash(otherBase) };
    const decision = (hash: string, route: string) => ({ observationHash: hash, route, code: "substantive-text-delta", severity: "Major", status: "accepted", rationale: "reviewed exact observation", by: "reviewer", date: "2026-08-11" });
    const currentDecision = decision(current.observationHash, "/shared/");
    const otherDecision = decision(other.observationHash, "/shared/");
    expect(adjudicateDecisions([current], { decisions: [currentDecision, otherDecision] }, { deferUnused: true })).toMatchObject({ failures: [], observations: [{ decision: currentDecision }] });
    expect(adjudicateDecisions([], { decisions: [currentDecision, otherDecision] }, { deferUnused: true }).failures).toEqual([]);
    expect(adjudicateDecisions([current], { decisions: [currentDecision, otherDecision] }).failures).toEqual([expect.objectContaining({ code: "decision-unused", decisionHash: otherDecision.observationHash })]);
  });

  it("binds hash, fileCount, bytes, and source revision and detects output mutation", async () => {
    const root = await tempDir();
    const out = join(root, "out");
    const artifact = join(root, "artifact.json");
    await mkdir(out);
    await writeFile(join(out, "index.html"), "before");
    await initGitFixture(root);
    const created = await createBuildArtifact({ outDirectory: out, repository: root, artifactPath: artifact, generatedAt: "2026-08-11T00:00:00.000Z" });
    expect(created).toMatchObject({ fileCount: 1, bytes: 6, source: expect.any(Object) });
    expect((await verifyBuildArtifact({ outDirectory: out, artifactPath: artifact })).matches).toBe(true);
    await writeFile(join(out, "index.html"), "after");
    const mutated = await verifyBuildArtifact({ outDirectory: out, artifactPath: artifact });
    expect(mutated.matches).toBe(false);
    expect(mutated.reason).toContain("current output");
  });

  it("rejects non-git source revisions, empty output, and structurally incomplete artifacts", async () => {
    const nonGit = await tempDir(); const nonGitOut = join(nonGit, "out");
    await mkdir(nonGitOut); await writeFile(join(nonGitOut, "index.html"), "built");
    await expect(createBuildArtifact({ outDirectory: nonGitOut, repository: nonGit, artifactPath: join(nonGit, "artifact.json") })).rejects.toThrow("source revision is unavailable");

    const empty = await tempDir(); const emptyOut = join(empty, "out");
    await mkdir(emptyOut); await initGitFixture(empty);
    await expect(createBuildArtifact({ outDirectory: emptyOut, repository: empty, artifactPath: join(empty, "artifact.json") })).rejects.toThrow("build output is empty");

    const invalidPath = join(empty, "invalid.json");
    await writeFile(invalidPath, JSON.stringify({ schemaVersion: 1, buildHash: "a".repeat(64), fileCount: 1, bytes: 1, source: {} }));
    await expect(readBuildArtifact(invalidPath)).rejects.toThrow("build artifact is invalid");

    const outer = await tempDir();
    execFileSync("git", ["init", "--quiet"], { cwd: outer });
    await writeFile(join(outer, ".gitignore"), "ignored/\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: outer });
    execFileSync("git", ["-c", "user.name=wpkit-test", "-c", "user.email=wpkit@example.invalid", "commit", "--quiet", "-m", "outer fixture"], { cwd: outer });
    const ignoredSite = join(outer, "ignored", "site"); const ignoredOut = join(ignoredSite, "out");
    await mkdir(ignoredOut, { recursive: true }); await writeFile(join(ignoredSite, "source.txt"), "ignored source"); await writeFile(join(ignoredOut, "index.html"), "built");
    expect(sourceRevision(ignoredSite)).toMatchObject({ commit: null, dirty: null, error: expect.stringContaining("scope has no tracked source") });
    await expect(createBuildArtifact({ outDirectory: ignoredOut, repository: ignoredSite, artifactPath: join(ignoredSite, "artifact.json") })).rejects.toThrow("source revision is unavailable");
  });

  it("invalidates a dirty build when source contents change without changing dirty=true", async () => {
    const root = await tempDir(); const out = join(root, "out"); const artifact = join(root, "artifact.json");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, ".gitignore"), "out/\nartifact.json\n");
    await writeFile(join(root, "source.txt"), "committed");
    execFileSync("git", ["add", ".gitignore", "source.txt"], { cwd: root });
    execFileSync("git", ["-c", "user.name=wpkit-test", "-c", "user.email=wpkit@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: root });
    await mkdir(out); await writeFile(join(out, "index.html"), "built");
    await writeFile(join(root, "source.txt"), "dirty-before-build");
    const created = await createBuildArtifact({ outDirectory: out, repository: root, artifactPath: artifact });
    expect(created.source).toMatchObject({ dirty: true, worktreeHash: expect.stringMatching(/^[a-f\d]{64}$/) });
    await writeFile(join(root, "source.txt"), "dirty-after-build");
    const stale = await verifyBuildArtifact({ outDirectory: out, artifactPath: artifact, repository: root, verifySource: true });
    expect(stale.matches).toBe(false);
    expect(stale.reason).toContain("source revision");
  });

  it("fails a zero-page partial selection and derives inventory from an archive directory override", async () => {
    const root = await tempDir(); const archive = join(root, "archive"); const out = join(root, "out");
    const artifactPath = join(root, "artifact.json"); const inventoryPath = join(archive, "inventory.json");
    const ledgerPath = join(root, "routes.json"); const decisionsPath = join(root, "decisions.json");
    await mkdir(join(archive, "pages", encodeURIComponent("/one")), { recursive: true });
    await mkdir(join(out, "one"), { recursive: true });
    const html = "<html><head><title>One</title></head><body><main>same</main></body></html>";
    await writeFile(join(archive, "pages", encodeURIComponent("/one"), "page.html"), html);
    await writeFile(join(out, "one", "index.html"), html);
    await writeFile(inventoryPath, JSON.stringify({ urls: [{ url: "https://old.test/one", status: 200 }] }));
    await writeFile(ledgerPath, JSON.stringify([{ path: "/one/", expected: { type: "output" } }]));
    await writeFile(decisionsPath, JSON.stringify({ schemaVersion: 1, decisions: [] }));
    await initGitFixture(root);
    await createBuildArtifact({ outDirectory: out, repository: root, artifactPath });

    const partial = await collectArchiveBuiltAudit({
      repository: root,
      archiveDirectory: archive,
      outDirectory: out,
      artifactPath,
      inventoryPath,
      routeLedgerPath: ledgerPath,
      decisionsPath,
      config: { origin: "https://old.test", partialSurfaceSelection: true, surfaceRules: [{ id: "absent", route: "^/absent/$", archive: "main", built: "main" }] },
    });
    expect(partial.result).toBe("FAIL");
    expect(partial.coverage.comparedPages).toBe(0);
    expect(partial.observations).toEqual([
      expect.objectContaining({ code: "partial-selection-empty", severity: "Blocking", surfaceIds: ["absent"] }),
    ]);

    const cliConfig = join(root, "audit.config.json");
    const reportPath = join(root, "override-report.json");
    await writeFile(cliConfig, JSON.stringify({
      schemaVersion: 1,
      repository: ".",
      archiveDirectory: "wrong/archive",
      inventory: "wrong/inventory.json",
      outDirectory: "out",
      artifact: "artifact.json",
      routeLedger: "routes.json",
      decisions: "decisions.json",
      report: "override-report.json",
      origin: "https://old.test",
      internalHosts: ["old.test"],
      excludeSelectors: [],
      surfaceRules: [{ id: "one", route: "^/one/$", archive: "main", built: "main" }],
    }));
    const childEnv: NodeJS.ProcessEnv = { ...process.env, WPKIT_ARCHIVE_DIR: archive };
    for (const key of ["WPKIT_INVENTORY", "WPKIT_OUT_DIR", "WPKIT_BUILD_ARTIFACT", "WPKIT_MEDIA_MAP"]) delete childEnv[key];
    execFileSync(process.execPath, [join(process.cwd(), "templates", "next-app", "scripts", "archive-built-audit.mjs"), "--config", cliConfig], { env: childEnv, stdio: "pipe" });
    await expect(readFile(reportPath, "utf8").then(JSON.parse)).resolves.toMatchObject({ result: "PASS", coverage: { comparedPages: 1 } });
  });

  it("rejects historical wrapper flags with an explicit migration command", () => {
    const scripts = join(process.cwd(), "templates", "next-app", "scripts");
    for (const [script, flag] of [["fidelity-static-audit.mjs", "--archive-dir"], ["fidelity-text.mjs", "--port"]] as const) {
      const result = spawnSync(process.execPath, [join(scripts, script), flag, "unused"], { encoding: "utf8" });
      expect(result.status, script).toBe(2);
      expect(result.stderr, script).toContain(`historical flag ${flag}`);
      expect(result.stderr, script).toContain("npm run verify:archive-built -- --config <path> [--only <surface-id>] [--report <path>]");
      expect(result.stderr, script).not.toContain("Unknown option");
    }
  });

  it("rejects readable legacy static-audit configs while forwarding current, unreadable, and invalid JSON configs", async () => {
    const root = await tempDir();
    const script = join(process.cwd(), "templates", "next-app", "scripts", "fidelity-static-audit.mjs");
    const legacyFields = join(root, "legacy-fields.json");
    const legacyVersion = join(root, "legacy-version.json");
    const currentSchema = join(root, "current-schema.json");
    const invalidJson = join(root, "invalid.json");
    const missing = join(root, "missing.json");
    await writeFile(legacyFields, JSON.stringify({ allowMissingPaths: ["/old/"], redirects: {} }));
    await writeFile(legacyVersion, JSON.stringify({ schemaVersion: 0 }));
    await writeFile(currentSchema, JSON.stringify({ schemaVersion: 1 }));
    await writeFile(invalidJson, "{invalid");

    for (const args of [["--config", legacyFields], [`--config=${legacyVersion}`]]) {
      const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("legacy config schema");
      expect(result.stderr).toContain("npm run verify:archive-built -- --config <path> [--only <surface-id>] [--report <path>]");
      expect(result.stderr).not.toContain("Unknown option");
    }

    const forwardedCurrent = spawnSync(process.execPath, [script, `--config=${currentSchema}`], { encoding: "utf8" });
    expect(forwardedCurrent.status).toBe(2);
    expect(forwardedCurrent.stderr).toContain("origin must be an absolute URL");
    expect(forwardedCurrent.stderr).not.toContain("legacy config schema");

    for (const [path, collectorError] of [[invalidJson, /SyntaxError/], [missing, /ENOENT/]] as const) {
      const result = spawnSync(process.execPath, [script, "--config", path], { encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(collectorError);
      expect(result.stderr).not.toContain("legacy config schema");
      expect(result.stderr).not.toContain("historical flag");
    }
  });

  it("collects the inventory/ledger/built union, including inventory-only 404 output, and supports partial surfaces", async () => {
    const root = await tempDir(); const archive = join(root, "archive"); const out = join(root, "out");
    await mkdir(join(archive, "pages", encodeURIComponent("/one")), { recursive: true });
    await mkdir(join(archive, "pages", encodeURIComponent("/two/")), { recursive: true });
    await mkdir(join(archive, "pages", encodeURIComponent("/json-both-invalid")), { recursive: true });
    await mkdir(join(archive, "pages", encodeURIComponent("/excluded")), { recursive: true });
    await mkdir(join(archive, "pages", encodeURIComponent("/redirect-to-output")), { recursive: true });
    for (const route of ["/redirect-match", "/redirect-mismatch", "/redirect-chain", "/redirect-body"]) await mkdir(join(archive, "pages", encodeURIComponent(route)), { recursive: true });
    await mkdir(join(out, "one"), { recursive: true }); await mkdir(join(out, "two"), { recursive: true }); await mkdir(join(out, "json-both-invalid"), { recursive: true }); await mkdir(join(out, "excluded"), { recursive: true }); await mkdir(join(out, "redirect-to-output"), { recursive: true }); await mkdir(join(out, "archive", "page", "2"), { recursive: true }); await mkdir(join(out, "statusless"), { recursive: true });
    const oneHtml = '<html><head><title>One</title><script type="application/ld+json">{"@type":"Person","name":"Archive Person","url":"/person/"}</script></head><body><header><button id=menu aria-label=menu></button></header><main>one<a href="/x/?a=1#id">x</a><a href="https://lin.ee/legacy">LINE</a></main><div class="volatile">archive runtime</div></body></html>';
    const twoHtml = '<html><head><title>Two</title><script type="application/ld+json">{invalid archive</script><script type="application/ld+json">{"@type":"Person","name":"Legacy Person"}</script></head><body><main>two</main></body></html>';
    const twoBuiltHtml = '<html><head><title>Two</title><script type="application/ld+json">{"@type":"Person","name":"Repaired"}</script></head><body><main>two</main></body></html>';
    const bothInvalidArchiveHtml = '<html><head><title>Both invalid</title><script type="application/ld+json">{invalid archive</script><script type="application/ld+json">{"@type":"Person","name":"Legacy Person"}</script></head><body><main>both invalid</main></body></html>';
    const bothInvalidBuiltHtml = '<html><head><title>Both invalid</title><script type="application/ld+json">{invalid built</script><script type="application/ld+json">{"@type":"Person","name":"Changed Person"}</script></head><body><main>both invalid</main></body></html>';
    const excludedArchive = '<html><head><title>Excluded</title></head><body><main>same</main><aside class="volatile" aria-label="archive">archive only</aside></body></html>';
    const excludedBuilt = '<html><head><title>Excluded</title></head><body><main>same</main><aside class="volatile" aria-label="built">built only</aside></body></html>';
    await writeFile(join(archive, "pages", encodeURIComponent("/one"), "page.html"), oneHtml);
    await writeFile(join(archive, "pages", encodeURIComponent("/two/"), "page.html"), twoHtml);
    await writeFile(join(archive, "pages", encodeURIComponent("/json-both-invalid"), "page.html"), bothInvalidArchiveHtml);
    await writeFile(join(archive, "pages", encodeURIComponent("/excluded"), "page.html"), excludedArchive);
    await writeFile(join(archive, "pages", encodeURIComponent("/excluded"), "meta.json"), JSON.stringify({ redirects: [] }));
    await writeFile(join(archive, "pages", encodeURIComponent("/redirect-to-output"), "page.html"), '<html><head><title>Output</title></head><body><main>same output</main></body></html>');
    await writeFile(join(archive, "pages", encodeURIComponent("/redirect-to-output"), "meta.json"), JSON.stringify({ redirects: [{ from: "https://old.test/redirect-to-output", to: "https://old.test/final-output/?kept=1#target", status: 301 }] }));
    await writeFile(join(archive, "pages", encodeURIComponent("/redirect-match"), "meta.json"), JSON.stringify({ redirects: [{ from: "https://old.test/redirect-match", to: "https://old.test/current/?mode=full#section", status: 301 }] }));
    await writeFile(join(archive, "pages", encodeURIComponent("/redirect-mismatch"), "meta.json"), JSON.stringify({ redirects: [{ from: "https://old.test/redirect-mismatch", to: "https://old.test/wrong/?lost=1#no", status: 302 }] }));
    await writeFile(join(archive, "pages", encodeURIComponent("/redirect-chain"), "meta.json"), JSON.stringify({ redirects: [{ from: "https://old.test/redirect-chain", to: "https://old.test/intermediate/", status: 301 }, { from: "https://old.test/intermediate/", to: "https://old.test/final/?keep=1#yes", status: 302 }] }));
    await writeFile(join(archive, "pages", encodeURIComponent("/redirect-body"), "meta.json"), JSON.stringify({ redirects: [] }));
    await writeFile(join(out, "one", "index.html"), oneHtml.replace("<main>one", '<main>one changed<div title="new tracked element"></div>').replace("archive runtime", "built runtime").replace("Archive Person", "Built Person").replace("lin.ee/legacy", "lin.ee/built")); await writeFile(join(out, "two", "index.html"), twoBuiltHtml); await writeFile(join(out, "json-both-invalid", "index.html"), bothInvalidBuiltHtml); await writeFile(join(out, "excluded", "index.html"), excludedBuilt); await writeFile(join(out, "redirect-to-output", "index.html"), '<html><head><title>Output</title></head><body><main>same output</main></body></html>'); await writeFile(join(out, "archive", "page", "2", "index.html"), "<html><body><main>new page</main></body></html>"); await writeFile(join(out, "statusless", "index.html"), "<html><body><main>status missing</main></body></html>");
    const inventoryPath = join(archive, "inventory.json"); const ledgerPath = join(root, "routes.json"); const decisionsPath = join(root, "decisions.json"); const artifactPath = join(root, "artifact.json");
    await writeFile(inventoryPath, JSON.stringify({ urls: [{ url: "https://old.test/one", status: 200 }, { url: "https://old.test/two/", status: 200 }, { url: "https://old.test/json-both-invalid", status: 200 }, { url: "https://old.test/excluded", status: 200 }, { url: "https://old.test/redirect-to-output", status: 200 }, { url: "https://old.test/redirect-match", status: 200 }, { url: "https://old.test/redirect-mismatch", status: 200 }, { url: "https://old.test/redirect-chain", status: 200 }, { url: "https://old.test/redirect-body", status: 200 }, { url: "https://old.test/redirect-no-meta", status: 200 }, { url: "https://old.test/archive/page/2/", status: 404 }, { url: "https://old.test/statusless/" }] }));
    await writeFile(ledgerPath, JSON.stringify({ routes: [{ path: "/one/" }, { path: "/two/" }, { path: "/json-both-invalid/" }, { path: "/excluded/" }, { path: "/redirect-to-output/", expected: { type: "output" } }, { path: "/redirect-match/", expected: { type: "redirect", status: 301, destination: "/current/?mode=full#section" } }, { path: "/redirect-mismatch/", expected: { type: "redirect", status: 301, destination: "/right/?keep=1#yes" } }, { path: "/redirect-chain/", expected: { type: "redirect", status: 301, destination: "/final/?keep=1#yes" } }, { path: "/redirect-body/", expected: { type: "redirect", destination: "/body-target/" } }, { path: "/redirect-no-meta/", expected: { type: "redirect", destination: "/missing-target/" } }] })); await writeFile(decisionsPath, JSON.stringify({ decisions: [] }));
    await initGitFixture(root);
    await createBuildArtifact({ outDirectory: out, repository: root, artifactPath });
    const report = await collectArchiveBuiltAudit({ repository: root, archiveDirectory: archive, outDirectory: out, artifactPath, inventoryPath, routeLedgerPath: ledgerPath, decisionsPath, config: { origin: "https://old.test", excludeSelectors: [".volatile"], partialSurfaceSelection: true, expectedCoverage: { comparedPages: 999 }, surfaceRules: [{ id: "one", route: "^/one/$", archive: "main", built: "main" }] } });
    expect(report.coverage.comparedPages).toBe(1);
    expect(report.selection).toEqual({ mode: "partial", surfaceIds: ["one"] });
    expect(report.observations).toEqual(expect.arrayContaining([expect.objectContaining({ code: "archive-non-200-built-output", route: "/archive/page/2/" })]));
    expect(report.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "attribute-element-identity-delta", route: "/one/" }),
      expect.objectContaining({ code: "archive-status-missing-built-output", route: "/statusless/" }),
      expect.objectContaining({ code: "substantive-text-delta", route: "/one/", archiveTextHash: expect.stringMatching(/^[a-f\d]{64}$/), builtTextHash: expect.stringMatching(/^[a-f\d]{64}$/) }),
      expect.objectContaining({ code: "cta-delta", route: "/one/", severity: "Major", archive: expect.objectContaining({ line: ["https://lin.ee/legacy"] }), built: expect.objectContaining({ line: ["https://lin.ee/built"] }) }),
      expect.objectContaining({ code: "json-ld-value-delta", route: "/one/", severity: "Major" }),
      expect.objectContaining({ code: "archive-redirect-mismatch", route: "/redirect-mismatch/", expected: { status: 301, destination: "/right/?keep=1#yes" }, archive: { status: 302, destination: "/wrong/?lost=1#no" } }),
      expect.objectContaining({ code: "archive-redirect-chain-delta", route: "/redirect-chain/", expected: { status: 301, destination: "/final/?keep=1#yes", hops: 1 }, archive: expect.objectContaining({ status: 301, destination: "/final/?keep=1#yes", hops: 2 }) }),
      expect.objectContaining({ code: "archive-redirect-became-output", route: "/redirect-to-output/", archive: { status: 301, destination: "/final-output/?kept=1#target", hops: 1 } }),
      expect.objectContaining({ code: "archive-200-became-redirect", route: "/redirect-body/" }),
      expect.objectContaining({ code: "archive-redirect-meta-missing", route: "/redirect-no-meta/" }),
    ]));
    expect(report.observations.some((observation: { route?: string }) => observation.route === "/redirect-match/")).toBe(false);
    expect(report.observations.some((observation: { code: string }) => observation.code === "surface-rule-missing")).toBe(false);
    expect(report.observations.some((observation: { code: string }) => observation.code === "coverage-mismatch")).toBe(false);

    const fullReport = await collectArchiveBuiltAudit({ repository: root, archiveDirectory: archive, outDirectory: out, artifactPath, inventoryPath, routeLedgerPath: ledgerPath, decisionsPath, config: { origin: "https://old.test", excludeSelectors: [".volatile"], expectedCoverage: { comparedPages: 999 }, surfaceRules: [{ id: "primary", route: "^/(?:one|two|json-both-invalid|excluded|redirect-to-output)/$", archive: "main", built: "main" }] } });
    expect(fullReport.selection.mode).toBe("full");
    expect(fullReport.observations.some((observation: { route?: string }) => observation.route === "/excluded/")).toBe(false);
    expect(fullReport.observations).toEqual(expect.arrayContaining([expect.objectContaining({ code: "json-ld-archive-parse-error", severity: "Major", route: "/two/" })]));
    expect(fullReport.observations).toEqual(expect.arrayContaining([expect.objectContaining({ code: "json-ld-value-delta", severity: "Major", route: "/two/" })]));
    expect(fullReport.observations.some((observation: { code: string; route?: string }) => observation.code === "json-ld-built-parse-error" && observation.route === "/two/")).toBe(false);
    expect(fullReport.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "json-ld-built-parse-error", severity: "Blocking", route: "/json-both-invalid/" }),
      expect.objectContaining({ code: "json-ld-archive-parse-error", severity: "Major", route: "/json-both-invalid/" }),
      expect.objectContaining({ code: "json-ld-value-delta", severity: "Major", route: "/json-both-invalid/" }),
    ]));
    expect(fullReport.observations.some((observation: { code: string; route?: string }) => observation.code === "archive-redirect-became-output" && observation.route === "/excluded/")).toBe(false);
    expect(fullReport.observations).toEqual(expect.arrayContaining([expect.objectContaining({ code: "coverage-mismatch", field: "comparedPages", expected: 999 })]));

    const cliConfig = join(root, "audit.config.json");
    await writeFile(cliConfig, JSON.stringify({
      schemaVersion: 1,
      repository: ".",
      archiveDirectory: "archive",
      inventory: "archive/inventory.json",
      outDirectory: "out",
      artifact: "artifact.json",
      routeLedger: "routes.json",
      decisions: "decisions.json",
      report: "standard-report.json",
      origin: "https://old.test",
      internalHosts: ["old.test"],
      excludeSelectors: [".volatile"],
      expectedCoverage: { comparedPages: 999 },
      surfaceRules: [{ id: "one", route: "^/one/$", archive: "main", built: "main" }],
    }));
    try {
      execFileSync(process.execPath, [join(process.cwd(), "templates", "next-app", "scripts", "archive-built-audit.mjs"), "--config", cliConfig, "--only", "one"], { stdio: "pipe" });
    } catch { /* Expected unresolved observations; the partial report must still be written. */ }
    await expect(readFile(join(root, "standard-report.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(root, "standard-report.one.partial.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({ selection: { mode: "partial", surfaceIds: ["one"] } });

    await writeFile(join(root, "duplicate.config.json"), JSON.stringify({
      ...JSON.parse(await readFile(cliConfig, "utf8")),
      surfaceRules: [{ id: "duplicate", route: "^/", archive: "main", built: "main" }, { id: "duplicate", route: "^/", archive: "main", built: "main" }],
    }));
    expect(() => execFileSync(process.execPath, [join(process.cwd(), "templates", "next-app", "scripts", "archive-built-audit.mjs"), "--config", join(root, "duplicate.config.json")], { stdio: "pipe" })).toThrow();
  });
});
