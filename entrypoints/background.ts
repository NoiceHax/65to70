import { browser } from 'wxt/browser';
import { syncContentScripts } from '@/lib/permissions';
import { db } from '@/lib/db';
import { handleMediaProgress, handlePageMeta, handleTabClosed } from '@/lib/sessionStore';
import { invalidateLibrarySnapshot, librarySnapshot } from '@/lib/librarySnapshot';
import { addFromSearch, offerFromSearch } from '@/lib/searchIntent';
import { confirmCandidate, dismissPending } from '@/lib/resolver';
import { refreshBadge } from '@/lib/badge';
import { loadBundledIndexes } from '@/lib/bundledIndexes';
import { collectFrameReport, formatReports, type FrameReport } from '@/lib/diagnose';
import { maybePromptForSite } from '@/lib/newSitePrompt';
import type { KeeperMessage } from '@/lib/messages';

export default defineBackground(() => {
  // Runtime content-script registrations persist across browser restarts, so
  // these calls exist to repair drift - e.g. the user revoked a site through
  // Chrome's own permissions UI rather than ours.
  // Prepared indexes that shipped in the build go in without being asked for.
  const seed = () => {
    void syncContentScripts();
    void loadBundledIndexes().then((report) => {
      if (report.titles || report.availability || report.similar) {
        console.log('[keeper] loaded bundled indexes:', report);
      }
    });
  };

  browser.runtime.onInstalled.addListener(seed);
  browser.runtime.onStartup.addListener(seed);
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

    /*
     * Run the collector in every frame at once.
     *
     * scripting.executeScript with allFrames returns one result per frame,
     * which is what makes this workable on sites that put the player in an
     * embed - the frame holding the video reports alongside its parent, and
     * neither needs a devtools panel open to be inspected.
     */
    if (msg.type === 'diagnose-page') {
      void browser.scripting
        .executeScript({
          target: { tabId: msg.tabId, allFrames: true },
          func: collectFrameReport,
        })
        .then((results) => {
          const reports = results.map((r) => r.result).filter(Boolean) as FrameReport[];
          sendResponse({ report: formatReports(reports) || 'No frames responded.' });
        })
        .catch((error: Error) => {
          sendResponse({ report: `Could not inspect this page: ${error.message}` });
        });
      return true;
    }

    if (msg.type === 'search-query') {
      void offerFromSearch(msg.query).then(sendResponse);
      return true;
    }

    // Saving from a search is an explicit choice, so it goes straight to the
    // watchlist rather than through the confirm queue.
    if (msg.type === 'watchlist-add') {
      void addFromSearch(msg.tmdbId, msg.mediaType, msg.title, msg.year).then(() => {
        invalidateLibrarySnapshot();
      });
      return;
    }

    // The in-page prompt. Confirming here does exactly what the queue does -
    // there is still only one path by which anything becomes "watched".
    if (msg.type === 'toast-action') {
      // Only a matched title can be confirmed from the page. An unmatched one
      // stays in the queue, where it can be searched for properly.
      if (msg.action === 'confirm' && msg.tmdbId !== undefined) {
        void confirmCandidate(msg.pendingId, msg.tmdbId, msg.mediaType, {
          rating: msg.rating,
        }).then(refreshBadge);
      } else if (msg.action === 'dismiss') {
        void dismissPending(msg.pendingId).then(refreshBadge);
      }
      // 'ignore' deliberately does nothing: the detection stays in the queue.
      return;
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

  // Notice a streaming site we are not allowed to run on and say so once.
  browser.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url) void maybePromptForSite(changeInfo.url);
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void handleTabClosed(tabId);
  });

  // Opening the database here means the first popup render doesn't pay for it.
  void db.open().then(refreshBadge);
});
