import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { ogPlugin } from './server/vite-og-plugin.mjs';
import { vendorChunkOf } from './scripts/vendor-chunks.mjs';
import { fileURLToPath, URL } from 'node:url';

// Puerto 3100: no interfiere con melodya_web (3000) ni con el backoffice (3001).
export default defineConfig({
  plugins: [react(), tailwindcss(), ogPlugin()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 3000, strictPort: true },
  preview: { port: 3000, strictPort: true },
  build: {
    // División por librerías (scripts/vendor-chunks.mjs): ningún chunk debe superar 900 kB sin minificar (`npm run check:chunks`).
    rollupOptions: { output: { manualChunks: vendorChunkOf } },
  },
});
