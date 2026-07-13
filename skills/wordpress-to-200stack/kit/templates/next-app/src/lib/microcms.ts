export type MicroCmsRecord = { id: string; [field: string]: unknown };

type MicroCmsListResponse<T> = { contents?: T[]; totalCount?: number };

function apiRoot(serviceDomain: string): string {
  if (!/^[a-z0-9-]+$/i.test(serviceDomain)) throw new Error("MICROCMS_SERVICE_DOMAIN が不正です");
  return `https://${serviceDomain}.microcms.io/api/v1`;
}

/** microCMS のリスト API を limit=100 で最後まで取得する。ビルド時のみ使用する。 */
export async function fetchAllMicroCms<T extends MicroCmsRecord>(api: string, options: {
  serviceDomain?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<T[]> {
  const serviceDomain = options.serviceDomain ?? process.env.MICROCMS_SERVICE_DOMAIN;
  const apiKey = options.apiKey ?? process.env.MICROCMS_API_KEY;
  if (!serviceDomain || !apiKey) throw new Error("MICROCMS_SERVICE_DOMAIN と MICROCMS_API_KEY が必要です");

  const fetchImpl = options.fetchImpl ?? fetch;
  const root = apiRoot(serviceDomain);
  const values: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const response = await fetchImpl(`${root}/${encodeURIComponent(api)}?limit=100&offset=${offset}`, {
      headers: { "X-MICROCMS-API-KEY": apiKey },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`microCMS ${api} の取得に失敗しました: HTTP ${response.status}`);
    const body = await response.json() as MicroCmsListResponse<T>;
    const contents = body.contents ?? [];
    values.push(...contents);
    if (contents.length < 100 || (typeof body.totalCount === "number" && values.length >= body.totalCount)) return values;
  }
}

export async function fetchMicroCmsApis(apis: readonly string[]): Promise<Record<string, MicroCmsRecord[]>> {
  return Object.fromEntries(await Promise.all(apis.map(async (api) => [api, await fetchAllMicroCms<MicroCmsRecord>(api)] as const)));
}
