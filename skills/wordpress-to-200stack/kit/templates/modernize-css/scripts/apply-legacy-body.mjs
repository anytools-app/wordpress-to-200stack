import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { bodyFor } from "./lib/legacy-chrome-resolve.mjs";

const project = resolve(import.meta.dirname, "..");
const outDir = join(project, "out");
const legacyMeta = JSON.parse(await readFile(join(project, ".next-data", "legacy-meta.json"), "utf8"));

async function htmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => entry.isDirectory()
    ? htmlFiles(join(directory, entry.name))
    : entry.name === "index.html" ? [join(directory, entry.name)] : []));
  return nested.flat();
}

function pathFor(file) {
  const relativePath = relative(outDir, file).replaceAll("\\", "/");
  if (relativePath === "index.html") return "/";
  const directory = relativePath.replace(/\/index\.html$/, "");
  return directory ? `/${directory}` : "/";
}

function bodyTag(path) {
  const body = bodyFor(legacyMeta, path);
  if (!body) return undefined;
  const attributes = [body.className && `class="${body.className}"`, body.id && `id="${body.id}"`].filter(Boolean);
  return `<body${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
}

const files = await htmlFiles(outDir);
await Promise.all(files.map(async (file) => {
  const html = await readFile(file, "utf8");
  const tag = bodyTag(pathFor(file));
  const updated = tag ? html.replace(/<body\b[^>]*>/i, tag) : html;
  if (updated !== html) await writeFile(file, updated);
}));

console.log(JSON.stringify({
  pages: files.length,
  bodyMetadata: Object.keys(legacyMeta.byPath).length,
}));
