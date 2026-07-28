import { COVERAGE_BUCKETS } from './types';

/**
 * Mapping playback position onto coverage buckets.
 *
 * Kept separate from the content script so the seek-versus-playback rule can be
 * tested directly — it's the invariant that stops "skip to the credits" from
 * marking a film watched.
 */

export function bucketIndex(currentTimeSec: number, durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const bucket = Math.floor((currentTimeSec / durationSec) * COVERAGE_BUCKETS);
  return Math.min(COVERAGE_BUCKETS - 1, Math.max(0, bucket));
}

/**
 * Which buckets to credit for a sample.
 *
 * During continuous playback the range between the previous sample and this one
 * was genuinely watched, so it all counts. This matters for short media: a
 * 300-second video has 3-second buckets, so a 5-second sampling interval would
 * skip most of them and the completion threshold could never be reached.
 *
 * When the jump isn't consistent with continuous playback — a seek, a resume,
 * a backward scrub — only the bucket actually landed on is credited. Painting
 * over the skipped range is exactly the failure this design exists to prevent.
 */
export function bucketsCovered(
  previousBucket: number | null,
  currentBucket: number,
  elapsedMs: number,
  sampleIntervalMs: number,
): number[] {
  const contiguous =
    previousBucket !== null &&
    currentBucket >= previousBucket &&
    elapsedMs <= sampleIntervalMs * 2.5;

  if (!contiguous) return [currentBucket];

  const out: number[] = [];
  for (let i = previousBucket; i <= currentBucket; i++) out.push(i);
  return out;
}
