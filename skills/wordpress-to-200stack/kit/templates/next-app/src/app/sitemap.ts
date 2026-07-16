import type { MetadataRoute } from "next";

import { ContentRepository } from "@/lib/repository";

export const dynamic = "force-static";

function siteUrl(): URL { return new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"); }

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const repository = await ContentRepository.load();
  return repository.allRoutes().flatMap((route) => {
    const document = repository.findByRoute(route.segments);
    if (!document || document.seo?.noindex) return [];
    const lastModified = document.source.modifiedGmt || document.content.publishedAt;
    return [{ url: new URL(route.path, siteUrl()).toString(), ...(lastModified ? { lastModified } : {}) }];
  });
}
