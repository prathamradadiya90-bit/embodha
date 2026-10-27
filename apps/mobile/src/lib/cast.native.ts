import { useSyncExternalStore } from 'react';
import { NativeModules } from 'react-native';
import {
  CastContext,
  RemoteMediaClient,
  type CastSession,
  type CastState,
  type MediaLoadRequest,
  type MediaStatus,
} from 'react-native-google-cast';
import { track } from './analytics';
import { api } from './api';
import { addBeat, sendBeats } from './beats';
import {
  CastController,
  NOT_CASTING,
  type Castable,
  type CastPort,
  type CastSnapshot,
  type Connection,
  type IdleReason,
  type MediaUpdate,
  type SessionEvent,
  type TvState,
} from './cast-core';
import { downloads } from './downloads';
import { storage } from './storage';

export type { Castable, CastSnapshot, TvNow } from './cast-core';

/**
 * Chromecast on the phones, through react-native-google-cast (the Google Cast SDK underneath). Everything the app
 * decides lives in cast-core.ts; this file only translates. A development build made before Chromecast went in has
 * none of the SDK's native parts, and simply doesn't offer casting.
 */
const present = Boolean(
  NativeModules.RNGCCastContext && NativeModules.RNGCSessionManager && NativeModules.RNGCRemoteMediaClient && NativeModules.RNGCCastSession,
);

export const castSupported = present;

const states: Record<string, Connection> = {
  noDevicesAvailable: 'noDevices',
  notConnected: 'notConnected',
  connecting: 'connecting',
  connected: 'connected',
};

/** Android without Google Play services reports no cast state at all. */
const toConnection = (state: CastState | null | undefined): Connection => (state ? (states[state] ?? 'notConnected') : 'unavailable');

function toUpdate(status: MediaStatus | null): MediaUpdate | null {
  if (!status) return null;
  const info = status.mediaInfo ?? null;
  const data = (info?.customData ?? null) as { chapterId?: unknown; sender?: unknown } | null;
  const position = Number(status.streamPosition);
  const duration = Number(info?.streamDuration);
  return {
    chapterId: typeof data?.chapterId === 'string' ? data.chapterId : null,
    sender: typeof data?.sender === 'string' ? data.sender : null,
    state: (status.playerState ?? null) as TvState | null,
    idleReason: (status.idleReason ?? null) as IdleReason | null,
    positionS: Number.isFinite(position) && position > 0 ? position : 0,
    durationS: Number.isFinite(duration) && duration > 0 ? duration : null,
  };
}

function nativePort(): CastPort {
  const sessions = CastContext.getSessionManager();
  const client = new RemoteMediaClient();
  const deviceOf = async (session: CastSession | null) => {
    if (!session) return null;
    const device = await session.getCastDevice().catch(() => null);
    return { name: device?.friendlyName?.trim() || null };
  };
  return {
    connection: async () => toConnection(await CastContext.getCastState()),
    onConnection(listener) {
      const subscription = CastContext.onCastStateChanged((state) => listener(toConnection(state)));
      return () => subscription.remove();
    },
    session: async () => deviceOf(await sessions.getCurrentCastSession()),
    onSession(listener) {
      // The TV's name is looked up after each event; the events still reach the app in the order they happened.
      let queue = Promise.resolve();
      const relay = (event: SessionEvent, session: CastSession | null) => {
        queue = queue
          .then(async () => listener(event, event === 'started' || event === 'resumed' ? ((await deviceOf(session)) ?? { name: null }) : null))
          .catch(() => undefined);
      };
      const subscriptions = [
        sessions.onSessionStarted((session) => relay('started', session)),
        sessions.onSessionResumed((session) => relay('resumed', session)),
        sessions.onSessionSuspended((session) => relay('suspended', session)),
        sessions.onSessionEnded((session) => relay('ended', session)),
      ];
      return () => subscriptions.forEach((subscription) => subscription.remove());
    },
    media: {
      // cast-core writes the request in the SDK's own values; only the enum types differ.
      loadMedia: (request) => client.loadMedia(request as unknown as MediaLoadRequest),
      play: () => client.play(),
      pause: () => client.pause(),
      seek: (options) => client.seek(options),
      // The library's progress events would do this job, but removing their listener on Android rejects a promise
      // nobody catches, so the position is asked for instead (once a second while the TV plays and the app is open).
      position: () => client.getStreamPosition(),
      status: async () => toUpdate(await client.getMediaStatus()),
      requestStatus: () => client.requestStatus(),
      onStatus(listener) {
        const subscription = client.onMediaStatusUpdated((status) => listener(toUpdate(status)));
        return () => subscription.remove();
      },
    },
    endSession: () => sessions.endCurrentSession(true),
  };
}

/** A random tag for this install, so a phone counts only the chapters it put on the TV, not another one's. */
const SENDER_KEY = 'embodha.cast-sender';
let senderTag: Promise<string> | null = null;

function randomTag(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  let tag = '';
  for (let i = 0; i < 16; i++) tag += Math.floor(Math.random() * 16).toString(16);
  return tag;
}

function sender(): Promise<string> {
  senderTag ??= storage
    .get(SENDER_KEY)
    .then(async (saved) => {
      if (saved) return saved;
      const made = randomTag();
      await storage.set(SENDER_KEY, made).catch(() => undefined);
      return made;
    })
    .catch(() => randomTag());
  return senderTag;
}

const controller = present
  ? new CastController(nativePort(), {
      tracker: {
        addBeat(beat) {
          addBeat(beat);
          // A chapter that's also downloaded keeps the TV's place, for playing offline later.
          if (downloads.saved(beat.chapterId)) downloads.savePosition(beat.chapterId, beat.positionS);
        },
        sendBeats: () => sendBeats(),
        complete: (chapterId) => void api(`/v1/chapters/${chapterId}/complete`, { method: 'POST' }).catch(() => undefined),
      },
      sender,
      sent: (chapter, startS) => track('cast_start', { chapterId: chapter.chapterId, kind: chapter.type, resumed: startS > 5 }),
      failed: (chapterId, type, message) => track('cast_error', { chapterId, ...(type ? { kind: type } : {}), message: message.slice(0, 120) }),
    })
  : null;

const nothing = () => Promise.resolve();
const notCasting = () => NOT_CASTING;
const noSubscription = () => () => undefined;

export function useCast(): CastSnapshot {
  return useSyncExternalStore(controller?.subscribe ?? noSubscription, controller?.getSnapshot ?? notCasting, controller?.getSnapshot ?? notCasting);
}

export const cast = {
  start: (): void => controller?.start(),
  setTracking: (on: boolean): void => controller?.setTracking(on),
  setForeground: (active: boolean): void => controller?.setForeground(active),
  send: (chapter: Castable, startS: number): Promise<boolean> => controller?.send(chapter, startS) ?? Promise.resolve(false),
  play: (): Promise<void> => controller?.play() ?? nothing(),
  pause: (): Promise<void> => controller?.pause() ?? nothing(),
  seekBy: (seconds: number): Promise<void> => controller?.seekBy(seconds) ?? nothing(),
  seekTo: (positionS: number): Promise<void> => controller?.seekTo(positionS) ?? nothing(),
  stop: (): Promise<void> => controller?.stop() ?? nothing(),
};
