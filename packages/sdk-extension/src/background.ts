/// <reference types="chrome" />
import { HubClient } from '@pef-hub/sdk-core';
import type { ConnectionState, Envelope, TabInfo } from '@pef-hub/protocol';
import { SDK_VERSION, type CrmExtensionConfig } from './config';

interface TabEntry {
  port: chrome.runtime.Port;
  info: TabInfo;
}

/** Messages exchanged on the chrome.runtime Port (content script <-> service worker). */
export type PortToWorker =
  | { kind: 'tabInfo'; info: Partial<TabInfo> }
  | { kind: 'toHub'; env: Envelope }
  | { kind: 'kick' };

export type PortToTab =
  | { kind: 'state'; state: ConnectionState; detail: { hub: string; pefLoggedIn: boolean; error?: string } }
  | { kind: 'hub'; env: Envelope };

const COLORS: Record<ConnectionState, string> = {
  connected: '#1E8E5A',
  partial: '#D89B00',
  disconnected: '#C8372D',
  'no-crm': '#8A96A3',
};
const BADGE: Record<ConnectionState, string> = { connected: 'ON', partial: '!', disconnected: 'OFF', 'no-crm': '?' };
const TITLE: Record<ConnectionState, string> = {
  connected: 'Connected to PEF Hub',
  partial: 'Hub connected, PEF not ready (login / phone)',
  disconnected: 'PEF Hub unreachable, retrying (click to retry now)',
  'no-crm': 'Hub connected, no CRM page detected',
};

const QUEUEABLE_TO_FOCUSED = new Set(['screenPop', 'processCallLog', 'openCallLog', 'interactionUpdate', 'contactSearch']);

/**
 * Service-worker side of a CRM extension.
 * The WebSocket lives HERE, not in the page: CRM page refreshes never drop the hub connection.
 */
export function startBackground(cfg: CrmExtensionConfig): HubClient {
  const tabs = new Map<number, TabEntry>();
  const client = new HubClient({
    url: `wss://${cfg.host ?? '127.0.0.1'}:${cfg.port}`,
    token: cfg.token,
    crmId: cfg.crmId,
    sdkVersion: SDK_VERSION,
    extensionId: chrome.runtime.id,
    capabilities: ['screenPop', 'contactSearch', 'processCallLog', 'openCallLog', 'clickToDial', 'interactionUpdate', 'snapshot'],
    heartbeatMs: 20_000,
  });

  const tabList = (): TabInfo[] => [...tabs.values()].map((t) => t.info);
  client.setTabsProvider(tabList);

  const computeState = (): ConnectionState => {
    if (client.state !== 'connected') return 'disconnected';
    if (!tabList().some((t) => t.crmDetected)) return 'no-crm';
    return client.pefState.loggedIn ? 'connected' : 'partial';
  };

  const post = (port: chrome.runtime.Port, msg: PortToTab) => {
    try {
      port.postMessage(msg);
    } catch {
      /* port already closed */
    }
  };

  const refresh = () => {
    const s = computeState();
    void chrome.action.setBadgeText({ text: BADGE[s] });
    void chrome.action.setBadgeBackgroundColor({ color: COLORS[s] });
    void chrome.action.setTitle({ title: `${cfg.displayName} (port ${cfg.port}): ${TITLE[s]}` });
    const detail = { hub: client.state, pefLoggedIn: client.pefState.loggedIn, error: client.lastError };
    for (const t of tabs.values()) post(t.port, { kind: 'state', state: s, detail });
  };
  client.onStateChange(refresh);

  const focusedTab = (): TabEntry | undefined =>
    [...tabs.values()].filter((t) => t.info.crmDetected).sort((a, b) => b.info.lastFocusAt - a.info.lastFocusAt)[0];

  const markFocus = (tabId?: number) => {
    const e = tabId !== undefined ? tabs.get(tabId) : undefined;
    if (!e) return;
    e.info.lastFocusAt = Date.now();
    client.send('heartbeat', { tabs: tabList() });
  };

  client.onMessage((env) => {
    const target = env.tabId ? tabs.get(Number(env.tabId)) : QUEUEABLE_TO_FOCUSED.has(env.type) ? focusedTab() : undefined;
    if (!target) {
      if (env.type === 'contactSearch') {
        client.send('contactSearchResult', { results: [] }, { correlationId: env.correlationId });
      }
      return;
    }
    post(target.port, { kind: 'hub', env });
  });

  chrome.runtime.onConnect.addListener((port) => {
    const tab = port.sender?.tab;
    if (port.name !== 'pef-hub-tab' || tab?.id === undefined) return;
    const tabId = tab.id;
    tabs.set(tabId, {
      port,
      info: {
        tabId: String(tabId),
        url: tab.url ?? '',
        focused: !!tab.active,
        crmDetected: false,
        lastFocusAt: tab.active ? Date.now() : 0,
      },
    });

    port.onMessage.addListener((m: PortToWorker) => {
      const e = tabs.get(tabId);
      if (!e) return;
      switch (m.kind) {
        case 'tabInfo': {
          const wasDetected = e.info.crmDetected;
          Object.assign(e.info, m.info);
          if (m.info.focused) e.info.lastFocusAt = Date.now();
          // Freshly detected (new tab or refresh): ask the hub for the current state.
          if (!wasDetected && e.info.crmDetected) client.send('snapshotRequest', {}, { tabId: String(tabId) });
          client.send('heartbeat', { tabs: tabList() });
          refresh();
          break;
        }
        case 'toHub':
          client.send(m.env.type, m.env.payload, { correlationId: m.env.correlationId, tabId: String(tabId) });
          break;
        case 'kick':
          client.kick();
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      tabs.delete(tabId);
      client.send('heartbeat', { tabs: tabList() });
      refresh();
    });

    client.kick();
    refresh();
  });

  chrome.tabs.onActivated.addListener(({ tabId }) => markFocus(tabId));
  chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    const [active] = await chrome.tabs.query({ active: true, windowId });
    markFocus(active?.id);
  });

  // MV3 safety net: timers die when the worker is suspended, alarms wake it up.
  void chrome.alarms.create('pef-hub-reconnect', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === 'pef-hub-reconnect') client.kick();
  });
  chrome.action.onClicked.addListener(() => client.kick());
  chrome.runtime.onStartup.addListener(() => client.kick());
  chrome.runtime.onInstalled.addListener(() => client.kick());

  client.connect();
  refresh();
  return client;
}
