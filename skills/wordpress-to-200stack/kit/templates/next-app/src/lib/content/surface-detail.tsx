import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ContentRepository } from "@/lib/repository";
import { templateFor } from "@/templates/registry";

export type SurfaceDetailPageProps = { params: Promise<{ id: string }> };

export async function surfaceDetailParams(api: string): Promise<Array<{ id: string }>> {
  const repository = await ContentRepository.load();
  return repository.byApi(api).map((document) => ({ id: document.contentId }));
}

async function findDocument(api: string, id: string) {
  const repository = await ContentRepository.load();
  const document = repository.findByContentId(id);
  return document?.api === api ? document : undefined;
}

export async function surfaceDetailMetadata(api: string, id: string): Promise<Metadata> {
  const document = await findDocument(api, id);
  if (!document) return {};
  return {
    title: document.seo?.title || document.content.title,
    description: document.seo?.description || document.content.excerpt || undefined,
    alternates: { canonical: document.route.path },
    robots: document.seo?.noindex ? { index: false, follow: false } : undefined,
  };
}

export async function renderSurfaceDetail(api: string, id: string) {
  const document = await findDocument(api, id);
  if (!document) return notFound();
  const Template = templateFor(document.api, document.kind);
  return <Template document={document} />;
}
