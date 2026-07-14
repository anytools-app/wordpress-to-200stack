import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCached } from "./lib/remote-cache.mjs";

const project = resolve(import.meta.dirname, "..");
// 移行元サイトのオリジン。fetch-once キャッシュ経由で1回だけ取得する(本番保護)。
const ORIGIN = process.env.WPKIT_ORIGIN?.replace(/\/$/, "");
const outDir = join(project, "out");
const MIME_TYPES = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".ico": "image/x-icon", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2" };

function outputPath(pathname) {
  return pathname === "/"
    ? join(outDir, "index.html")
    : extname(pathname)
      ? join(outDir, ...pathname.slice(1).split("/"))
      : join(outDir, ...pathname.slice(1).split("/"), "index.html");
}

function safePath(pathname) {
  const candidate = resolve(outputPath(pathname));
  if (candidate !== outDir && !candidate.startsWith(`${outDir}${sep}`)) throw new Error("invalid path");
  return candidate;
}

function send(response, status, contentType, body, method) {
  response.writeHead(status, { "content-type": contentType });
  response.end(method === "HEAD" ? undefined : body);
}

/** Serve exported files first, then proxy missing assets through the fetch-once remote cache. */
export function createCachedServer() {
  return createServer(async (request, response) => {
    const method = request.method ?? "GET";
    if (!["GET", "HEAD"].includes(method)) {
      send(response, 405, "text/plain; charset=utf-8", "Method not allowed", method);
      return;
    }
    let url;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
      const file = safePath(url.pathname);
      const body = await readFile(file);
      send(response, 200, MIME_TYPES[extname(file)] ?? "application/octet-stream", body, method);
      return;
    } catch {}

    try {
      const cached = ORIGIN ? await resolveCached(`${ORIGIN}${url.pathname}${url.search}`) : null;
      if (cached) {
        send(response, cached.status, cached.contentType, cached.body, method);
        return;
      }
    } catch {}
    send(response, 404, "text/plain; charset=utf-8", "Not found", method);
  });
}

function parsePort(argv) {
  let port = 8899;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--port") throw new Error(`Unknown option: ${argv[index]}`);
    const value = Number(argv[++index]);
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error("--port requires a valid port number");
    port = value;
  }
  return port;
}

async function main() {
  const port = parsePort(process.argv.slice(2));
  if (!ORIGIN) console.warn("WPKIT_ORIGIN 未設定: リモート補完なしで out/ のみ配信します");
  const server = createCachedServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  console.log(`Serving cached export on http://127.0.0.1:${port}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
