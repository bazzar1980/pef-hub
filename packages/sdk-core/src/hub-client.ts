import {
  PROTOCOL_VERSION,
  envelope,
  type Envelope,
  type HelloPayload,
  type MessageType,
  type PefState,
  type TabInfo,
  type WelcomePayload,
} from '@pef-hub/protocol';

export type SocketState = 'disconnected' | 'connecting' | 'connected';

export interface HubClientOptions {
  /** e.g. wss://127.0.0.1:9101 */
  url: string;
  token: string;
  crmId: string;
  sdkVersion: string;
  extensionId?: string;
  capabilities: string[];
  /** App-level heartbeat. Keep < 30s so the MV3 service worker stays alive. */
  heartbeatMs?: number;
  /** Reconnect backoff steps (ms). The last value repeats. */
  backoffMs?: number[];
}

type MessageListener = (env: Envelope) => void;
type StateListener = () => void;

/**
 * Hub client (runs inside the extension service worker).
 * - hello/pairing handshake: "connected" only after the hub's welcome
 * - heartbeat carries tab info, heartbeatAck carries PEF state
 * - reconnect with backoff + jitter, kick() for an immediate retry
 */
export class HubClient {
  state: SocketState = 'disconnected';
  pefState: PefState = { loggedIn: false };
  sessionId?: string;
  lastError?: string;

  private ws?: WebSocket;
  private attempt = 0;
  private hbTimer?: ReturnType<typeof setInterval>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly stateListeners = new Set<StateListener>();
  private tabsProvider: () => TabInfo[] = () => [];
  private readonly opts: Required<HubClientOptions>;

  constructor(opts: HubClientOptions) {
    this.opts = {
      heartbeatMs: 20_000,
      backoffMs: [1_000, 2_000, 5_000, 10_000],
      extensionId: '',
      ...opts,
    };
  }

  setTabsProvider(fn: () => TabInfo[]): void {
    this.tabsProvider = fn;
  }

  onMessage(fn: MessageListener): () => void {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  onStateChange(fn: StateListener): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(this.retryTimer);
    this.setState('connecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (e) {
      this.lastError = String(e);
      this.setState('disconnected');
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      const hello: HelloPayload = {
        token: this.opts.token,
        crmId: this.opts.crmId,
        sdkVersion: this.opts.sdkVersion,
        extensionId: this.opts.extensionId,
        capabilities: this.opts.capabilities,
      };
      ws.send(JSON.stringify(envelope('hello', hello)));
    };

    ws.onmessage = (ev) => {
      let env: Envelope;
      try {
        env = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      this.handle(env);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.stopHeartbeat();
      this.ws = undefined;
      this.sessionId = undefined;
      this.setState('disconnected');
      this.scheduleRetry();
    };

    ws.onerror = () => {
      this.lastError = 'socket error (hub not running, port closed or certificate not trusted)';
    };
  }

  /** Immediate retry (tab opened, focus, alarm, badge click). No-op when connected. */
  kick(): void {
    if (this.state === 'connected' || this.state === 'connecting') return;
    this.attempt = 0;
    this.connect();
  }

  send<T>(type: MessageType, payload?: T, extra: Partial<Envelope<T>> = {}): boolean {
    if (this.state !== 'connected' || !this.ws) return false;
    this.ws.send(JSON.stringify(envelope(type, payload, extra)));
    return true;
  }

  private handle(env: Envelope): void {
    switch (env.type) {
      case 'welcome': {
        const w = env.payload as WelcomePayload;
        if (w.protocolVersion !== PROTOCOL_VERSION) {
          this.lastError = `protocol mismatch: hub v${w.protocolVersion}, sdk v${PROTOCOL_VERSION}`;
        }
        this.sessionId = w.sessionId;
        this.pefState = w.pefState ?? { loggedIn: false };
        this.attempt = 0;
        this.lastError = undefined;
        this.startHeartbeat();
        this.setState('connected');
        break;
      }
      case 'heartbeatAck': {
        const next = (env.payload?.pefState ?? this.pefState) as PefState;
        const changed = next.loggedIn !== this.pefState.loggedIn;
        this.pefState = next;
        if (changed) this.emitState();
        break;
      }
      case 'error':
        this.lastError = env.payload?.reason ?? 'hub error';
        this.emitState();
        break;
      default:
        for (const l of this.messageListeners) l(env);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const beat = () => this.send('heartbeat', { tabs: this.tabsProvider() });
    beat();
    this.hbTimer = setInterval(beat, this.opts.heartbeatMs);
  }

  private stopHeartbeat(): void {
    clearInterval(this.hbTimer);
    this.hbTimer = undefined;
  }

  private scheduleRetry(): void {
    const steps = this.opts.backoffMs;
    const base = steps[Math.min(this.attempt, steps.length - 1)];
    const delay = base + Math.floor(Math.random() * 400);
    this.attempt++;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private setState(s: SocketState): void {
    if (this.state === s) return;
    this.state = s;
    this.emitState();
  }

  private emitState(): void {
    for (const l of this.stateListeners) l();
  }
}
