import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// /api 代理到本机 Application API，避免浏览器跨域
// GISER_API_TARGET：隔离实例验证/截图时指向其他端口，默认同 server 端口（13001）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.GISER_API_TARGET || "http://127.0.0.1:13001",
        changeOrigin: true,
      },
    },
  },
});
