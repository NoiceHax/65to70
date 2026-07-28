import { browser } from 'wxt/browser';
import { getSettings } from './settings';

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
 * `scope` decides which granted origins each one runs on - the overlay must not
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
 * treadmill, and worse, it trains someone to approve unfamiliar domains - which
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
/**
 * Serialises registration.
 *
 * This is called from five places - install, startup, permission added,
 * permission removed, and each grant - and several of those fire together. Two
 * concurrent runs both read the registration list as empty and both try to
 * register, which fails with a duplicate id and leaves a script unregistered
 * entirely. Chaining onto the previous run makes that impossible.
 */
let syncQueue: Promise<void> = Promise.resolve();

export function syncContentScripts(): Promise<void> {
  syncQueue = syncQueue.then(runSync, runSync);
  return syncQueue;
}

async function runSync(): Promise<void> {
  const origins = await grantedOrigins();
  const { excludedOrigins, trackingPaused } = await getSettings();

  console.log('[keeper] granted origins:', origins.length > 0 ? origins.join(', ') : '(none)');

  /*
   * Paused means nothing runs at all.
   *
   * Unregistering rather than filtering later, so there is genuinely no script
   * in any page reading anything. A pause that still ran and quietly threw the
   * results away would be a worse promise than not offering one.
   */
  if (trackingPaused) {
    const running = await browser.scripting.getRegisteredContentScripts();
    const ids = running.map((script) => script.id);
    if (ids.length > 0) await browser.scripting.unregisterContentScripts({ ids });
    console.log('[keeper] tracking paused, no scripts registered');
    return;
  }

  const existing = await browser.scripting.getRegisteredContentScripts();
  const existingIds = new Set(existing.map((s) => s.id));

  for (const script of RUNTIME_SCRIPTS) {
    const matches =
      script.scope === 'search'
        ? origins.filter(isSearchOrigin)
        : origins.filter((origin) => !isSearchOrigin(origin));

    // Keep the tracker off search engines, always.
    //
    // Filtering the granted list is not enough once an all-sites grant exists,
    // because the catch-all pattern is not itself a search origin and so
    // matches everything including them. The tracker then ran on results
    // pages, saw the YouTube frames there, concluded the page was somewhere
    // you watch things, and queued the search query itself as something
    // watched, while the overlay offered to add the same query to the
    // watchlist. Two prompts, both wrong.
    //
    // Nobody watches a film on a results page, so this is unconditional.
    const exclusions =
      script.scope === 'search'
        ? excludedOrigins
        : [...excludedOrigins, ...SEARCH_ORIGINS];

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
      // Excluded at registration, not filtered afterwards. Nothing of ours
      // runs on these origins, so there is no title to leak because none is
      // ever read.
      ...(exclusions.length > 0 ? { excludeMatches: exclusions } : {}),
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
      // Something registered it between the read above and here. Replacing it
      // is the recovery: the alternative is a script that never registers.
      try {
        await browser.scripting.unregisterContentScripts({ ids: [script.id] });
        await browser.scripting.registerContentScripts([registration]);
        console.log(`[keeper] re-registered ${script.id} for:`, matches.join(', '));
      } catch (retryError) {
        console.error(`[keeper] could not register ${script.id}:`, retryError, error);
      }
    }
  }
}
