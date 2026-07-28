import { browser } from 'wxt/browser';

/**
 * Per-site permissions.
 *
 * Keeper never requests host access at install time. `<all_urls>` at install
 * reads as spyware, is the single biggest uninstall trigger for extensions like
 * this, and would undercut the entire privacy pitch. Instead every origin is
 * granted individually by the user, and content scripts are registered at
 * runtime only for origins that were actually granted.
 *
 * Consequence: `chrome.permissions.getAll()` is the source of truth for which
 * sites we watch. There is no separate list in the database to drift out of
 * sync with reality.
 */

/** Content scripts registered at runtime, keyed by id. */
const RUNTIME_SCRIPTS = {
  generic: {
    id: 'keeper-generic',
    js: ['content-scripts/generic.js'],
  },
} as const;

/** Sites offered during onboarding. Users can add any other site themselves. */
export const SUGGESTED_SITES = [
  { label: 'Netflix', origin: '*://*.netflix.com/*' },
  { label: 'Prime Video', origin: '*://*.primevideo.com/*' },
  { label: 'JioHotstar', origin: '*://*.hotstar.com/*' },
  { label: 'YouTube', origin: '*://*.youtube.com/*' },
] as const;

export async function grantedOrigins(): Promise<string[]> {
  const perms = await browser.permissions.getAll();
  return perms.origins ?? [];
}

/** Must be called from a user gesture (popup/options click) or Chrome rejects it. */
export async function requestSite(origin: string): Promise<boolean> {
  const granted = await browser.permissions.request({ origins: [origin] });
  if (granted) await syncContentScripts();
  return granted;
}

export async function revokeSite(origin: string): Promise<void> {
  await browser.permissions.remove({ origins: [origin] });
  await syncContentScripts();
}

/** Turn a tab URL into an origin pattern we can request. */
export function originPatternFor(url: string): string | null {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return `*://${hostname}/*`;
  } catch {
    return null;
  }
}

/**
 * Re-register runtime content scripts to match exactly the granted origins.
 *
 * Called on startup, on install, and after any grant/revoke. Chrome persists
 * runtime registrations across restarts, so this also repairs drift if a user
 * revokes a permission through Chrome's own UI rather than ours.
 */
export async function syncContentScripts(): Promise<void> {
  const origins = await grantedOrigins();

  const existing = await browser.scripting.getRegisteredContentScripts();
  const existingIds = new Set(existing.map((s) => s.id));

  for (const script of Object.values(RUNTIME_SCRIPTS)) {
    // No granted origins means nothing to match — unregister rather than
    // registering a script with an empty matches array (which is invalid).
    if (origins.length === 0) {
      if (existingIds.has(script.id)) {
        await browser.scripting.unregisterContentScripts({ ids: [script.id] });
      }
      continue;
    }

    const registration = {
      id: script.id,
      js: [...script.js],
      matches: origins,
      // Embedded players are commonly cross-origin iframes; the title usually
      // lives in the parent frame, so both need the script.
      allFrames: true,
      runAt: 'document_idle' as const,
    };

    if (existingIds.has(script.id)) {
      await browser.scripting.updateContentScripts([registration]);
    } else {
      await browser.scripting.registerContentScripts([registration]);
    }
  }
}
