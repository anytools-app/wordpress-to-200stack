import type { ComponentType } from "react";

import type { SearchIndexRegistry } from "@/lib/search-index";
import { ArticleTemplate, type DocumentTemplateProps } from "./ArticleTemplate";
import { NotImplemented } from "./NotImplemented";

export type TemplateRegistration = {
  component: ComponentType<DocumentTemplateProps>;
  /** 一覧検索で public/data に公開してよいフィールドだけを記載する。 */
  searchIndex?: { fields: readonly string[] };
};

// 案件固有のテンプレート対応はこのファイルだけを編集する。
// キーは "api" または "api:kind"。未登録の API は ArticleTemplate にフォールバックする。
export const registry: Record<string, TemplateRegistration> = {
  // news: { component: NewsTemplate, searchIndex: { fields: ["content.title", "fields.category"] } },
};

export const searchIndexRegistry: SearchIndexRegistry = Object.entries(registry)
  .reduce<Record<string, { fields: readonly string[] }>>((indexes, [key, entry]) => {
    if (!entry.searchIndex) return indexes;
    const api = key.split(":", 1)[0]!;
    indexes[api] = { fields: [...new Set([...(indexes[api]?.fields ?? []), ...entry.searchIndex.fields])] };
    return indexes;
  }, {});

export function templateFor(api: string, kind?: string): ComponentType<DocumentTemplateProps> {
  return registry[kind ? `${api}:${kind}` : api]?.component ?? registry[api]?.component ?? ArticleTemplate;
}

export { NotImplemented };
