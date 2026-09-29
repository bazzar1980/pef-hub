# PEF Hub

One Genesys Cloud **Embeddable Framework (PEF)** session, many CRMs at the same time.

```
 Chrome / Edge                                    PEF Hub (Tauri 2, ~5-10 MB)
 ┌──────────────────────────┐   wss://127.0.0.1:9101  ┌──────────────────────────────────┐
 │ Fake CRM tab             │◄──────────────────────►│ listener fake-crm   ┐            │
 │  extension (SW holds WS) │                         │                     ├─ router ─┐ │
 ├──────────────────────────┤   wss://127.0.0.1:9102  │                     │  state   │ │
 │ Mystery CRM tab          │◄──────────────────────►│ listener mystery-crm┘  queue   │ │
 │  extension (SW holds WS) │                         │                                │ │
 └──────────────────────────┘                         │ PEF iframe (1 session, 1 phone)◄┘ │
                                                      └──────────────────────────────────┘
```

* **Multi-port**: one WSS listener per CRM. A port only accepts its own `crmId` (hello handshake), from loopback, from allowed origins, with a valid pairing token.
* **Refresh-proof**: the WebSocket lives in the extension **service worker**, not in the page. A CRM refresh only re-attaches the content script (local Port) and requests a **snapshot** from the hub.
* **Stateful hub, stateless adapters**: interaction ownership, offline queue with TTL, contact-search fan-out/merge all live in the hub (Rust).
* **SDK-generated extensions**: CRM-specific code is one file (`adapters/<crm>/adapter.ts`). Change the SDK, rebuild, every extension is regenerated.

## Repository layout

| Path | What |
|---|---|
| `packages/protocol` | Wire protocol v1 (TS). Mirrored in `apps/hub/src-tauri/src/protocol.rs` |
| `packages/sdk-core` | `HubClient`: hello/pairing, heartbeat, reconnect with backoff + jitter |
| `packages/sdk-extension` | MV3 runtime: service worker, isolated bridge, MAIN-world adapter runtime, badge + in-page pill |
| `adapters/fake-crm`, `adapters/mystery-crm` | Generated extensions (WXT). Only `crm.config.ts` + `adapter.ts` are CRM-specific |
| `tools/adapter-template`, `tools/new-adapter.mjs` | Generator for new CRM extensions |
| `apps/hub` | Tauri 2 hub: WSS listeners, router, PEF host page, status UI, tray |
| `pef/framework.js` | Reference framework.js message contract to merge into yours |
| `config/hub.config.json` | Ports, routing rules, certificate paths, PEF URL |
| `certs/test` | **Shareable test certificates** (see below) |
| `scripts/certs` | Generate / trust / remove certificates |

## Prerequisites (Windows)

* Node **24 LTS** (`nvm use 24`), `npm i -g pnpm`
* Rust: <https://rustup.rs> (stable)
* Visual Studio Build Tools, workload **Desktop development with C++**
* WebView2 runtime (already present with an updated Edge)

## Quick start

```powershell
pnpm install

# 1. Trust the TEST CA (current user, Windows asks for confirmation)
powershell -ExecutionPolicy Bypass -File scripts\certs\install-ca.ps1

# 2. framework.js for ?crm=framework-local-secure (https://localhost/framework.js, port 443)
#    Set your OAuth client ID in pef/framework.js, or in pef/client-id.local (gitignored)
pnpm pef:serve

# 3. Hub (Vite on https://localhost:1420 + Tauri window, listeners 9101/9102)
pnpm hub:dev

# 4. Dev CRM pages (stand-ins for the real CRMs, window.pefHubCrm + tel: links + event log)
pnpm crm:dev:fake       # https://localhost:5173
pnpm crm:dev:mystery    # https://localhost:4200

# 5. Extensions (each opens a Chrome instance with the extension loaded)
pnpm ext:dev:fake       # matches https://localhost:5173/*
pnpm ext:dev:mystery    # matches https://localhost:4200/*
```

Dev notes:

* The PEF login runs in a popup (`dedicatedLoginWindow: true`): login.mypurecloud.ie refuses to be framed under the hub.
  The hub only allows popups on the region domain derived from `pef.url` (e.g. `*.mypurecloud.ie`).
* OAuth client: grant type **Code Authorization (PKCE)**, redirect URI `https://apps.mypurecloud.ie/crm/authWindow.html`
  (the PEF uses PKCE for the popup login).
* Antivirus HTTPS scanning (e.g. Avast Web Shield) intercepts loopback TLS too. It works as long as the browser trusts
  the antivirus root, but check it on customer PCs.

Production builds:

```powershell
pnpm hub:build   # MSI + NSIS in apps/hub/src-tauri/target/release/bundle
pnpm ext:zip     # one zip per CRM in adapters/<crm>/.output
```

## Genesys Cloud configuration

* In the Embeddable Framework integration, add the hub origins as CRM domain / allowed origin:
  `https://tauri.localhost` (installed app) and `https://localhost:1420` (dev).
