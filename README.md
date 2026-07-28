# Keeper

A local-first watch tracker and universal watchlist for the browser.

It notices what you actually finish across every site you use, merges your
scattered watchlists into one, and pushes your history out to Simkl, Trakt or
Letterboxd — without your viewing history ever leaving your machine.

> Working name. Renaming is a find-and-replace plus one manifest field.

## The constraint

Watch history, watchlists and ratings live in IndexedDB on your machine.
Keeper downloads prepared data and uploads nothing except to sync targets you
explicitly connect. Data flows *down*, never up.

Two consequences worth knowing before you use it:

- **No host permissions at install.** The built manifest has empty
  `host_permissions` and empty `content_scripts`. Keeper is inert until you
  turn on a site in the popup, at which point it registers a content script for
  that origin only.
- **Title lookup is opt-in.** Ids found in a page's URL are resolved
  automatically, since that reveals nothing. Searching TMDB *by title* is off
  by default, because it tells TMDB someone searched that title.

## Running it

```bash
npm install
npm run dev      # launches Chrome with the extension loaded
npm run build    # production build in .output/chrome-mv3
npm test         # 127 tests
```

To load a production build manually: `chrome://extensions` → Developer mode →
Load unpacked → `.output/chrome-mv3`.

## Setting it up

1. Open the popup and turn on the sites you watch things on. Nothing happens
   until you do.
2. Play something. Keeper tracks coverage and, at ~80% watched, queues it for
   confirmation. Nothing is recorded until you confirm it.
3. For it to identify *what* you watched, give it one of:
   - a **TMDB API key** (free, from themoviedb.org → Settings → API), or
   - a **title index** built offline (below), which needs no key at runtime.

## Offline indexes

Both are built on your machine and loaded through the options page. They
contain no personal data and are identical for everyone in a region.

```bash
TMDB_API_KEY=xxx npx vite-node pipeline/buildTitleIndex.ts -- 40000
TMDB_API_KEY=xxx npx vite-node pipeline/buildAvailability.ts -- IN
```

The title index lets popular titles resolve with no network call at all. The
availability index maps titles to the services carrying them in one region —
TMDB publishes no bulk export for this, so the script pages `/discover` per
provider and shards by release year to stay under the 500-page cap. Any shard
that still hits the cap is reported rather than passed off as complete.

## How detection works

Four tiers, in order of preference:

| Tier | Source | Where it wins |
|---|---|---|
| URL ids | TMDB/IMDb ids in the page URL | Client-rendered sites with no readable title |
| Adapters | Player chrome on Netflix, Prime, JioHotstar | Services whose page titles say nothing |
| Page metadata | JSON-LD → og:title → h1 → document.title → slug | The long tail, which is SEO-driven and title-rich |
| Ask once | The user names it, the selector is remembered | Everything else |

Completion is measured against a 100-bucket coverage bitmap, not playback
position — skipping to the credits leaves coverage at ~5%, and coverage unions
across sessions so a film watched over two nights still counts.

## Diagnosing a site

```bash
npm run probe -- https://example.com/watch/12345
```

Runs the real detection pipeline against a live page and prints every
candidate with the strategy that produced it. Fetches server-rendered HTML
only, so client-rendered sites look emptier here than in a real browser — a
poor result is a reason to check in the extension, not a verdict.

## Not implemented

- **Reading watchlists out of Netflix / Prime / JioHotstar.** The merge,
  provenance and dedupe machinery is done and tested; the per-platform
  scrapers are not. Watchlist entries currently arrive from confirmations and
  imports.
- **A hosted index.** The pipeline emits files you load yourself. There is no
  CDN to fetch them from.

## Layout

```
entrypoints/
  background.ts          resolver, sessions, sync orchestration
  generic.content.ts     tiers 1–3, registered at runtime only
  overlay.content.ts     search result annotation
  popup/  options/       React
lib/
  db.ts                  Dexie schema, coverage helpers
  progress.ts            coverage bitmap, 80% rule
  titleClean.ts          page title → matchable title
  pageMeta.ts            metadata cascade and ranking
  urlIds.ts              catalogue ids from URLs
  adapters.ts            per-platform readers
  resolver.ts            detection → canonical title
  match.ts               token-set scoring
  sync/                  simkl, trakt, letterboxd
pipeline/                offline index builders (never bundled)
```
