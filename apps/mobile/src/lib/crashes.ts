import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { AppState, Platform } from 'react-native';
import { api, ApiError } from './api';
import { crashStore } from './crash-store';

/**
 * Crash and error reports, sent to Embodha's own server rather than to an outside service.
 *
 * - A crash is written to the phone the moment it happens, because the app is about to close, and sent on the next
 *   launch. A screen that fails and shows "Something went wrong" counts as a crash too, and goes straight away.
 * - Other errors nobody caught wait a few seconds in memory and go up together. Each different one is sent once per
 *   launch, twenty at most, so a loop can't flood anything.
 * - Nothing is sent while "Share how you use the app" is off, and development builds send nothing at all.
 *
 * A report carries the error's message and stack, the screen it happened on, the app version, and the phone's model
 * and system version: never the name someone gave their phone, and never anything they typed.
 */
export type ReportKind = 'crash' | 'error';
export interface CrashReport {
  kind: ReportKind;
  message: string;
  stack?: string;
  screen?: string;
  /** The version the error happened on. A crash may be sent after the app was updated. */
  appVersion: string | null;
  at: string;
}
interface Deps {
  /** The install's random ID, shared with the usage events. */
  identity: () => Promise<string>;
  /** "Share how you use the app". */
  sharing: () => Promise<boolean>;
  /** How long after launch last time's crashes go up, and how long errors wait to be sent together. */
  sendAfterMs?: number;
}

const KEEP_ON_DISK = 5;
const PER_REQUEST = 10; // the server's limit
const MAX_PER_LAUNCH = 20;
const MAX_MESSAGE = 1_000;
const MAX_STACK = 8_000;
/** Noise browsers make that isn't Embodha's: cross-origin "Script error.", and a harmless layout warning. */
const IGNORED = [/^Script error\.?$/, /ResizeObserver loop/];

const platform = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web';
const appVersion = Constants.expoConfig?.version ?? null;

let deps: Deps | null = null;
let screen = '';
let queue: CrashReport[] = [];
const seen = new Set<string>();
let queuedThisLaunch = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let sending: Promise<void> | null = null;

/** The message and stack of whatever was thrown, which isn't always an Error. */
export function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error || (error && typeof error === 'object' && 'message' in error)) {
    const e = error as Error;
    const name = e.name && e.name !== 'Error' ? `${e.name}: ` : '';
    return { message: `${name}${e.message || 'An error with no message'}`, stack: typeof e.stack === 'string' ? e.stack : undefined };
  }
  if (typeof error === 'string') return { message: error || 'An error with no message' };
  try {
    return { message: JSON.stringify(error) ?? String(error) };
  } catch {
    return { message: String(error) };
  }
}

export function makeReport(kind: ReportKind, error: unknown, where = screen, now = new Date()): CrashReport {
  const { message, stack } = describeError(error);
  return {
    kind,
    message: message.slice(0, MAX_MESSAGE),
    ...(stack ? { stack: stack.slice(0, MAX_STACK) } : {}),
    ...(where ? { screen: where } : {}),
    appVersion,
    at: now.toISOString(),
  };
}

/** Crashes waiting on the phone. Anything unreadable is dropped rather than sent. */
export function readPending(text: string | null | undefined): CrashReport[] {
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is CrashReport => Boolean(r) && (r.kind === 'crash' || r.kind === 'error') && typeof r.message === 'string' && typeof r.at === 'string').slice(-KEEP_ON_DISK);
  } catch {
    return [];
  }
}

export const writePending = (reports: CrashReport[]) => JSON.stringify(reports.slice(-KEEP_ON_DISK));

/** Two errors are the same if they say the same thing from the same place. */
const topFrame = (stack?: string) => (stack ?? '').split('\n').find((line) => /^\s*at\s|@/.test(line))?.trim() ?? '';
const sameness = (r: CrashReport) => `${r.kind}|${r.message}|${topFrame(r.stack)}`;

/** The screen the member is on, for the next report. The analytics bridge sets it as the route changes. */
export function noteScreen(path: string) {
  screen = path;
}

function keepCrash(report: CrashReport) {
  try {
    crashStore.write(writePending([...readPending(crashStore.read()), report]));
  } catch {
    // Nowhere to keep it: the crash goes unreported rather than getting in the way.
  }
}

