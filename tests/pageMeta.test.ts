// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { brandTokens, extractPageMeta, rankCandidates, stripBrand } from '@/lib/pageMeta';
import { cleanTitle } from '@/lib/titleClean';

function docFrom(html: string): Document {
  const doc = document.implementation.createHTMLDocument('');
  doc.documentElement.innerHTML = html;
  return doc;
}

function strategies(html: string, url = 'https://example.com/watch/inception-2010') {
  return extractPageMeta(docFrom(html), url).map((c) => c.strategy);
}

describe('extractPageMeta', () => {
  it('reads JSON-LD and prefers it', () => {
    const html = `
      <head>
        <title>Watch Inception Online Free | SiteName</title>
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Movie","name":"Inception","datePublished":"2010-07-16"}
        </script>
      </head><body></body>`;

    const [first] = extractPageMeta(docFrom(html), 'https://example.com/x');
    expect(first).toMatchObject({
      rawTitle: 'Inception',
      strategy: 'jsonld',
      yearHint: 2010,
    });
  });

  it('unwraps an @graph wrapper', () => {
    const html = `
      <head><script type="application/ld+json">
        {"@graph":[{"@type":"WebSite","name":"SiteName"},{"@type":"Movie","name":"Dune: Part Two"}]}
      </script></head><body></body>`;

    const [first] = extractPageMeta(docFrom(html), 'https://example.com/x');
    expect(first).toMatchObject({ rawTitle: 'Dune: Part Two', strategy: 'jsonld' });
  });

  it('ignores malformed JSON-LD instead of throwing', () => {
    const html = `
      <head>
        <script type="application/ld+json">{ not json at all }</script>
        <meta property="og:title" content="Inception (2010)">
      </head><body></body>`;

    expect(strategies(html)).toContain('og');
  });

  it('falls back through og:title, h1, and document.title', () => {
    const html = `
      <head>
        <title>Watch Arrival Online Free HD | SiteName</title>
        <meta property="og:title" content="Arrival (2016) Watch Online">
      </head>
      <body><h1>Arrival</h1></body>`;

    const found = strategies(html);
    expect(found).toEqual(['og', 'h1', 'document-title', 'slug']);
  });

  it('derives a title from the URL slug when the page offers nothing', () => {
    const [first] = extractPageMeta(
      docFrom('<head></head><body></body>'),
      'https://example.com/movie/the-lego-movie-2014',
    );
    expect(first).toMatchObject({ rawTitle: 'the lego movie 2014', strategy: 'slug' });
  });

  it('skips a trailing numeric id when reading the slug', () => {
    const [first] = extractPageMeta(
      docFrom('<head></head><body></body>'),
      'https://example.com/watch/interstellar/157336',
    );
    expect(first?.rawTitle).toBe('interstellar');
  });

  it('skips a trailing /watch segment when reading the slug', () => {
    const [first] = extractPageMeta(
      docFrom('<head></head><body></body>'),
      'https://example.com/film/blade-runner-2049/watch',
    );
    expect(first?.rawTitle).toBe('blade runner 2049');
  });

  it('strips a catalogue id glued to the slug', () => {
    // Real TMDB URL shape, found while probing.
    const [first] = extractPageMeta(
      docFrom('<head></head><body></body>'),
      'https://www.themoviedb.org/movie/27205-inception',
    );
    expect(first?.rawTitle).toBe('inception');
  });

  it('does not mistake a four-digit title for an id', () => {
    const [first] = extractPageMeta(
      docFrom('<head></head><body></body>'),
      'https://example.com/movie/1917-watch',
    );
    expect(first?.rawTitle).toContain('1917');
  });

  it('deduplicates identical candidates from different sources', () => {
    const html = `
      <head><title>Heat</title><meta property="og:title" content="Heat"></head>
      <body><h1>Heat</h1></body>`;

    const titles = extractPageMeta(docFrom(html), 'https://example.com/heat');
    expect(titles.filter((c) => c.rawTitle === 'Heat')).toHaveLength(1);
  });
});

describe('brandTokens', () => {
  it('drops the TLD and www', () => {
    expect([...brandTokens('cineby.cc')]).toEqual(['cineby']);
    expect([...brandTokens('www.fmovies.to')]).toEqual(['fmovies']);
  });
});

