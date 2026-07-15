import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import * as csstree from "css-tree";

const generatedBundleName = /^bundle-[a-f0-9]{8}\.css$/;

function isAbsoluteUrl(value) {
  return value.startsWith("/") || value.startsWith("#") || value.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(value);
}

function publicPathname(href) {
  const url = new URL(href, "https://legacy-origin.invalid");
  if (url.origin !== "https://legacy-origin.invalid") {
    throw new Error(`CSS source must be a local URL: ${href}`);
  }
  return url.pathname;
}

function sourcePath(sourceDir, href) {
  const pathname = publicPathname(href);
  if (!pathname.startsWith("/")) throw new Error(`CSS source must use a root-relative URL: ${href}`);
  return new URL(`.${pathname}`, `file://${sourceDir}/`).pathname;
}

function rewriteUrl(value, sourceHref) {
  if (!value || isAbsoluteUrl(value)) return value;
  const sourceUrl = new URL(sourceHref, "https://legacy-origin.invalid");
  const resolved = new URL(value, sourceUrl);
  if (resolved.origin !== sourceUrl.origin) return value;
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

function importTarget(node) {
  const prelude = node.prelude ? csstree.generate(node.prelude) : "";
  const match = prelude.match(/^(?:url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)|"([^"]*)"|'([^']*)')(.*)$/i);
  if (!match) throw new Error(`Unsupported @import syntax: ${prelude}`);
  return {
    href: match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5],
    media: match[6],
  };
}

function importHref(sourceHref, href) {
  if (!href || href.startsWith("data:")) throw new Error(`Unsupported @import URL in ${sourceHref}: ${href}`);
  const resolved = new URL(href, new URL(sourceHref, "https://legacy-origin.invalid"));
  if (resolved.origin !== "https://legacy-origin.invalid") {
    throw new Error(`@import must resolve to a local CSS file: ${href}`);
  }
  return `${resolved.pathname}${resolved.search}`;
}

function wrapImportedCss(css, media) {
  if (!media) return css;
  return `@media ${media}{${css}}`;
}

/**
 * Builds CSS bundles from already-vendored, root-relative stylesheet URLs.
 * `originals` remains separate so bundles.json can preserve the source HTML URLs.
 */
export async function writeCssBundles({ sourceDir, outputDir, bundles }) {
  const cssDir = new URL("assets/css/", `file://${outputDir}/`).pathname;
  await mkdir(cssDir, { recursive: true });

  const existing = await readdir(cssDir, { withFileTypes: true });
  await Promise.all(existing
    .filter((entry) => entry.isFile() && generatedBundleName.test(entry.name))
    .map((entry) => unlink(new URL(entry.name, `file://${cssDir}/`).pathname)));

  const bundleManifest = {};
  const hrefByStylesheets = new Map();

  async function inlineCss(sourceHref, importStack, firstCharset) {
    const sourceFile = sourcePath(sourceDir, sourceHref);
    if (importStack.includes(sourceFile)) {
      throw new Error(`Circular CSS @import: ${[...importStack, sourceFile].join(" -> ")}`);
    }

    const source = await readFile(sourceFile, "utf8");
    const ast = csstree.parse(source, { parseCustomProperty: true, parseValue: true });
    const chunks = [];
    const nextStack = [...importStack, sourceFile];

    for (const node of ast.children) {
      if (node.type === "Atrule" && node.name.toLowerCase() === "charset") {
        firstCharset.value ??= csstree.generate(node);
        continue;
      }

      if (node.type === "Atrule" && node.name.toLowerCase() === "import") {
        const { href, media } = importTarget(node);
        const imported = await inlineCss(importHref(sourceHref, href), nextStack, firstCharset);
        chunks.push(wrapImportedCss(imported, media));
        continue;
      }

      csstree.walk(node, {
        visit: "Url",
        enter(url) {
          url.value = rewriteUrl(url.value, sourceHref);
        },
      });
      chunks.push(csstree.generate(node));
    }

    return chunks.join("");
  }

  for (const bundle of bundles) {
    const firstCharset = { value: undefined };
    const contents = [];
    for (const stylesheet of bundle.stylesheets) contents.push(await inlineCss(stylesheet, [], firstCharset));
    const css = csstree.generate(csstree.parse(`${firstCharset.value ?? ""}${contents.join("")}`, {
      parseCustomProperty: true,
      parseValue: true,
    }));
    const hash = createHash("sha256").update(css).digest("hex").slice(0, 8);
    const href = `/assets/css/bundle-${hash}.css`;
    await writeFile(new URL(`bundle-${hash}.css`, `file://${cssDir}/`).pathname, css);
    hrefByStylesheets.set(JSON.stringify(bundle.stylesheets), href);
    bundleManifest[href] = bundle.originals;
  }

  await writeFile(new URL("bundles.json", `file://${cssDir}/`).pathname, `${JSON.stringify(bundleManifest, null, 2)}\n`);
  return { bundleManifest, hrefByStylesheets };
}
