import { resolve } from 'node:path';
import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  webExt: {
    // Opens a DevTools Protocol port so `npm run logs` can stream the service
    // worker and content-script consoles into a terminal.
    chromiumArgs: ['--remote-debugging-port=9222'],

    /*
     * A persistent profile, kept between runs.
     *
     * By default web-ext launches a throwaway profile, which wipes every host
     * permission on restart. Since Keeper asks for nothing at install and is
     * inert until sites are granted, that meant every dev restart began with
     * an extension that could not do anything - and a log that looked like a
     * permissions bug rather than a fresh profile.
     */
    chromiumProfile: resolve('.wxt/chrome-profile'),
    keepProfileChanges: true,
  },
  manifest: {
    name: 'Keeper',
    // The action title comes from the popup entrypoint's <title>, not here.
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
      // Reading where each frame in a tab actually is, after redirects. Embed
      // hosts redirect, so an iframe's src attribute names the wrong origin to
      // grant. This reads frame URLs only - never their contents.
      'webNavigation',
      // Saying so when a streaming site is open that Keeper is not allowed to
      // run on. No content script of ours exists on an ungranted site, so
      // there is nothing in the page to draw a prompt with.
      'notifications',
    ],
    // Deliberately empty. Host access is granted per-site by the user at
    // runtime; nothing is requested at install. See lib/permissions.ts.
    host_permissions: [],
    optional_host_permissions: ['*://*/*'],
  },
});
