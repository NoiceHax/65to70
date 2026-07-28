import { browser } from 'wxt/browser';
import { badgeText, findLibraryMatch } from '@/lib/overlayMatch';
import type { LibraryEntry, LibraryResponse } from '@/lib/messages';

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
  // textContent, never innerHTML — this runs on pages we don't control.
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

export default defineContentScript({
  registration: 'runtime',
  async main() {
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
