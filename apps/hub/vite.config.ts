import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Dev server runs on HTTPS with the same (test or customer) certificate used by the WSS listeners.
const certDir = process.env.PEF_HUB_CERT_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../certs/test');

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    https: {
      cert: fs.readFileSync(path.join(certDir, 'localhost-fullchain.crt')),
      key: fs.readFileSync(path.join(certDir, 'localhost.key')),
    },
  },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
});
