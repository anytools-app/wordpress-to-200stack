import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const project = resolve(import.meta.dirname, "..");
const outDirectory = join(project, "out");
const fixture = JSON.parse(
  await readFile(join(project, "scripts", "fixtures", "forms.json"), "utf8"),
);

async function htmlFiles(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await htmlFiles(path, files);
    else if (entry.name === "index.html") files.push(path);
  }
  return files;
}

function routeFor(file) {
  const directory = relative(outDirectory, resolve(file, ".."));
  return directory ? `/${directory.split(sep).join("/")}/` : "/";
}

function attribute(tag, name) {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function stable(entries) {
  return [...entries].sort((left, right) =>
    left.path.localeCompare(right.path) ||
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

const directForms = [];
const embeddedForms = [];
for (const file of await htmlFiles(outDirectory)) {
  const path = routeFor(file);
  const html = await readFile(file, "utf8");
  for (const match of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)) {
    const openingTag = match[0].match(/^<form\b[^>]*>/i)?.[0] ?? "";
    const action = attribute(openingTag, "action");
    if (!action) continue;
    const names = [...match[0].matchAll(/<(input|textarea|select)\b[^>]*>/gi)]
      .flatMap((field) => {
        const name = attribute(field[0], "name");
        return name ? [name] : [];
      });
    directForms.push({ path, action, names });
  }
  for (const match of html.matchAll(/\bdata-formrun-form\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    embeddedForms.push({ path, formId: match[1] ?? match[2] });
  }
}

const actual = {
  directForms: stable(directForms),
  embeddedForms: stable(embeddedForms),
};
const expected = {
  directForms: stable(fixture.directForms ?? []),
  embeddedForms: stable(fixture.embeddedForms ?? []),
};
const matches = JSON.stringify(actual) === JSON.stringify(expected);
console.log(JSON.stringify({ fixture: "scripts/fixtures/forms.json", matches, expected, actual }, null, 2));
if (!matches) process.exitCode = 1;
