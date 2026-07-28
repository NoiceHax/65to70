import { browser } from 'wxt/browser';
import { syncContentScripts } from '@/lib/permissions';
import { db } from '@/lib/db';
import { handleMediaProgress, handlePageMeta, handleTabClosed } from '@/lib/sessionStore';
import { librarySnapshot } from '@/lib/librarySnapshot';
import type { KeeperMessage } from '@/lib/messages';

export default defineBackground(() => {
  // Runtime content-script registrations persist across browser restarts, so
  // these calls exist to repair drift — e.g. the user revoked a site through
  // Chrome's own permissions UI rather than ours.
  browser.runtime.onInstalled.addListener(() => {
    void syncContentScripts();
  });
  browser.runtime.onStartup.addListener(() => {
    void syncContentScripts();
  });
  browser.permissions.onAdded.addListener(() => {
    void syncContentScripts();
  });
  browser.permissions.onRemoved.addListener(() => {
    void syncContentScripts();
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const msg = message as KeeperMessage;

    // The overlay needs an answer, so this branch returns true to keep the
    // channel open for the async reply.
    if (msg.type === 'library-request') {
      void librarySnapshot().then((entries) => sendResponse({ entries }));
      return true;
    }

    const tabId = sender.tab?.id;
    if (tabId === undefined) return;

    switch (msg.type) {
      case 'page-meta':
        void handlePageMeta(tabId, msg);
        break;
      case 'media-progress':
        void handleMediaProgress(tabId, msg);
        break;
    }
    // No response for the fire-and-forget messages.
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void handleTabClosed(tabId);
  });

  // Opening the database here means the first popup render doesn't pay for it.
  void db.open();
});
