import { normalizeTitle } from './match';
import type { LibraryEntry } from './messages';

/**
 * Finding a known title inside a search result heading.
 *
 * Kept out of the content script so the boundary rules can be tested directly.
 * A false positive here is worse than a miss: a badge on the wrong result is
 * visible, wrong, and immediately discredits everything else the overlay says.
 */

/**
 * Longest library title contained in the heading.
 *
 * Entries are expected longest-first, so the first hit is the most specific -
 * "Blade Runner 2049" wins over "Blade Runner" when both are in the library.
 *
 * The boundary check is what stops substring matches from firing on unrelated
 * words: "Her" must not light up inside "Gathering", and "Up" must not match
 * inside "Upgrade".
 */
export function findLibraryMatch(
  headingText: string,
  library: LibraryEntry[],
): LibraryEntry | null {
  if (headingText.length === 0 || headingText.length > 300) return null;

  const normalized = normalizeTitle(headingText);
  if (normalized.length === 0) return null;

  for (const entry of library) {
    if (entry.n.length === 0) continue;

    let from = 0;
    for (;;) {
      const at = normalized.indexOf(entry.n, from);
      if (at === -1) break;

      const before = at === 0 ? ' ' : normalized[at - 1];
      const afterIndex = at + entry.n.length;
      const after = afterIndex >= normalized.length ? ' ' : normalized[afterIndex];

      if (before === ' ' && after === ' ') return entry;
      from = at + 1;
    }
  }

  return null;
}

/**
 * Sites a search engine links to when the subject is a film or a show.
 *
 * These appear in results and knowledge panels for screen titles and almost
 * nothing else, which makes their presence a far better signal than anything
 * the query text can offer.
 */
const FILM_REFERENCE = /(^|\.)(imdb\.com|rottentomatoes\.com|themoviedb\.org|letterboxd\.com|metacritic\.com|justwatch\.com)$/i;

/** Descriptions a knowledge panel uses for screen titles. */
const FILM_DESCRIPTION =
  /\b(tv series|television series|web series|miniseries|feature film|American film|film series|directed by|season \d|episodes?\b.*\bseasons?)\b/i;

/**
 * Whether this search is actually about something watchable.
 *
 * The query on its own cannot answer this. A great many titles are ordinary
 * words - "Up", "Her", "It", "Ghost", "Frozen" - so matching the query against
 * a catalogue of tens of thousands says almost nothing about intent, and using
 * it alone offered to save a film for practically every search typed.
 *
 * The results page does answer it. A search about a film links to film
 * databases and carries a panel describing it as one; a search about anything
 * else does neither.
 */
export function searchLooksLikeScreenTitle(root: ParentNode): boolean {
  for (const link of Array.from(root.querySelectorAll('a[href]'))) {
    const href = link.getAttribute('href') ?? '';
    try {
      // Search engines wrap outbound links, so the target may be a parameter.
      const url = new URL(href, 'https://example.invalid');
      const target = url.searchParams.get('q') ?? url.searchParams.get('url') ?? href;
      const { hostname } = new URL(target, 'https://example.invalid');
      if (FILM_REFERENCE.test(hostname)) return true;
    } catch {
      // Relative or malformed; nothing to read.
    }
  }

  // Knowledge panels are short and descriptive. Long prose is an article that
  // merely mentions a film.
  for (const element of Array.from(root.querySelectorAll('span, div, h2'))) {
    const text = element.textContent?.trim() ?? '';
    if (text.length > 0 && text.length <= 80 && FILM_DESCRIPTION.test(text)) return true;
  }

  return false;
}

/** The line shown next to a matched result. */
export function badgeText(entry: LibraryEntry): string {
  const bits: string[] = [];

  if (entry.watched) bits.push(entry.at ? `Watched ${entry.at.slice(0, 4)}` : 'Watched');
  if (entry.rating !== null) bits.push('★'.repeat(Math.round(entry.rating)));
  else if (entry.liked) bits.push('♥');
  if (bits.length === 0) bits.push('On your watchlist');
  if (entry.on?.length) bits.push(`on ${entry.on.slice(0, 2).join(', ')}`);

  return bits.join(' · ');
}
