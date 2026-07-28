import { describe, expect, it } from 'vitest';
import { isDecisive, normalizeTitle, rankMatches, scoreMatch } from '@/lib/match';
import type { TmdbTitle } from '@/lib/tmdb';

function title(partial: Partial<TmdbTitle> & { title: string }): TmdbTitle {
  return { tmdbId: 1, mediaType: 'movie', ...partial };
}

describe('normalizeTitle', () => {
  it('strips diacritics so regional spellings match', () => {
    expect(normalizeTitle('Amélie')).toBe(normalizeTitle('Amelie'));
  });

  it('normalises ampersands and punctuation', () => {
    expect(normalizeTitle('Fire & Ice!')).toBe('fire and ice');
  });

  it('leaves non-Latin scripts intact', () => {
    expect(normalizeTitle('पुष्पा')).toBe('पुष्पा');
  });
});

describe('scoreMatch', () => {
  it('scores an exact title highly', () => {
    expect(scoreMatch({ title: 'Inception' }, title({ title: 'Inception' }))).toBeGreaterThan(0.9);
  });

  it('tolerates leftover padding from cleaning', () => {
    // Cleaning deliberately keeps weak words rather than risk deleting real
    // ones, so the matcher has to absorb them.
    const score = scoreMatch({ title: 'Inception Full Movie' }, title({ title: 'Inception' }));
    expect(score).toBeGreaterThan(0.75);
  });

  it('rewards a matching year', () => {
    // An exact title already scores at the ceiling, so the year bonus is only
    // observable on an inexact one.
    const withYear = scoreMatch(
      { title: 'The Batman Returns Again', year: 2022 },
      title({ title: 'The Batman', year: 2022 }),
    );
    const wrongYear = scoreMatch(
      { title: 'The Batman Returns Again', year: 2022 },
      title({ title: 'The Batman', year: 1992 }),
    );
    expect(withYear).toBeGreaterThan(wrongYear);
  });

  it('penalises a remake by a wide year gap', () => {
    const original = scoreMatch(
      { title: 'Dune', year: 2021 },
      title({ title: 'Dune', year: 1984 }),
    );
    const remake = scoreMatch({ title: 'Dune', year: 2021 }, title({ title: 'Dune', year: 2021 }));
    expect(remake).toBeGreaterThan(original);
  });

  it('matches against the original title when the page served a localised one', () => {
    const score = scoreMatch(
      { title: 'Sen to Chihiro no Kamikakushi' },
      title({ title: 'Spirited Away', originalTitle: 'Sen to Chihiro no Kamikakushi' }),
    );
    expect(score).toBeGreaterThan(0.9);
  });

  it('uses runtime to separate otherwise equal candidates', () => {
    const close = scoreMatch(
      { title: 'Solaris', runtimeMinutes: 167 },
      title({ title: 'Solaris', runtime: 167 }),
    );
    const far = scoreMatch(
      { title: 'Solaris', runtimeMinutes: 167 },
      title({ title: 'Solaris', runtime: 99 }),
    );
    expect(close).toBeGreaterThan(far);
  });
});

describe('isDecisive', () => {
  it('accepts a clear winner', () => {
    const ranked = rankMatches({ title: 'Interstellar', year: 2014 }, [
      title({ tmdbId: 157336, title: 'Interstellar', year: 2014 }),
      title({ tmdbId: 2, title: 'Interstellar Wars', year: 2016 }),
    ]);
    expect(isDecisive(ranked)).toBe(true);
    expect(ranked[0].candidate.tmdbId).toBe(157336);
  });

  it('refuses to choose between two near-identical candidates', () => {
    // Two releases of the same title a year apart: exactly the case where
    // guessing silently puts the wrong entry in someone's diary.
    const ranked = rankMatches({ title: 'The Guest' }, [
      title({ tmdbId: 1, title: 'The Guest', year: 2014 }),
      title({ tmdbId: 2, title: 'The Guest', year: 2015 }),
    ]);
    expect(isDecisive(ranked)).toBe(false);
  });

  it('does not let a shorter title win outright over the fuller one', () => {
    // The risk the subset bonus introduces: "Alien" is contained in the query,
    // so it scores well. It must not beat "Alien: Covenant" decisively.
    const ranked = rankMatches({ title: 'Alien Covenant Full Movie' }, [
      title({ tmdbId: 1, title: 'Alien' }),
      title({ tmdbId: 2, title: 'Alien: Covenant' }),
    ]);
    expect(ranked[0].candidate.tmdbId).toBe(2);
    expect(isDecisive(ranked)).toBe(false);
  });

  it('rejects an empty result set', () => {
    expect(isDecisive([])).toBe(false);
  });

  it('rejects a weak top match', () => {
    const ranked = rankMatches({ title: 'Some Unknown Thing' }, [
      title({ title: 'Completely Different' }),
    ]);
    expect(isDecisive(ranked)).toBe(false);
  });
});
