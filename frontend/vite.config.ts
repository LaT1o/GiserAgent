import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// /api 代理到本机 Application API，避免浏览器跨域
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
});
