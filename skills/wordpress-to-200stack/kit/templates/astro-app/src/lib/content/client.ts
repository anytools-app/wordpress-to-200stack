import type { MicroCmsRecord } from "./types";

/** Build-time microCMS reader. Snapshot lifetime is owned by documents.ts. */
const PAGE_SIZE = 50;
const DEV_REVALIDATE_SECONDS = 5;
const MAX_RETRIES = 5;
const isDevelopment = import.meta.env.DEV;

export const SNAPSHOT_TTL_MS = isDevelopment
  ? DEV_REVALIDATE_SECONDS * 1000
  : Number.POSITIVE_INFINITY;

type MicroCmsListResponse<T> = { contents?: T[]; totalCount?: number };

function credentials(): { root: string; apiKey: string } {
  const serviceDomain = import.meta.env.MICROCMS_SERVICE_DOMAIN;
  const apiKey = import.meta.env.MICROCMS_API_KEY;
  if (!serviceDomain || !apiKey) {
    throw new Error("MICROCMS_SERVICE_DOMAIN と MICROCMS_API_KEY が必要です");
  }
  if (!/^[a-z0-9-]+$/i.test(serviceDomain)) {
    throw new Error("MICROCMS_SERVICE_DOMAIN が不正です");
  }
  return { root: `https://${serviceDomain}.microcms.io/api/v1`, apiKey };
}

function retryAfterMilliseconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function fetchPage(url: string, apiKey: string): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const init: RequestInit = {
      headers: { "X-MICROCMS-API-KEY": apiKey },
    };
    const response = await fetch(url, init);
    if (response.status < 500 || attempt >= MAX_RETRIES) return response;
    const backoff = retryAfterMilliseconds(response) ?? Math.min(500 * 2 ** attempt, 8_000);
    await new Promise((resolve) => setTimeout(resolve, backoff));
  }
}

export async function fetchMicroCmsList<T extends MicroCmsRecord>(api: string): Promise<T[]> {
  const { root, apiKey } = credentials();
  const values: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const response = await fetchPage(
      `${root}/${encodeURIComponent(api)}?limit=${PAGE_SIZE}&offset=${offset}`,
      apiKey,
    );
    if (!response.ok) {
      throw new Error(`microCMS ${api} の取得に失敗しました: HTTP ${response.status}`);
    }
    const body = (await response.json()) as MicroCmsListResponse<T>;
    const contents = body.contents ?? [];
    values.push(...contents);
    if (
      contents.length < PAGE_SIZE ||
      (typeof body.totalCount === "number" && values.length >= body.totalCount)
    ) {
      return values;
    }
  }
}

export async function fetchMicroCmsApis(
  apis: readonly string[],
): Promise<Record<string, MicroCmsRecord[]>> {
  return Object.fromEntries(
    await Promise.all(
      apis.map(async (api) => [api, await fetchMicroCmsList<MicroCmsRecord>(api)] as const),
    ),
  );
}
