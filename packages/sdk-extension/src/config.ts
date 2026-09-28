/** Bump on every SDK change: all extensions are regenerated with the new value. */
export const SDK_VERSION = '0.1.0';

export interface CrmExtensionConfig {
  /** Must match a listener crmId in hub.config.json. */
  crmId: string;
  displayName: string;
  /** Dedicated WSS port for this CRM (one listener per CRM on the hub). */
  port: number;
  /** Use 127.0.0.1 (not "localhost") to avoid IPv6 ::1 fallback delays on Windows. */
  host?: string;
  /** Pairing token (dev). Production: per-install token, see README. */
  token: string;
  /** Chrome match patterns for the CRM pages. */
  matches: string[];
  /** Show the in-page status pill (badge on the toolbar icon is always shown). */
  showPill?: boolean;
}

export const defineCrmConfig = (c: CrmExtensionConfig): CrmExtensionConfig => c;
