import { startBridge } from '@pef-hub/sdk-extension/bridge';
import crm from '../crm.config';

export default defineContentScript({
  matches: crm.matches,
  runAt: 'document_idle',
  main() {
    startBridge(crm);
  },
});
