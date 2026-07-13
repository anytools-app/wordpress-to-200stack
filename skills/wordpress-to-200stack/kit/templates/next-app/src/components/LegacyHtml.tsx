import { sanitizeLegacyHtml } from "../lib/legacy-html";

export function LegacyHtml({ html, iframeHosts }: { html: string; iframeHosts?: readonly string[] }) {
  const safeHtml = sanitizeLegacyHtml(html, iframeHosts);
  // HTML の直接挿入はこのコンポーネントに閉じ込める。
  return <div data-testid="legacy-html" dangerouslySetInnerHTML={{ __html: safeHtml }} />;
}
