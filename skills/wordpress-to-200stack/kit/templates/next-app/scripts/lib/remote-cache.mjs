import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { get as getHttp } from "node:http";
import { get as getHttps } from "node:https";
import { extname, join, resolve } from "node:path";

const project = resolve(import.meta.dirname, "../..");
const cacheDir = join(project, "_scratch", "remote-cache");
const archiveAssetsDir = process.env.WPKIT_ARCHIVE_ASSETS ?? join(project, "_scratch", "archive", "assets");
const inFlight = new Map();
const failed = new Set();

const CONTENT_TYPES = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function cacheKey(url) {
  return createHash("sha1").update(url).digest("hex");
}

function contentTypeFor(url) {
  try {
    return CONTENT_TYPES[extname(new URL(url).pathname).toLowerCase()] ?? "application/octet-stream";
  } catch {
    return "application/octet-stream";
  }
}

function cachePaths(url) {
  const key = cacheKey(url);
  return { body: join(cacheDir, `${key}.bin`), meta: join(cacheDir, `${key}.json`) };
}

async function readRemoteCache(url) {
  const { body, meta } = cachePaths(url);
  if (!existsSync(body) || !existsSync(meta)) return null;
  try {
    const [contents, rawMeta] = await Promise.all([readFile(body), readFile(meta, "utf8")]);
    const metadata = JSON.parse(rawMeta);
    if (metadata.url !== url || !Number.isInteger(metadata.status) || metadata.status < 200 || metadata.status >= 300) return null;
    return { body: contents, contentType: metadata.contentType || contentTypeFor(url), status: metadata.status };
  } catch {
    return null;
  }
}

async function writeRemoteCache(url, result) {
  const { body, meta } = cachePaths(url);
  const suffix = `${process.pid}-${Date.now()}`;
  try {
    await mkdir(cacheDir, { recursive: true });
    await Promise.all([
      writeFile(`${body}.${suffix}.tmp`, result.body),
      writeFile(`${meta}.${suffix}.tmp`, `${JSON.stringify({
        url,
        contentType: result.contentType,
        status: result.status,
        fetchedAt: new Date().toISOString(),
      })}\n`),
    ]);
    await Promise.all([rename(`${body}.${suffix}.tmp`, body), rename(`${meta}.${suffix}.tmp`, meta)]);
  } catch {
    await Promise.all([`${body}.${suffix}.tmp`, `${meta}.${suffix}.tmp`].map((path) => unlink(path).catch(() => {})));
  }
}

function archivePaths(url) {
  const paths = [join(archiveAssetsDir, encodeURIComponent(url))];
  // The existing archive was written by wp-static-kit as host + pathname.
  // Keep this fallback so old captures become cache entries without a refetch.
  try {
    const parsed = new URL(url);
    paths.push(join(archiveAssetsDir, encodeURIComponent(`${parsed.host}${parsed.pathname}`)));
  } catch {}
  return paths;
}

async function readArchiveAsset(url) {
  for (const path of archivePaths(url)) {
    try {
      const body = await readFile(path);
      return { body, contentType: contentTypeFor(url), status: 200 };
    } catch {}
  }
  return null;
}

function requestRemote(url, redirects = 0) {
  return new Promise((resolveRequest) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolveRequest(null);
      return;
    }
    const get = parsed.protocol === "https:" ? getHttps : parsed.protocol === "http:" ? getHttp : null;
    if (!get) {
      resolveRequest(null);
      return;
    }

    const request = get(parsed, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location && redirects < 5) {
        response.resume();
        try {
          requestRemote(new URL(location, parsed).href, redirects + 1).then(resolveRequest);
        } catch {
          resolveRequest(null);
        }
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        resolveRequest(null);
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("error", () => resolveRequest(null));
      response.once("end", () => resolveRequest({
        body: Buffer.concat(chunks),
        contentType: typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : contentTypeFor(url),
        status,
      }));
    });
    request.setTimeout(10_000, () => request.destroy());
    request.once("error", () => resolveRequest(null));
  });
}

async function resolveUncached(url) {
  const archive = await readArchiveAsset(url);
  if (archive) {
    await writeRemoteCache(url, archive);
    return archive;
  }
  const remote = await requestRemote(url);
  if (!remote) return null;
  await writeRemoteCache(url, remote);
  return remote;
}

/** Resolve a URL without re-fetching a successful or already-failed request in this process. */
export async function resolveCached(url) {
  const cached = await readRemoteCache(url);
  if (cached) return cached;
  if (failed.has(url)) return null;
  if (!inFlight.has(url)) {
    inFlight.set(url, resolveUncached(url).then((result) => {
      if (!result) failed.add(url);
      return result;
    }).finally(() => inFlight.delete(url)));
  }
  return inFlight.get(url);
}

function isLocal(url) {
  return url.protocol === "file:" || ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
}

/** Route external browser requests through the disk cache, returning a deterministic 404 on a miss. */
export async function installCacheRoutes(context, { hosts = [] } = {}) {
  const configuredHosts = new Set(hosts.map((host) => host.toLowerCase()));
  await context.route("**/*", async (route) => {
    let url;
    try {
      url = new URL(route.request().url());
    } catch {
      await route.continue();
      return;
    }
    const shouldIntercept = configuredHosts.has(url.hostname.toLowerCase()) || !isLocal(url);
    if (!shouldIntercept || !["http:", "https:"].includes(url.protocol)) {
      await route.continue();
      return;
    }
    const cached = await resolveCached(url.href);
    if (!cached) {
      await route.fulfill({ status: 404, contentType: "text/plain; charset=utf-8", body: "Not found" });
      return;
    }
    await route.fulfill({ status: cached.status, contentType: cached.contentType, body: cached.body });
  });
}
