# 65to70

[![CI](https://github.com/NoiceHax/65to70/actions/workflows/ci.yml/badge.svg)](https://github.com/NoiceHax/65to70/actions/workflows/ci.yml)

A local-first watch tracker and universal watchlist for the browser.

It notices what you actually finish across every site you use, merges your
scattered watchlists into one, and pushes your history out to Simkl, Trakt or
Letterboxd - without your viewing history ever leaving your machine.

> Named for the gauges: the negative is 65mm, the release print is 70mm, and
> the 5mm of difference is the magnetic sound stripes. Which is the shape of
> this thing too. Your library is the negative and never leaves the building; a
> sync target gets a print, struck on request.
>
> Two strings deliberately still say `keeper`, the name this was built under.
> The Dexie database in `lib/db.ts` cannot be renamed without orphaning every
> library already on disk, since IndexedDB keys on the name. The other is a
> comment in `lib/permissions.ts` explaining the registration sweep that the
> rename made necessary.

## The constraint

Watch history, watchlists and ratings live in IndexedDB on your machine.
65to70 uploads nothing except to sync targets you explicitly connect. Data
flows *down*, never up.

Two consequences worth knowing before you use it:

- **No host permissions at install.** The built manifest has empty
  `host_permissions` and empty `content_scripts`. 65to70 is inert until you
  turn on a site in the popup, at which point it registers a content script for
  that origin only.
- **Identifying a title asks TMDB.** This is the one seam in the promise, and
  it is on by default. A lookup tells TMDB that someone searched a title - not
  who, and not that it was watched. It can be turned off in options, which
  falls back to a prepared index.

That default used to be the other way round, and it was wrong. An index that
fits in a build holds the popular tens of thousands; everything else - new
releases, regional cinema, most series - came back as "not in the catalogue",
which is indistinguishable from a broken extension. Shipping a bigger index
only moves the line. TMDB's whole catalogue is the only thing that covers what
people actually watch, so that is what 65to70 asks, and the index is now a
cache in front of it rather than the catalogue itself.

## Running it

```bash
npm install
npm run dev      # launches Chrome with the extension loaded
npm run build    # production build in .output/chrome-mv3
npm test         # 244 tests
```

To load a production build manually: `chrome://extensions` → Developer mode →
Load unpacked → `.output/chrome-mv3`.

## Setting it up

1. Open the popup and turn on the sites you watch things on. Nothing happens
   until you do.
2. Play something. 65to70 names what it thinks is playing, in the page. Say
   yes, correct it, or ignore it - nothing is recorded either way until you
   confirm, and coverage decides whether it counts as *watched*.

Identification needs a TMDB key. Builds carry one, taken from
`WXT_TMDB_API_KEY` at build time, so a fresh install works without setup:

```bash
echo 'WXT_TMDB_API_KEY=your-v3-key' >> .env
```

It is a read-only v3 key and anyone who unpacks the build can read it, which is
the accepted trade for an extension that works when installed. A published
build should point at a proxy instead, or ship without one and let each user
paste their own in options.

## Offline indexes

Optional. Built on your machine, they contain no personal data and are
identical for everyone in a region.

```bash
TMDB_API_KEY=xxx npx vite-node pipeline/buildTitleIndex.ts -- 40000
TMDB_API_KEY=xxx npx vite-node pipeline/buildAvailability.ts -- IN
```

The title index is a cache: a hit answers without a request, a miss means
nothing and the lookup goes to TMDB as usual. Skip building it and everything
still works, one request at a time. The availability index maps titles to the
services carrying them in one region - TMDB publishes no bulk export for this,
so the script pages `/discover` per provider and shards by release year to stay
under the 500-page cap. Any shard that still hits the cap is reported rather
than passed off as complete.

## The popup

Five screens, each answering one question, and a gear for the settings worth
changing between one evening and the next.

| Screen | Answers |
|---|---|
| **Now** | Is what I watched recorded? Live status, anything awaiting confirmation, and a search box for recording what 65to70 could not see - a cinema, a television, someone else's account |
| **For you** | What should I watch? A deck of suggestions, one card at a time, each stating its reasoning and what it is about. Drag it aside or answer it: not this, save it, or seen it already. Six alternatives underneath, and the discarded pile at the bottom |
| **List** | What did I save? Ordered by what fits the time you have, and closable - "I've seen it" is one click |
| **Watched** | What was I in the middle of, and what did I just finish? One to resume, three recent, the rest behind a click. Series carry a season and an episode, both correctable, and anything can be removed |
| **Sites** | Where may 65to70 run? Per-site grants, an all-sites option, never-track origins, and reporting a site that does not work |
| **⚙** | Pause tracking, whether to be asked about every site, whether titles may be looked up, region, sync status and the exports |

Nothing on any screen records a watch on its own. That still takes a
confirmation, which is the one rule the whole thing is built around - the deck's
"seen it" included, which is a confirmation in the same sense that typing a
title in by hand is one.

The gear and the options page are the same screen, not two of them - both
render `components/SettingsPanel`, and the popup holds what you *do* while the
page holds what you *set up once*. So the popup leaves out the offline index
loaders, whose every route out is an npm script; the tracker client
credentials, which are a one-time registration of your own OAuth app; and the
TMDB key field on builds that ship a key, where its only message would be that
there is nothing to do in it.

The page still exists for the rest, because a browser's own "Extension options"
item has to lead somewhere, and because two controls cannot finish inside a
popup at all: approving a tracker's device code means leaving the window, and a
file chooser closes it outright. Both say so and hand off rather than opening a
tab unannounced.

Turning a suggestion down is permanent, and everything discarded is listed at
the bottom of the screen with a button to put it back. Those two go together:
this was session-only for a while, which meant the title someone had just said
no to led the deck again the next time the popup opened - an answer that looks
like it worked and did not. Permanence is only frightening when it is also
irreversible, so the pile is on the same screen rather than behind a setting.
Each card says what it is about as well as why it was picked. That costs a TMDB
request, so it is fetched two cards ahead rather than for the whole deck, and
cached afterwards.

## Reporting a broken site

The popup can assemble a report about the page you are on: its address, what
65to70 made of it, and the page's structure with the text stripped out - tags,
ids and classes, which is what a selector is written against. No cookies, no
storage, no form values, nothing from your library.

It is shown in full before anything happens and sent only by a click that does
nothing else. Builds set the destination with `WXT_DIAGNOSTICS_URL`; without
one, a report can still be assembled and copied by hand.

## How detection works

Four tiers, in order of preference:

| Tier | Source | Where it wins |
|---|---|---|
| URL ids | TMDB/IMDb ids in the page URL | Client-rendered sites with no readable title |
| Adapters | Player chrome on Netflix, Prime, JioHotstar | Services whose page titles say nothing |
| Page metadata | JSON-LD → og:title → h1 → document.title → slug | The long tail, which is SEO-driven and title-rich |
| Ask | The viewer names it in the prompt, or in the queue | Everything else |

Pages lie, and mostly by accident: a page is a dozen frames and all but one are
advertising or analytics, each with a title of its own. `Document` is what an
HTML file that never set a title is called, so it arrives constantly and names
a film that does not exist. Three things stop that - a frame's word is ranked
below the page's, placeholder strings are rejected outright, and a title TMDB
has never heard of is dropped rather than queued for someone to sort out.

Completion is measured against a 100-bucket coverage bitmap, not playback
position - skipping to the credits leaves coverage at ~5%, and coverage unions
across sessions so a film watched over two nights still counts.

## Diagnosing a site

```bash
npm run probe -- https://example.com/watch/12345
```

Runs the real detection pipeline against a live page and prints every
candidate with the strategy that produced it. Fetches server-rendered HTML
only, so client-rendered sites look emptier here than in a real browser - a
poor result is a reason to check in the extension, not a verdict.

## Not implemented

- **Reading watchlists out of Netflix / Prime / JioHotstar.** The merge,
  provenance and dedupe machinery is done and tested; the per-platform
  scrapers are not. Watchlist entries currently arrive from confirmations and
  imports.
- **A hosted index.** The pipeline emits files that ship in the build. There is
  no CDN to fetch them from - and now less reason to want one, since the
  catalogue itself is what gets asked.

## Layout

```
entrypoints/
  background.ts          resolver, sessions, sync orchestration
  generic.content.ts     tiers 1-3, registered at runtime only
  overlay.content.ts     search result annotation
  popup/  options/       React
components/
  SettingsPanel.tsx      every setting, rendered by both surfaces
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
