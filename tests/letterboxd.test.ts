import { describe, expect, it } from 'vitest';
import { buildDiaryRows, escapeCsv, toCsv } from '@/lib/sync/letterboxd';
import { emptyCoverage } from '@/lib/db';
import { titleKey, type Movie, type Session } from '@/lib/types';

function movie(partial: Partial<Movie> = {}): Movie {
  return {
    key: titleKey('movie', 27205),
    tmdbId: 27205,
    imdbId: 'tt1375666',
    mediaType: 'movie',
    title: 'Inception',
    year: 2010,
    watched: 1,
    liked: 0,
    rating: null,
    rewatch: 0,
    sources: [],
    tags: [],
    ...partial,
  };
}

function session(startedAt: number, complete = 1): Session {
  return {
    titleKey: titleKey('movie', 27205),
    mediaType: 'movie',
    startedAt,
    lastSeenAt: startedAt,
    stoppedAt: startedAt,
    coverage: emptyCoverage(),
    site: 'example.com',
    complete: complete as 0 | 1,
  };
}

const JAN_2 = Date.UTC(2025, 0, 2, 12);
const JUN_9 = Date.UTC(2025, 5, 9, 12);

describe('escapeCsv', () => {
  it('leaves ordinary values alone', () => {
    expect(escapeCsv('Inception')).toBe('Inception');
  });

  it('quotes a title containing a comma', () => {
    // "Paris, Texas" unquoted would shift every later column silently.
    expect(escapeCsv('Paris, Texas')).toBe('"Paris, Texas"');
  });

  it('doubles internal quotation marks', () => {
    expect(escapeCsv('The "Burbs')).toBe('"The ""Burbs"');
  });

  it('quotes a value containing a newline', () => {
    expect(escapeCsv('a\nb')).toBe('"a\nb"');
  });
});

describe('buildDiaryRows', () => {
  it('writes one row per completed session, dated when it was seen', () => {
    // A diary logs viewings, so a film watched twice belongs in it twice.
    const rows = buildDiaryRows(movie(), [session(JAN_2), session(JUN_9)]);

    expect(rows).toHaveLength(2);
    expect(rows[0].WatchedDate).toBe('2025-01-02');
    expect(rows[1].WatchedDate).toBe('2025-06-09');
  });

  it('marks every session after the first as a rewatch', () => {
    const rows = buildDiaryRows(movie(), [session(JAN_2), session(JUN_9)]);
    expect(rows.map((r) => r.Rewatch)).toEqual(['false', 'true']);
  });

  it('ignores incomplete sessions', () => {
    const rows = buildDiaryRows(movie(), [session(JAN_2), session(JUN_9, 0)]);
    expect(rows).toHaveLength(1);
  });

  it('carries both ids so the import is an exact match', () => {
    const [row] = buildDiaryRows(movie(), [session(JAN_2)]);
    expect(row.imdbID).toBe('tt1375666');
    expect(row.tmdbID).toBe('27205');
  });

  it('leaves the rating blank when unrated', () => {
    // Most people never rate anything; an empty column is the correct output.
    const [row] = buildDiaryRows(movie({ rating: null }), [session(JAN_2)]);
    expect(row.Rating).toBe('');
  });

  it('formats ratings to half stars', () => {
    expect(buildDiaryRows(movie({ rating: 4 }), [session(JAN_2)])[0].Rating).toBe('4.0');
    expect(buildDiaryRows(movie({ rating: 3.5 }), [session(JAN_2)])[0].Rating).toBe('3.5');
  });

  it('still exports a watched film whose sessions were pruned', () => {
    const rows = buildDiaryRows(movie({ lastConfirmed: JAN_2 }), []);
    expect(rows).toHaveLength(1);
    expect(rows[0].WatchedDate).toBe('2025-01-02');
  });

  it('exports nothing for a film that was never watched', () => {
    expect(buildDiaryRows(movie({ watched: 0 }), [])).toHaveLength(0);
  });
});

describe('toCsv', () => {
  it('emits the header Letterboxd expects', () => {
    const csv = toCsv(buildDiaryRows(movie(), [session(JAN_2)]));
    expect(csv.split('\n')[0]).toBe('Title,Year,imdbID,tmdbID,Rating,WatchedDate,Rewatch');
  });

  it('keeps columns aligned when a title contains a comma', () => {
    const csv = toCsv(buildDiaryRows(movie({ title: 'Paris, Texas' }), [session(JAN_2)]));
    const row = csv.split('\n')[1];
    expect(row.startsWith('"Paris, Texas",2010,')).toBe(true);
  });
});
