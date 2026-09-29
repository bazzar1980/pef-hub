import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Dev-only stand-in CRM pages for the fake-crm (5173) and mystery-crm (4200) extensions.
// Served over HTTPS with the same certificate as the hub.
const PROFILES: Record<string, { port: number }> = {
  fake: { port: 5173 },
  mystery: { port: 4200 },
};

const certDir = process.env.PEF_HUB_CERT_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../certs/test');

export default defineConfig(({ mode }) => {
  const profile = PROFILES[mode];
  if (!profile) throw new Error(`Unknown dev-crm mode "${mode}" (expected: ${Object.keys(PROFILES).join(', ')})`);
  return {
    clearScreen: false,
    define: { __CRM_PROFILE__: JSON.stringify(mode) },
    server: {
      port: profile.port,
      strictPort: true,
      https: {
        cert: fs.readFileSync(path.join(certDir, 'localhost-fullchain.crt')),
        key: fs.readFileSync(path.join(certDir, 'localhost.key')),
      },
    },
  };
});
