# PEF Hub – project context

## What this is
PEF Hub lets ONE Genesys Cloud Embeddable Framework (PEF) session serve MULTIPLE CRMs at the same time.
Out of the box the PEF integrates with one CRM at a time; customers running several CRMs in parallel can't use it.
Solution: a lightweight desktop hub hosts the single PEF iframe (one session, one WebRTC phone) and brokers
events to per-CRM browser extensions over local secure WebSockets.

Owner: Genesys Professional Services (PoC → customer delivery). Genesys Cloud region: mypurecloud.ie.

## Architecture
```
CRM tab (Chrome/Edge)                         PEF Hub (Tauri 2, Windows, WebView2)
 MAIN-world adapter ⇄ isolated bridge          ┌───────────────────────────────────────┐
        ⇅ chrome.runtime Port                  │ WSS listener per CRM (multi-port)      │
 extension service worker (holds the WS) ══wss://127.0.0.1:<port>══► router + state (Rust)  │
                                               │ PEF host page ⇄ PEF iframe (postMessage)│
                                               └───────────────────────────────────────┘
```
- The WebSocket lives in the extension SERVICE WORKER, never in the page → CRM refreshes don't drop the hub connection.
- Hub is STATEFUL (interaction ownership, offline queue with TTL, contact-search fan-out/merge, snapshots).
  Adapters are STATELESS.
- One WSS listener per CRM: each port only accepts its own crmId (hello handshake), loopback only,
  allowed origins only, valid pairing token.

## Hard decisions (do not revisit without asking)
- Tauri 2, NOT Electron (Electron rejected: installer too heavy for customers/delivery).
- HTTPS/WSS everywhere from day one. Hub UI served from https://tauri.localhost (`useHttpsScheme: true`),
  dev on https://localhost:1420.
- Multi-port WSS, one port per CRM (fake-crm 9101, mystery-crm 9102).
- Per-CRM extensions GENERATED from a shared SDK: change the SDK → rebuild → all extensions regenerated.
  CRM-specific code lives only in `adapters/<crm>/adapter.ts` + `crm.config.ts`.
- Shareable TEST certificate in `certs/test`, replaceable by the customer's own without rebuilding.
  The test CA has X.509 Name Constraints (localhost / 127.0.0.1 / ::1 only), so a shared key is safe to distribute.
- Extensions connect to 127.0.0.1 (not "localhost") to avoid IPv6 ::1 fallback delays on Windows.

## Repository layout
- `packages/protocol` – wire protocol v1 (TS). MIRRORED in `apps/hub/src-tauri/src/protocol.rs`.
- `packages/sdk-core` – `HubClient`: hello/pairing, heartbeat (20s, keeps MV3 SW alive), reconnect backoff 1/2/5/10s + jitter, `kick()`.
- `packages/sdk-extension` – MV3 runtime:
  `background.ts` (SW, WS, badge, tab registry, focus tracking, chrome.alarms wake-up),
  `bridge.ts` (isolated content script, Port, status pill in Shadow DOM),
  `adapter.ts` (MAIN-world runtime + `CrmAdapter` interface),
  `generic-adapter.ts` (`window.pefHubCrm` page contract + DOM events + toast).
