import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: {
    // 案件で独自の CDN loader を使う場合は、この設定を差し替える。
    unoptimized: true,
  },
};

export default nextConfig;
