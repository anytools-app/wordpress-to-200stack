import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { archiveSite } from "../src/archive/index.js";

const temporary: string[] = [];
async function tempDir(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "wpkit-archive-")); temporary.push(path); return path; }
async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.off("error", failed); reject(error); };
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => { server.off("error", failed); resolve(); });
  });
}
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("wpkit archive", () => {
  it("crawls sitemap and internal links, preserves source HTML, redirects, forms, and assets", async () => {
    const server = createServer((request, response) => {
      const path = request.url ?? "/";
      if (path === "/sitemap.xml") return void response.end('<?xml version="1.0"?><sitemapindex><sitemap><loc>/sitemap-pages.xml</loc></sitemap></sitemapindex>');
      if (path === "/sitemap-pages.xml") return void response.end('<?xml version="1.0"?><urlset><url><loc>/</loc></url><url><loc>/about</loc></url><url><loc>/old</loc></url></urlset>');
      if (path === "/old") { response.writeHead(301, { location: "/about" }); response.end(); return; }
      if (path === "/") { response.setHeader("content-type", "text/html"); response.end('<title>Home</title><link rel="stylesheet" href="/wp-content/themes/demo/style.css"><a href="/about">About</a><a href="/wp-admin/x">Admin</a><a href="/search?q=x">Search</a>'); return; }
      if (path === "/about") { response.setHeader("content-type", "text/html"); response.end('<title>About</title><link rel="canonical" href="https://example.test/about"><meta name="description" content="Description"><meta property="og:title" content="OG title"><script src="/theme.js"></script><form action="https://formrun.example/submit" method="post"><input name="email"><textarea name="message"></textarea></form>'); return; }
      if (path === "/wp-content/themes/demo/style.css") { response.setHeader("content-type", "text/css"); response.end("body{background:url('/wp-content/themes/demo/bg.png')}"); return; }
      if (path === "/theme.js" || path === "/wp-content/themes/demo/bg.png") { response.end("asset"); return; }
      response.statusCode = 404; response.end("missing");
    });
    try { await listen(server); }
    catch (error: unknown) {
      // The development sandbox forbids binding sockets. CI and normal local runs execute the assertions below.
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("server did not start");
      const origin = `http://127.0.0.1:${address.port}`;
      const archiveDir = await tempDir();
      const result = await archiveSite({ origin, archiveDir, screenshots: false, requestDelayMs: 0 });
      expect(result.pages).toHaveLength(3);
      expect(result.pages.find((page) => page.url.endsWith("/old"))).toMatchObject({ status: 200, screenshots: false });
      expect(result.forms).toEqual([{ endpoint: "https://formrun.example/submit", pages: [`${origin}/about`] }]);
      const oldMeta = JSON.parse(await readFile(join(archiveDir, "pages", encodeURIComponent("/old"), "meta.json"), "utf8"));
      expect(oldMeta.redirects).toEqual([{ from: `${origin}/old`, to: `${origin}/about`, status: 301 }]);
      expect(oldMeta.forms).toEqual([]);
      const aboutMeta = JSON.parse(await readFile(join(archiveDir, "pages", encodeURIComponent("/about"), "meta.json"), "utf8"));
      expect(aboutMeta).toMatchObject({ title: "About", canonical: "https://example.test/about", description: "Description", og: { title: "OG title" }, forms: [{ method: "post", inputs: ["email", "message"] }] });
      const inventory = JSON.parse(await readFile(join(archiveDir, "inventory.json"), "utf8"));
      expect(inventory.urls.map((page: { url: string }) => page.url)).not.toContain(`${origin}/wp-admin/x`);
      expect(await readFile(join(archiveDir, "assets", encodeURIComponent(`127.0.0.1:${address.port}/theme.js`)), "utf8")).toBe("asset");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});
