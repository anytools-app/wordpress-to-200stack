import type { DocumentTemplateProps } from "./ArticleTemplate";

export function NotImplemented({ document }: DocumentTemplateProps) {
  return <article data-testid="template-not-implemented">
    <h1>{document.content.title}</h1>
    <p>テンプレート未実装: {document.api}{document.kind ? ` (${document.kind})` : ""}</p>
  </article>;
}
