import { fileURLToPath } from 'node:url';
import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Where the real dashboard listens during development. Override with
 * EZ_DASHBOARD_ORIGIN when the dashboard was started on another port.
 */
const DASHBOARD_ORIGIN = process.env.EZ_DASHBOARD_ORIGIN ?? 'http://localhost:6443';

/**
 * The dashboard's local-request guard requires Host and Origin to name the
 * dashboard's own port. The browser talks to the Vite dev server instead, so
 * the proxy presents each request as if it came from the dashboard origin.
 * This is development tooling only: the backend check itself is untouched,
 * and the built UI is served same-origin and sends its real Origin.
 */
const presentAsDashboard: NonNullable<ProxyOptions['configure']> = (proxy) => {
  const origin = new URL(DASHBOARD_ORIGIN).origin;
  proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('origin', origin));
  proxy.on('proxyReqWs', (proxyReq) => proxyReq.setHeader('origin', origin));
};

const proxy = {
  target: DASHBOARD_ORIGIN,
  changeOrigin: true,
  configure: presentAsDashboard,
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative asset URLs: the bundle works at /ui/, /dashboard/ or any prefix
  // the backend eventually mounts it on.
  base: './',
  build: {
    outDir: fileURLToPath(new URL('../../../dist/ui', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': proxy,
      '/socket.io': { ...proxy, ws: true },
    },
  },
});
