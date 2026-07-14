import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { collectMediaUrls, pullMedia, type MediaManifestEntry } from "../src/media/pull.js";
import { pushMedia } from "../src/media/push.js";
import { collectReferencedMediaUrls, transformMedia } from "../src/media/transform.js";
import { collectCmsImageUrls, uploadMedia } from "../src/media/upload.js";
import type { MigrationConfig } from "../src/config.js";

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

function cacheKey(url: string): string { return createHash("sha1").update(url).digest("hex"); }
async function cacheImage(cacheDir: string, url: string, body: Buffer): Promise<void> {
  const key = cacheKey(url);
  await Promise.all([
    writeFile(join(cacheDir, `${key}.bin`), body),
    writeFile(join(cacheDir, `${key}.json`), JSON.stringify({ url, status: 200, contentType: "image/test" })),
  ]);
}

describe("wpkit media transform", () => {
  it("collects document references only, transforms cache hits, and records cache misses without fetching", async () => {
    const root = await tempDir(); const irDir = join(root, "ir"); const cacheDir = join(root, "cache"); const outDir = join(root, "public", "media"); const manifestPath = join(root, "src", "data", "media-manifest.json");
    await (await import("node:fs/promises")).mkdir(irDir, { recursive: true });
    await (await import("node:fs/promises")).mkdir(cacheDir, { recursive: true });
    const jpg = "https://legacy.example.com/wp-content/uploads/2024/large.jpg";
    const png = "https://legacy.example.com/wp-content/uploads/2024/field.png";
    const gif = "https://legacy.example.com/wp-content/uploads/2024/animated.gif";
    const webp = "https://legacy.example.com/wp-content/uploads/2024/already.webp";
    const missing = "https://legacy.example.com/wp-content/uploads/2024/missing.jpg";
    const ignoredAttachment = "https://legacy.example.com/wp-content/uploads/2024/not-referenced.jpg";
    await writeFile(join(irDir, "documents.ndjson"), `${JSON.stringify({
      featuredImage: jpg,
      fields: { image: png },
      repeaters: { gallery: [{ image: gif }, { image: webp }] },
      content: { legacyBodyHtml: `<img src="${missing}" srcset="${jpg} 1x">` },
      assets: [ignoredAttachment],
    })}\n`);
    const jpgBody = await sharp({ create: { width: 20, height: 10, channels: 3, background: "#336699" } }).jpeg().toBuffer();
    const pngBody = await sharp({ create: { width: 8, height: 6, channels: 4, background: "#ff0000" } }).png().toBuffer();
    const gifBody = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
    const webpBody = await sharp({ create: { width: 20, height: 10, channels: 3, background: "#00ff00" } }).webp().toBuffer();
    await Promise.all([cacheImage(cacheDir, jpg, jpgBody), cacheImage(cacheDir, png, pngBody), cacheImage(cacheDir, gif, gifBody), cacheImage(cacheDir, webp, webpBody)]);

    expect(collectReferencedMediaUrls([{ featuredImage: jpg, fields: { image: png }, repeaters: { gallery: [{ image: gif }] }, content: { legacyBodyHtml: `<img src="${missing}">` } }])).toEqual([gif, png, jpg, missing]);
    const result = await transformMedia({ irDir, cacheDir, outDir, manifestPath, maxWidth: 10, quality: 70 });

    expect(result.manifest.summary).toMatchObject({ referenced: 5, cached: 4, missing: 1, converted: 3, copied: 1 });
    expect(result.manifest.missing).toEqual([missing]);
    expect(result.entries["/wp-content/uploads/2024/large.jpg"]).toMatchObject({ local: "/media/wp-content/uploads/2024/large.jpg.webp", width: 10, height: 5 });
    expect(result.entries["/wp-content/uploads/2024/animated.gif"]).toMatchObject({ local: "/media/wp-content/uploads/2024/animated.gif", width: 1, height: 1, bytes: gifBody.byteLength });
    expect(await sharp(await readFile(join(outDir, "wp-content/uploads/2024/large.jpg.webp"))).metadata()).toMatchObject({ format: "webp", width: 10, height: 5 });
    expect(await readFile(join(outDir, "wp-content/uploads/2024/animated.gif"))).toEqual(gifBody);
    expect(await sharp(await readFile(join(outDir, "wp-content/uploads/2024/already.webp"))).metadata()).toMatchObject({ format: "webp", width: 10, height: 5 });
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({ missing: [missing] });

    const rerun = await transformMedia({ irDir, cacheDir, outDir, manifestPath, maxWidth: 10, quality: 70 });
    expect(rerun.manifest.summary).toMatchObject({ skipped: 4, converted: 0, copied: 0 });
  });

  it("prints a complete planned manifest without creating output during dry-run", async () => {
    const root = await tempDir(); const irDir = join(root, "ir"); const cacheDir = join(root, "cache"); const outDir = join(root, "public", "media"); const manifestPath = join(root, "src", "data", "media-manifest.json");
    await (await import("node:fs/promises")).mkdir(irDir, { recursive: true });
    await (await import("node:fs/promises")).mkdir(cacheDir, { recursive: true });
    const url = "https://legacy.example.com/wp-content/uploads/2024/dry.jpg";
    await writeFile(join(irDir, "documents.ndjson"), `${JSON.stringify({ featuredImage: url, fields: {}, repeaters: {}, content: { legacyBodyHtml: "" } })}\n`);
    await cacheImage(cacheDir, url, await sharp({ create: { width: 2, height: 2, channels: 3, background: "#ffffff" } }).jpeg().toBuffer());
    const result = await transformMedia({ irDir, cacheDir, outDir, manifestPath, dryRun: true });
    expect(result.entries["/wp-content/uploads/2024/dry.jpg"]).toMatchObject({ local: "/media/wp-content/uploads/2024/dry.jpg.webp" });
    await expect(readFile(manifestPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(outDir, "wp-content/uploads/2024/dry.jpg.webp"))).rejects.toMatchObject({ code: "ENOENT" });
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

const mediaConfig: MigrationConfig = {
  wxr: "fixture.xml",
  site: { origin: "https://old.test", mediaHost: "https://media.test" },
  apis: {
    cars: {
      from: "cars", featuredImage: true,
      fields: [{ metaKey: "card", fieldId: "card", type: "image" }, { metaKey: "name", fieldId: "name", type: "string" }],
      repeaters: [{ fieldId: "gallery", columns: [{ metaKey: "photo", fieldId: "photo", type: "image" }, { metaKey: "caption", fieldId: "caption", type: "string" }] }],
    },
  },
};
function uploadDocument(urls: { featured?: string; card?: string; gallery?: string[] }): Record<string, unknown> {
  return {
    source: { wpId: 1, postType: "cars", status: "publish" }, api: "cars", contentId: "cars-1", route: { legacyUrl: "https://old.test/cars/1", path: "/cars/1", segments: ["cars", "1"], trailingSlash: false },
    content: { title: "car", legacyBodyHtml: `<img src="${urls.featured ?? "https://old.test/body.jpg"}">`, excerpt: "", publishedAt: "2026-01-01" }, seo: {}, taxonomies: [],
    fields: { card: urls.card, name: "ignore" }, repeaters: { gallery: (urls.gallery ?? []).map((photo) => ({ photo, caption: "caption" })) }, relations: [], featuredImage: urls.featured, assets: ["https://old.test/assets-only.jpg"], payloadChecksum: "checksum",
  };
}

describe("wpkit media upload", () => {
  it("uploads CMS image fields from cache only, uses multipart, skips mapped entries, and spaces requests", async () => {
    const root = await tempDir(); const irDir = join(root, "ir"); const cacheDir = join(root, "cache"); const mapPath = join(root, "state", "map.json");
    await (await import("node:fs/promises")).mkdir(irDir, { recursive: true }); await (await import("node:fs/promises")).mkdir(cacheDir, { recursive: true }); await (await import("node:fs/promises")).mkdir(dirname(mapPath), { recursive: true });
    const featured = "https://old.test/wp-content/uploads/a.jpg"; const card = "https://old.test/wp-content/uploads/b.jpg"; const gallery = "https://old.test/wp-content/uploads/c.jpg";
    await writeFile(join(irDir, "documents.ndjson"), `${JSON.stringify(uploadDocument({ featured, card, gallery: [gallery] }))}\n`);
    await Promise.all([cacheImage(cacheDir, featured, Buffer.from("featured")), cacheImage(cacheDir, card, Buffer.from("card")), cacheImage(cacheDir, gallery, Buffer.from("gallery"))]);
    await writeFile(mapPath, JSON.stringify({ [card]: { assetUrl: "https://images.microcms-assets.io/assets/existing", uploadedAt: "2026-01-01T00:00:00.000Z" } }));
    const calls: Array<{ url: string; init?: RequestInit }> = []; const sleeps: number[] = [];
    const result = await uploadMedia({ irDir, cacheDir, config: mediaConfig, mapPath, serviceDomain: "service", apiKey: "key", now: () => new Date("2026-07-15T00:00:00.000Z"), sleep: async (ms) => { sleeps.push(ms); }, fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ url: `https://images.microcms-assets.io/assets/${calls.length}` }), { headers: { "content-type": "application/json" } }); } });
    expect(collectCmsImageUrls([uploadDocument({ featured, card, gallery: [gallery] }) as never], mediaConfig)).toEqual([featured, card, gallery]);
    expect(result).toMatchObject({ referenced: 3, cached: 2, skipped: 1, uploaded: 2, missing: [], failures: [] });
    expect(calls.map((call) => call.url)).toEqual(["https://service.microcms-management.io/api/v1/media", "https://service.microcms-management.io/api/v1/media"]);
    expect(calls[0]?.init?.headers).toEqual({ "X-MICROCMS-API-KEY": "key" });
    expect(calls[0]?.init?.body).toBeInstanceOf(FormData);
    expect(sleeps).toHaveLength(1);
    const map = JSON.parse(await readFile(mapPath, "utf8"));
    expect(map[featured]).toMatchObject({ assetUrl: "https://images.microcms-assets.io/assets/1" });
    expect(map[gallery]).toMatchObject({ assetUrl: "https://images.microcms-assets.io/assets/2" });
  });

  it("reports cache misses and dry-run statistics without auth or requests", async () => {
    const root = await tempDir(); const irDir = join(root, "ir"); const cacheDir = join(root, "cache"); const mapPath = join(root, "map.json");
    await (await import("node:fs/promises")).mkdir(irDir, { recursive: true }); await (await import("node:fs/promises")).mkdir(cacheDir, { recursive: true });
    const hit = "https://old.test/wp-content/uploads/hit.jpg"; const missing = "https://old.test/wp-content/uploads/missing.jpg";
    await writeFile(join(irDir, "documents.ndjson"), `${JSON.stringify(uploadDocument({ featured: hit, card: missing }))}\n`); await cacheImage(cacheDir, hit, Buffer.from("hit"));
    const result = await uploadMedia({ irDir, cacheDir, config: mediaConfig, mapPath, dryRun: true });
    expect(result).toMatchObject({ referenced: 2, cached: 1, sourceBytes: 3, missing: [missing], uploaded: 0, dryRun: true });
    await expect(readFile(mapPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("converts cache files over 5MB to WebP before multipart upload", async () => {
    const root = await tempDir(); const irDir = join(root, "ir"); const cacheDir = join(root, "cache"); const mapPath = join(root, "map.json");
    await (await import("node:fs/promises")).mkdir(irDir, { recursive: true }); await (await import("node:fs/promises")).mkdir(cacheDir, { recursive: true });
    const url = "https://old.test/wp-content/uploads/large.png";
    await writeFile(join(irDir, "documents.ndjson"), `${JSON.stringify(uploadDocument({ featured: url }))}\n`);
    const pixels = Buffer.alloc(2100 * 2100 * 3); for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 31) % 251;
    const large = await sharp(pixels, { raw: { width: 2100, height: 2100, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer(); expect(large.byteLength).toBeGreaterThan(5 * 1024 * 1024);
    await cacheImage(cacheDir, url, large);
    let uploaded: File | undefined;
    const result = await uploadMedia({ irDir, cacheDir, config: mediaConfig, mapPath, serviceDomain: "service", apiKey: "key", sleep: async () => undefined, fetchImpl: async (_url, init) => { uploaded = await (init?.body as FormData).get("file") as File; return new Response(JSON.stringify({ url: "https://images.microcms-assets.io/assets/large" }), { headers: { "content-type": "application/json" } }); } });
    expect(result.oversized).toBe(1); expect(uploaded?.type).toBe("image/webp"); expect(uploaded?.name).toBe("large.webp"); expect((await uploaded?.arrayBuffer())?.byteLength).toBeLessThan(5 * 1024 * 1024);
  });

  it("does not send a converted image that still exceeds microCMS's 5MB cap", async () => {
    const root = await tempDir(); const irDir = join(root, "ir"); const cacheDir = join(root, "cache"); const mapPath = join(root, "map.json");
    await (await import("node:fs/promises")).mkdir(irDir, { recursive: true }); await (await import("node:fs/promises")).mkdir(cacheDir, { recursive: true });
    const url = "https://old.test/wp-content/uploads/alpha-noise.png";
    await writeFile(join(irDir, "documents.ndjson"), `${JSON.stringify(uploadDocument({ featured: url }))}\n`);
    const pixels = Buffer.alloc(2560 * 2560 * 4); let seed = 123456789; for (let index = 0; index < pixels.length; index += 1) { seed = (seed * 1664525 + 1013904223) >>> 0; pixels[index] = seed >>> 24; }
    await cacheImage(cacheDir, url, await sharp(pixels, { raw: { width: 2560, height: 2560, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer());
    let calls = 0;
    const result = await uploadMedia({ irDir, cacheDir, config: mediaConfig, mapPath, serviceDomain: "service", apiKey: "key", fetchImpl: async () => { calls += 1; return new Response(); } });
    expect(calls).toBe(0); expect(result.uploaded).toBe(0); expect(result.failures).toEqual([expect.objectContaining({ url, message: expect.stringContaining("5MB") })]);
  });
});
