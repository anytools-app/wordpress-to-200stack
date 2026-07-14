import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it } from "vitest";

import { collectMediaUrls, pullMedia, type MediaManifestEntry } from "../src/media/pull.js";
import { pushMedia } from "../src/media/push.js";

const temporary: string[] = [];
async function tempDir(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "wpkit-media-")); temporary.push(path); return path; }
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("wpkit media pull", () => {
  it("combines original, derived, and document uploads while removing duplicates", () => {
    expect(collectMediaUrls([{ wpId: 1, url: "https://old.test/wp-content/uploads/2024/a.jpg", path: "/wp-content/uploads/2024/a.jpg", derivedSizes: [{ name: "thumb", file: "a-150x150.jpg" }] }], [{ assets: ["https://old.test/wp-content/uploads/2024/a.jpg?ver=2", "https://old.test/not-media.jpg"] }], true)).toEqual([
      "https://old.test/wp-content/uploads/2024/a-150x150.jpg",
      "https://old.test/wp-content/uploads/2024/a.jpg",
    ]);
  });

  it("retries transient responses, rejects HTML, writes a manifest, and skips matching files on rerun", async () => {
    const root = await tempDir(); const irDir = join(root, "ir"); const mediaDir = join(root, "media");
    await (await import("node:fs/promises")).mkdir(irDir);
    await writeFile(join(irDir, "attachments.ndjson"), `${JSON.stringify({ wpId: 1, url: "https://old.test/wp-content/uploads/2024/a.jpg", path: "/wp-content/uploads/2024/a.jpg", derivedSizes: [{ name: "thumb", file: "a-150x150.jpg" }] })}\n`);
    await writeFile(join(irDir, "documents.ndjson"), `${JSON.stringify({ assets: ["https://old.test/wp-content/uploads/2024/html.jpg", "https://old.test/wp-content/uploads/2024/retry.jpg"] })}\n`);
    const calls = new Map<string, number>();
    const mockedFetch: typeof fetch = async (input) => {
      const url = String(input); calls.set(url, (calls.get(url) ?? 0) + 1);
      if (url.endsWith("html.jpg")) return new Response("<html>wrong</html>", { headers: { "content-type": "text/html" } });
      if (url.endsWith("retry.jpg") && calls.get(url) === 1) return new Response("temporary", { status: 503 });
      const body = url.endsWith("retry.jpg") ? "retry" : url.endsWith("150x150.jpg") ? "thumb" : "original";
      return new Response(body, { headers: { "content-type": "image/jpeg", "content-length": String(Buffer.byteLength(body)) } });
    };
    const first = await pullMedia({ irDir, mediaDir, includeDerived: true, fetchImpl: mockedFetch, sleep: async () => undefined, adaptive: false });
    expect(first).toMatchObject({ ok: 3, invalid: 1, missing: 0, skipped: 0 });
    expect(calls.get("https://old.test/wp-content/uploads/2024/retry.jpg")).toBe(2);
    const manifest = (await readFile(join(mediaDir, "manifest.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as MediaManifestEntry);
    expect(manifest.find((entry) => entry.sourceUrl.endsWith("html.jpg"))).toMatchObject({ status: "invalid-type", contentType: "text/html" });
    expect(await readFile(join(mediaDir, "wp-content/uploads/2024/a-150x150.jpg"), "utf8")).toBe("thumb");
    const second = await pullMedia({ irDir, mediaDir, includeDerived: true, fetchImpl: mockedFetch, sleep: async () => undefined, adaptive: false });
    expect(second.skipped).toBe(3);
  });
});

describe("wpkit media push", () => {
  it("skips identical remote objects and reports only changes during dry-run", async () => {
    const mediaDir = await tempDir();
    const matching: MediaManifestEntry = { sourceUrl: "https://old.test/wp-content/uploads/a.jpg", path: "/wp-content/uploads/a.jpg", bytes: 3, contentType: "image/jpeg", sha256: "same", status: "ok", fetchedAt: "2026-01-01T00:00:00.000Z" };
    const changed: MediaManifestEntry = { ...matching, path: "/wp-content/uploads/b.jpg", sha256: "changed" };
    await writeFile(join(mediaDir, "manifest.ndjson"), `${JSON.stringify(matching)}\n${JSON.stringify(changed)}\n`);
    await (await import("node:fs/promises")).mkdir(join(mediaDir, "wp-content/uploads"), { recursive: true });
    await Promise.all([writeFile(join(mediaDir, "wp-content/uploads/a.jpg"), "aaa"), writeFile(join(mediaDir, "wp-content/uploads/b.jpg"), "bbb")]);
    const commands: Array<HeadObjectCommand | PutObjectCommand> = [];
    const client = { send: async (command: HeadObjectCommand | PutObjectCommand) => {
      commands.push(command);
      const input = command.input as { Key?: string };
      if (command instanceof HeadObjectCommand && input.Key?.endsWith("a.jpg")) return { Metadata: { sha256: "same" } };
      if (command instanceof HeadObjectCommand) throw { $metadata: { httpStatusCode: 404 } };
      return {};
    } };
    const result = await pushMedia({ mediaDir, bucket: "bucket", prefix: "assets", dryRun: true, client });
    expect(result).toEqual({ uploaded: ["assets/wp-content/uploads/b.jpg"], skipped: ["assets/wp-content/uploads/a.jpg"], dryRun: true });
    expect(commands.filter((command) => command instanceof PutObjectCommand)).toHaveLength(0);
  });
});
