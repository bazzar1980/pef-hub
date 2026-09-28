import type {
  CallLogPayload,
  ContactResult,
  Envelope,
  InteractionUpdatePayload,
  ScreenPopPayload,
  Snapshot,
} from '@pef-hub/protocol';
import { envelope } from '@pef-hub/protocol';
import { onChannel, postChannel } from './channel';

/** The only thing a CRM-specific adapter has to implement. Runs in the page (MAIN world). */
export interface CrmAdapter {
  id: string;
  /** true when this page is the CRM and the user is logged in. Polled every 3s. */
  detect(): boolean;
  screenPop(p: ScreenPopPayload): void | Promise<void>;
  searchContacts?(searchString: string): ContactResult[] | Promise<ContactResult[]>;
  logCall?(p: CallLogPayload): void | Promise<void>;
  openCallLog?(p: CallLogPayload): void | Promise<void>;
  onInteractionUpdate?(p: InteractionUpdatePayload): void | Promise<void>;
  /** Current state after a (re)connect or page refresh. */
  onSnapshot?(s: Snapshot): void | Promise<void>;
  /** Wire click-to-dial in the CRM UI and call dial(number). */
  bindClickToDial?(dial: (number: string, autoPlace?: boolean) => void): void;
}

export const defineAdapter = (a: CrmAdapter): CrmAdapter => a;

/** MAIN-world runtime: dispatches hub envelopes to the adapter. No chrome.* APIs here. */
export function startAdapter(adapter: CrmAdapter): void {
  const toIso = (env: Envelope) => postChannel('toIso', env);

  let last: boolean | undefined;
  const check = () => {
    let detected = false;
    try {
      detected = adapter.detect();
    } catch {
      detected = false;
    }
    if (detected !== last) {
      last = detected;
      toIso(envelope('crmDetected', detected));
    }
  };
  check();
  setInterval(check, 3000);

  adapter.bindClickToDial?.((number, autoPlace = true) => toIso(envelope('clickToDial', { number, autoPlace })));

  onChannel('toMain', async (env) => {
    try {
      switch (env.type) {
        case 'crmDetected': // bridge (re)started and asks for the current detection state
          last = undefined;
          check();
          break;
        case 'screenPop':
          await adapter.screenPop(env.payload);
          break;
        case 'contactSearch': {
          const results = (await adapter.searchContacts?.(env.payload?.searchString ?? '')) ?? [];
          toIso(envelope('contactSearchResult', { results }, { correlationId: env.correlationId }));
          break;
        }
        case 'processCallLog':
          await adapter.logCall?.(env.payload);
          break;
        case 'openCallLog':
          await adapter.openCallLog?.(env.payload);
          break;
        case 'interactionUpdate':
          await adapter.onInteractionUpdate?.(env.payload);
          break;
        case 'snapshot':
          await adapter.onSnapshot?.(env.payload);
          break;
      }
    } catch (e) {
      console.error(`[pef-hub:${adapter.id}] adapter failed on ${env.type}`, e);
      if (env.type === 'contactSearch') {
        toIso(envelope('contactSearchResult', { results: [] }, { correlationId: env.correlationId }));
      }
    }
  });
}
