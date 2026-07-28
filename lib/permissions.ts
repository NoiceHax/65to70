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

/**
 * Origins where the search overlay is useful. Kept separate because the overlay
 * is a different bargain from watch tracking: it reads result headings on pages
 * that have nothing to do with playback, so it's granted separately and never
 * implied by turning on a streaming site.
 */
export const SEARCH_ORIGINS = [
  '*://*.google.com/*',
  '*://*.duckduckgo.com/*',
  '*://*.bing.com/*',
  '*://*.imdb.com/*',
] as const;

/**
 * Content scripts registered at runtime, keyed by id.
 *
 * `scope` decides which granted origins each one runs on — the overlay must not
 * be injected into every site the user tracks, and the tracker has no business
 * on a search results page.
 */
const RUNTIME_SCRIPTS = [
  {
    id: 'keeper-generic',
    js: ['content-scripts/generic.js'],
    allFrames: true,
    scope: 'watch' as const,
  },
  {
    id: 'keeper-overlay',
    js: ['content-scripts/overlay.js'],
    allFrames: false,
    scope: 'search' as const,
  },
];

/** Sites offered during onboarding. Users can add any other site themselves. */
export const SUGGESTED_SITES = [
  { label: 'Netflix', origin: '*://*.netflix.com/*' },
  { label: 'Prime Video', origin: '*://*.primevideo.com/*' },
  { label: 'JioHotstar', origin: '*://*.hotstar.com/*' },
  { label: 'YouTube', origin: '*://*.youtube.com/*' },
] as const;

export const SEARCH_SITES = [
  { label: 'Google', origin: '*://*.google.com/*' },
  { label: 'DuckDuckGo', origin: '*://*.duckduckgo.com/*' },
  { label: 'Bing', origin: '*://*.bing.com/*' },
  { label: 'IMDb', origin: '*://*.imdb.com/*' },
] as const;

function isSearchOrigin(origin: string): boolean {
  return (SEARCH_ORIGINS as readonly string[]).includes(origin);
}

/** The catch-all grant. */
export const ALL_SITES = '*://*/*';

/**
 * Whether the user has opted into tracking every site.
 *
 * Per-origin grants are the right default and remain the default. They are
 * also, on aggregator sites, unworkable: those pages load the player from a
 * separate host, offer a switcher that changes that host with every click, and
 * rotate the domains outright every few weeks. Granting them one at a time is a
 * treadmill, and worse, it trains someone to approve unfamiliar domains — which
 * is how ad and tracking origins end up granted by mistake.
 *
 * So this exists, off by default, stated plainly, and revocable in one click.
 */
export async function hasAllSites(): Promise<boolean> {
  return browser.permissions.contains({ origins: [ALL_SITES] });
}

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
  console.log('[keeper] granted origins:', origins.length > 0 ? origins.join(', ') : '(none)');

  const existing = await browser.scripting.getRegisteredContentScripts();
  const existingIds = new Set(existing.map((s) => s.id));

  for (const script of RUNTIME_SCRIPTS) {
    const matches =
      script.scope === 'search'
        ? origins.filter(isSearchOrigin)
        : origins.filter((origin) => !isSearchOrigin(origin));

    // An empty matches array is invalid, so unregister instead of registering
    // a script that can never run.
    if (matches.length === 0) {
      if (existingIds.has(script.id)) {
        await browser.scripting.unregisterContentScripts({ ids: [script.id] });
      }
      continue;
    }

    const registration = {
      id: script.id,
      js: [...script.js],
      matches,
      // Embedded players are commonly cross-origin iframes; the title usually
      // lives in the parent frame, so both need the tracker.
      allFrames: script.allFrames,
      runAt: 'document_idle' as const,
    };

    // Registration is one of the few places a silent failure looks exactly
    // like "the extension does nothing", so it says so either way.
    try {
      if (existingIds.has(script.id)) {
        await browser.scripting.updateContentScripts([registration]);
      } else {
        await browser.scripting.registerContentScripts([registration]);
      }
      console.log(`[keeper] registered ${script.id} for:`, matches.join(', '));
    } catch (error) {
      console.error(`[keeper] FAILED to register ${script.id}:`, error);
    }
  }
}
