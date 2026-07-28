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
