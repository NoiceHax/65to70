/**
 * Build the offline title index.
 *
 *   TMDB_API_KEY=xxx npx vite-node pipeline/buildTitleIndex.ts -- 40000
 *
 * Resolving a title normally means asking TMDB, which reveals the title to
 * them. This index exists so the common case never leaves the machine: the
 * most popular titles are matched entirely locally, and the network is only
 * touched for the long tail — and only if the user opted in.
 *
 * Two things learned while testing that shape the build:
 *
 *  - Sites serve titles in the viewer's language. A probe of a TMDB page from
 *    India came back in Hindi. So the index has to carry alternative and
 *    localised titles, not just `original_title`, or regional viewing resolves
 *    to nothing.
 *  - The daily id export carries no year, and year is what separates a remake
 *    from its original. So popularity comes from the export, but the details
 *    have to be fetched per title.
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
const limit = Number(process.argv[2] ?? 40000);

if (!apiKey) {
  console.error('No TMDB key. Put TMDB_API_KEY in .env, or set it in the environment.');
  process.exit(1);
}

interface ExportRow {
  id: number;
  original_title: string;
  popularity: number;
  adult: boolean;
  video: boolean;
}

/** Yesterday's export, since today's may not have been published yet. */
function exportUrl(): string {
  const date = new Date(Date.now() - 36 * 60 * 60 * 1000);
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `https://files.tmdb.org/p/exports/movie_ids_${mm}_${dd}_${date.getUTCFullYear()}.json.gz`;
}

async function topByPopularity(count: number): Promise<ExportRow[]> {
  const url = exportUrl();
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

  console.log(`  ${rows.length} titles in export`);
  rows.sort((a, b) => b.popularity - a.popularity);
  return rows.slice(0, count);
}

interface IndexEntry {
  i: number; // tmdb id
  t: string; // primary title
  y?: number; // year
  r?: number; // runtime, minutes
  a?: string[]; // alternative and localised titles
}

async function detailsFor(id: number): Promise<IndexEntry | null> {
  const url = new URL(`${API}/movie/${id}`);
  url.searchParams.set('api_key', apiKey!);
  url.searchParams.set('append_to_response', 'alternative_titles');

  const detail = await getJson<{
    id: number;
    title: string;
    original_title?: string;
    release_date?: string;
    runtime?: number;
    alternative_titles?: { titles?: { title: string; iso_3166_1: string }[] };
  }>(url, { retries: 4 });

  if (!detail) {
    dropped++;
    return null;
  }

  const aliases = new Set<string>();
  if (detail.original_title && detail.original_title !== detail.title) {
    aliases.add(detail.original_title);
  }
  for (const alt of detail.alternative_titles?.titles ?? []) {
    if (alt.title && alt.title !== detail.title) aliases.add(alt.title);
  }

  const year = detail.release_date ? Number(detail.release_date.slice(0, 4)) : undefined;

  return {
    i: detail.id,
    t: detail.title,
    y: Number.isFinite(year) ? year : undefined,
    r: detail.runtime || undefined,
    a: aliases.size > 0 ? [...aliases].slice(0, 12) : undefined,
  };
}

const OUT_PATH = resolve(process.cwd(), 'public/data/titles.json');

function save(entries: IndexEntry[]): void {
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), entries }));
}

/**
 * Anything already fetched on a previous run.
 *
 * Forty thousand requests take a while, and losing all of them to one dropped
 * connection near the end is intolerable. Re-running now picks up where the
 * last attempt stopped rather than starting again.
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

async function main(): Promise<void> {
  const top = await topByPopularity(limit);

  const entries = existingEntries();
  const have = new Set(entries.map((entry) => entry.i));
  const todo = top.filter((row) => !have.has(row.id));

  if (entries.length > 0) {
    console.log(`  ${entries.length} already fetched — resuming`);
  }
  console.log(`Fetching details for ${todo.length} titles…`);

  let done = 0;

  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((row) => detailsFor(row.id)));

    for (const entry of results) if (entry) entries.push(entry);

    done += batch.length;
    if (done % 1000 < CONCURRENCY) {
      process.stdout.write(`\r  ${done}/${todo.length}`);
      // Checkpoint, so an interruption costs minutes rather than everything.
      save(entries);
    }
  }

  save(entries);

  console.log(`\nWrote ${entries.length} titles to ${OUT_PATH}`);
  if (dropped > 0) {
    console.warn(`${dropped} request(s) failed after retries — re-run to fill the gaps.`);
  }
  console.log('Rebuild the extension (npm run build) — it loads this itself.');
}

await main();
