import { api, ApiError } from './api';
import { beatStore } from './beat-store';

/**
 * The player's heartbeats, kept on the phone until the server has them. Every 30 seconds of playing makes one;
 * online it goes up at once, and offline (a downloaded chapter on a flight) it waits here, through closing the app,
 * and goes up with its original time when there's a connection. The server takes them up to 30 days late, which is
 * as long as a download plays offline.
 */
export interface Beat {
  chapterId: string;
  positionS: number;
  seconds: number;
  at: string;
}

/** About 16 hours of playing. Past that, the oldest go first. */
const KEEP = 2000;
const PER_REQUEST = 50; // the server's limit

let queue: Beat[] | null = null;
let sending: Promise<boolean> | null = null;

function load(): Beat[] {
  if (!queue) {
    try {
      const saved = JSON.parse(beatStore.read() ?? '[]') as unknown;
      queue = Array.isArray(saved) ? (saved as Beat[]) : [];
    } catch {
      queue = [];
    }
  }
  return queue;
}

function persist() {
  try {
    if (queue?.length) beatStore.write(JSON.stringify(queue));
    else beatStore.clear();
  } catch {
    // A full disk: they wait in memory, and the next save tries again.
  }
}

export function addBeat(beat: Beat): void {
  const q = load();
  q.push(beat);
  if (q.length > KEEP) q.splice(0, q.length - KEEP);
  persist();
}

export function pendingBeats(): number {
  return load().length;
}

/** Sends what's waiting, oldest first. True once nothing is left; false if it has to wait for a connection. */
export function sendBeats(): Promise<boolean> {
  // Cleared in a .finally added after the assignment: with nothing waiting the work finishes at once, and a finally
  // inside it would run before `sending` was set, leaving a finished promise there for good.
  sending ??= (async () => {
    const q = load();
    while (q.length) {
      const batch = q.slice(0, PER_REQUEST);
      try {
        await api('/v1/playback/heartbeats', { method: 'POST', body: { events: batch } });
      } catch (error) {
        // Turned down as it stands (a 4xx other than "sign in again" or "slow down"): sending it again won't help.
        const refused = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 429;
        if (!refused) return false;
      }
      q.splice(0, batch.length);
      persist();
    }
    return true;
  })().finally(() => {
    sending = null;
  });
  return sending;
}

/** After signing out: what's waiting was the last member's. */
export function clearBeats(): void {
  queue = [];
  persist();
}
