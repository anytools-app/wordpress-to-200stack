import Link from "next/link";

import { ContentRepository } from "@/lib/repository";

export default async function HomePage() {
  const repository = await ContentRepository.load();
  return <main>
    <h1>Site</h1>
    {repository.latestByApi().map(({ api, documents }) => <section key={api}>
      <h2>{api}</h2>
      <ul>{documents.map((document) => <li key={document.contentId}><Link href={document.route.path}>{document.content.title}</Link></li>)}</ul>
    </section>)}
  </main>;
}
