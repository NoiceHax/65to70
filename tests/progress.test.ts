import { describe, expect, it } from 'vitest';
import { bucketIndex, bucketsCovered, effectiveDuration } from '@/lib/progress';
import { coverageRatio, emptyCoverage, isComplete, unionCoverage } from '@/lib/db';

const SAMPLE_MS = 5_000;

function cover(indices: number[]): Uint8Array {
  const map = emptyCoverage();
  for (const i of indices) map[i] = 1;
  return map;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

describe('effectiveDuration', () => {
  const seekable = (end: number) => ({ length: 1, end: () => end });

  it('uses the duration when it is a real number', () => {
    expect(effectiveDuration({ duration: 6480 })).toBe(6480);
  });

  it('falls back to seekable when the manifest has not parsed yet', () => {
    // The real failure on cineby: a streaming player inserts its <video> with
    // duration NaN, so the film was rejected as too short and nothing was ever
    // recorded.
    expect(effectiveDuration({ duration: NaN, seekable: seekable(6480) })).toBe(6480);
  });

  it('falls back to seekable for an unbounded stream', () => {
    expect(effectiveDuration({ duration: Infinity, seekable: seekable(6480) })).toBe(6480);
  });

  it('returns 0 when nothing is knowable yet', () => {
    expect(effectiveDuration({ duration: NaN })).toBe(0);
    expect(effectiveDuration({ duration: NaN, seekable: { length: 0, end: () => 0 } })).toBe(0);
  });

  it('ignores a zero-length seekable range', () => {
    expect(effectiveDuration({ duration: NaN, seekable: seekable(0) })).toBe(0);
  });

  it('prefers a real duration over seekable', () => {
    // While buffering, seekable trails the true runtime.
    expect(effectiveDuration({ duration: 6480, seekable: seekable(120) })).toBe(6480);
  });
});

describe('bucketIndex', () => {
  it('maps position to a percentage bucket', () => {
    expect(bucketIndex(0, 100)).toBe(0);
    expect(bucketIndex(50, 100)).toBe(50);
  });

  it('clamps the final bucket rather than overflowing to 100', () => {
    expect(bucketIndex(100, 100)).toBe(99);
    expect(bucketIndex(120, 100)).toBe(99);
  });

  it('survives a live stream reporting no usable duration', () => {
    expect(bucketIndex(30, Infinity)).toBe(0);
    expect(bucketIndex(30, 0)).toBe(0);
  });
});

describe('bucketsCovered', () => {
  it('fills the range during continuous playback', () => {
    // Short media: 300s runtime means 3s buckets, so one 5s tick spans two.
    expect(bucketsCovered(10, 12, SAMPLE_MS, SAMPLE_MS)).toEqual([10, 11, 12]);
  });

  it('credits only the landing bucket after a forward seek', () => {
    // Same bucket jump, but far too much wall-clock elapsed to be playback.
    expect(bucketsCovered(10, 95, 60_000, SAMPLE_MS)).toEqual([95]);
  });

  it('credits only the landing bucket when scrubbing backwards', () => {
    expect(bucketsCovered(80, 20, SAMPLE_MS, SAMPLE_MS)).toEqual([20]);
  });

  it('credits only the current bucket on the first sample', () => {
    expect(bucketsCovered(null, 7, 0, SAMPLE_MS)).toEqual([7]);
  });
});

describe('completion', () => {
  it('requires 80% of buckets', () => {
    expect(isComplete(cover(range(0, 78)))).toBe(false); // 79 buckets
    expect(isComplete(cover(range(0, 79)))).toBe(true); // 80 buckets
  });

  it('does not count a film watched when the viewer skipped to the end', () => {
    // The failure this whole design exists to prevent: open, watch two minutes,
    // drag the scrubber to the credits.
    const coverage = emptyCoverage();
    let previous: number | null = null;

    for (const bucket of [0, 1, 2, 3]) {
      for (const i of bucketsCovered(previous, bucket, SAMPLE_MS, SAMPLE_MS)) coverage[i] = 1;
      previous = bucket;
    }
    // The seek: a big jump after a long pause.
    for (const i of bucketsCovered(previous, 99, 120_000, SAMPLE_MS)) coverage[i] = 1;

    expect(coverageRatio(coverage)).toBeCloseTo(0.05, 5);
    expect(isComplete(coverage)).toBe(false);
  });

  it('counts a film watched across two sittings', () => {
    // Half on Monday, half on Friday - neither session completes alone.
    const monday = cover(range(0, 44));
    const friday = cover(range(40, 89));

    expect(isComplete(monday)).toBe(false);
    expect(isComplete(friday)).toBe(false);
    expect(isComplete(unionCoverage([monday, friday]))).toBe(true);
  });

  it('ignores a trailer-length glance', () => {
    expect(coverageRatio(cover(range(0, 2)))).toBeCloseTo(0.03, 5);
    expect(isComplete(cover(range(0, 2)))).toBe(false);
  });
});
