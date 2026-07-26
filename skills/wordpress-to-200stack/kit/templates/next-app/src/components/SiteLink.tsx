import NextLink from "next/link";
import type { ComponentPropsWithoutRef } from "react";
import { withTrailingSlash } from "@/lib/content/types";

/** 内部リンクだけ App Router のクライアント遷移を使う単一窓口。 */
export function SiteLink({ href, ...props }: ComponentPropsWithoutRef<"a">) {
  if (
    typeof href === "string" &&
    href.startsWith("/") &&
    !href.startsWith("//") &&
    props.target !== "_blank"
  ) {
    return <NextLink href={withTrailingSlash(href)} {...props} />;
  }
  return <a href={href} {...props} />;
}
