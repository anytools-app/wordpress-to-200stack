import { readdir, readFile, rmdir, unlink } from "node:fs/promises";
import * as csstree from "css-tree";

const generatedBundleName = /^bundle-[a-f0-9]{8}\.css$/;
const surfaceGuards = new Map([
  ["/wp-content/themes/YOUR-THEME/css/index.css", "home"],
  ["/wp-content/themes/YOUR-THEME/css/page.css", "page"],
  ["/wp-content/themes/YOUR-THEME/css/recruit.css", "page"],
  ["/wp-content/themes/YOUR-THEME/css/archive.css", "archive"],
  ["/wp-content/themes/YOUR-THEME/css/gallery.css", "archive"],
  ["/wp-content/themes/YOUR-THEME/css/vendor.css", "archive"],
  ["/wp-content/themes/YOUR-THEME/css/single.css", "single"],
  ["/wp-content/themes/YOUR-THEME/css/detail.css", "single"],
]);

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

function ensureFontDisplaySwap(ast) {
  csstree.walk(ast, {
    visit: "Atrule",
    enter(node) {
      if (node.name.toLowerCase() !== "font-face" || !node.block) return;
      let has = false;
      node.block.children.forEach((child) => {
        if (child.type === "Declaration" && child.property.toLowerCase() === "font-display") has = true;
      });
      if (!has) node.block.children.appendData({
        type: "Declaration",
        important: false,
        property: "font-display",
        value: { type: "Raw", value: "swap" },
      });
    },
  });
}

function wrapImportedCss(css, media) {
  return media ? `@media ${media}{${css}}` : css;
}

function selectorStrings(ast) {
  const selectors = new Set();
  csstree.walk(ast, {
    visit: "Rule",
    enter(node) {
      if (this.atrule?.name.toLowerCase().endsWith("keyframes")) return;
      if (node.prelude.type !== "SelectorList") return;
      node.prelude.children.forEach((selector) => selectors.add(csstree.generate(selector)));
    },
  });
  return selectors;
}

function normalizeLegacySelectorHacks(ast) {
  let count = 0;
  csstree.walk(ast, {
    visit: "Rule",
    enter(node) {
      if (this.atrule?.name.toLowerCase().endsWith("keyframes")) return;
      if (node.prelude.type !== "SelectorList") return;
      const selector = csstree.generate(node.prelude);
      const normalized = selector.replace(/_:-ms-lang\(x\)::(?:-ms-)?backdrop/gi, () => {
        count += 1;
        // These selectors are IE-only parser hacks. Next's CSS parser rejects
        // them, while :not(*) preserves their no-match behavior in modern UAs.
        return ":not(*)";
      });
      if (normalized !== selector) node.prelude = csstree.parse(normalized, { context: "selectorList" });
    },
  });
  return count;
}

function isLeadingElement(selector, element) {
  return new RegExp(`^${element}(?=$|[.#[:\\s>+~])`, "i").test(selector);
}

