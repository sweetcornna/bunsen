import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发时：`bunsen serve --dev --no-open` 在 7878，Vite 在 5173 代理接口与终端通道。
const backend = process.env.BUNSEN_BACKEND ?? "http://127.0.0.1:7878";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      "/ws": { target: backend, ws: true, changeOrigin: true },
    },
  },
});
