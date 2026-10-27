import type { Castable, CastSnapshot } from './cast-core';

export type { Castable, CastSnapshot, TvNow } from './cast-core';

/** The web app doesn't cast (Chrome can cast the whole tab itself). The phone apps use cast.native.ts. */
export const castSupported = false;

// Written out rather than imported, so the web build doesn't carry the phones' casting code for one constant.
const NOT_CASTING: CastSnapshot = { connection: 'unavailable', deviceName: null, session: 0, checked: false, tv: null, sending: null, failed: null };

const nothing = () => Promise.resolve();

export function useCast(): CastSnapshot {
  return NOT_CASTING;
}

export const cast = {
  start: (): void => undefined,
  setTracking: (_on: boolean): void => undefined,
  setForeground: (_active: boolean): void => undefined,
  send: (_chapter: Castable, _startS: number): Promise<boolean> => Promise.resolve(false),
  play: nothing,
  pause: nothing,
  seekBy: (_seconds: number): Promise<void> => nothing(),
  seekTo: (_positionS: number): Promise<void> => nothing(),
  stop: nothing,
};
