import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Админка отдаётся сервером по пути /dash (см. CONTRACT §10.4), поэтому base обязателен:
 * без него собранный index.html будет ссылаться на /assets/... и получит 404.
 */
const target = process.env.API_PROXY_TARGET ?? 'http://localhost:8787';

const proxyCommon = {
  target,
  changeOrigin: true,
  timeout: 0,
  proxyTimeout: 0,
};

export default defineConfig({
  base: '/dash/',
  plugins: [react()],
  server: {
    host: true,
    port: 5174,
    strictPort: false,
    proxy: {
      '/api': proxyCommon,
      '/healthz': proxyCommon,
    },
  },
  preview: {
    port: 4174,
    proxy: {
      '/api': proxyCommon,
      '/healthz': proxyCommon,
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    assetsInlineLimit: 8192,
  },
});
