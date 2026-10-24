import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import nextEnv from "@next/env";
import { expectedPublicPathForLookup, normalizeLookupPath, trailingSlashFor } from "./lib/seo-contract.mjs";

const project = resolve(import.meta.dirname, "..");
const { loadEnvConfig } = nextEnv;
loadEnvConfig(project);
const outDirectory = resolve(project, process.env.VERIFY_OUT_DIR ?? "out");
const siteOrigin = process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "https://example.invalid";
const expectedOrigin = new URL(siteOrigin).origin;

function rawPathname(value) {
  try {
    return new URL(String(value || "/"), siteOrigin).pathname;
  } catch {
    const path = String(value || "/").split(/[?#]/, 1)[0];
    return path.startsWith("/") ? path : `/${path}`;
  }
}

function outputRoute(value, trailingSlash) {
  return expectedPublicPathForLookup(normalizeLookupPath(value), trailingSlash);
}

function stripJsonComments(source) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      result += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") result += "\n";
        index += 1;
      }
      index += 1;
      continue;
    }
    result += char;
  }
  return result;
}

function removeTrailingCommas(source) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (/\s/.test(source[lookahead] ?? "")) lookahead += 1;
      if (source[lookahead] === "}" || source[lookahead] === "]") continue;
    }
    result += char;
  }
  return result;
}

function parseJsonc(source) {
  return JSON.parse(removeTrailingCommas(stripJsonComments(source)));
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function canonicalValue(html) {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!attribute(tag, "rel")?.split(/\s+/).includes("canonical")) continue;
    const href = attribute(tag, "href");
    if (!href) return { href, invalid: true };
    try {
      const url = new URL(href, siteOrigin);
      return {
        href,
        absolute: /^https?:\/\//i.test(href),
        origin: url.origin,
        publicPath: `${url.pathname}${url.search}${url.hash}`,
        resolved: url.href,
      };
    } catch {
      return { href, invalid: true };
    }
  }
  return undefined;
}

async function outputRoutes(directory, trailingSlash, values = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await outputRoutes(path, trailingSlash, values);
    else if (entry.name === "index.html") {
      const directoryName = relative(outDirectory, resolve(path, ".."));
      const route = outputRoute(directoryName ? `/${directoryName.split(sep).join("/")}` : "/", trailingSlash);
      const html = await readFile(path, "utf8");
      values.push({ route, canonical: canonicalValue(html) });
    }
  }
  return values;
}

function destinationFor(rule, pathname) {
  if (rule.patternSyntax === "regex") {
    const match = new RegExp(rule.source).exec(pathname);
    return match ? rule.destination.replace(/\$(\d+)/g, (_all, index) => match[Number(index)] ?? "") : undefined;
  }
  return rawPathname(rule.source) === pathname ? rule.destination : undefined;
}

function statusFor(rule) {
  return rule.statusCode ?? rule.status;
}

const [legacyRoutes, routingConfig, seoContract] = await Promise.all([
  readFile(join(project, "src", "data", "legacy-routes.json"), "utf8").then(JSON.parse),
  readFile(join(project, "routing-config.jsonc"), "utf8").then(parseJsonc),
  readFile(join(project, "seo-contract.config.json"), "utf8").then(JSON.parse),
]);
const trailingSlash = trailingSlashFor(seoContract);
const emitted = await outputRoutes(outDirectory, trailingSlash);
const output = new Set(emitted.map(({ route }) => route));
const duplicateOutputPaths = emitted
  .map(({ route }) => route)
  .filter((route, index, routes) => routes.indexOf(route) !== index);
