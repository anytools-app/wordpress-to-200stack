"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import {
  documentFromMicroCms,
  MICROCMS_APIS,
} from "@/lib/content/microcms-document";
import type { MicroCmsRecord } from "@/lib/content/types";
import { templateFor } from "@/templates/registry";

type PreviewState =
  | { status: "idle" | "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; api: string; record: MicroCmsRecord };

export function PreviewClient() {
  const searchParams = useSearchParams();
  const api = searchParams.get("api") ?? "";
  const contentId = searchParams.get("contentId") ?? "";
  const draftKey = searchParams.get("draftKey") ?? "";
  const [state, setState] = useState<PreviewState>({ status: "idle" });

  useEffect(() => {
    if (!api) {
      setState({ status: "idle" });
      return;
    }
    if (!MICROCMS_APIS.includes(api)) {
      setState({ status: "error", message: `未登録の API です: ${api}` });
      return;
    }
    const domain = process.env.NEXT_PUBLIC_MICROCMS_SERVICE_DOMAIN;
    const apiKey = process.env.NEXT_PUBLIC_MICROCMS_PREVIEW_KEY;
    if (!domain || !apiKey || !/^[a-z0-9-]+$/i.test(domain)) {
      setState({
        status: "error",
        message: "公開用の microCMS service domain / read-only preview key が必要です",
      });
      return;
    }
    const controller = new AbortController();
    const url = new URL(
      `https://${domain}.microcms.io/api/v1/${encodeURIComponent(api)}${
        contentId ? `/${encodeURIComponent(contentId)}` : ""
      }`,
    );
    if (!contentId) url.searchParams.set("limit", "1");
    if (draftKey) url.searchParams.set("draftKey", draftKey);
    setState({ status: "loading" });
    fetch(url, {
      headers: { "X-MICROCMS-API-KEY": apiKey },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`microCMS preview: HTTP ${response.status}`);
        const body = await response.json() as MicroCmsRecord | { contents?: MicroCmsRecord[] };
        const list = body as { contents?: MicroCmsRecord[] };
        const record = Array.isArray(list.contents) ? list.contents[0] : (body as MicroCmsRecord);
        if (!record || typeof record.id !== "string") {
          throw new Error("preview 対象のコンテンツがありません");
        }
        setState({ status: "ready", api, record });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [api, contentId, draftKey]);

  let preview = <p>API を選択してください。</p>;
  if (state.status === "loading") preview = <p>読み込み中...</p>;
  if (state.status === "error") preview = <p role="alert">{state.message}</p>;
  if (state.status === "ready") {
    const document = documentFromMicroCms(state.api, state.record);
    const Template = templateFor(document.api, document.kind);
    preview = <Template document={document} />;
  }

  return <main>
    <h1>microCMS Preview</h1>
    <form method="get">
      <label>API
        <select name="api" defaultValue={api}>
          <option value="">選択してください</option>
          {MICROCMS_APIS.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label>contentId
        <input name="contentId" defaultValue={contentId} />
      </label>
      <label>draftKey
        <input name="draftKey" defaultValue={draftKey} />
      </label>
      <button type="submit">表示</button>
    </form>
    {preview}
  </main>;
}
