import { fetchMicroCmsApis, SNAPSHOT_TTL_MS } from "./client";
import { documentsFromMicroCms, MICROCMS_APIS, routesFromDocuments } from "./microcms-document";
import type { LegacyDocument, RouteEntry } from "./types";

export type ContentSnapshot = { documents: LegacyDocument[]; routes: RouteEntry[] };

async function fetchSnapshot(apis: readonly string[]): Promise<ContentSnapshot> {
  const records = await fetchMicroCmsApis(apis);
  const documents = documentsFromMicroCms(records, apis);
  const routes = routesFromDocuments(documents);
  const duplicatePaths = routes.filter(
    (route, index) => routes.findIndex((candidate) => candidate.path === route.path) !== index,
  );
  if (duplicatePaths.length) {
    throw new Error(`routes に重複があります: ${duplicatePaths.map(({ path }) => path).join(", ")}`);
  }
  return { documents, routes };
}

let snapshot: { startedAt: number; value: Promise<ContentSnapshot> } | undefined;

/** build はプロセスごとに固定、dev は client.ts と同じ5秒で更新する Promise snapshot。 */
export function loadContentSnapshot(
  apis: readonly string[] = MICROCMS_APIS,
): Promise<ContentSnapshot> {
  if (snapshot && performance.now() - snapshot.startedAt < SNAPSHOT_TTL_MS) {
    return snapshot.value;
  }
  const pending = { startedAt: performance.now(), value: fetchSnapshot(apis) };
  snapshot = pending;
  pending.value.catch(() => {
    if (snapshot === pending) snapshot = undefined;
  });
  return pending.value;
}
