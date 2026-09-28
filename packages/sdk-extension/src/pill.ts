import type { ConnectionState } from '@pef-hub/protocol';

const COLORS: Record<ConnectionState, string> = {
  connected: '#1E8E5A',
  partial: '#D89B00',
  disconnected: '#C8372D',
  'no-crm': '#8A96A3',
};
const LABEL: Record<ConnectionState, string> = {
  connected: 'Connected',
  partial: 'PEF not ready',
  disconnected: 'Hub offline',
  'no-crm': 'CRM not detected',
};

export interface Pill {
  set(state: ConnectionState, detail?: { hub?: string; pefLoggedIn?: boolean; error?: string }): void;
}

/** In-page status pill in a closed Shadow DOM, immune to the CRM's CSS. Click = retry now. */
export function createPill(displayName: string, port: number, onRetry: () => void): Pill {
  const host = document.createElement('pef-hub-status');
  host.style.cssText = 'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      button { font: 500 12px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; display: flex; gap: 8px;
        align-items: center; padding: 7px 12px 7px 9px; border-radius: 999px; border: 1px solid #C9D2DB;
        background: #FFFFFF; color: #16202A; cursor: pointer; box-shadow: 0 1px 2px rgba(22,32,42,.12); }
      button:focus-visible { outline: 2px solid #1F5C7A; outline-offset: 2px; }
      .lamp { width: 10px; height: 10px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(0,0,0,.15); }
      .port { color: #5B6B7A; font-variant-numeric: tabular-nums; }
      .collapsed .text { display: none; }
      @media (prefers-reduced-motion: no-preference) { .lamp.pulse { animation: p 1.2s ease-in-out infinite; } }
      @keyframes p { 50% { opacity: .35; } }
    </style>
    <button type="button" aria-live="polite"><span class="lamp"></span><span class="text"><span class="label"></span> <span class="port"></span></span></button>`;
  const btn = root.querySelector('button')!;
  const lamp = root.querySelector<HTMLElement>('.lamp')!;
  const label = root.querySelector<HTMLElement>('.label')!;
  root.querySelector<HTMLElement>('.port')!.textContent = `:${port}`;

  let collapseTimer: ReturnType<typeof setTimeout> | undefined;
  btn.addEventListener('click', onRetry);
  btn.addEventListener('mouseenter', () => btn.classList.remove('collapsed'));

  const mount = () => {
    if (!host.isConnected) (document.body ?? document.documentElement).appendChild(host);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  return {
    set(state, detail) {
      lamp.style.background = COLORS[state];
      lamp.classList.toggle('pulse', state === 'disconnected');
      label.textContent = `${displayName}: ${LABEL[state]}`;
      btn.title = detail?.error ? `${LABEL[state]} (${detail.error}). Click to retry.` : `${LABEL[state]}. Click to retry.`;
      // Stay expanded while something is wrong, shrink to a lamp when healthy.
      clearTimeout(collapseTimer);
      btn.classList.remove('collapsed');
      if (state === 'connected') collapseTimer = setTimeout(() => btn.classList.add('collapsed'), 4000);
    },
  };
}
