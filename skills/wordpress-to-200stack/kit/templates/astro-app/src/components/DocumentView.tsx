import type { LegacyDocument } from "@/lib/content/types";
import { templateFor } from "@/templates/registry";

// Production static HTML and the CSR preview use the same registry and article component.
export default function DocumentView({ document }: { document: LegacyDocument }) {
  const Template = templateFor(document.api, document.kind);
  return <Template document={document} />;
}
