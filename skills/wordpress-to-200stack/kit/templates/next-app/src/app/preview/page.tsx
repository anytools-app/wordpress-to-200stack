import type { Metadata } from "next";
import { Suspense } from "react";

import { PreviewClient } from "./PreviewClient";

export const metadata: Metadata = {
  title: "Preview",
  alternates: { canonical: "/preview/" },
  robots: { index: false, follow: false },
};

export default function PreviewPage() {
  return (
    <Suspense fallback={<p>読み込み中...</p>}>
      <PreviewClient />
    </Suspense>
  );
}
