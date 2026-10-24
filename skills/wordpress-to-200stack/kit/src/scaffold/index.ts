import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SiteFramework = "next" | "astro";
const templates = fileURLToPath(new URL("../../templates/", import.meta.url));
const ignored = new Set(["node_modules", ".next", ".astro", "out", "dist", "_scratch", "tsconfig.tsbuildinfo"]);
const shared = [
  "scripts", "docs", "routing-config.jsonc", "seo-contract.config.json",
  "blocks.config.json", "fidelity-audit.config.json", "fidelity-decisions.config.json", "fidelity-text.config.json",
  "src/data", "src/lib/content/types.ts", "src/lib/content/microcms-document.ts",
  "src/lib/content/documents.ts", "src/lib/repository.ts", "src/lib/media.ts", "src/lib/legacy-html.tsx",
  "src/templates", "src/components/LegacyHtml.tsx",
];

/** Shared audits and CMS normalization are copied from one maintained source into either framework. */
export async function scaffoldSite(options: { framework: string; outDir: string }): Promise<{ framework: SiteFramework; outDir: string }> {
  if (options.framework !== "next" && options.framework !== "astro") throw new Error("framework は next または astro を指定してください");
  const framework = options.framework;
  const outDir = resolve(options.outDir);
  try {
    await lstat(outDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dirname(outDir), { recursive: true });
    // mkdir without recursive rejects a concurrently-created destination, including symlinks.
    await mkdir(outDir);
    const copy = async (from: string, to: string): Promise<void> => {
      await mkdir(dirname(to), { recursive: true });
      await cp(from, to, { recursive: true, filter: (path) => !path.split(/[\\/]/).some((part) => ignored.has(part)) });
    };
    if (framework === "next") await copy(resolve(templates, "next-app"), outDir);
    else {
      for (const path of shared) await copy(resolve(templates, "next-app", path), resolve(outDir, path));
      await copy(resolve(templates, "astro-app"), outDir);
      // The same preview renderer and sanitizer run in production SSR and the browser island.
      const preview = (await readFile(resolve(templates, "next-app/src/app/preview/PreviewClient.tsx"), "utf8"))
        .replace('"use client";\n', "")
        .replace('import { useSearchParams } from "next/navigation";\n', "")
        .replace('useSearchParams()', 'new URLSearchParams(window.location.search)')
        .replaceAll('process.env.NEXT_PUBLIC_', 'import.meta.env.PUBLIC_');
      await writeFile(resolve(outDir, "src/components/PreviewClient.tsx"), preview);
      const mediaPath = resolve(outDir, "src/lib/media.ts");
      await writeFile(mediaPath, (await readFile(mediaPath, "utf8")).replaceAll("process.env.NEXT_PUBLIC_", "import.meta.env.PUBLIC_"));
      for (const name of ["verify-seo.mjs", "verify-routes.mjs"]) {
        const path = resolve(outDir, "scripts", name);
        await writeFile(path, (await readFile(path, "utf8"))
          .replace('import nextEnv from "@next/env";', 'import { loadEnvConfig } from "./lib/load-env.mjs";')
          .replace('const { loadEnvConfig } = nextEnv;\n', "")
          .replaceAll('NEXT_PUBLIC_SITE_ORIGIN', 'PUBLIC_SITE_ORIGIN'));
      }
    }
    return { framework, outDir };
  }
  throw new Error(`出力先は既に存在します。新しいディレクトリを指定してください: ${outDir}`);
}
