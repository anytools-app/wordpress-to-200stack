import type { APIRoute } from "astro";
import { ContentRepository } from "../lib/repository";
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;").replaceAll(">", "&gt;");
export const GET: APIRoute = async ({ site }) => {
  const repository = await ContentRepository.load();
  const paths = ["/", ...repository.allDocuments().filter((document) => !document.seo?.noindex).map((document) => document.route.path)];
  const body = paths.map((path) => `<url><loc>${xml(new URL(path, site).href)}</loc></url>`).join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`, { headers: { "Content-Type": "application/xml" } });
};
