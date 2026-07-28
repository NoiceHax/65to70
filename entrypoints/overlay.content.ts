import { browser } from 'wxt/browser';
import { badgeText, findLibraryMatch } from '@/lib/overlayMatch';
import { showToast } from '@/lib/toast';
import type {
  LibraryEntry,
  LibraryResponse,
  SearchQueryResponse,
  WatchlistAddMessage,
} from '@/lib/messages';

/**
 * Search result overlay.
 *
 * Puts what you already know about a film where you are already looking,
 * instead of behind a popup nobody opens. Search "Prisoners" and the result
 * carries "Watched 2019 · ★★★★ · on Prime".
 *
 * Scoped deliberately to titles already in the local library. Recognising
 * arbitrary film names in arbitrary result text is unreliable and open-ended;
 * matching a few thousand titles the user already has a relationship with is
 * trivial, offline, and is exactly the set this has anything to say about.
 *
 * Annotate-only. Nothing is reordered, rewritten, or linked elsewhere.
 */

const BADGE_CLASS = 'keeper-badge';
const MARKED = 'data-keeper-checked';

/** Result headings, per engine. Kept narrow so nothing else gets touched. */
const HEADING_SELECTORS = [
  'h3', // Google
  'article h2 a', // DuckDuckGo
  '[data-testid="result-title-a"]', // DuckDuckGo (newer)
  '.b_algo h2', // Bing
];

let library: LibraryEntry[] = [];

function render(entry: LibraryEntry): HTMLElement {
  const badge = document.createElement('span');
  badge.className = BADGE_CLASS;
  // textContent, never innerHTML - this runs on pages we don't control.
  badge.textContent = badgeText(entry);
  badge.style.cssText = [
    'display:inline-block',
    'margin-left:8px',
    'padding:1px 7px',
    'border-radius:9px',
    'background:rgba(31,111,235,0.12)',
    'color:#1f6feb',
    'font-size:12px',
    'font-weight:500',
    'vertical-align:middle',
    'white-space:nowrap',
  ].join(';');

  return badge;
}

function annotate(): void {
  if (library.length === 0) return;

  for (const selector of HEADING_SELECTORS) {
    for (const heading of Array.from(document.querySelectorAll(selector))) {
      if (heading.hasAttribute(MARKED)) continue;
      heading.setAttribute(MARKED, '1');

      const match = findLibraryMatch(heading.textContent ?? '', library);
      if (!match) continue;

      heading.appendChild(render(match));
    }
  }
}

/** The query, from whichever engine this is. All three use `q`. */
function searchQuery(): string | null {
  try {
    const query = new URL(location.href).searchParams.get('q');
    return query && query.trim().length > 0 ? query.trim() : null;
  } catch {
    return null;
  }
}

let offeredFor = '';

/**
 * Offer to save a searched film.
 *
 * Searching for something is a statement of interest, and right now is the
 * cheapest moment to save it - cheaper than remembering to add it later, which
 * is the step everyone skips. Only ever asks once per query, and only when the
 * background is confident the query names a real title that isn't already
 * known.
 */
async function offerWatchlist(): Promise<void> {
  const query = searchQuery();
  if (!query || query === offeredFor) return;
  offeredFor = query;

  let response: SearchQueryResponse | undefined;
  try {
    response = (await browser.runtime.sendMessage({
      type: 'search-query',
      query,
    })) as SearchQueryResponse | undefined;
  } catch {
    return;
  }

  const match = response?.match;
  if (!match) return;

  const reply = (message: WatchlistAddMessage) => {
    browser.runtime.sendMessage(message).catch(() => {});
  };

  showToast({
    title: match.title,
    year: match.year,
    prompt: 'Save this to your watchlist?',
    confirmLabel: 'Add',
    dismissLabel: 'No thanks',
    // Rating something you haven't watched makes no sense.
    showStars: false,
    onConfirm: () =>
      reply({
        type: 'watchlist-add',
        tmdbId: match.tmdbId,
        mediaType: match.mediaType,
        title: match.title,
        year: match.year,
      }),
    onDismiss: () => {},
    onIgnore: () => {},
  });
}

export default defineContentScript({
  registration: 'runtime',
  async main() {
    void offerWatchlist();
    // Search pages rewrite themselves as the query is refined.
    setInterval(() => void offerWatchlist(), 2_000);

    try {
      const response = (await browser.runtime.sendMessage({
        type: 'library-request',
      })) as LibraryResponse | undefined;

      library = response?.entries ?? [];
    } catch {
      return; // Worker asleep or extension reloading.
    }

    if (library.length === 0) return;

    annotate();

    // Results are injected and replaced as the user refines a query.
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver(() => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(annotate, 200);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  },
});
