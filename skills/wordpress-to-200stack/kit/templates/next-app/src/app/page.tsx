import { SiteLink } from "@/components/SiteLink";
import { ContentRepository } from "@/lib/repository";

export default async function HomePage() {
  const repository = await ContentRepository.load();
  return <main>
    <h1>Site</h1>
    {repository.latestByApi().map(({ api, documents }) => <section key={api}>
      <h2>{api}</h2>
      <ul>{documents.map((document) => <li key={document.contentId}><SiteLink href={document.route.path}>{document.content.title}</SiteLink></li>)}</ul>
    </section>)}
  </main>;
}