- `adapters/fake-crm`, `adapters/mystery-crm` – WXT extensions (https://localhost:5173, https://localhost:4200).
- `tools/adapter-template`, `tools/new-adapter.mjs` – generator (`pnpm adapter:new <id> <port> "<match>" "<Name>"`).
- `apps/hub` – Vite + TS UI (status panel + PEF iframe host page) and `src-tauri`:
  `config.rs` (hub.config.json lookup + validation), `tls.rs` (rustls/ring, PEM),
  `ws.rs` (per-port WSS server, origin check, hello validation, heartbeat timeout),
  `router.rs` (sessions, routing, queue, search fan-out, Tauri commands/events), `main.rs` (tray, single instance).
- `apps/dev-crm` – dev-only stand-in CRM pages (`window.pefHubCrm`, tel: links, event log) on 5173 (fake) / 4200 (mystery).
- `pef/framework.js` – reference Embeddable Framework message contract (to merge into the real framework.js).
  `scripts/serve-framework.mjs` serves it on https://localhost/framework.js for `?crm=framework-local-secure`.
  Never commit a real OAuth client ID: keep the `<YOUR_OAUTH_CLIENT_ID>` placeholder (local ID in `pef/client-id.local`).
- `config/hub.config.json` – listeners/ports, routing rules, TLS paths, PEF URL, timeouts.
- `certs/test`, `scripts/certs` – test certs, gen-certs.sh, install-ca.ps1 / uninstall-ca.ps1.

## Protocol v1 (Envelope `{v, type, id, correlationId?, crmId?, tabId?, payload}`)
- CRM→Hub: `hello`, `heartbeat {tabs}`, `snapshotRequest`, `clickToDial`, `contactSearchResult`, `callLogResult`, `focusRecord`
- Hub→CRM: `welcome {sessionId, pefState, snapshot}`, `heartbeatAck {pefState}`, `snapshot`, `screenPop`,
  `contactSearch`, `processCallLog`, `openCallLog`, `interactionUpdate`, `error`
- PEF iframe ⇄ hub page (JSON string `{type, data}`): screenPop, processCallLog, openCallLog, contactSearch,
  interactionSubscription, userActionSubscription, pefReady / clickToDial, contactSearchResult, addAssociation
- Webview ⇄ Rust: command `from_pef`, `hub_status`, `get_ui_config`; events `to-pef`, `hub-status`, `hub-log`

## Routing rules
screenPop target: attribute `crmTarget` → `queueRules[queueName]` → last focused CRM (or broadcast).
Target becomes interaction OWNER. Call logs / updates go to the owner. clickToDial from CRM X → next outbound
interaction within 30s is owned by X. contactSearch fans out to one session per CRM, merged, tagged
`attributes.pefHubCrm`. Owner offline → queued for `queueTtlSecs`, flushed on reconnect.

## Status indicator (badge + in-page pill)
green ON = hub + paired + agent signed in · amber ! = PEF not ready · red OFF = hub unreachable · grey ? = no CRM page detected.

## Environment & commands
Windows, Node 24 LTS, pnpm, Rust ≥ 1.90 (current Tauri requires it), VS Build Tools (C++), WebView2.
- `pnpm install`
- `pnpm hub:dev` / `pnpm hub:build` (MSI + NSIS)
- `pnpm pef:serve` (framework.js on :443), `pnpm crm:dev:fake`, `pnpm crm:dev:mystery` (dev CRM pages)
- `pnpm ext:dev:fake`, `pnpm ext:dev:mystery`, `pnpm ext:build`, `pnpm ext:zip`
- `pnpm typecheck` (all TS), `cargo check` in `apps/hub/src-tauri`

## Rules when editing
- Any protocol change: update BOTH `packages/protocol/src/index.ts` and `src-tauri/src/protocol.rs`, bump `SDK_VERSION`
  in `packages/sdk-extension/src/config.ts`, keep hub backward compatible with the previous version.
- Never put CRM-specific logic in `packages/*`; it belongs in `adapters/<crm>/adapter.ts`.
- No chrome.* APIs in MAIN-world code (`adapter.ts`, `generic-adapter.ts`, `toast.ts`).
- Don't hold the router Mutex across `.await` or while calling `emit_status()`.
- Keep the hub light: no heavy dependencies, no Node sidecar.
- Never commit customer certificates (`certs/customer/` is gitignored).
- Code, comments and docs in English.

## Known gaps / next steps
- WebView2 microphone prompt on first run → auto-grant for the PEF origin via `PermissionRequested`.
- Validate PEF agent state derivation (`userActionSubscription` login/logout) on the real org.
- Production pairing: per-install token (Native Messaging or MSI) instead of the static token in the extension.
- Replace `chrome-extension://*` with exact extension IDs (manifest `key`), force-install via policy + self-hosted `update_url`.
- Chrome Local Network Access policy check; VDI multi-session port offsets; `tauri-plugin-autostart`.
- First real CRM adapter (ServiceNow or Salesforce).
