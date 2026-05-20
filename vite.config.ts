import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import path from "node:path";

// Vite + React SPA + Cloudflare Worker (Hono) running together.
// In dev mode, `npm run dev` starts Vite which proxies /api/* through the Worker.
// In prod, `npm run build` compiles the SPA into dist/client and bundles the Worker.
export default defineConfig({
  plugins: [react(), cloudflare()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src/client"),
      "@shared": path.resolve(__dirname, "./src/shared"),
    },
  },
  build: {
    outDir: "dist/client",
  },
});
