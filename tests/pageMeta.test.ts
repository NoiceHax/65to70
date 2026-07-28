// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { extractPageMeta } from '@/lib/pageMeta';
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
