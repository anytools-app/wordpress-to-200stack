import NextLink from "next/link";
import type { ComponentPropsWithoutRef } from "react";

/** Internal links keep App Router client navigation for native React page chrome updates. */
export function SiteLink({ href, ...props }: ComponentPropsWithoutRef<"a">) {
  if (typeof href === "string" && href.startsWith("/") && !href.startsWith("//") && props.target !== "_blank") {
    return <NextLink href={href} {...props} />;
  }

  return <a href={href} {...props} />;
}
