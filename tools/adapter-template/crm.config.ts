import { defineCrmConfig } from '@pef-hub/sdk-extension';

export default defineCrmConfig({
  crmId: '__CRM_ID__',
  displayName: '__DISPLAY_NAME__',
  port: __PORT__,
  host: '127.0.0.1',
  token: 'dev-pairing-token-change-me',
  matches: ['__MATCH__'],
  showPill: true,
});
