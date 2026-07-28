/**
 * Build the offline title index.
 *
 *   npx vite-node pipeline/buildTitleIndex.ts -- 40000
 *
 * Resolving a title normally means asking TMDB, which reveals the title to
 * them. This index exists so the common case never leaves the machine: the
 * most popular titles are matched entirely locally, and the network is only
 * touched for the long tail, and only if the user opted in.
 *
 * Three things learned while testing that shape the build:
 *
 *  - Sites serve titles in the viewer's language. A probe of a TMDB page from
 *    India came back in Hindi. So the index has to carry alternative and
 *    localised titles, not just the original, or regional viewing resolves to
 *    nothing.
 *  - The daily id export carries no year, and year is what separates a remake
 *    from its original. So popularity comes from the export, but the details
 *    have to be fetched per title.
 *  - Series need to be in here too. An index of films alone cannot match a
 *    show, and worse, its silence looked like a verdict: a correctly-read
 *    series was discarded as "not a real title" without a word.
 *
 * Runs on your machine, never in the extension.
 */
import { createGunzip } from 'node:zlib';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { tmdbApiKey } from '../scripts/env';
import { getJson } from '../scripts/http';

const API = 'https://api.themoviedb.org/3';
const CONCURRENCY = 20;

/** Requests lost after their retries were spent. Reported, never hidden. */
let dropped = 0;

const apiKey = tmdbApiKey();
const movieLimit = Number(process.argv[2] ?? 40000);
/** Fewer shows exist than films, and the tail is watched far less. */
const tvLimit = Math.round(movieLimit * 0.4);

if (!apiKey) {
  console.error('No TMDB key. Put TMDB_API_KEY in .env, or set it in the environment.');
  process.exit(1);
}

type Kind = 'movie' | 'tv';

interface ExportRow {
  id: number;
  popularity: number;
  adult?: boolean;
  video?: boolean;
}

/** Yesterday's export, since today's may not have been published yet. */
function exportUrl(kind: Kind): string {
  const date = new Date(Date.now() - 36 * 60 * 60 * 1000);
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const name = kind === 'movie' ? 'movie_ids' : 'tv_series_ids';
  return `https://files.tmdb.org/p/exports/${name}_${mm}_${dd}_${date.getUTCFullYear()}.json.gz`;
}

async function topByPopularity(kind: Kind, count: number): Promise<ExportRow[]> {
  const url = exportUrl(kind);
  console.log(`Fetching ${url}`);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Export download failed: HTTP ${response.status}`);

  const stream = Readable.fromWeb(response.body as never).pipe(createGunzip());
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  const rows: ExportRow[] = [];
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as ExportRow;
      if (row.adult || row.video) continue;
      rows.push(row);
    } catch {
      // The export occasionally carries a malformed line; skipping it is
      // cheaper than aborting a million-row download.
    }
  }

  console.log(`  ${rows.length} ${kind} entries in export`);
  rows.sort((a, b) => b.popularity - a.popularity);
  return rows.slice(0, count);
}

interface IndexEntry {
  i: number; // tmdb id
  t: string; // primary title
  y?: number; // year
  r?: number; // runtime, minutes
  a?: string[]; // alternative and localised titles
  m?: 'tv'; // absent means a film
}

interface Detail {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  runtime?: number;
  episode_run_time?: number[];
  alternative_titles?: {
    titles?: { title: string }[];
    results?: { title: string }[];
  };
}

async function detailsFor(id: number, kind: Kind): Promise<IndexEntry | null> {
  const url = new URL(`${API}/${kind}/${id}`);
  url.searchParams.set('api_key', apiKey!);
  url.searchParams.set('append_to_response', 'alternative_titles');

  const detail = await getJson<Detail>(url, { retries: 4 });
  if (!detail) {
    dropped++;
    return null;
  }

  // Films and series name the same fields differently.
  const title = detail.title ?? detail.name;
  const original = detail.original_title ?? detail.original_name;
  const released = detail.release_date ?? detail.first_air_date;
  const runtime = detail.runtime ?? detail.episode_run_time?.[0];

  if (!title) return null;

  const aliases = new Set<string>();
  if (original && original !== title) aliases.add(original);

  // Films return `titles`, series return `results`. Same data, different key.
  const alternatives = detail.alternative_titles?.titles ?? detail.alternative_titles?.results ?? [];
  for (const alt of alternatives) {
    if (alt.title && alt.title !== title) aliases.add(alt.title);
  }

  const year = released ? Number(released.slice(0, 4)) : undefined;

  return {
    i: detail.id,
    t: title,
    y: Number.isFinite(year) ? year : undefined,
    r: runtime || undefined,
    a: aliases.size > 0 ? [...aliases].slice(0, 12) : undefined,
    m: kind === 'tv' ? 'tv' : undefined,
  };
}

const OUT_PATH = resolve(process.cwd(), 'public/data/titles.json');

function save(entries: IndexEntry[]): void {
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(
    OUT_PATH,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      mediaTypes: ['movie', 'tv'],
      entries,
    }),
  );
}

/**
 * Anything already fetched on a previous run.
 *
 * Tens of thousands of requests take a while, and losing all of them to one
 * dropped connection near the end is intolerable. Re-running picks up where
 * the last attempt stopped rather than starting again.
 */
function existingEntries(): IndexEntry[] {
  if (!existsSync(OUT_PATH)) return [];
  try {
    const stored = JSON.parse(readFileSync(OUT_PATH, 'utf8')) as { entries?: IndexEntry[] };
    return stored.entries ?? [];
  } catch {
    return [];
  }
}

/** Films and series share an id space, so the kind is part of the key. */
const entryKey = (id: number, kind: Kind): string => `${kind}:${id}`;

async function fetchAll(
  rows: ExportRow[],
  kind: Kind,
  entries: IndexEntry[],
  have: Set<string>,
): Promise<void> {
  const todo = rows.filter((row) => !have.has(entryKey(row.id, kind)));
  console.log(`Fetching details for ${todo.length} ${kind} titles...`);

  let done = 0;

  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((row) => detailsFor(row.id, kind)));

    for (const entry of results) if (entry) entries.push(entry);

    done += batch.length;
    if (done % 1000 < CONCURRENCY) {
      process.stdout.write(`\r  ${done}/${todo.length}`);
      // Checkpoint, so an interruption costs minutes rather than everything.
      save(entries);
    }
  }

  process.stdout.write('\n');
}

async function main(): Promise<void> {
  const entries = existingEntries();
  const have = new Set(entries.map((entry) => entryKey(entry.i, entry.m === 'tv' ? 'tv' : 'movie')));

  if (entries.length > 0) console.log(`${entries.length} already fetched, resuming`);

  await fetchAll(await topByPopularity('movie', movieLimit), 'movie', entries, have);
  await fetchAll(await topByPopularity('tv', tvLimit), 'tv', entries, have);

  save(entries);

  const films = entries.filter((entry) => entry.m !== 'tv').length;
  console.log(`\nWrote ${films} films and ${entries.length - films} series to ${OUT_PATH}`);
  if (dropped > 0) {
    console.warn(`${dropped} request(s) failed after retries, re-run to fill the gaps.`);
  }
  console.log('Rebuild the extension (npm run build) - it loads this itself.');
}

await main();
