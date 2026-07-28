// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { adapterFor, parseJwSecondary, readAdapterMeta } from '@/lib/adapters';
import { cleanTitle } from '@/lib/titleClean';

function docFrom(html: string): Document {
  const doc = document.implementation.createHTMLDocument('');
  doc.documentElement.innerHTML = html;
  return doc;
}

describe('adapterFor', () => {
  it('matches the premium hosts', () => {
    expect(adapterFor('www.netflix.com')?.id).toBe('netflix');
    expect(adapterFor('www.primevideo.com')?.id).toBe('prime');
    expect(adapterFor('www.hotstar.com')?.id).toBe('hotstar');
  });

  it('does not match a lookalike domain', () => {
    expect(adapterFor('netflix.com.evil.example')).toBeNull();
    expect(adapterFor('cineby.cc')).toBeNull();
  });
});

describe('Netflix', () => {
  const url = 'https://www.netflix.com/watch/81234567';

  it('reads a film title from the player chrome', () => {
    const doc = docFrom('<body><div data-uia="video-title">Inception</div></body>');
    const meta = readAdapterMeta(doc, url, 'www.netflix.com');
    expect(meta).toMatchObject({ rawTitle: 'Inception', strategy: 'manual' });
  });

  it('folds season and episode into a form the cleaner understands', () => {
    const doc = docFrom(`
      <body><div data-uia="video-title">
        <h4>Breaking Bad</h4><span>S1:E2</span><span>Cat's in the Bag...</span>
      </div></body>`);

    const meta = readAdapterMeta(doc, url, 'www.netflix.com');
    expect(meta?.rawTitle).toBe('Breaking Bad S1E2');

    // The point of emitting a string rather than a bespoke structure: all the
    // existing parsing carries over unchanged.
    expect(cleanTitle(meta!.rawTitle)).toMatchObject({
      title: 'Breaking Bad',
      season: 1,
      episode: 2,
      mediaType: 'tv',
    });
  });

  it('stays out of the way on browse pages', () => {
    const doc = docFrom('<body><div data-uia="video-title">Inception</div></body>');
    expect(readAdapterMeta(doc, 'https://www.netflix.com/browse', 'www.netflix.com')).toBeNull();
  });

  it('returns null when the player chrome is absent, so Tier 2 can run', () => {
    expect(readAdapterMeta(docFrom('<body></body>'), url, 'www.netflix.com')).toBeNull();
  });
});

describe('Prime Video', () => {
  it('reads title and episode from the player', () => {
    const doc = docFrom(`
      <body>
        <div class="atvwebplayersdk-title-text">The Boys</div>
        <div class="atvwebplayersdk-subtitle-text">S2 E3 - Over the Hill</div>
      </body>`);

    const meta = readAdapterMeta(doc, 'https://www.primevideo.com/detail/0XYZ', 'www.primevideo.com');
    expect(meta?.rawTitle).toBe('The Boys S2E3');
  });

  it('reads the title and episode from the page when the player classes are gone', () => {
    // Prime's player class names are hashed now and the ones this adapter used
    // to read no longer exist. The document title and episode heading do, and
    // both are load bearing for the page itself.
    const doc = docFrom(`
      <body>
        <h1>Adarsh Baal Vidyalaya</h1>
        <h2>Season 1, Ep. 1 Gawaar Goldy</h2>
      </body>`);
    doc.title = 'Prime Video: Adarsh Baal Vidyalaya - Season 1';

    const meta = readAdapterMeta(doc, 'https://www.primevideo.com/detail/0KJ', 'www.primevideo.com');
    expect(meta).toMatchObject({ season: 1, episode: 1 });
    expect(cleanTitle(meta!.rawTitle)).toMatchObject({
      title: 'Adarsh Baal Vidyalaya',
      season: 1,
      episode: 1,
      mediaType: 'tv',
    });
  });

  it('strips the service name and season suffix from the document title', () => {
    const doc = docFrom('<body></body>');
    doc.title = 'Prime Video: Fallout - Season 2';

    const meta = readAdapterMeta(doc, 'https://www.primevideo.com/detail/0KJ', 'www.primevideo.com');
    expect(meta?.rawTitle).toBe('Fallout');
  });

  it('handles a film with no subtitle', () => {
    const doc = docFrom('<body><div class="atvwebplayersdk-title-text">Arrival</div></body>');
    const meta = readAdapterMeta(doc, 'https://www.primevideo.com/detail/0XYZ', 'www.primevideo.com');
    expect(meta?.rawTitle).toBe('Arrival');
  });
});

