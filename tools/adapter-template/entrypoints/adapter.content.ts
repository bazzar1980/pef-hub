import { startAdapter } from '@pef-hub/sdk-extension/adapter';
import crm from '../crm.config';
import adapter from '../adapter';

export default defineContentScript({
  matches: crm.matches,
  world: 'MAIN',
  runAt: 'document_idle',
  main() {
    startAdapter(adapter);
  },
});
