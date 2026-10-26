import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, repoRoot, "");
  const webEnv = loadEnv(mode, process.cwd(), "");
  const apiTarget =
    webEnv.VITE_API_URL ?? rootEnv.VITE_API_URL ?? `http://localhost:${rootEnv.PORT ?? "8787"}`;

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@opensiel/shared": fileURLToPath(
          new URL("../../packages/shared/src/index.ts", import.meta.url),
        ),
      },
    },
    server: {
      port: 5173,
      proxy: {
        "/api": apiTarget,
      },
    },
    build: {
      outDir: "dist",
      sourcemap: false,
    },
  };
});
