import { defineCrmConfig } from '@pef-hub/sdk-extension';

export default defineCrmConfig({
  crmId: 'mystery-crm',
  displayName: 'Mystery CRM',
  port: 9102,
  host: '127.0.0.1',
  token: 'dev-pairing-token-change-me',
  matches: ['https://localhost:4200/*'],
  showPill: true,
});
