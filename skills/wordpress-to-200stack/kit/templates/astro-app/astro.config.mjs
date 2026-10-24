import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import { loadEnv } from "vite";

const env = loadEnv(process.env.NODE_ENV ?? "production", process.cwd(), "");
export default defineConfig({
  site: process.env.PUBLIC_SITE_ORIGIN || env.PUBLIC_SITE_ORIGIN || "https://example.invalid",
  output: "static",
  outDir: "./out",
  trailingSlash: "always",
  build: { format: "directory" },
  integrations: [react()],
});
