// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { adapterFor, readAdapterMeta } from '@/lib/adapters';
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

  it('handles a film with no subtitle', () => {
    const doc = docFrom('<body><div class="atvwebplayersdk-title-text">Arrival</div></body>');
    const meta = readAdapterMeta(doc, 'https://www.primevideo.com/detail/0XYZ', 'www.primevideo.com');
    expect(meta?.rawTitle).toBe('Arrival');
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
});
