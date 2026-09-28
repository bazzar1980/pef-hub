import { defineConfig } from 'wxt';
import crm from './crm.config';

export default defineConfig({
  manifest: {
    name: `PEF Hub connector: ${crm.displayName}`,
    description: `Connects ${crm.displayName} to the local PEF Hub on wss://127.0.0.1:${crm.port}`,
    permissions: ['alarms'],
    host_permissions: crm.matches,
    action: { default_title: `PEF Hub: ${crm.displayName}` },
  },
});
