import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Keeper',
    action: { default_title: 'Keeper' },
    description:
      'Local-first watch tracker and universal watchlist. Your history never leaves your machine.',
    permissions: [
      'storage',
      // Runtime registration of content scripts, for granted origins only.
      'scripting',
      // Reading the active tab's URL so the popup can offer "watch this site".
      'tabs',
      // Weekly refresh of the prepared title/availability indexes.
      'alarms',
    ],
    // Deliberately empty. Host access is granted per-site by the user at
    // runtime; nothing is requested at install. See lib/permissions.ts.
    host_permissions: [],
    optional_host_permissions: ['*://*/*'],
  },
});
