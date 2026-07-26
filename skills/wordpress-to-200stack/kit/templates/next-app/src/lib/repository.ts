import { type ContentSnapshot, loadContentSnapshot } from "./content/documents";
import { normalizeRoutePath, type LegacyDocument, type RouteEntry } from "./content/types";

let cached: { snapshot: ContentSnapshot; repository: ContentRepository } | undefined;

export function findRouteByPath(
  routes: readonly RouteEntry[],
  path: readonly string[],
): RouteEntry | undefined {
  const normalized = normalizeRoutePath(path.length === 0 ? "/" : `/${path.map((segment) => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  }).join("/")}`);
  return routes.find((entry) => normalizeRoutePath(entry.path) === normalized);
}

export class ContentRepository {
  private constructor(
    private readonly documents: LegacyDocument[],
    private readonly routes: RouteEntry[],
    private readonly documentsById: Map<string, LegacyDocument>,
  ) {}

  static async load(): Promise<ContentRepository> {
    const snapshot = await loadContentSnapshot();
    if (cached?.snapshot !== snapshot) {
      cached = {
        snapshot,
        repository: new ContentRepository(
          snapshot.documents,
          snapshot.routes,
          new Map(snapshot.documents.map((document) => [document.contentId, document])),
        ),
      };
    }
    return cached.repository;
  }

  allRoutes(): RouteEntry[] { return this.routes; }

  allDocuments(): readonly LegacyDocument[] { return this.documents; }

  byApi(api: string): LegacyDocument[] {
    return this.documents.filter((document) => document.api === api);
  }

  findByRoute(path: string[]): LegacyDocument | undefined {
    const route = findRouteByPath(this.routes, path);
    return route ? this.documentsById.get(route.contentId) : undefined;
  }

  findByContentId(contentId: string): LegacyDocument | undefined {
    return this.documentsById.get(contentId);
  }

  latestByApi(limit = 3): Array<{ api: string; documents: LegacyDocument[] }> {
    const groups = new Map<string, LegacyDocument[]>();
    for (const document of this.documents) groups.set(document.api, [...(groups.get(document.api) ?? []), document]);
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([api, documents]) => ({
      api,
      documents: [...documents].sort((left, right) => right.content.publishedAt.localeCompare(left.content.publishedAt)).slice(0, limit),
    }));
  }
}
