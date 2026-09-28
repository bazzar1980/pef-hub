/// <reference types="chrome" />
import { envelope } from '@pef-hub/protocol';
import { onChannel, postChannel } from './channel';
import { createPill } from './pill';
import type { CrmExtensionConfig } from './config';
import type { PortToTab, PortToWorker } from './background';

/**
 * Isolated-world content script: owns the Port to the service worker, the status pill,
 * and relays envelopes to/from the MAIN-world adapter.
 */
export function startBridge(cfg: CrmExtensionConfig): void {
  let port: chrome.runtime.Port | undefined;
  let crmDetected = false;

  const send = (m: PortToWorker) => {
    try {
      port?.postMessage(m);
    } catch {
      /* reconnect will follow */
    }
  };

  const pill = cfg.showPill === false ? undefined : createPill(cfg.displayName, cfg.port, () => send({ kind: 'kick' }));
  pill?.set('disconnected');

  const tabInfo = () =>
    send({
      kind: 'tabInfo',
      info: { url: location.href, focused: document.hasFocus() && document.visibilityState === 'visible', crmDetected },
    });

  const connect = () => {
    if (!chrome.runtime?.id) return; // extension updated/removed: this context is dead
    try {
      port = chrome.runtime.connect({ name: 'pef-hub-tab' });
    } catch {
      pill?.set('disconnected');
      return;
    }
    port.onMessage.addListener((m: PortToTab) => {
      if (m.kind === 'state') pill?.set(m.state, m.detail);
      else if (m.kind === 'hub') postChannel('toMain', m.env);
    });
    port.onDisconnect.addListener(() => {
      port = undefined;
      pill?.set('disconnected');
      setTimeout(connect, 1000); // service worker restarted: re-attach
    });
    tabInfo();
  };

  onChannel('toIso', (env) => {
    if (env.type === 'crmDetected') {
      crmDetected = !!env.payload;
      tabInfo();
      return;
    }
    send({ kind: 'toHub', env });
  });

  // The MAIN-world adapter may have announced itself before this script loaded: ask again.
  postChannel('toMain', envelope('crmDetected'));

  window.addEventListener('focus', tabInfo);
  window.addEventListener('blur', tabInfo);
  document.addEventListener('visibilitychange', tabInfo);
  connect();
}
