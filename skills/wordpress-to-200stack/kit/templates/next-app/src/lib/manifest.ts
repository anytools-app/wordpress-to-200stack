import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type LegacyDocument = {
  /** IR 台帳ではなく microCMS のみのレコードから生成した文書。 */
  synthetic?: true;
  source: { wpId: number; postType: string; status: string; modifiedGmt?: string };
  api: string;
  kind?: string;
  contentId: string;
  route: {
    legacyUrl: string;
    path: string;
    segments: string[];
    trailingSlash: boolean;
    /** contentId 採番により移動したページの、リダイレクト元となる旧パス。 */
    legacyRedirectFrom?: string;
  };
  content: { title: string; legacyBodyHtml: string; excerpt: string; publishedAt: string };
  seo?: { title?: string; description?: string; noindex?: boolean };
  taxonomies: Array<{ taxonomy: string; slug: string; name: string }>;
  fields: Record<string, unknown>;
  repeaters: Record<string, Array<Record<string, unknown>>>;
  relations: Array<{ fieldId: string; toApi: string; targetWpId: number; targetContentId?: string }>;
  featuredImage?: string;
  assets: string[];
  payloadChecksum: string;
};

export type RouteEntry = LegacyDocument["route"] & {
  api: string;
  contentId: string;
  wpId: number;
  legacyUrl: string;
};

export type BuildDataSource = "ir" | "microcms";
export type BuildDataManifest = { source: BuildDataSource };

export function dataDirectory(): string {
  return resolve(process.env.WPKIT_DATA_DIR ?? join(process.cwd(), ".next-data"));
}

export function irDirectory(): string {
  return resolve(process.env.WPKIT_IR_DIR ?? join(process.cwd(), "..", "ir"));
}

function parseNdjson<T>(body: string, fileName: string): T[] {
  return body.split("\n").filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line) as T;
    } catch {
      throw new Error(`${fileName}:${index + 1}: JSON を読み取れません`);
    }
  });
}

async function readJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`${path} を読み取れません: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readIrDocuments(dir = irDirectory()): Promise<LegacyDocument[]> {
  try {
    return parseNdjson<LegacyDocument>(await readFile(join(dir, "documents.ndjson"), "utf8"), "documents.ndjson");
  } catch (error) {
    throw new Error(`IR の documents.ndjson を読み取れません (${dir}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readIrRoutes(dir = irDirectory()): Promise<RouteEntry[]> {
  return readJson<RouteEntry[]>(join(dir, "routes.json"));
}

export async function readCachedDocuments(): Promise<LegacyDocument[]> {
  return readIrDocuments(dataDirectory());
}

export async function readCachedRoutes(): Promise<RouteEntry[]> {
  return readIrRoutes(dataDirectory());
}

export async function readBuildDataManifest(): Promise<BuildDataManifest> {
  return readJson<BuildDataManifest>(join(dataDirectory(), "manifest.json"));
}
