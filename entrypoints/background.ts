import { browser } from 'wxt/browser';
import { syncContentScripts } from '@/lib/permissions';
import { db } from '@/lib/db';
import { handleMediaProgress, handlePageMeta, handleTabClosed } from '@/lib/sessionStore';
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

  browser.runtime.onMessage.addListener((message, sender) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;

    const msg = message as KeeperMessage;
    switch (msg.type) {
      case 'page-meta':
        void handlePageMeta(tabId, msg);
        break;
      case 'media-progress':
        void handleMediaProgress(tabId, msg);
        break;
    }
    // No response is sent; returning undefined keeps the channel synchronous.
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void handleTabClosed(tabId);
  });

  // Opening the database here means the first popup render doesn't pay for it.
  void db.open();
});
