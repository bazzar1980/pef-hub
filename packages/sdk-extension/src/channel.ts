import type { Envelope } from '@pef-hub/protocol';

/** window.postMessage channel between the isolated content script and the MAIN-world adapter. */
export const NS = 'pef-hub-sdk';
export type Direction = 'toMain' | 'toIso';

export interface ChannelMessage {
  ns: typeof NS;
  dir: Direction;
  env: Envelope;
}

export function postChannel(dir: Direction, env: Envelope): void {
  window.postMessage({ ns: NS, dir, env } satisfies ChannelMessage, location.origin);
}

export function onChannel(dir: Direction, fn: (env: Envelope) => void): void {
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== window) return;
    const d = ev.data as ChannelMessage | undefined;
    if (!d || d.ns !== NS || d.dir !== dir || !d.env) return;
    fn(d.env);
  });
}