* Put the same iframe URL you use today in `config/hub.config.json` → `pef.url` (region `.ie` preset).
* Merge `pef/framework.js` (message contract) into your framework.js. Keep your clientIds and settings.

## Certificates

### Test certificate (shareable, ready to use)

`certs/test` contains a **name-constrained** CA: it can only sign certificates for `localhost`, `127.0.0.1` and `::1`.
Even though the test CA key is shared, it cannot be abused to impersonate any other website.

| File | Purpose |
|---|---|
| `ca.crt` | Trust on agent PCs (Trusted Root) |
| `localhost-fullchain.crt` | Hub `tls.certPath` (leaf + CA) |
| `localhost.key` | Hub `tls.keyPath` |
| `ca.key` | Only for re-issuing the leaf. **Test only**: everyone with this repo has it |

Leaf: SAN `localhost`, `127.0.0.1`, `::1`, EKU serverAuth, valid 397 days. CA: 5 years.

### Replacing it with the customer certificate

1. Generate the customer's own CA + leaf (Git Bash):
   ```bash
   bash scripts/certs/gen-certs.sh certs/customer "ACME Contact Center"
   ```
   or use a certificate issued by the customer's PKI (PEM, SAN must include `127.0.0.1` and `localhost`).
2. Point the hub to it. Either edit `config/hub.config.json`, or (no rebuild) drop a
   `hub.config.json` in `%APPDATA%\com.genesys.ps.pefhub\` with:
   ```json
   "tls": { "certPath": "C:\\ProgramData\\PEFHub\\localhost-fullchain.crt",
            "keyPath":  "C:\\ProgramData\\PEFHub\\localhost.key" }
   ```
3. Trust the customer CA on agent PCs (Intune / GPO, machine store, silent):
   ```powershell
   scripts\certs\install-ca.ps1 -CaPath C:\path\ca.crt -Machine
   ```
4. Remove the test CA: `scripts\certs\uninstall-ca.ps1` (add `-Machine` if installed per machine).

Config lookup order: `%PEF_HUB_CONFIG%` → `%APPDATA%\com.genesys.ps.pefhub\hub.config.json` → bundled `config/hub.config.json`.

## Adding a CRM

```powershell
pnpm adapter:new servicenow 9103 "https://*.service-now.com/*" "ServiceNow"
pnpm install
```

This copies the template, sets the port, and adds the listener to `config/hub.config.json`.
Then implement `adapters/servicenow/adapter.ts` (`detect`, `screenPop`, `searchContacts`, `logCall`, `bindClickToDial`).
The generic adapter already works with any page exposing `window.pefHubCrm` (see `packages/sdk-extension/src/generic-adapter.ts`).

## Status indicators

| Badge / pill | Meaning |
|---|---|
| green `ON` | Hub reached, paired, agent signed in to Genesys Cloud |
| amber `!` | Hub reached, PEF not ready (not signed in) |
| red `OFF` (blinking pill) | Hub unreachable: app not running, port closed, certificate not trusted |
| grey `?` | Hub reached, no CRM page detected |

Click the toolbar icon or the pill to retry immediately. Background retry: backoff 1s → 2s → 5s → 10s, plus a `chrome.alarms` wake-up every 30s.

## Routing (hub)

1. `screenPop`: interaction attribute `crmTarget` (configurable) → `queueRules[queueName]` → last focused CRM (`fallback: "focused"`) or all (`"broadcast"`). The chosen CRM becomes the interaction **owner**.
2. `processCallLog` / `openCallLog` / `interactionUpdate`: to the owner.
3. `clickToDial`: any CRM → PEF. The next outbound interaction within 30s is owned by that CRM.
4. `contactSearch`: fan-out to one session per CRM, merge with `attributes.pefHubCrm`, timeout `searchTimeoutMs`.
5. Owner offline: event queued for `queueTtlSecs`, delivered on reconnect. Refreshed tabs get a snapshot.

## Security notes and production hardening

* Listeners bind `127.0.0.1` only and drop non-loopback peers.
* Replace `"allowedOrigins": ["chrome-extension://*"]` with exact extension IDs (`chrome-extension://<id>`). Fix IDs by setting a `key` in each extension manifest or by publishing them.
* The pairing token inside an extension is readable: treat it as an extra check, not a secret. Production: per-install token delivered via Native Messaging or MSI.
* Distribute extensions with `ExtensionInstallForcelist` (Chrome / Edge policy) and a self-hosted `update_url`.
* Chrome Local Network Access: validate on the customer's Chrome version; allow via enterprise policy if prompted.
* VDI / multi-session hosts: one user per port set. Plan per-session port offsets before rollout.

## Known gaps (PoC)

* Microphone permission: WebView2 shows its own prompt the first time. Next step: auto-grant for the PEF origin via WebView2 `PermissionRequested`.
* PEF agent state is derived from `userActionSubscription` (`login` / `logout`) and interaction events. Validate the category names on your org.
* Autostart at login: add `tauri-plugin-autostart`.
