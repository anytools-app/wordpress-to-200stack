import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as cheerio from "cheerio";

import { extractScfDefinitions, type ScfDefinition } from "../core/scf.js";
import type { WxrExport, WxrItem } from "../core/wxr.js";

export type AnalyzeOptions = { sampleLimit?: number; sampleBytes?: number };

export type UrlPattern = {
  pattern: string;
  count: number;
  examples: string[];
  trailingSlash: { with: number; without: number };
};

export type AnalyzeResult = {
  census: {
    postTypes: Record<string, Record<string, number>>;
    taxonomies: Record<string, Array<{ slug: string; name: string; uses: number }>>;
    taxonomyTermCounts: Record<string, number>;
    authors: WxrExport["authors"];
    attachments: number;
    sanitizeReport: WxrExport["sanitizeReport"];
  };
  metaKeys: Record<string, Array<{ key: string; count: number }>>;
  urlPatterns: Record<string, UrlPattern[]>;
  customPermalinks: Array<{ wpId: number; link: string; customPermalink: string }>;
  scfDefinitions: ScfDefinition[];
  embeds: Record<string, {
    iframes: Record<string, number>;
    scripts: { hosts: Record<string, number>; inline: number };
    tables: number;
    images: Record<string, number>;
  }>;
  samples: Record<string, string[]>;
  warnings: string[];
  mappingScaffold: string;
};

function increment(map: Record<string, number>, key: string, amount = 1): void {
  map[key] = (map[key] ?? 0) + amount;
}

