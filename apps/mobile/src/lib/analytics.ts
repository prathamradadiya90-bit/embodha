import Constants from 'expo-constants';
import { AppState, Platform } from 'react-native';
import { api, ApiError } from './api';
import { storage } from './storage';

/**
 * What the app tells Embodha's own server about how it's used: a few named moments, with IDs, slugs and screen
 * names attached. Never anything typed in, and nothing goes to an outside tracker. The server drops names it
 * doesn't know (see EVENT_NAMES in the API), so add a name there before sending it from here.
 *
 * Events wait in memory and go up in batches: every 15 seconds, at 20 events, and when the app goes to the
 * background. Offline, the newest 200 wait for the next try.
 */
export type EventName =
  | 'app_open'
  | 'screen_view'
  | 'course_view'
  | 'locked_view'
  | 'purchase_start'
  | 'purchase_done'
  | 'purchase_cancel'
  | 'breath_start'
  | 'video_start'
  | 'video_error'
  | 'cast_start'
  | 'cast_error';
export type EventProps = Record<string, string | number | boolean>;

interface Pending {
  name: EventName;
  at: string;
  props?: EventProps;
}

const DEVICE_KEY = 'embodha.device';
const SHARING_KEY = 'embodha.share-usage';
const FLUSH_MS = 15_000;
const BATCH = 20;
const PER_REQUEST = 50; // the server's limit
const KEEP = 200;

const platform = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web';
const appVersion = Constants.expoConfig?.version ?? null;

let queue: Pending[] = [];
let deviceId = '';
let sharing = true;
let loaded: Promise<void> | null = null;
let flushing: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let quietUntil = 0;

/** A random ID for this install, so guests can be counted without knowing who they are. */
function randomId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  let id = '';
  for (let i = 0; i < 32; i++) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}

function load(): Promise<void> {
  loaded ??= (async () => {
    const [saved, choice] = await Promise.all([storage.get(DEVICE_KEY), storage.get(SHARING_KEY)]).catch(() => [null, null]);
    sharing = choice !== 'off';
    if (!sharing) queue = [];
    deviceId = saved ?? randomId();
    if (!saved) await storage.set(DEVICE_KEY, deviceId).catch(() => undefined);
  })();
  return loaded;
}

function stopTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

export function track(name: EventName, props?: EventProps): void {
  if (!sharing) return;
  queue.push(props ? { name, at: new Date().toISOString(), props } : { name, at: new Date().toISOString() });
  if (queue.length > KEEP) queue = queue.slice(-KEEP);
  // After a failed send, wait for the timer rather than retrying on every new event.
  if (queue.length >= BATCH && Date.now() >= quietUntil) void flushEvents();
  else timer ??= setTimeout(() => void flushEvents(), FLUSH_MS);
}

/** Sends what's waiting. Never throws: if it can't send, the events wait for the next try. */
export function flushEvents(): Promise<void> {
  stopTimer();
  flushing ??= (async () => {
    try {
      await load();
      while (queue.length && sharing) {
        const batch = queue.slice(0, PER_REQUEST);
        queue = queue.slice(batch.length);
        try {
          await api('/v1/events', { method: 'POST', body: { anonId: deviceId, platform, appVersion, events: batch }, keepalive: true });
        } catch (error) {
          // The server turned the batch down (4xx): sending it again won't help. Anything else, keep it.
          if (error instanceof ApiError && error.status < 500 && error.status !== 429) continue;
          queue = [...batch, ...queue].slice(-KEEP);
          quietUntil = Date.now() + FLUSH_MS;
          return;
        }
      }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/** Counts the open, then each return from the background, and sends what's waiting whenever the app is put away. */
export function startAnalytics(): () => void {
  void load();
  track('app_open', { cold: true });
  let last = AppState.currentState;
  const subscription = AppState.addEventListener('change', (next) => {
    if (next === 'active' && last === 'background') track('app_open', { cold: false });
    if (next === 'background') void flushEvents();
    last = next;
  });
  return () => subscription.remove();
}

/** After signing out: a new ID, so a shared phone doesn't tie the next person's browsing to the last one. */
export async function resetDevice(): Promise<void> {
  await load();
  stopTimer();
  queue = [];
  deviceId = randomId();
  await storage.set(DEVICE_KEY, deviceId).catch(() => undefined);
}

/** The install's random ID, which crash reports carry too, so a crash can be put next to the session it ended. */
export async function deviceIdentity(): Promise<string> {
  await load();
  return deviceId;
}

export async function sharingUsage(): Promise<boolean> {
  await load();
  return sharing;
}

/** The switch in Profile. Off means nothing is recorded on this phone, and what was waiting is dropped. */
export async function setSharingUsage(on: boolean): Promise<void> {
  await load();
  sharing = on;
  if (!on) {
    stopTimer();
    queue = [];
  }
  await storage.set(SHARING_KEY, on ? 'on' : 'off').catch(() => undefined);
}