function scopeSurfaceRules(ast, guard, source, unscopable) {
  csstree.walk(ast, {
    visit: "Rule",
    enter(node) {
      if (this.atrule?.name.toLowerCase().endsWith("keyframes")) return;
      if (node.prelude.type !== "SelectorList") return;

      const selectors = node.prelude.children.toArray().map((selectorNode) => {
        const selector = csstree.generate(selectorNode);
        if (isLeadingElement(selector, "html") || /^:root(?=$|[.#[:\s>+~])/i.test(selector)) {
          unscopable.push({ source, selector });
          return selector;
        }
        if (isLeadingElement(selector, "body")) {
          return selector.replace(/^body/i, (body) => `${body}:where(.${guard})`);
        }
        return `:where(body.${guard}) ${selector}`;
      });

      node.prelude = csstree.parse(selectors.join(","), { context: "selectorList" });
    },
  });
}

function countAtRules(ast, name) {
  let count = 0;
  csstree.walk(ast, {
    visit: "Atrule",
    enter(node) {
      if (node.name.toLowerCase() === name) count += 1;
    },
  });
  return count;
}

function countRules(ast) {
  let count = 0;
  csstree.walk(ast, {
    visit: "Rule",
    enter() {
      count += 1;
    },
  });
  return count;
}

function originalLooksLikeFontOrYtPlayer(original) {
  return /(?:fonts\.googleapis\.com|font-awesome|yakuhanjp|YTPlayer)/i.test(original);
}

export function guardForStylesheet(href) {
  const pathname = new URL(href, "https://legacy-origin.invalid").pathname;
  return surfaceGuards.get(pathname);
}

/**
 * Returns one deterministic topological order that preserves every legacy
 * stylesheet configuration's relative order.
 */
export function mergeStylesheetConfigurations(configurations) {
  const nodes = new Map();
  let nextIndex = 0;

  for (const configuration of configurations) {
    for (let index = 0; index < configuration.stylesheets.length; index += 1) {
      const href = configuration.stylesheets[index];
      const original = configuration.originals[index];
      const node = nodes.get(href) ?? { href, originals: new Set(), after: new Set(), index: nextIndex++ };
      node.originals.add(original);
      nodes.set(href, node);
    }

    for (let left = 0; left < configuration.stylesheets.length; left += 1) {
      for (let right = left + 1; right < configuration.stylesheets.length; right += 1) {
        const before = configuration.stylesheets[left];
        const after = configuration.stylesheets[right];
        if (before !== after) nodes.get(before).after.add(after);
      }
    }
  }

  const incoming = new Map([...nodes.keys()].map((href) => [href, 0]));
  for (const node of nodes.values()) {
    for (const after of node.after) incoming.set(after, incoming.get(after) + 1);
  }

  const ready = [...nodes.values()].filter((node) => incoming.get(node.href) === 0);
  const ordered = [];
  while (ready.length) {
    ready.sort((left, right) => left.index - right.index);
    const node = ready.shift();
    ordered.push({
      href: node.href,
      originals: [...node.originals],
      guard: guardForStylesheet(node.href),
    });
    for (const after of node.after) {
      incoming.set(after, incoming.get(after) - 1);
      if (incoming.get(after) === 0) ready.push(nodes.get(after));
    }
  }

  if (ordered.length !== nodes.size) {
    const cycle = [...incoming].filter(([, count]) => count > 0).map(([href]) => href);
    throw new Error(`Conflicting legacy stylesheet order: ${cycle.join(", ")}`);
  }
  return ordered;
}

/** Removes only outputs produced by the retired seven-bundle generator. */
export async function removeLegacyBundleOutputs(outputDir) {
  const cssDir = new URL("assets/css/", `file://${outputDir}/`).pathname;
  let entries;
  try {
    entries = await readdir(cssDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await Promise.all(entries
    .filter((entry) => entry.isFile() && (generatedBundleName.test(entry.name) || entry.name === "bundles.json"))
    .map((entry) => unlink(new URL(entry.name, `file://${cssDir}/`).pathname)));
  try {
    await rmdir(cssDir);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
  }
}

/** Builds the single, minified legacy stylesheet without writing it. */
export async function buildLegacyCss({ sourceDir, sources }) {
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

  const firstCharset = { value: undefined };
  const chunks = [];
  const selectorSets = new Map();
  const fontFaceCounts = new Map();
  const unscopableSurfaceSelectors = [];
  let legacySelectorHacksNormalized = 0;
  let expectedRules = 0;

  for (const source of sources) {
    const inlined = await inlineCss(source.href, [], firstCharset);
    const ast = csstree.parse(inlined, { parseCustomProperty: true, parseValue: true });
    expectedRules += countRules(ast);
    legacySelectorHacksNormalized += normalizeLegacySelectorHacks(ast);
    selectorSets.set(source.href, selectorStrings(ast));
    fontFaceCounts.set(source.href, countAtRules(ast, "font-face"));
    if (source.guard) scopeSurfaceRules(ast, source.guard, source.originals[0], unscopableSurfaceSelectors);
    chunks.push(csstree.generate(ast));
  }

  const ast = csstree.parse(`${firstCharset.value ?? ""}${chunks.join("")}`, {
    parseCustomProperty: true,
    parseValue: true,
  });
  ensureFontDisplaySwap(ast);
  const css = csstree.generate(ast);
  const actualRules = countRules(ast);
  if (actualRules !== expectedRules) {
    throw new Error(`CSS rule count changed while merging: expected ${expectedRules}, got ${actualRules}`);
  }

  const surfaceSelectors = new Set();
  const fontAndYtPlayerSelectors = new Set();
  let firstSurfaceIndex = -1;
  sources.forEach((source, index) => {
    if (source.guard && firstSurfaceIndex === -1) firstSurfaceIndex = index;
    if (source.guard) {
      for (const selector of selectorSets.get(source.href)) surfaceSelectors.add(selector);
      return;
    }
    if (source.originals.every(originalLooksLikeFontOrYtPlayer)) {
      for (const selector of selectorSets.get(source.href)) fontAndYtPlayerSelectors.add(selector);
    }
    if (index > firstSurfaceIndex && firstSurfaceIndex !== -1) {
      if (!source.originals.every(originalLooksLikeFontOrYtPlayer)) {
        throw new Error(`Unexpected global stylesheet after a surface stylesheet: ${source.originals.join(", ")}`);
      }
    }
  });
  const selectorOverlap = [...surfaceSelectors].filter((selector) => fontAndYtPlayerSelectors.has(selector));
  if (selectorOverlap.length) {
    throw new Error(`Surface/font/YTPlayer selector overlap: ${selectorOverlap.join(", ")}`);
  }

  const expectedFontFaces = [...fontFaceCounts.values()].reduce((sum, count) => sum + count, 0);
  const actualFontFaces = countAtRules(ast, "font-face");
  if (actualFontFaces !== expectedFontFaces) {
    throw new Error(`@font-face count changed while merging: expected ${expectedFontFaces}, got ${actualFontFaces}`);
  }

  return {
    css,
    report: {
      sources: sources.length,
      rules: actualRules,
      fontFaces: actualFontFaces,
      surfaceFontAndYtPlayerSelectorOverlap: selectorOverlap.length,
      legacySelectorHacksNormalized,
      unscopableSurfaceSelectors,
    },
  };
}
