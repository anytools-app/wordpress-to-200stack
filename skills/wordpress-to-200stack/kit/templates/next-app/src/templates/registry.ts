import type { ComponentType } from "react";

import { ArticleTemplate, type DocumentTemplateProps } from "./ArticleTemplate";
import { NotImplemented } from "./NotImplemented";

export type TemplateRegistration = {
  component: ComponentType<DocumentTemplateProps>;
};

// 案件固有のテンプレート対応はこのファイルだけを編集する。
// キーは "api" または "api:kind"。未登録の API は ArticleTemplate にフォールバックする。
export const registry: Record<string, TemplateRegistration> = {
  // news: { component: NewsTemplate },
};

export function templateFor(api: string, kind?: string): ComponentType<DocumentTemplateProps> {
  return registry[kind ? `${api}:${kind}` : api]?.component ?? registry[api]?.component ?? ArticleTemplate;
}

export { NotImplemented };
