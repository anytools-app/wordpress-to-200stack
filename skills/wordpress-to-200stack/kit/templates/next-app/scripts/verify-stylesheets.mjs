import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const project = resolve(import.meta.dirname, "..");
const fixture = JSON.parse(
  await readFile(join(project, "scripts", "fixtures", "stylesheets.json"), "utf8"),
);
const outputFile = (pathname) =>
  pathname === "/"
    ? join(project, "out", "index.html")
    : join(project, "out", ...pathname.replace(/^\/|\/$/g, "").split("/"), "index.html");
const attribute = (tag, name) => {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
};
const stylesheetHrefs = (html) =>
  [...html.matchAll(/<link\b[^>]*>/gi)]
    .filter((match) => attribute(match[0], "rel")?.split(/\s+/).includes("stylesheet"))
    .flatMap((match) => {
      const href = attribute(match[0], "href");
      return href ? [href.replaceAll("&amp;", "&")] : [];
    });

const report = [];
for (const target of fixture.targets ?? []) {
  const actual = stylesheetHrefs(await readFile(outputFile(target.path), "utf8"));
  const retainedLegacyStylesheets = (target.legacyStylesheets ?? [])
    .filter((href) => actual.includes(href));
  const expectedMatches = !Array.isArray(target.expectedStylesheets) ||
    JSON.stringify(actual) === JSON.stringify(target.expectedStylesheets);
  report.push({
    path: target.path,
    actual,
    retainedLegacyStylesheets,
    expectedStylesheets: target.expectedStylesheets,
    expectedMatches,
    valid: retainedLegacyStylesheets.length === 0 && expectedMatches,
  });
}
console.log(JSON.stringify(report, null, 2));
if (report.some((entry) => !entry.valid)) process.exitCode = 1;
