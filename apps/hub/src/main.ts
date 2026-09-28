import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { PefState } from '@pef-hub/protocol';

interface UiConfig { pefUrl: string }
interface TabInfo { tabId: string; url: string; focused: boolean; crmDetected: boolean; lastFocusAt: number }
interface SessionStatus { sessionId: string; sdkVersion: string; connectedAt: number; lastFocusAt: number; tabs: TabInfo[] }
interface ListenerStatus { crmId: string; port: number; listening: boolean; error?: string | null; sessions: SessionStatus[] }
interface HubStatus {
  listeners: ListenerStatus[];
  pefState: PefState;
  interactions: number;
  queued: number;
  bindAddress: string;
  configSource: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const iframe = $<HTMLIFrameElement>('pef');

// ------------------------------------------------------------------ PEF bridge
const cfg = await invoke<UiConfig>('get_ui_config');
const pefOrigin = new URL(cfg.pefUrl).origin;
iframe.src = cfg.pefUrl;

let pefState: PefState = { loggedIn: false };
const setPefState = (patch: Partial<PefState>) => {
  const next = { ...pefState, ...patch };
  if (next.loggedIn === pefState.loggedIn && next.station === pefState.station) return;
  pefState = next;
  void invoke('from_pef', { msg: { type: 'pefState', data: pefState } });
};

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.origin !== pefOrigin || ev.source !== iframe.contentWindow) return;
  let msg: { type?: string; data?: any };
  try {
    msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
  } catch {
    return;
  }
  if (!msg?.type) return;

  // Derive agent state from the framework's subscriptions (see pef/framework.js).
  if (msg.type === 'userActionSubscription') {
    const c = String(msg.data?.category ?? '').toLowerCase();
    if (c === 'login') setPefState({ loggedIn: true, lastEvent: c });
    else if (c === 'logout') setPefState({ loggedIn: false, lastEvent: c });
  } else if (msg.type === 'interactionSubscription') {
    setPefState({ loggedIn: true });
  }

  void invoke('from_pef', { msg });
});

await listen<{ type: string; data: unknown }>('to-pef', (e) => {
  iframe.contentWindow?.postMessage(JSON.stringify(e.payload), pefOrigin);
});

// ------------------------------------------------------------------ status UI
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function portRow(l: ListenerStatus): string {
  const tabs = l.sessions.flatMap((s) => s.tabs ?? []);
  const detected = tabs.filter((t) => t.crmDetected).length;
  let lamp = 'bad';
  let state = 'Port closed';
  let meta = l.error ?? 'Could not open the port';
  if (l.listening && l.sessions.length === 0) {
    lamp = '';
    state = 'Waiting';
    meta = 'No extension connected yet';
  } else if (l.listening) {
    lamp = detected > 0 ? 'ok' : 'warn';
    state = detected > 0 ? 'Connected' : 'Extension only';
    meta = `${detected} CRM tab${detected === 1 ? '' : 's'} open, SDK ${esc(l.sessions[0].sdkVersion)}`;
  }
  return `<li class="port${l.error ? ' err' : ''}">
    <span class="num"><small>:</small>${l.port}</span>
    <span><span class="name">${esc(l.crmId)}</span><br><span class="meta">${meta}</span></span>
    <span class="state"><span class="lamp ${lamp}"></span>${state}</span>
  </li>`;
}

function render(s: HubStatus): void {
  $('ports').innerHTML = s.listeners.map(portRow).join('');
  $('bind-hint').textContent = `One secure port per CRM on ${s.bindAddress}`;
  $('config-source').textContent = `Config: ${s.configSource}`;

  const login = $('pef-login');
  login.textContent = s.pefState?.loggedIn ? 'Signed in' : 'Not signed in';
  login.className = s.pefState?.loggedIn ? 'ok' : 'warn';
  $('pef-ix').textContent = String(s.interactions);
  $('pef-queued').textContent = String(s.queued);

  const closed = s.listeners.filter((l) => !l.listening).length;
  const connected = s.listeners.filter((l) => l.sessions.some((x) => (x.tabs ?? []).some((t) => t.crmDetected))).length;
  const [cls, text] =
    closed > 0
      ? ['bad', `${closed} port${closed === 1 ? '' : 's'} could not open`]
      : !s.pefState?.loggedIn
        ? ['warn', 'Sign in to Genesys Cloud']
        : connected === 0
          ? ['warn', 'No CRM connected']
          : ['ok', `${connected} of ${s.listeners.length} CRMs connected`];
  $('overall').innerHTML = `<span class="lamp ${cls}"></span><span class="overall-text">${text}</span>`;
}

const logEl = $('log');
logEl.innerHTML = '<li class="empty">Screen pops, searches and dials will appear here.</li>';
await listen<{ at: number; text: string }>('hub-log', (e) => {
  logEl.querySelector('.empty')?.remove();
  logEl.insertAdjacentHTML('afterbegin', `<li><time>${time(e.payload.at)}</time><span>${esc(e.payload.text)}</span></li>`);
  while (logEl.children.length > 60) logEl.lastElementChild?.remove();
});

await listen<HubStatus>('hub-status', (e) => render(e.payload));
render(await invoke<HubStatus>('hub_status'));
