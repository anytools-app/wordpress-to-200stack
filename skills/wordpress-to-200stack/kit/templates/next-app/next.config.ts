import type { NextConfig } from "next";

const memoryLimitMb = Number(process.env.BUILD_MEMORY_LIMIT_MB) || 0;
let constrainedExperimental: NextConfig["experimental"] | undefined;
if (memoryLimitMb > 0) {
  // 静的生成は worker 数 × 同時render数ぶん本文データを保持する。少RAM環境では CPU 数を
  // そのまま使うより、約640MB/workerの安全側予算と同時render=2で瞬間ピークを抑える。
  // ローカル無指定時は制約せず、build-app.mjsだけが指定時にwebpack/heap上限へ切り替える。
  const workerBudgetMb = Math.max(memoryLimitMb - 1024, 512);
  const cpus = Math.max(1, Math.min(4, Math.floor(workerBudgetMb / 640)));
  const childHeapMb = Math.max(384, Math.min(1024, Math.floor(workerBudgetMb / cpus) - 128));
  if (!(process.env.NODE_OPTIONS ?? "").includes("--max-old-space-size")) {
    process.env.NODE_OPTIONS =
      `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=${childHeapMb}`.trim();
  }
  constrainedExperimental = {
    cpus,
    workerThreads: false,
    staticGenerationMaxConcurrency: 2,
    webpackMemoryOptimizations: true,
    turbopackMemoryLimit: Math.max(512, Math.floor(memoryLimitMb / 2)) * 1024 * 1024,
  };
}

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: {
    // 案件で独自の CDN loader を使う場合は、この設定を差し替える。
    unoptimized: true,
  },
  ...(constrainedExperimental
    ? { experimental: constrainedExperimental, cacheMaxMemorySize: 0 }
    : {}),
};

export default nextConfig;
