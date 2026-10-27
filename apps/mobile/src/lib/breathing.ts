import type { BreathingPattern } from './types';

/** Shipped inside the app so breathing works offline and on first launch. The API's list replaces these when it loads. */
export const BUNDLED_PATTERNS: BreathingPattern[] = [
  { slug: 'box', name: 'Box breathing', description: 'Four counts in, hold, out, hold. Steadies you before a busy day.', inhaleS: 4, holdInS: 4, exhaleS: 4, holdOutS: 4, rounds: 6 },
  { slug: '4-7-8', name: '4-7-8 breathing', description: 'A long exhale for winding down.', inhaleS: 4, holdInS: 7, exhaleS: 8, holdOutS: 0, rounds: 4 },
  { slug: 'slow', name: 'Slow breathing', description: 'About six breaths a minute.', inhaleS: 5, holdInS: 0, exhaleS: 5, holdOutS: 0, rounds: 12 },
  { slug: 'long-sigh', name: 'Long sigh', description: 'A full breath in, a slow sigh out.', inhaleS: 3, holdInS: 0, exhaleS: 6, holdOutS: 0, rounds: 5 },
];

export const SMALL = 0.55;
export const LARGE = 1;

export interface Phase {
  label: string;
  seconds: number;
  scaleTo: number;
}

export function phasesOf(pattern: BreathingPattern): Phase[] {
  return [
    { label: 'Breathe in', seconds: pattern.inhaleS, scaleTo: LARGE },
    { label: 'Hold', seconds: pattern.holdInS, scaleTo: LARGE },
    { label: 'Breathe out', seconds: pattern.exhaleS, scaleTo: SMALL },
    { label: 'Hold', seconds: pattern.holdOutS, scaleTo: SMALL },
  ].filter((phase) => phase.seconds > 0);
}

export const totalSeconds = (pattern: BreathingPattern) =>
  (pattern.inhaleS + pattern.holdInS + pattern.exhaleS + pattern.holdOutS) * pattern.rounds;
