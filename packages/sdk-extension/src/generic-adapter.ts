import type { CallLogPayload, ContactResult, ScreenPopPayload, Snapshot } from '@pef-hub/protocol';
import { defineAdapter, type CrmAdapter } from './adapter';
import { showToast } from './toast';

/**
 * Optional page-side contract: a CRM (custom or dev) can expose window.pefHubCrm
 * and get a working integration with zero adapter code.
 */
export interface PefHubCrmApi {
  screenPop?(p: ScreenPopPayload): void | Promise<void>;
  searchContacts?(searchString: string): ContactResult[] | Promise<ContactResult[]>;
  logCall?(p: CallLogPayload): void | Promise<void>;
  onSnapshot?(s: Snapshot): void;
}

declare global {
  interface Window {
    pefHubCrm?: PefHubCrmApi;
  }
}

const DEMO: ContactResult[] = [
  { type: 'external', name: 'Mario Rossi', phone: [{ number: '+390755551234', label: 'Mobile' }] },
  { type: 'external', name: 'Giulia Bianchi', phone: [{ number: '+390755559876', label: 'Office' }] },
];

/**
 * Generic adapter: delegates to window.pefHubCrm when present, otherwise emits DOM events
 * (pefhub:screenpop, pefhub:calllog, pefhub:interaction) and shows a toast.
 */
export function createGenericAdapter(opts: { id: string; detect: () => boolean }): CrmAdapter {
  const emit = (name: string, detail: unknown): void => {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  };
  return defineAdapter({
    id: opts.id,
    detect: opts.detect,
    screenPop: async (p) => {
      emit('pefhub:screenpop', p);
      if (window.pefHubCrm?.screenPop) return window.pefHubCrm.screenPop(p);
      showToast(`Screen pop: ${p.interaction?.ani ?? p.searchString ?? p.interaction?.id}`);
    },
    searchContacts: async (q) => {
      if (window.pefHubCrm?.searchContacts) return window.pefHubCrm.searchContacts(q);
      const needle = q.replace(/\s/g, '').toLowerCase();
      return DEMO.filter((c) => c.name.toLowerCase().includes(needle) || c.phone?.some((p) => p.number.includes(needle)));
    },
    logCall: async (p) => {
      emit('pefhub:calllog', p);
      await window.pefHubCrm?.logCall?.(p);
    },
    onInteractionUpdate: (p) => {
      emit('pefhub:interaction', p);
    },
    onSnapshot: (s) => {
      emit('pefhub:snapshot', s);
      window.pefHubCrm?.onSnapshot?.(s);
    },
    bindClickToDial: (dial) => {
      document.addEventListener(
        'click',
        (e) => {
          const a = (e.target as Element | null)?.closest?.('a[href^="tel:"]') as HTMLAnchorElement | null;
          if (!a) return;
          e.preventDefault();
          dial(decodeURIComponent(a.getAttribute('href')!.slice(4)));
        },
        true,
      );
    },
  });
}
