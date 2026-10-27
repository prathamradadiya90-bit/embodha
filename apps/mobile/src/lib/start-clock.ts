/**
 * How long a chapter took to start, as the member felt it: from opening the player (the tap) to the first frame of
 * video, or the first sound of an audio chapter. The part spent asking the server for the stream is kept too, so a
 * slow start can be put down to the server or to the video network.
 *
 * Each clock gives one reading. Leaving before anything played gives a reading marked abandoned; a locked chapter or
 * one that failed to load gives none, because nothing was trying to play.
 */
export interface StartReading {
  ms: number;
  apiMs: number | null;
  abandoned: boolean;
}

export interface StartClock {
  /** The server answered with the stream's address. */
  answered(at?: number): void;
  /** First frame or first sound. The reading, the first time only. */
  started(at?: number): StartReading | null;
  /** The member left first. A reading marked abandoned, unless the clock already stopped. */
  left(at?: number): StartReading | null;
  /** Nothing was going to play: locked, still processing, or an error. */
  cancel(): void;
}

export function startClock(opened = Date.now()): StartClock {
  let answeredAt: number | null = null;
  let done = false;
  const reading = (at: number, abandoned: boolean): StartReading | null => {
    if (done) return null;
    done = true;
    return { ms: Math.max(0, Math.round(at - opened)), apiMs: answeredAt === null ? null : Math.max(0, Math.round(answeredAt - opened)), abandoned };
  };
  return {
    answered(at = Date.now()) {
      answeredAt ??= at;
    },
    started: (at = Date.now()) => reading(at, false),
    left: (at = Date.now()) => reading(at, true),
    cancel() {
      done = true;
    },
  };
}