describe('stripBrand', () => {
  it('removes the site name from a trailing segment', () => {
    // Ranking rejects a title that is only the brand. This is the far more
    // common case: the brand alongside the real answer.
    expect(stripBrand('Adarsh Baal Vidyalaya - Cineby', 'cineby.cc')).toBe(
      'Adarsh Baal Vidyalaya',
    );
  });

  it('removes it from a leading segment', () => {
    expect(stripBrand('FMovies | Interstellar', 'fmovies.to')).toBe('Interstellar');
  });

  it('keeps a title that merely contains the brand as a word', () => {
    // Only whole segments are removed, so a real title survives intact.
    expect(stripBrand('Cinema Paradiso - Something', 'cinema.to')).toBe(
      'Cinema Paradiso - Something',
    );
  });

  it('leaves a single-segment title alone', () => {
    expect(stripBrand('Cineby', 'cineby.cc')).toBe('Cineby');
  });

  it('does nothing when there is no brand to find', () => {
    expect(stripBrand('Interstellar - 2014', '')).toBe('Interstellar - 2014');
  });
});

describe('rankCandidates', () => {
  it('rejects a candidate that is just the site name', () => {
    // The actual failure on a client-rendered site: og:title was baked into the
    // app shell as the brand and never updated per page.
    const ranked = rankCandidates(
      [
        { rawTitle: 'Cineby', strategy: 'og' },
        { rawTitle: 'Paldo Script', strategy: 'h1' },
        { rawTitle: 'Weapons (2025)', strategy: 'document-title' },
      ],
      'cineby.cc',
    );

    expect(ranked[0].rawTitle).toBe('Weapons (2025)');
    expect(ranked[ranked.length - 1].rawTitle).toBe('Cineby');
  });

  it('prefers document.title over a stale og:title', () => {
    const ranked = rankCandidates(
      [
        { rawTitle: 'SomeSite - Free Movies', strategy: 'og' },
        { rawTitle: 'Arrival (2016)', strategy: 'document-title' },
      ],
      'somesite.to',
    );
    expect(ranked[0].strategy).toBe('document-title');
  });

  it('still puts JSON-LD first when it is present and not the brand', () => {
    const ranked = rankCandidates(
      [
        { rawTitle: 'Interstellar', strategy: 'jsonld' },
        { rawTitle: 'Interstellar (2014) Watch Free', strategy: 'document-title' },
      ],
      'example.to',
    );
    expect(ranked[0].strategy).toBe('jsonld');
  });

  it('does not penalise a real title that merely contains the brand', () => {
    // "Cinema Paradiso" on cinema.to should not be treated as the site's name.
    const ranked = rankCandidates(
      [
        { rawTitle: 'Cinema Paradiso (1988)', strategy: 'og' },
        { rawTitle: 'Cinema', strategy: 'h1' },
      ],
      'cinema.to',
    );
    expect(ranked[0].rawTitle).toBe('Cinema Paradiso (1988)');
  });
});

describe('extraction feeding into cleaning', () => {
  it('recovers the title from a keyword-stuffed piracy-site page', () => {
    const html = `
      <head>
        <title>Watch Interstellar (2014) Online Free HD 1080p - FMovies</title>
        <meta property="og:title" content="Watch Interstellar (2014) Online Free HD 1080p - FMovies">
      </head>
      <body><h1>Interstellar (2014)</h1></body>`;

    const [best] = extractPageMeta(docFrom(html), 'https://fmovies.example/watch/interstellar');
    expect(cleanTitle(best.rawTitle)).toMatchObject({
      title: 'Interstellar',
      year: 2014,
      mediaType: 'movie',
    });
  });

  it('recovers show, season and episode from an episode page', () => {
    const html = `
      <head><meta property="og:title" content="Watch The Wire S03E11 Online Free | SiteName"></head>
      <body></body>`;

    const [best] = extractPageMeta(docFrom(html), 'https://example.com/x');
    expect(cleanTitle(best.rawTitle)).toMatchObject({
      title: 'The Wire',
      season: 3,
      episode: 11,
      mediaType: 'tv',
    });
  });
});
