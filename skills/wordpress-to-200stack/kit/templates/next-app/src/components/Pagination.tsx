import Link from "next/link";

export function Pagination({ currentPage, totalPages, hrefForPage }: {
  currentPage: number;
  totalPages: number;
  hrefForPage: (page: number) => string;
}) {
  if (totalPages <= 1) return null;
  return <nav aria-label="ページ送り" data-testid="pagination"><ol>{Array.from({ length: totalPages }, (_, index) => index + 1).map((page) => <li key={page}>
    {page === currentPage ? <span aria-current="page">{page}</span> : <Link href={hrefForPage(page)}>{page}</Link>}
  </li>)}</ol></nav>;
}
