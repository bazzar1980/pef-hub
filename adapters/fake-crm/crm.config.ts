import { defineCrmConfig } from '@pef-hub/sdk-extension';

export default defineCrmConfig({
  crmId: 'fake-crm',
  displayName: 'Fake CRM',
  port: 9101,
  host: '127.0.0.1',
  token: 'dev-pairing-token-change-me',
  matches: ['https://localhost:5173/*'],
  showPill: true,
});
