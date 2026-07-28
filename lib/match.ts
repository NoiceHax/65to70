import type { TmdbTitle } from './tmdb';

/**
 * Scoring a cleaned page title against catalogue candidates.
 *
 * Title cleaning is deliberately conservative — it leaves weak padding in
 * rather than risk deleting a real word — so the matcher has to tolerate extra
 * tokens. Token-set overlap handles that far better than string distance:
 * "Inception Full Movie" still overlaps "Inception" completely.
 */

/**
 * Strip diacritics, punctuation and case so "Amélie" matches "Amelie".
 *
 * The combining-mark removal is restricted to Latin base letters on purpose.
 * Devanagari, Tamil and Thai express vowels as combining marks too, so a blanket
 * `\p{Diacritic}` strip doesn't fold an accent — it deletes half the word.
 * "पुष्पा" came back as something that no longer matched itself.
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/(\p{Script=Latin})\p{Mn}+/gu, '$1')
    .toLowerCase()
    .replace(/&/g, ' and ')
    // \p{M} has to be kept: Indic vowel signs are combining marks, so dropping
    // marks here deletes the vowels out of every Devanagari and Tamil title.
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim();
}

function tokens(title: string): Set<string> {
  return new Set(normalizeTitle(title).split(' ').filter(Boolean));
}

function isSubset(inner: Set<string>, outer: Set<string>): boolean {
  if (inner.size === 0 || inner.size > outer.size) return false;
  for (const token of inner) if (!outer.has(token)) return false;
  return true;
}

/** Jaccard overlap, biased toward covering the shorter of the two token sets. */
function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;

  const union = a.size + b.size - shared;
  const jaccard = shared / union;
  // Containment: "Inception" inside "Inception Full Movie" should score well
  // even though the union is larger.
  const containment = shared / Math.min(a.size, b.size);

  return jaccard * 0.4 + containment * 0.6;
}

export interface MatchInput {
  title: string;
  year?: number;
  /** Runtime in minutes, when the player reported a duration. */
  runtimeMinutes?: number;
}

/** 0–1. Above ~0.75 a single candidate is safe to treat as the answer. */
export function scoreMatch(input: MatchInput, candidate: TmdbTitle): number {
  const queryTokens = tokens(input.title);

  // Compare against both the localised and original titles — sites serve
  // whichever suits the viewer's region.
  const titleScore = Math.max(
    tokenOverlap(queryTokens, tokens(candidate.title)),
    candidate.originalTitle ? tokenOverlap(queryTokens, tokens(candidate.originalTitle)) : 0,
  );

  let score = titleScore;

  if (normalizeTitle(input.title) === normalizeTitle(candidate.title)) {
    score = Math.max(score, 0.95);
  }

  // The signature of leftover padding: the candidate's whole title appears
  // inside the query ("Inception" within "Inception Full Movie"). Safe in this
  // direction only — the reverse, where the query is a fragment of a longer
  // candidate, is how "Alien" gets mistaken for "Alien: Covenant".
  //
  // Scaled by how much of the query the candidate accounts for, not applied as
  // a flat floor. A flat floor tied "Alien" with "Alien: Covenant" on the query
  // "Alien Covenant Full Movie", since both are subsets — which discarded the
  // very ordering this is meant to preserve.
  const candidateTokens = tokens(candidate.title);
  if (isSubset(candidateTokens, queryTokens)) {
    const coverage = candidateTokens.size / queryTokens.size;
    score = Math.max(score, 0.78 + 0.17 * coverage);
  }

  if (input.year !== undefined && candidate.year !== undefined) {
    const drift = Math.abs(input.year - candidate.year);
    // Release-year metadata disagrees by a year all the time; more than that
    // usually means a different film, most often a remake.
    if (drift === 0) score += 0.15;
    else if (drift === 1) score += 0.05;
    else score -= 0.35;
  }

  if (input.runtimeMinutes !== undefined && candidate.runtime) {
    const drift = Math.abs(input.runtimeMinutes - candidate.runtime);
    if (drift <= 3) score += 0.1;
    else if (drift > 25) score -= 0.15;
  }

  return Math.max(0, Math.min(1, score));
}

export interface ScoredCandidate {
  candidate: TmdbTitle;
  score: number;
}

export function rankMatches(input: MatchInput, candidates: TmdbTitle[]): ScoredCandidate[] {
  return candidates
    .map((candidate) => ({ candidate, score: scoreMatch(input, candidate) }))
    .sort((a, b) => b.score - a.score);
}

/** Enough to accept without asking. */
export const CONFIDENT_SCORE = 0.75;
/** Below this a candidate isn't worth showing at all. */
export const PLAUSIBLE_SCORE = 0.35;

/**
 * Whether the top match can be taken automatically.
 *
 * Requires both a high score and clear separation from the runner-up. Two
 * candidates scoring 0.8 and 0.78 means a remake or a re-release, and guessing
 * between them is exactly the kind of silent error that puts a wrong entry in
 * someone's diary.
 */
export function isDecisive(ranked: ScoredCandidate[]): boolean {
  if (ranked.length === 0) return false;
  if (ranked[0].score < CONFIDENT_SCORE) return false;
  if (ranked.length === 1) return true;
  return ranked[0].score - ranked[1].score >= 0.15;
}