function sortedEntries(counts: Record<string, number>): Array<{ key: string; count: number }> {
  return Object.entries(counts)
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function hostOf(value: string | undefined): string {
  if (!value) return "(missing)";
  try {
    return new URL(value.startsWith("//") ? `https:${value}` : value).host || "(relative)";
  } catch {
    return "(relative)";
  }
}

function pathnameOf(link: string): string {
  try {
    return new URL(link).pathname || "/";
  } catch {
    return link.split(/[?#]/, 1)[0] || "/";
  }
}

function urlPatternFor(item: WxrItem, stableSegments: Map<number, string | undefined>): string {
  const pathname = pathnameOf(item.link);
  const segments = pathname.split("/").filter(Boolean);
  const patternSegments = segments.map((segment, index) => {
    if (/%[0-9A-Fa-f]{2}/.test(segment)) return "{encoded}";
    if (/^\d{4}$/.test(segment)) return "{yyyy}";
    if (/^\d+$/.test(segment)) {
      const previous = segments[index - 1];
      return previous !== undefined && /^\d{4}$/.test(previous) && /^\d{2}$/.test(segment) ? "{mm}" : "{n}";
    }
    return stableSegments.get(index) === segment ? segment : "{slug}";
  });
  return `/${patternSegments.join("/")}${pathname.endsWith("/") && pathname !== "/" ? "/" : ""}`;
}

function makeUrlPatterns(items: WxrItem[]): Record<string, UrlPattern[]> {
  const byType = new Map<string, WxrItem[]>();
  for (const item of items) {
    const typed = byType.get(item.postType) ?? [];
    typed.push(item);
    byType.set(item.postType, typed);
  }
  const output: Record<string, UrlPattern[]> = {};
  for (const [postType, typedItems] of byType) {
    const valuesByPosition = new Map<number, Set<string>>();
    for (const item of typedItems) {
      pathnameOf(item.link).split("/").filter(Boolean).forEach((segment, index) => {
        const values = valuesByPosition.get(index) ?? new Set<string>();
        values.add(segment);
        valuesByPosition.set(index, values);
      });
    }
    const stableSegments = new Map<number, string | undefined>(
      [...valuesByPosition.entries()].map(([index, values]) => [index, values.size === 1 ? [...values][0] : undefined]),
    );
    const patterns = new Map<string, UrlPattern>();
    for (const item of typedItems) {
      const pattern = urlPatternFor(item, stableSegments);
      const current = patterns.get(pattern) ?? {
        pattern,
        count: 0,
        examples: [],
        trailingSlash: { with: 0, without: 0 },
      };
      current.count += 1;
      if (current.examples.length < 3) current.examples.push(item.link);
      if (pathnameOf(item.link).endsWith("/")) current.trailingSlash.with += 1;
      else current.trailingSlash.without += 1;
      patterns.set(pattern, current);
    }
    output[postType] = [...patterns.values()].sort((left, right) => right.count - left.count || left.pattern.localeCompare(right.pattern));
  }
  return output;
}

function makeEmbeds(items: WxrItem[]): AnalyzeResult["embeds"] {
  const output: AnalyzeResult["embeds"] = {};
  for (const item of items) {
    const summary = output[item.postType] ?? {
      iframes: {}, scripts: { hosts: {}, inline: 0 }, tables: 0, images: {},
    };
    const document = cheerio.load(item.contentHtml);
    document("iframe").each((_, element) => increment(summary.iframes, hostOf(document(element).attr("src"))));
    document("script").each((_, element) => {
      const source = document(element).attr("src");
      if (source) increment(summary.scripts.hosts, hostOf(source));
      else summary.scripts.inline += 1;
    });
    summary.tables += document("table").length;
    document("img").each((_, element) => increment(summary.images, hostOf(document(element).attr("src"))));
    output[item.postType] = summary;
  }
  return output;
}

function isInternalMeta(key: string): boolean {
  return key.startsWith("_") || key.startsWith("scc_share_count_");
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function makeMappingScaffold(metaKeys: AnalyzeResult["metaKeys"], definitions: ScfDefinition[]): string {
  const postTypes = Object.keys(metaKeys)
    .filter((postType) => postType !== "attachment" && postType !== "smart-custom-fields" && !postType.includes("revision"))
    .sort((left, right) => left.localeCompare(right));
  const lines = [
    "// これは自動生成の雛形。人が編集して mapping.config.ts として確定する。",
    "// import type { MigrationConfig } from \"wp-static-kit\";",
    "export default {",
    "  apis: {",
  ];

  for (const postType of postTypes) {
    const keys = metaKeys[postType] ?? [];
    const repeaters = definitions
      .filter((definition) => !definition.error && definition.conditions.postTypes.includes(postType))
      .flatMap((definition) => definition.groups.filter((group) => group.repeat))
      .map((group) => ({ name: group.name, fields: group.fields.map((field) => field.name) }))
      .filter((group) => group.fields.length > 0 && group.fields.every((field) => keys.some((entry) => entry.key === field)));
    const repeaterFields = new Set(repeaters.flatMap((repeater) => repeater.fields));
    lines.push(`    ${quote(postType)}: {`);
    lines.push(`      from: ${quote(postType)},`);
    lines.push("      fields: {");
    for (const entry of keys) {
      if (repeaterFields.has(entry.key)) continue;
      const fieldLine = `        ${quote(entry.key)}: { from: ${quote(entry.key)} }, // ${entry.count}`;
      lines.push(isInternalMeta(entry.key) ? `        // ${fieldLine.trimStart()}` : fieldLine);
    }
    lines.push("      },");
    if (repeaters.length > 0) {
      lines.push("      repeaters: {");
      for (const repeater of repeaters) {
        lines.push(`        ${quote(repeater.name)}: [${repeater.fields.map(quote).join(", ")}],`);
      }
      lines.push("      },");
    }
    if (keys.some((entry) => entry.key === "_thumbnail_id")) lines.push("      featuredImage: true,");
    if (keys.some((entry) => entry.key.startsWith("_yoast_"))) lines.push("      seo: { yoast: true },");
    lines.push("    },");
  }
  lines.push("  },", "};", "");
  return lines.join("\n");
}

export function analyzeWxr(exp: WxrExport, opts: AnalyzeOptions = {}): AnalyzeResult {
  const postTypes: Record<string, Record<string, number>> = {};
  const taxonomyCounts = new Map<string, Map<string, { name: string; uses: number }>>();
  const metaCounts: Record<string, Record<string, number>> = {};
  const customPermalinks: AnalyzeResult["customPermalinks"] = [];
  for (const item of exp.items) {
    const statuses = postTypes[item.postType] ?? {};
    increment(statuses, item.status);
    postTypes[item.postType] = statuses;
    for (const taxonomy of item.taxonomies) {
      const terms = taxonomyCounts.get(taxonomy.taxonomy) ?? new Map<string, { name: string; uses: number }>();
      const current = terms.get(taxonomy.slug) ?? { name: taxonomy.name, uses: 0 };
      current.uses += 1;
      terms.set(taxonomy.slug, current);
      taxonomyCounts.set(taxonomy.taxonomy, terms);
    }
    if (item.postType !== "attachment") {
      const counts = metaCounts[item.postType] ?? {};
      for (const meta of item.meta) increment(counts, meta.key);
      metaCounts[item.postType] = counts;
    }
    for (const meta of item.meta) {
      if (meta.key === "custom_permalink") customPermalinks.push({ wpId: item.wpId, link: item.link, customPermalink: meta.value });
    }
  }
  const metaKeys = Object.fromEntries(Object.entries(metaCounts).map(([postType, counts]) => [postType, sortedEntries(counts)]));
  const taxonomies = Object.fromEntries([...taxonomyCounts.entries()].map(([taxonomy, terms]) => [
    taxonomy,
    [...terms.entries()].map(([slug, value]) => ({ slug, ...value })).sort((left, right) => left.slug.localeCompare(right.slug)),
  ]));
  const scfDefinitions = extractScfDefinitions(exp.items);
  const sampleLimit = opts.sampleLimit ?? 2;
  const sampleBytes = opts.sampleBytes ?? 12 * 1024;
  const samples: Record<string, string[]> = {};
  for (const item of exp.items) {
    const current = samples[item.postType] ?? [];
    if (current.length < sampleLimit) current.push((item.rawXml ?? "").slice(0, sampleBytes));
    samples[item.postType] = current;
  }
  const warnings = scfDefinitions.filter((definition) => definition.error).map((definition) => `SCF定義「${definition.title}」: ${definition.error}`);
  return {
    census: {
      postTypes,
      taxonomies,
      taxonomyTermCounts: Object.fromEntries(Object.entries(taxonomies).map(([taxonomy, terms]) => [taxonomy, terms.length])),
      authors: exp.authors,
      attachments: exp.items.filter((item) => item.postType === "attachment").length,
      sanitizeReport: exp.sanitizeReport,
    },
    metaKeys,
    urlPatterns: makeUrlPatterns(exp.items),
    customPermalinks,
    scfDefinitions,
    embeds: makeEmbeds(exp.items),
    samples,
    warnings,
    mappingScaffold: makeMappingScaffold(metaKeys, scfDefinitions),
  };
}

function table(rows: Array<Array<string | number>>): string {
  return [
    `| ${rows[0]?.join(" | ") ?? ""} |`,
    `| ${rows[0]?.map(() => "---").join(" | ") ?? ""} |`,
    ...rows.slice(1).map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function censusMarkdown(result: AnalyzeResult): string {
  const lines = ["# WXR Census", "", "## Post types × status", ""];
  for (const [postType, statuses] of Object.entries(result.census.postTypes).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`### ${postType}`, "", table([["status", "count"], ...Object.entries(statuses).sort().map(([status, count]) => [status, count])]), "");
  }
  lines.push("## Taxonomies", "");
  for (const [taxonomy, terms] of Object.entries(result.census.taxonomies).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`### ${taxonomy} (terms: ${result.census.taxonomyTermCounts[taxonomy] ?? 0})`, "", table([["slug", "name", "uses"], ...terms.map((term) => [term.slug, term.name, term.uses])]), "");
  }
  lines.push("## Authors", "", table([["id", "login", "display name"], ...result.census.authors.map((author) => [author.id, author.login, author.displayName])]), "");
  lines.push(`## Attachments\n\n${result.census.attachments}\n`, "## Removed XML controls", "");
  lines.push(result.census.sanitizeReport.length === 0 ? "None" : table([["code point", "count"], ...result.census.sanitizeReport.map((entry) => [`U+${entry.codePoint.toString(16).toUpperCase().padStart(4, "0")}`, entry.count])]), "");
  return lines.join("\n");
}

function metaMarkdown(result: AnalyzeResult): string {
  const lines = ["# Meta key frequencies", ""];
  for (const [postType, entries] of Object.entries(result.metaKeys).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`## ${postType}`, "", table([["count", "meta key"], ...entries.map((entry) => [entry.count, entry.key])]), "");
  }
  return lines.join("\n");
}

function urlMarkdown(result: AnalyzeResult): string {
  const lines = ["# URL patterns", ""];
  for (const [postType, patterns] of Object.entries(result.urlPatterns).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`## ${postType}`, "", table([["pattern", "count", "trailing /", "no trailing /", "examples"], ...patterns.map((pattern) => [pattern.pattern, pattern.count, pattern.trailingSlash.with, pattern.trailingSlash.without, pattern.examples.join("<br>")])]), "");
  }
  lines.push("## custom_permalink", "", table([["wp_id", "link", "custom_permalink"], ...result.customPermalinks.map((entry) => [entry.wpId, entry.link, entry.customPermalink])]), "");
  return lines.join("\n");
}

function embedsMarkdown(result: AnalyzeResult): string {
  const lines = ["# Embedded content", ""];
  for (const [postType, embeds] of Object.entries(result.embeds).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`## ${postType}`, "", "### iframe", "", table([["host", "count"], ...sortedEntries(embeds.iframes).map((entry) => [entry.key, entry.count])]), "");
    lines.push("### script", "", table([["host", "count"], ...sortedEntries(embeds.scripts.hosts).map((entry) => [entry.key, entry.count]), ["inline", embeds.scripts.inline]]), "");
    lines.push(`### table\n\n${embeds.tables}\n`, "### img", "", table([["host", "count"], ...sortedEntries(embeds.images).map((entry) => [entry.key, entry.count])]), "");
  }
  return lines.join("\n");
}

export async function writeAnalysis(result: AnalyzeResult, outDir: string): Promise<void> {
  await mkdir(join(outDir, "samples"), { recursive: true });
  await Promise.all([
    writeFile(join(outDir, "census.json"), `${JSON.stringify(result.census, null, 2)}\n`),
    writeFile(join(outDir, "census.md"), censusMarkdown(result)),
    writeFile(join(outDir, "meta-keys.md"), metaMarkdown(result)),
    writeFile(join(outDir, "url-patterns.md"), urlMarkdown(result)),
    writeFile(join(outDir, "scf-definitions.json"), `${JSON.stringify(result.scfDefinitions, null, 2)}\n`),
    writeFile(join(outDir, "embeds.md"), embedsMarkdown(result)),
    writeFile(join(outDir, "mapping.config.scaffold.ts"), result.mappingScaffold),
    ...Object.entries(result.samples).map(([postType, fragments]) => writeFile(join(outDir, "samples", `${postType.replace(/[^A-Za-z0-9._-]/g, "_")}.xml`), fragments.join("\n\n"))),
  ]);
}
