import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const project = resolve(import.meta.dirname, "..");
const outDirectory = resolve(project, process.env.VERIFY_OUT_DIR ?? "out");

function normalizePath(value) {
  const path = String(value || "/").split(/[?#]/, 1)[0];
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  return withSlash === "/" ? "/" : `${withSlash.replace(/\/+$/, "")}/`;
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
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
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
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
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
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function canonicalPath(html, route) {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!attribute(tag, "rel")?.split(/\s+/).includes("canonical")) continue;
    const href = attribute(tag, "href");
    if (!href) break;
    try {
      return normalizePath(new URL(href, "https://example.invalid").pathname);
    } catch {
      break;
    }
  }
  return route;
}

async function outputRoutes(directory, values = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await outputRoutes(path, values);
    else if (entry.name === "index.html") {
      const directoryName = relative(outDirectory, resolve(path, ".."));
      const route = normalizePath(directoryName ? `/${directoryName.split(sep).join("/")}` : "/");
      const html = await readFile(path, "utf8");
      values.push({ route, canonical: canonicalPath(html, route) });
    }
  }
  return values;
}

function destinationFor(rule, pathname) {
  if (rule.patternSyntax === "regex") {
    const match = new RegExp(rule.source).exec(pathname);
    return match
      ? rule.destination.replace(/\$(\d+)/g, (_all, index) => match[Number(index)] ?? "")
      : undefined;
  }
  return normalizePath(rule.source) === pathname ? rule.destination : undefined;
}

const [legacyRoutes, routingConfig, emitted] = await Promise.all([
  readFile(join(project, "src", "data", "legacy-routes.json"), "utf8").then(JSON.parse),
  readFile(join(project, "routing-config.jsonc"), "utf8").then(parseJsonc),
  outputRoutes(outDirectory),
]);
const output = new Set(emitted.map(({ route }) => route));
const duplicateOutputPaths = emitted
  .map(({ route }) => route)
  .filter((route, index, routes) => routes.indexOf(route) !== index);
const unreachable = legacyRoutes.flatMap((entry) => {
  const oldPath = normalizePath(entry.path);
  if (output.has(oldPath)) return [];
  const destination = routingConfig.rules
    .map((rule) => destinationFor(rule, oldPath))
    .find(Boolean);
  return destination && output.has(normalizePath(destination))
    ? []
    : [{ oldPath, destination: destination && normalizePath(destination) }];
});
const ruleSourceKeys = routingConfig.rules.map((rule) =>
  `${rule.patternSyntax ?? "exact"}:${
    rule.patternSyntax === "regex" ? rule.source : normalizePath(rule.source)
  }`,
);
const duplicateRuleSources = ruleSourceKeys.filter(
  (source, index) => ruleSourceKeys.indexOf(source) !== index,
);
const routesByCanonical = new Map();
for (const { route, canonical } of emitted) {
  routesByCanonical.set(canonical, [...(routesByCanonical.get(canonical) ?? []), route]);
}
const canonicalCollisions = [...routesByCanonical.entries()]
  .filter(([, routes]) => new Set(routes).size > 1)
  .map(([canonical, routes]) => ({ canonical, routes: [...new Set(routes)].sort() }));
const non301Rules = routingConfig.rules
  .filter((rule) => rule.statusCode !== 301)
  .map((rule) => rule.id ?? rule.source);

const result = {
  legacyRoutes: legacyRoutes.length,
  outputPaths: output.size,
  unreachable,
  duplicateOutputPaths: [...new Set(duplicateOutputPaths)],
  duplicateRuleSources: [...new Set(duplicateRuleSources)],
  canonicalCollisions,
  non301Rules,
};
console.log(JSON.stringify(result, null, 2));
if (
  unreachable.length ||
  duplicateOutputPaths.length ||
  duplicateRuleSources.length ||
  canonicalCollisions.length ||
  non301Rules.length
) process.exitCode = 1;
