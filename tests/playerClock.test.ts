// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { parseClock, readPlayerClock } from '@/lib/playerClock';

function docFrom(html: string): Document {
  const doc = document.implementation.createHTMLDocument('');
  doc.documentElement.innerHTML = html;
  return doc;
}

describe('parseClock', () => {
  it('reads hours, minutes and seconds', () => {
    expect(parseClock('1:23:45')).toBe(5025);
  });

  it('reads minutes and seconds', () => {
    expect(parseClock('23:45')).toBe(1425);
  });

  it('rejects impossible values', () => {
    expect(parseClock('1:99:00')).toBeNull();
    expect(parseClock('1:00:75')).toBeNull();
  });

  it('rejects things that merely contain a colon', () => {
    expect(parseClock('Season 1: Episode 2')).toBeNull();
    expect(parseClock('')).toBeNull();
  });
});

describe('readPlayerClock - from the scrubber', () => {
  it('reads the slider a screen reader would', () => {
    // Preferred source: these values have to be correct for the player to be
    // usable without sight, so they survive when the media element does not.
    const doc = docFrom(`
      <body><div role="slider" aria-valuenow="1200" aria-valuemax="6480"></div></body>`);

    expect(readPlayerClock(doc)).toEqual({
      positionSec: 1200,
      durationSec: 6480,
      source: 'aria',
    });
  });

  it('reads a range input', () => {
    const doc = docFrom('<body><input type="range" value="600" max="5400"></body>');
    expect(readPlayerClock(doc)).toMatchObject({ positionSec: 600, durationSec: 5400 });
  });

  it('ignores a slider too short to be a film', () => {
    // A volume control is also a slider.
    const doc = docFrom('<body><div role="slider" aria-valuenow="5" aria-valuemax="100"></div></body>');
    expect(readPlayerClock(doc)).toBeNull();
  });

  it('ignores a position beyond the runtime', () => {
    const doc = docFrom(
      '<body><div role="slider" aria-valuenow="9999" aria-valuemax="6480"></div></body>',
    );
    expect(readPlayerClock(doc)).toBeNull();
  });
});

describe('readPlayerClock - from rendered time', () => {
  it('reads elapsed and total together', () => {
    const doc = docFrom('<body><span>1:23:45 / 2:14:30</span></body>');
    expect(readPlayerClock(doc)).toEqual({
      positionSec: 5025,
      durationSec: 8070,
      source: 'text',
    });
  });

  it('adds a countdown to the elapsed time', () => {
    // The other common shape: elapsed, and how much is left.
    const doc = docFrom('<body><span>0:30:00</span><span>-1:10:00</span></body>');
    expect(readPlayerClock(doc)).toMatchObject({ positionSec: 1800, durationSec: 6000 });
  });

  it('ignores prose that happens to contain times', () => {
    const doc = docFrom(
      '<body><p>The film runs 2:14:30 and was released in 1999, a long sentence.</p></body>',
    );
    expect(readPlayerClock(doc)).toBeNull();
  });

  it('returns null when there is no clock on screen', () => {
    expect(readPlayerClock(docFrom('<body><span>Play</span></body>'))).toBeNull();
  });

  it('prefers the scrubber over rendered text', () => {
    const doc = docFrom(`
      <body>
        <span>1:00:00 / 2:00:00</span>
        <div role="slider" aria-valuenow="1200" aria-valuemax="6480"></div>
      </body>`);

    expect(readPlayerClock(doc)?.source).toBe('aria');
  });
});
