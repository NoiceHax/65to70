import { db } from '../db';
import type { Movie, Session } from '../types';

/**
 * Letterboxd diary export.
 *
 * Letterboxd has no public write API - it's invite-gated - so this is a file
 * the user uploads themselves. That makes it the one sync target that can never
 * be automatic, which is worth stating plainly in the UI rather than letting
 * people discover it.
 *
 * Column set verified against the ecosystem's import tooling:
 *   Title, imdbID, tmdbID, Rating, WatchedDate
 * Rating is 0.5-5.0 in half steps; WatchedDate is YYYY-MM-DD. Providing an
 * imdbID or tmdbID makes the import an exact match rather than a title guess,
 * which is the difference between a clean import and a pile of near-misses.
 *
 * Note on likes: Letterboxd's importer has no column for them. A liked film
 * exports like any other and the heart has to be re-applied by hand - there is
 * no way around that from this side.
 */

export interface DiaryRow {
  Title: string;
  Year: string;
  imdbID: string;
  tmdbID: string;
  Rating: string;
  WatchedDate: string;
  Rewatch: string;
}

const COLUMNS: (keyof DiaryRow)[] = [
  'Title',
  'Year',
  'imdbID',
  'tmdbID',
  'Rating',
  'WatchedDate',
  'Rewatch',
];

/**
 * RFC 4180 quoting.
 *
 * Film titles routinely contain commas ("Paris, Texas") and quotation marks,
 * and a mis-quoted row doesn't fail loudly - it silently shifts every later
 * column, which is how an import ends up with the year in the rating field.
 */
export function escapeCsv(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Letterboxd accepts half stars; anything finer has to be rounded. */
function formatRating(rating: number | null): string {
  if (rating === null) return '';
  return (Math.round(rating * 2) / 2).toFixed(1);
}

/**
 * One row per completed session, not per film.
 *
 * A diary is a log of viewings, so a film watched twice belongs in it twice,
 * with the dates it was actually seen. Collapsing to one row per film would
 * throw away exactly the history the diary exists to hold.
 */
export function buildDiaryRows(movie: Movie, sessions: Session[]): DiaryRow[] {
  const complete = sessions
    .filter((session) => session.complete === 1)
    .sort((a, b) => a.startedAt - b.startedAt);

  // Confirmed as watched but with no surviving session rows - still worth one
  // entry, dated when it was confirmed.
  if (complete.length === 0) {
    if (movie.watched !== 1) return [];
    return [
      {
        Title: movie.title,
        Year: movie.year?.toString() ?? '',
        imdbID: movie.imdbId ?? '',
        tmdbID: movie.tmdbId.toString(),
        Rating: formatRating(movie.rating),
        WatchedDate: isoDate(movie.lastConfirmed ?? Date.now()),
        Rewatch: 'false',
      },
    ];
  }

  return complete.map((session, index) => ({
    Title: movie.title,
    Year: movie.year?.toString() ?? '',
    imdbID: movie.imdbId ?? '',
    tmdbID: movie.tmdbId.toString(),
    // The rating is a property of the film, so it rides on every viewing.
    Rating: formatRating(movie.rating),
    WatchedDate: isoDate(session.stoppedAt ?? session.lastSeenAt ?? session.startedAt),
    Rewatch: index > 0 ? 'true' : 'false',
  }));
}

export function toCsv(rows: DiaryRow[]): string {
  const header = COLUMNS.join(',');
  const body = rows.map((row) => COLUMNS.map((c) => escapeCsv(row[c])).join(','));
  return [header, ...body].join('\n');
}

/**
 * Build the diary for every watched film.
 *
 * Films only - Letterboxd does not track television, so exporting episodes
 * would produce entries it can't match.
 */
export async function buildDiaryCsv(): Promise<{ csv: string; rows: number }> {
  const movies = await db.movies.where('watched').equals(1).toArray();

  const rows: DiaryRow[] = [];
  for (const movie of movies) {
    if (movie.mediaType !== 'movie') continue;
    const sessions = await db.sessions.where('titleKey').equals(movie.key).toArray();
    rows.push(...buildDiaryRows(movie, sessions));
  }

  rows.sort((a, b) => a.WatchedDate.localeCompare(b.WatchedDate));
  return { csv: toCsv(rows), rows: rows.length };
}
