import { describe, expect, it } from 'vitest';
import { cleanTitle, isUsableTitle } from '@/lib/titleClean';

describe('cleanTitle - SEO-stuffed page titles', () => {
  it('cuts at a parenthesised year and drops trailing quality noise', () => {
    expect(cleanTitle('Watch Inception (2010) Online Free HD - SiteName')).toMatchObject({
      title: 'Inception',
      year: 2010,
      mediaType: 'movie',
    });
  });

  it('drops a bare year mid-string and strips quality tags', () => {
    expect(cleanTitle('Full Metal Jacket 1987 1080p BluRay')).toMatchObject({
      title: 'Full Metal Jacket',
      year: 1987,
    });
  });

  it('handles bracketed quality markers before the noise run', () => {
    expect(cleanTitle('Dune: Part Two (2024) [4K] Watch Online Free')).toMatchObject({
      title: 'Dune: Part Two',
      year: 2024,
    });
  });
});

describe('cleanTitle - separator handling', () => {
  it('keeps title parts split by a hyphen, dropping only the noise segment', () => {
    // Naively taking the first segment would lose "Fallout".
    expect(cleanTitle('Mission: Impossible - Fallout | Watch Online Free')).toMatchObject({
      title: 'Mission: Impossible - Fallout',
    });
  });

  it('drops a trailing site-name segment', () => {
    expect(cleanTitle('Free Guy (2021) - Watch Online')).toMatchObject({
      title: 'Free Guy',
      year: 2021,
    });
  });
});

describe('cleanTitle - series', () => {
  it('parses SxxExx and treats it as a boundary, discarding the episode title', () => {
    expect(cleanTitle("Breaking Bad S01E02 - Cat's in the Bag... | FMovies")).toMatchObject({
      title: 'Breaking Bad',
      season: 1,
      episode: 2,
      mediaType: 'tv',
    });
  });

  it('parses the spelled-out form', () => {
    expect(cleanTitle('Watch Breaking Bad Season 1 Episode 2 Online Free')).toMatchObject({
      title: 'Breaking Bad',
      season: 1,
      episode: 2,
      mediaType: 'tv',
    });
  });

  it('parses the 4x01 form', () => {
    expect(cleanTitle('Stranger Things 4x01 Chapter One')).toMatchObject({
      title: 'Stranger Things',
      season: 4,
      episode: 1,
      mediaType: 'tv',
    });
  });

  it('does not mistake a resolution for a season/episode marker', () => {
    const result = cleanTitle('Some Film 4x1080 webrip');
    expect(result.season).toBeUndefined();
    expect(result.episode).toBeUndefined();
  });
});

describe('cleanTitle - titles that look like noise', () => {
  it('keeps "Movie" when it is part of the title', () => {
    expect(cleanTitle('The Lego Movie (2014) Full Movie Online Free')).toMatchObject({
      title: 'The Lego Movie',
      year: 2014,
    });
  });

  it('keeps a trailing "Now"', () => {
    expect(cleanTitle('Apocalypse Now')).toMatchObject({ title: 'Apocalypse Now' });
  });

  it('keeps a leading "Free"', () => {
    expect(cleanTitle('Free Guy')).toMatchObject({ title: 'Free Guy' });
  });

  it('keeps a leading "Full"', () => {
    expect(cleanTitle('Full Metal Jacket')).toMatchObject({ title: 'Full Metal Jacket' });
  });

  it('does not strip a year that is the entire title', () => {
    const result = cleanTitle('1917');
    expect(result.title).toBe('1917');
    expect(result.year).toBeUndefined();
  });

  it('separates a title-year from a release-year', () => {
    expect(cleanTitle('Watch 1917 (2019) Online')).toMatchObject({
      title: '1917',
      year: 2019,
    });
  });
});

describe('cleanTitle - non-Latin scripts', () => {
  // Found by probing a live TMDB page, which served a Hindi title based on
  // region. An ASCII-only normaliser reduced it to nothing and the noise check
  // then discarded it as padding.
  it('keeps a Devanagari title', () => {
    const result = cleanTitle('चक्रव्यूह (2012) Watch Online Free');
    expect(result.title).toBe('चक्रव्यूह');
    expect(result.year).toBe(2012);
    expect(isUsableTitle(result)).toBe(true);
  });

  it('keeps a Tamil title', () => {
    expect(isUsableTitle(cleanTitle('விக்ரம்'))).toBe(true);
  });

  it('keeps a Japanese title', () => {
    expect(isUsableTitle(cleanTitle('千と千尋の神隠し'))).toBe(true);
  });

  it('still strips Latin quality noise around a non-Latin title', () => {
    expect(cleanTitle('Watch पुष्पा Online Free HD 1080p')).toMatchObject({
      title: 'पुष्पा',
    });
  });
});

describe('isUsableTitle', () => {
  it('rejects bare navigation titles', () => {
    expect(isUsableTitle(cleanTitle('Home'))).toBe(false);
    expect(isUsableTitle(cleanTitle('Sign in'))).toBe(false);
  });

  it('rejects strings that reduce to pure padding', () => {
    expect(isUsableTitle(cleanTitle('Watch Now'))).toBe(false);
    expect(isUsableTitle(cleanTitle('Watch Online Free HD'))).toBe(false);
  });

  it('rejects empty input', () => {
    expect(isUsableTitle(cleanTitle(''))).toBe(false);
  });

  it('accepts a real title', () => {
    expect(isUsableTitle(cleanTitle('Watch Inception (2010) Online Free'))).toBe(true);
  });
});
