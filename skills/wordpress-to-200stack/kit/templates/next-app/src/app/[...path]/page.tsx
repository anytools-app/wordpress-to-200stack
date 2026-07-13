import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ContentRepository } from "../../lib/repository";
import { templateFor } from "../../templates/registry";

type PageProps = { params: Promise<{ path: string[] }> };

export const dynamicParams = false;

export async function generateStaticParams(): Promise<Array<{ path: string[] }>> {
  const repository = await ContentRepository.load();
  // / は src/app/page.tsx が担当するため、required catch-all には渡さない。
  return repository.allRoutes().filter((route) => route.segments.length > 0).map((route) => ({ path: route.segments }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const repository = await ContentRepository.load();
  const document = repository.findByRoute((await params).path);
  if (!document) return {};
  const title = document.seo?.title || document.content.title;
  return {
    title,
    description: document.seo?.description || document.content.excerpt || undefined,
    alternates: { canonical: document.route.path },
    robots: document.seo?.noindex ? { index: false, follow: false } : undefined,
  };
}

export default async function LegacyRoutePage({ params }: PageProps) {
  const repository = await ContentRepository.load();
  const document = repository.findByRoute((await params).path);
  if (!document) return notFound();
  const Template = templateFor(document.api, document.kind);
  return <Template document={document} />;
}
