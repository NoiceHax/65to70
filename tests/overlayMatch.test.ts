import { describe, expect, it } from 'vitest';
import { badgeText, findLibraryMatch } from '@/lib/overlayMatch';
import { normalizeTitle } from '@/lib/match';
import type { LibraryEntry } from '@/lib/messages';

function entry(title: string, extra: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    n: normalizeTitle(title),
    title,
    rating: null,
    liked: false,
    watched: true,
    ...extra,
  };
}

/** The snapshot is sorted longest-first, so tests mirror that. */
function library(...titles: string[]): LibraryEntry[] {
  return titles.map((t) => entry(t)).sort((a, b) => b.n.length - a.n.length);
}

describe('findLibraryMatch', () => {
  it('matches a title inside a search result heading', () => {
    const found = findLibraryMatch('Prisoners (2013) - IMDb', library('Prisoners'));
    expect(found?.title).toBe('Prisoners');
  });

  it('prefers the most specific title when both are in the library', () => {
    const found = findLibraryMatch(
      'Blade Runner 2049 review',
      library('Blade Runner', 'Blade Runner 2049'),
    );
    expect(found?.title).toBe('Blade Runner 2049');
  });

  it('does not fire on a word that merely contains a title', () => {
    // The failure mode that would discredit the whole overlay.
    expect(findLibraryMatch('The Gathering Storm', library('Her'))).toBeNull();
    expect(findLibraryMatch('Upgrade your account', library('Upgr'))).toBeNull();
  });

  it('keeps searching past a boundary failure to find a real hit', () => {
    // "her" appears inside "Gathering" first, then standing alone.
    const found = findLibraryMatch('Gathering thoughts on Her tonight', [entry('Her')]);
    expect(found?.title).toBe('Her');
  });

  it('matches at the start and end of a heading', () => {
    expect(findLibraryMatch('Arrival is streaming', library('Arrival'))?.title).toBe('Arrival');
    expect(findLibraryMatch('Watch Arrival', library('Arrival'))?.title).toBe('Arrival');
  });

  it('ignores punctuation differences', () => {
    expect(findLibraryMatch('Spider-Man: No Way Home', library('Spider Man'))).toBeTruthy();
  });

  it('returns null for empty or absurdly long text', () => {
    expect(findLibraryMatch('', library('Arrival'))).toBeNull();
    expect(findLibraryMatch('x'.repeat(400), library('Arrival'))).toBeNull();
  });

  it('returns null when the library is empty', () => {
    expect(findLibraryMatch('Prisoners', [])).toBeNull();
  });
});

describe('badgeText', () => {
  it('states the year watched and the rating', () => {
    const text = badgeText(entry('Prisoners', { at: '2019-04-02', rating: 4 }));
    expect(text).toContain('Watched 2019');
    expect(text).toContain('★★★★');
  });

  it('falls back to a heart when liked but unrated', () => {
    // Liked without stars is a first-class state, so it has to render as one.
    expect(badgeText(entry('Arrival', { liked: true, rating: null }))).toContain('♥');
  });

  it('says watchlist when nothing has been watched or rated', () => {
    expect(badgeText(entry('Dune', { watched: false }))).toBe('On your watchlist');
  });

  it('appends where it is streaming', () => {
    const text = badgeText(entry('Dune', { watched: false, on: ['Netflix', 'Prime'] }));
    expect(text).toContain('on Netflix, Prime');
  });
});
