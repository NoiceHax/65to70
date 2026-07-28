import { browser } from 'wxt/browser';
import { syncContentScripts } from '@/lib/permissions';
import { db } from '@/lib/db';

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

  // Chrome fires these when permissions change from anywhere, including
  // Chrome's settings page.
  browser.permissions.onAdded.addListener(() => {
    void syncContentScripts();
  });
  browser.permissions.onRemoved.addListener(() => {
    void syncContentScripts();
  });

  // Opening the database here means the first popup render doesn't pay for it.
  void db.open();
});
