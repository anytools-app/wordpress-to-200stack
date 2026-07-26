import type { MicroCmsRecord } from "./types";

/**
 * microCMS 取得の唯一の窓口。キャッシュ方針を別モジュールへ分散させない。
 *
 * revalidate を省略すると静的生成中にも fetch-cache が stale 扱いになり、ページ数に比例して
 * API リクエストが増える。実案件では 651 ページで約 2,300 リクエストまで増えたため、
 * build は false で凍結し、dev だけ 5 秒で更新する。PAGE_SIZE=50 は Next Data Cache の
 * 1エントリ 2MB 上限に本文の長い記事が近づかないための実測ベースの余裕である。
 * 5xx は移行先や案件に依存しない一時障害として最大5回だけ指数 retry する。恒久的な4xxを
 * retry しないことで、設定ミスを隠さず build を早く失敗させる。プロセス内 snapshot は
 * documents.ts が握り、同一静的生成 worker での JSON parse・正規化の反復を避ける。
 */
const PAGE_SIZE = 50;
const DEV_REVALIDATE_SECONDS = 5;
const MAX_RETRIES = 5;
const isDevelopment = process.env.NODE_ENV === "development";

export const SNAPSHOT_TTL_MS = isDevelopment
  ? DEV_REVALIDATE_SECONDS * 1000
  : Number.POSITIVE_INFINITY;

type MicroCmsListResponse<T> = { contents?: T[]; totalCount?: number };
type NextRequestInit = RequestInit & { next: { revalidate: number | false } };

function credentials(): { root: string; apiKey: string } {
  const serviceDomain = process.env.MICROCMS_SERVICE_DOMAIN;
  const apiKey = process.env.MICROCMS_API_KEY;
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
    const init: NextRequestInit = {
      headers: { "X-MICROCMS-API-KEY": apiKey },
      next: { revalidate: isDevelopment ? DEV_REVALIDATE_SECONDS : false },
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
