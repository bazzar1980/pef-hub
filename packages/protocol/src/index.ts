/**
 * PEF Hub wire protocol (v1) - shared by hub, SDK and adapters.
 * The Rust side mirrors this in apps/hub/src-tauri/src/protocol.rs.
 */
export const PROTOCOL_VERSION = 1;

/** Visual state shown by badge / pill / hub window. */
export type ConnectionState = 'connected' | 'partial' | 'disconnected' | 'no-crm';

export type MessageType =
  // CRM -> Hub
  | 'hello'
  | 'heartbeat'
  | 'snapshotRequest'
  | 'clickToDial'
  | 'contactSearchResult'
  | 'callLogResult'
  | 'focusRecord'
  // Hub -> CRM
  | 'welcome'
  | 'heartbeatAck'
  | 'snapshot'
  | 'screenPop'
  | 'contactSearch'
  | 'processCallLog'
  | 'openCallLog'
  | 'interactionUpdate'
  | 'error'
  // internal (content script <-> MAIN world only)
  | 'crmDetected';

export interface Envelope<T = any> {
  v: number;
  type: MessageType;
  id?: string;
  correlationId?: string;
  crmId?: string;
  tabId?: string;
  payload?: T;
}

export interface HelloPayload {
  token: string;
  crmId: string;
  sdkVersion: string;
  extensionId?: string;
  capabilities: string[];
}

export interface PefState {
  loggedIn: boolean;
  station?: string | null;
  lastEvent?: string;
}

/** Subset of the Embeddable Framework interaction object we rely on. */
export interface PefInteraction {
  id: string;
  ani?: string;
  calledNumber?: string;
  direction?: string;
  queueName?: string;
  state?: string;
  attributes?: Record<string, string>;
  [key: string]: unknown;
}

export interface InteractionSnapshot {
  id: string;
  ownerCrm?: string | null;
  interaction: PefInteraction;
}

export interface Snapshot {
  interactions: InteractionSnapshot[];
}

export interface WelcomePayload {
  sessionId: string;
  protocolVersion: number;
  pefState: PefState;
  snapshot: Snapshot;
}

export interface ScreenPopPayload {
  searchString?: string;
  interaction: PefInteraction;
}

export interface CallLogPayload {
  callLog: Record<string, unknown>;
  interaction: PefInteraction;
  eventName?: string;
}

export interface InteractionUpdatePayload {
  category: string;
  interaction: PefInteraction;
}

/** Embeddable Framework contactSearch result format. */
export interface ContactResult {
  type: 'external';
  name: string;
  phone?: { number: string; label?: string }[];
  attributes?: Record<string, string>;
}

export interface TabInfo {
  tabId: string;
  url: string;
  focused: boolean;
  crmDetected: boolean;
  lastFocusAt: number;
}

export function newId(): string {
  return crypto.randomUUID();
}

export function envelope<T>(type: MessageType, payload?: T, extra: Partial<Envelope<T>> = {}): Envelope<T> {
  return { v: PROTOCOL_VERSION, type, id: newId(), payload, ...extra };
}