describe('JW Player', () => {
  // Matched by its own DOM rather than by hostname, so one adapter covers every
  // site embedding it - including ones never looked at.
  const url = 'https://net52.cc/play.php?id=81446739';

  it('reads the title from the player, whatever the host', () => {
    const doc = docFrom(`
      <body><div id="jw" class="jwplayer">
        <div class="jw-title-primary jw-reset-text">Lift</div>
        <div class="jw-title-secondary jw-reset-text">2024 U/A 13+ 1h 46m</div>
      </div></body>`);

    const meta = readAdapterMeta(doc, url, 'net52.cc');
    expect(meta).toMatchObject({ rawTitle: 'Lift', strategy: 'manual', yearHint: 2024 });
  });

  it('folds an episode marker into the title', () => {
    const doc = docFrom(`
      <body>
        <div class="jw-title-primary">How I Met Your Mother</div>
        <div class="jw-title-secondary">2008 S3:E12 22m</div>
      </body>`);

    const meta = readAdapterMeta(doc, url, 'net52.cc');
    expect(cleanTitle(meta!.rawTitle)).toMatchObject({
      title: 'How I Met Your Mother',
      season: 3,
      episode: 12,
      mediaType: 'tv',
    });
  });

  it('reads the episode from a second secondary line', () => {
    // A real series page splits them: one line has the year and season count,
    // another the episode. Reading only the first recorded whole series as
    // films.
    const doc = docFrom(`
      <body>
        <div class="jw-title-primary">Lock Upp</div>
        <div class="jw-title-secondary jw-reset-text">2026 U/A 16+ 1 Seasons</div>
        <div class="jw-title-secondary player-ep-info">Ep. 9 - Greed v/s Need</div>
      </body>`);

    const meta = readAdapterMeta(doc, url, 'net52.cc');
    expect(meta).toMatchObject({ episode: 9, season: 1, yearHint: 2026 });
    expect(cleanTitle(meta!.rawTitle)).toMatchObject({ title: 'Lock Upp', mediaType: 'tv' });
  });

  it('reports a known episode even when the season is not stated', () => {
    // "3 Seasons" is a count, not a number - it does not say which one is
    // playing. Inventing a season would put wrong data in a diary.
    const doc = docFrom(`
      <body>
        <div class="jw-title-primary">Some Show</div>
        <div class="jw-title-secondary">2024 3 Seasons</div>
        <div class="jw-title-secondary player-ep-info">Ep. 4</div>
      </body>`);

    const meta = readAdapterMeta(doc, url, 'net52.cc');
    expect(meta?.episode).toBe(4);
    expect(meta?.season).toBeUndefined();
  });

  it('returns null when no JW Player is present', () => {
    expect(readAdapterMeta(docFrom('<body><h1>Home</h1></body>'), url, 'net52.cc')).toBeNull();
  });
});

describe('parseJwSecondary', () => {
  it('reads year and runtime', () => {
    expect(parseJwSecondary('2024 U/A 13+ 1h 46m')).toMatchObject({
      year: 2024,
      runtimeMinutes: 106,
    });
  });

  it('reads a runtime given only in minutes', () => {
    expect(parseJwSecondary('2008 22m')).toMatchObject({ runtimeMinutes: 22 });
  });

  it('reads a season and episode', () => {
    expect(parseJwSecondary('2008 S3:E12 22m')).toMatchObject({ season: 3, episode: 12 });
  });

  it('reads the spelled-out episode form', () => {
    expect(parseJwSecondary('Season 3: Episode 12')).toMatchObject({ season: 3, episode: 12 });
  });

  it('reads the 3x12 form', () => {
    expect(parseJwSecondary('2008 3x12 22m')).toMatchObject({ season: 3, episode: 12 });
  });

  it('does not read a runtime as an episode', () => {
    // "1h 46m" must not become season 1, episode 46.
    expect(parseJwSecondary('2024 U/A 13+ 1h 46m').season).toBeUndefined();
  });

  it('returns nothing useful for an empty line', () => {
    expect(parseJwSecondary('')).toEqual({});
  });
});

describe('JioHotstar', () => {
  it('falls back to the URL slug before the player renders', () => {
    const meta = readAdapterMeta(
      docFrom('<body></body>'),
      'https://www.hotstar.com/in/movies/inception/1260022016/watch',
      'www.hotstar.com',
    );
    expect(meta?.rawTitle).toBe('inception');
  });

  it('reads season and episode from the URL', () => {
    // This adapter emitted only the show name, so every episode resolved to
    // the same title and the episode count never moved off one.
    const meta = readAdapterMeta(
      docFrom('<body></body>'),
      'https://www.hotstar.com/in/shows/how-i-met-your-mother/123/season-2/episode-7/watch',
      'www.hotstar.com',
    );

    expect(cleanTitle(meta!.rawTitle)).toMatchObject({
      title: 'how i met your mother',
      season: 2,
      episode: 7,
      mediaType: 'tv',
    });
  });

  it('falls back to an episode marker in the page', () => {
    const meta = readAdapterMeta(
      docFrom('<body><div class="player-title">How I Met Your Mother</div><span>S3 E12</span></body>'),
      'https://www.hotstar.com/in/shows/himym/123/456/watch',
      'www.hotstar.com',
    );

    expect(cleanTitle(meta!.rawTitle)).toMatchObject({ season: 3, episode: 12 });
  });

  it('leaves a film without an episode number', () => {
    const meta = readAdapterMeta(
      docFrom('<body></body>'),
      'https://www.hotstar.com/in/movies/inception/1260022016/watch',
      'www.hotstar.com',
    );
    expect(cleanTitle(meta!.rawTitle).season).toBeUndefined();
  });
});
