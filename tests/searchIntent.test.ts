// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { searchLooksLikeScreenTitle } from '@/lib/overlayMatch';

function docFrom(html: string): Document {
  const doc = document.implementation.createHTMLDocument('');
  doc.documentElement.innerHTML = html;
  return doc;
}

describe('searchLooksLikeScreenTitle', () => {
  it('recognises a link to a film database', () => {
    const doc = docFrom('<body><a href="https://www.imdb.com/title/tt1375666/">Inception</a></body>');
    expect(searchLooksLikeScreenTitle(doc)).toBe(true);
  });

  it('unwraps a search engine redirect', () => {
    // Results are wrapped, so the real target is a parameter.
    const doc = docFrom(
      '<body><a href="/url?q=https://www.rottentomatoes.com/m/dune">Dune</a></body>',
    );
    expect(searchLooksLikeScreenTitle(doc)).toBe(true);
  });

  it('recognises a knowledge panel description', () => {
    const doc = docFrom('<body><span>2022 TV series</span></body>');
    expect(searchLooksLikeScreenTitle(doc)).toBe(true);
  });

  it('stays quiet on an ordinary search', () => {
    // The whole point. "Wednesday", "Up" and "Her" are all real titles, so the
    // query alone said yes to practically everything typed.
    const doc = docFrom(`
      <body>
        <a href="https://en.wikipedia.org/wiki/Wednesday">Wednesday</a>
        <a href="https://www.timeanddate.com/">What day is it</a>
        <span>Wednesday is the day of the week between Tuesday and Thursday.</span>
      </body>`);
    expect(searchLooksLikeScreenTitle(doc)).toBe(false);
  });

  it('ignores prose that merely mentions a film', () => {
    const doc = docFrom(`
      <body><div>A long article about how the director works, mentioning that
      the film series was directed by someone notable across many years and
      several studios.</div></body>`);
    expect(searchLooksLikeScreenTitle(doc)).toBe(false);
  });

  it('stays quiet on an empty page', () => {
    expect(searchLooksLikeScreenTitle(docFrom('<body></body>'))).toBe(false);
  });
});

describe('searchLooksLikeScreenTitle - panel signals', () => {
  it('recognises a where-to-watch section', () => {
    const doc = docFrom('<body><h2>Where to watch</h2><div>JioHotstar</div></body>');
    expect(searchLooksLikeScreenTitle(doc)).toBe(true);
  });

  it('recognises watchlist controls', () => {
    const doc = docFrom('<body><button>Want to watch</button></body>');
    expect(searchLooksLikeScreenTitle(doc)).toBe(true);
  });

  it('recognises two information labels together', () => {
    const doc = docFrom(`
      <body>
        <span>Release date</span><span>19 June 2009</span>
        <span>Running time</span><span>1h 48m</span>
      </body>`);
    expect(searchLooksLikeScreenTitle(doc)).toBe(true);
  });

  it('recognises two review services quoted together', () => {
    const doc = docFrom(`
      <body>
        <div><span>IMDb</span><span>6.8/10</span></div>
        <div><span>Rotten Tomatoes</span><span>45%</span></div>
      </body>`);
    expect(searchLooksLikeScreenTitle(doc)).toBe(true);
  });

  it('is not convinced by a single weak label', () => {
    // "Director" alone turns up in plenty of unrelated contexts, which is why
    // weak signals are counted rather than trusted.
    const doc = docFrom('<body><span>Director</span><span>Jane Smith</span></body>');
    expect(searchLooksLikeScreenTitle(doc)).toBe(false);
  });

  it('is not convinced by one review service alone', () => {
    const doc = docFrom('<body><span>IMDb</span></body>');
    expect(searchLooksLikeScreenTitle(doc)).toBe(false);
  });
});