function queueError(report: CrashReport) {
  if (IGNORED.some((pattern) => pattern.test(report.message))) return;
  const key = sameness(report);
  if (seen.has(key) || queuedThisLaunch >= MAX_PER_LAUNCH) return;
  seen.add(key);
  queuedThisLaunch += 1;
  queue.push(report);
  timer ??= setTimeout(() => {
    timer = null;
    void sendReports();
  }, deps?.sendAfterMs ?? 5_000);
}

/** A screen that failed to draw and showed "This screen didn't load". The app is still running, so it goes now. */
export function reportScreenCrash(error: unknown) {
  if (!deps) return;
  keepCrash(makeReport('crash', error));
  void sendReports();
}

/** Once, as the app starts. Sends whatever crashed last time, then listens for what goes wrong this time. */
export function installCrashReporting(next: Deps) {
  if (deps) return;
  deps = next;

  if (platform === 'web') {
    const page = globalThis as unknown as { addEventListener?: (type: string, listener: (event: never) => void) => void; location?: { origin: string } };
    page.addEventListener?.('error', (event: { error?: unknown; message?: string; filename?: string }) => {
      // Errors from browser extensions and other sites' scripts aren't Embodha's.
      if (event.filename && page.location && !event.filename.startsWith(page.location.origin)) return;
      queueError(makeReport('error', event.error ?? event.message));
    });
    page.addEventListener?.('unhandledrejection', (event: { reason?: unknown }) => queueError(makeReport('error', event.reason)));
  } else {
    const handlers = globalThis as unknown as { ErrorUtils?: typeof ErrorUtils };
    const previous = handlers.ErrorUtils?.getGlobalHandler();
    handlers.ErrorUtils?.setGlobalHandler((error: unknown, isFatal?: boolean) => {
      try {
        if (isFatal) keepCrash(makeReport('crash', error));
        else queueError(makeReport('error', error));
      } catch {
        // Reporting must never stand between the error and the system's own handling of it.
      }
      previous?.(error, isFatal);
    });
    // Promises nobody caught. React Native only watches for these in development, where they show as warnings.
    const hermes = (globalThis as { HermesInternal?: { enablePromiseRejectionTracker?: (options: object) => void } }).HermesInternal;
    hermes?.enablePromiseRejectionTracker?.({
      allRejections: true,
      onUnhandled: (_id: number, rejection: unknown) => queueError(makeReport('error', rejection)),
      onHandled: () => undefined,
    });
  }

  AppState.addEventListener('change', (state) => {
    if (state === 'background') void sendReports();
  });
  setTimeout(() => void sendReports(), next.sendAfterMs ?? 1_500);
}

const turnedDown = (error: unknown) => error instanceof ApiError && error.status < 500 && error.status !== 429;

/** Sends saved crashes, then queued errors. Never throws: whatever can't go now waits for the next try. */
export function sendReports(): Promise<void> {
  sending ??= (async () => {
    try {
      if (!deps) return;
      if (!(await deps.sharing())) {
        queue = [];
        crashStore.clear();
        return;
      }
      const anonId = await deps.identity();
      const send = (reports: CrashReport[]) =>
        api('/v1/app-errors', {
          method: 'POST',
          body: { anonId, platform, appVersion, osVersion: Device.osVersion ?? null, device: Device.modelName ?? (platform === 'web' ? Device.osName : null) ?? null, reports },
          keepalive: true,
        });

      const crashes = readPending(crashStore.read());
      if (crashes.length) {
        try {
          await send(crashes);
        } catch (error) {
          if (!turnedDown(error)) return; // offline or the server's busy: they stay on the phone
        }
        // Another crash may have been written while this was sending; only what went is taken off.
        const sent = new Set(crashes.map((r) => `${r.at}|${r.message}`));
        const left = readPending(crashStore.read()).filter((r) => !sent.has(`${r.at}|${r.message}`));
        if (left.length) crashStore.write(writePending(left));
        else crashStore.clear();
      }

      while (queue.length) {
        const batch = queue.splice(0, PER_REQUEST);
        try {
          await send(batch);
        } catch (error) {
          if (turnedDown(error)) continue;
          queue = [...batch, ...queue].slice(-MAX_PER_LAUNCH);
          return;
        }
      }
    } catch {
      // Storage or identity failed: try again next time.
    } finally {
      sending = null;
    }
  })();
  return sending;
}
