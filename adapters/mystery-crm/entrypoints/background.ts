import { startBackground } from '@pef-hub/sdk-extension/background';
import crm from '../crm.config';

export default defineBackground(() => {
  startBackground(crm);
});
