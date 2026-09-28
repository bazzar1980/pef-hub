#!/usr/bin/env node
/**
 * Generates a new CRM extension from tools/adapter-template and registers its WSS listener.
 *
 *   pnpm adapter:new <crmId> <port> "<match pattern>" "<Display Name>"
 *   pnpm adapter:new servicenow 9103 "https://*.service-now.com/*" "ServiceNow"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , crmId, portArg, match, displayName = crmId] = process.argv;
const port = Number(portArg);
if (!crmId || !/^[a-z0-9-]+$/.test(crmId) || !Number.isInteger(port) || port < 1024 || port > 65535 || !match) {
  console.error('Usage: pnpm adapter:new <crmId [a-z0-9-]> <port 1024-65535> "<match pattern>" "<Display Name>"');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = path.join(root, 'tools', 'adapter-template');
const target = path.join(root, 'adapters', crmId);
const configPath = path.join(root, 'config', 'hub.config.json');

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (fs.existsSync(target)) { console.error(`adapters/${crmId} already exists`); process.exit(1); }
if (config.listeners.some((l) => l.crmId === crmId)) { console.error(`listener "${crmId}" already in hub.config.json`); process.exit(1); }
const clash = config.listeners.find((l) => l.port === port);
if (clash) { console.error(`port ${port} already used by "${clash.crmId}"`); process.exit(1); }

const replace = (s) =>
  s.replaceAll('__CRM_ID__', crmId).replaceAll('__DISPLAY_NAME__', displayName).replaceAll('__PORT__', String(port)).replaceAll('__MATCH__', match);

(function copy(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copy(s, d);
    else fs.writeFileSync(d, replace(fs.readFileSync(s, 'utf8')));
  }
})(template, target);

config.listeners.push({ crmId, port, allowedOrigins: ['chrome-extension://*'] });
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

console.log(`Created adapters/${crmId}  (wss://127.0.0.1:${port})`);
console.log('Listener added to config/hub.config.json');
console.log('Next: pnpm install && implement adapters/' + crmId + '/adapter.ts');
