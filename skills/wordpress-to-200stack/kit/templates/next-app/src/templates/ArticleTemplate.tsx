import { LegacyHtml } from "../components/LegacyHtml";
import type { LegacyDocument } from "../lib/manifest";

export type DocumentTemplateProps = { document: LegacyDocument };

export function ArticleTemplate({ document }: DocumentTemplateProps) {
  return <article data-testid={`document-${document.contentId}`}>
    <h1>{document.content.title}</h1>
    <LegacyHtml html={document.content.legacyBodyHtml} />
  </article>;
}
