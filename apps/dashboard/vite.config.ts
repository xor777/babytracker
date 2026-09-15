import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * В dev всё, что начинается с /api и /alice, уходит на сервер (порт 8787 по контракту §3).
 * Можно переопределить: API_PROXY_TARGET=http://192.168.1.10:8787 pnpm dev
 */
const target = process.env.API_PROXY_TARGET ?? 'http://localhost:8787';

const proxyCommon = {
  target,
  changeOrigin: true,
  // SSE: ничего не буферизуем и не рвём по таймауту
  timeout: 0,
  proxyTimeout: 0,
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': proxyCommon,
      '/alice': proxyCommon,
      '/healthz': proxyCommon,
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': proxyCommon,
      '/alice': proxyCommon,
      '/healthz': proxyCommon,
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    assetsInlineLimit: 8192,
    chunkSizeWarningLimit: 800,
  },
});
