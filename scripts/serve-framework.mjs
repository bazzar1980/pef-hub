#!/usr/bin/env node
/**
 * Dev-only: serves pef/framework.js on https://localhost/framework.js (port 443), which is where the
 * Embeddable Framework loads it from when the iframe URL uses ?crm=framework-local-secure.
 *
 * The OAuth client ID is injected at serve time (the reference file keeps the placeholder):
 *   - env PEF_HUB_CLIENT_ID, or
 *   - pef/client-id.local (gitignored, one line with the client ID)
 *
 *   pnpm pef:serve
 */
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const certDir = process.env.PEF_HUB_CERT_DIR ?? path.join(root, 'certs/test');
const frameworkPath = path.join(root, 'pef/framework.js');
const clientIdFile = path.join(root, 'pef/client-id.local');
const port = Number(process.env.PEF_FRAMEWORK_PORT ?? 443);

function clientId() {
  if (process.env.PEF_HUB_CLIENT_ID) return process.env.PEF_HUB_CLIENT_ID.trim();
  if (fs.existsSync(clientIdFile)) return fs.readFileSync(clientIdFile, 'utf8').trim();
  return null;
}

if (!clientId()) {
  console.warn(`WARNING: no OAuth client ID. Set PEF_HUB_CLIENT_ID or create ${path.relative(root, clientIdFile)}.`);
}

const server = https.createServer(
  {
    cert: fs.readFileSync(path.join(certDir, 'localhost-fullchain.crt')),
    key: fs.readFileSync(path.join(certDir, 'localhost.key')),
  },
  (req, res) => {
    const url = new URL(req.url ?? '/', 'https://localhost');
    if (url.pathname !== '/framework.js') {
      res.writeHead(404).end();
      return;
    }
    // Read on every request so edits to framework.js are picked up without a restart.
    let body = fs.readFileSync(frameworkPath, 'utf8');
    const id = clientId();
    if (id) body = body.replace('<YOUR_OAUTH_CLIENT_ID>', id);
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
    console.log(`${new Date().toLocaleTimeString()} served framework.js to ${req.headers.origin ?? req.headers.referer ?? '?'}`);
  },
);

server.on('error', (e) => {
  console.error(`Cannot listen on port ${port}: ${e.message}`);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => console.log(`framework.js on https://localhost${port === 443 ? '' : `:${port}`}/framework.js`));
