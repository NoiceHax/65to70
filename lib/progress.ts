import { COVERAGE_BUCKETS } from './types';

/**
 * Mapping playback position onto coverage buckets.
 *
 * Kept separate from the content script so the seek-versus-playback rule can be
 * tested directly — it's the invariant that stops "skip to the credits" from
 * marking a film watched.
 */

/**
 * How often playback position is sampled.
 *
 * Shared, because the content script samples at this rate and the background
 * relies on that spacing to tell ordinary playback from a seek.
 */
export const SAMPLE_INTERVAL_MS = 5_000;

/** The parts of a media element this module needs. Keeps it testable. */
export interface DurationSource {
  duration: number;
  seekable?: { length: number; end(index: number): number };
}

/**
 * Runtime in seconds, or 0 if not yet knowable.
 *
 * `video.duration` is not dependable on streaming sites. Players built on Media
 * Source Extensions — which is most of them — report `NaN` until the manifest
 * is parsed, and `Infinity` for streams whose end isn't declared. In both cases
 * the real runtime is in `seekable`, which is what the player's own scrub bar
 * reads.
 *
 * Getting this wrong is not a subtle degradation: a NaN duration fails the
 * minimum-length check, so the film is dismissed as an advert and nothing is
 * ever recorded.
 */
export function effectiveDuration(el: DurationSource): number {
  if (Number.isFinite(el.duration) && el.duration > 0) return el.duration;

  if (el.seekable && el.seekable.length > 0) {
    const end = el.seekable.end(el.seekable.length - 1);
    if (Number.isFinite(end) && end > 0) return end;
  }

  return 0;
}

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