const unreachable = legacyRoutes.flatMap((entry) => {
  const oldPath = rawPathname(entry.path);
  if (output.has(oldPath)) return [];
  const matchingRule = routingConfig.rules.find((rule) => destinationFor(rule, oldPath) !== undefined);
  const destination = matchingRule ? destinationFor(matchingRule, oldPath) : undefined;
  return destination && statusFor(matchingRule) === 301 && output.has(rawPathname(destination))
    ? []
    : [
        {
          oldPath,
          destination: destination && rawPathname(destination),
          status: matchingRule && statusFor(matchingRule),
        },
      ];
});
const ruleSourceKeys = routingConfig.rules.map(
  (rule) =>
    `${rule.patternSyntax ?? "exact"}:${rule.patternSyntax === "regex" ? rule.source : rawPathname(rule.source)}`,
);
const duplicateRuleSources = ruleSourceKeys.filter((source, index) => ruleSourceKeys.indexOf(source) !== index);
const routesByCanonical = new Map();
for (const { route, canonical } of emitted) {
  if (!canonical?.resolved) continue;
  routesByCanonical.set(canonical.resolved, [...(routesByCanonical.get(canonical.resolved) ?? []), route]);
}
const canonicalCollisions = [...routesByCanonical.entries()]
  .filter(([, routes]) => new Set(routes).size > 1)
  .map(([canonical, routes]) => ({ canonical, routes: [...new Set(routes)].sort() }));
const errorRoutes = new Set([outputRoute("/404", trailingSlash), outputRoute("/_not-found", trailingSlash)]);
const canonicalMismatches = emitted.flatMap(({ route, canonical }) => {
  if (errorRoutes.has(route)) return [];
  const reasons = [];
  if (!canonical) reasons.push("missing");
  else {
    if (canonical.invalid) reasons.push("invalid");
    if (!canonical.absolute) reasons.push("not-absolute");
    if (canonical.origin !== expectedOrigin) reasons.push("origin");
    if (canonical.publicPath !== route) reasons.push("public-path");
  }
  return reasons.length ? [{ route, canonical, expected: { origin: expectedOrigin, publicPath: route }, reasons }] : [];
});
const non301Rules = routingConfig.rules.filter((rule) => statusFor(rule) !== 301).map((rule) => rule.id ?? rule.source);
const normalizationRedirectErrors = emitted.flatMap(({ route }) => {
  if (route === "/" || errorRoutes.has(route)) return [];
  const source = trailingSlash ? route.replace(/\/$/, "") : `${route}/`;
  const rule = routingConfig.rules.find((candidate) => destinationFor(candidate, source) !== undefined);
  if (!rule) return [{ route, source, reason: "missing-redirect" }];
  const destination = destinationFor(rule, source);
  if (statusFor(rule) !== 301)
    return [{ route, source, rule: rule.id ?? rule.source, reason: "status", actual: statusFor(rule) }];
  if (rawPathname(destination) !== route) {
    return [{ route, source, rule: rule.id ?? rule.source, reason: "destination", actual: rawPathname(destination) }];
  }
  if (destinationFor(rule, route) !== undefined) {
    return [{ route, source, rule: rule.id ?? rule.source, reason: "canonical-loop" }];
  }
  return [];
});
const urlPolicyErrors =
  typeof seoContract?.urlPolicy?.trailingSlash === "boolean"
    ? []
    : [{ item: "urlPolicy.trailingSlash", message: "seo-contract.config.json must declare a boolean" }];

const result = {
  legacyRoutes: legacyRoutes.length,
  outputPaths: output.size,
  unreachable,
  duplicateOutputPaths: [...new Set(duplicateOutputPaths)],
  duplicateRuleSources: [...new Set(duplicateRuleSources)],
  canonicalCollisions,
  canonicalMismatches,
  normalizationRedirectErrors,
  urlPolicyErrors,
  non301Rules,
};
console.log(JSON.stringify(result, null, 2));
if (
  unreachable.length ||
  duplicateOutputPaths.length ||
  duplicateRuleSources.length ||
  canonicalCollisions.length ||
  canonicalMismatches.length ||
  normalizationRedirectErrors.length ||
  urlPolicyErrors.length ||
  non301Rules.length
) {
  process.exitCode = 1;
}
