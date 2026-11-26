import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Frontend lives in web/. In dev, /api is proxied to the local Express server (server/dev.ts).
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    // Explicit IPv4 loopback: on some Windows setups Vite binds only to [::1] while the browser
    // resolves "localhost" to 127.0.0.1, so the page fails to load. Also keeps dev off the LAN.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4000' },
  },
});
