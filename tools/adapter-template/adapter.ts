import { createGenericAdapter } from '@pef-hub/sdk-extension';

/**
 * CRM-specific logic lives ONLY here.
 * Start from the generic adapter (window.pefHubCrm contract + DOM events + toast),
 * then replace screenPop / searchContacts / logCall with the CRM's real APIs.
 */
export default createGenericAdapter({
  id: '__CRM_ID__',
  detect: () => document.readyState !== 'loading',
});
