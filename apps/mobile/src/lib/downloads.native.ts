import NetInfo, { type NetInfoState, NetInfoStateType } from '@react-native-community/netinfo';
import * as Device from 'expo-device';
import { Directory, DownloadTask, File, Paths, type DownloadPauseState } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import { api, ApiError } from './api';
import { DownloadManager, type FileStore, type Net, type Snapshot, type Transfer, type TransferFailure } from './downloads-core';
import './network'; // configures NetInfo before anything listens to it

export type { CourseInfo, Item, Quality, Snapshot } from './downloads-core';
export { sizeLabel } from './downloads-core';

export const downloadsSupported = true;

/**
 * Where the files go. On an iPhone, the Caches folder: iCloud doesn't back it up (Apple's rule for anything that can
 * be downloaded again), though iOS may empty it when the phone is nearly full, and the app then says so. On Android,
 * the app's own files, which the system never clears and the backup rules leave out (expo-secure-store's, in app.json).
 * The list of what's saved lives with the app's documents either way, so it outlives a clear-out and can say what went.
 */
const folder = () => new Directory(Platform.OS === 'ios' ? Paths.cache : Paths.document, 'downloads');
const manifestFile = () => new File(Paths.document, 'embodha-downloads.json');
const spareFile = () => new File(Paths.document, 'embodha-downloads.json.new');

function inFolder(name: string) {
  return new File(folder(), name);
}

const files: FileStore = {
  readManifest() {
    for (const f of [manifestFile(), spareFile()]) {
      try {
        if (f.exists) return f.textSync();
      } catch {
        // try the other
      }
    }
    return null;
  },
  writeManifest(text) {
    // Written beside the old one and moved over it, so the app closing mid-write can't leave half a list.
    const next = spareFile();
    if (!next.exists) next.create();
    next.writeSync(text);
    next.moveSync(manifestFile(), { overwrite: true });
  },
  list() {
    const dir = folder();
    return dir.exists ? dir.list().flatMap((entry) => (entry instanceof File ? [entry.name] : [])) : [];
  },
  size(name) {
    const f = inFolder(name);
    return f.exists ? f.size : null;
  },
  remove(name) {
    const f = inFolder(name);
    if (f.exists) f.delete();
  },
  uri: (name) => inFolder(name).uri,
  freeBytes() {
    try {
      return Paths.availableDiskSpace;
    } catch {
      return null;
    }
  },
  download: (job) => transfer(job),
};

/** The file host's HTTP status in expo-file-system's error ("HTTP 403" on Android, "...returned HTTP 403" on iOS). */
function statusIn(message: string): number | undefined {
  const found = /\b(?:HTTP|status)\s+(\d{3})\b/i.exec(message);
  return found ? Number(found[1]) : undefined;
}

function transfer(job: Parameters<FileStore['download']>[0]): Transfer {
  const dir = folder();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const destination = inFolder(job.name);
  const options = {
    sessionType: job.background ? ('background' as const) : ('foreground' as const),
    onProgress: ({ bytesWritten, totalBytes }: { bytesWritten: number; totalBytes: number }) => job.onProgress(bytesWritten, totalBytes),
  };
  const saved = job.resume as DownloadPauseState | null;
  // Android carries on with a range request from the bytes already in the file, so they must still be there; an
  // iPhone keeps them itself, inside the resume data.
  const canResume =
    Boolean(saved?.resumeData) && (Platform.OS === 'ios' || (destination.exists && destination.size >= Number(saved!.resumeData)));
  const task = canResume ? DownloadTask.fromSavable({ ...saved!, url: job.url, fileUri: destination.uri, isDirectory: false }, options) : File.createDownloadTask(job.url, destination, options);
  if (!canResume && destination.exists) destination.delete();

  const result = (async () => {
    try {
      const file = canResume ? await task.resumeAsync() : await task.downloadAsync();
      if (file) return { kind: 'done' as const };
      return { kind: 'paused' as const, resume: task.savable() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = new Error(message) as TransferFailure;
      failure.status = statusIn(message);
      // A dropped connection on Android: what reached the file can be carried on from.
      if (failure.status === undefined && Platform.OS === 'android' && destination.exists && destination.size > 0) {
        failure.resume = { url: job.url, fileUri: destination.uri, isDirectory: false, resumeData: String(destination.size) } satisfies DownloadPauseState;
      }
      throw failure;
    } finally {
      task.release();
    }
  })();
  return {
    result,
    pause() {
      try {
        task.pause();
      } catch {
        // not running any more
      }
    },
    cancel() {
      task.cancel();
    },
  };
}

function toNet(state: NetInfoState): Net {
  // Wi-Fi from another phone's hotspot is someone's data plan: Android says so, and it counts as mobile data.
  const unmetered = state.type === NetInfoStateType.wifi || state.type === NetInfoStateType.ethernet;
  const expensive = Boolean((state.details as { isConnectionExpensive?: boolean } | null)?.isConnectionExpensive);
  return { connected: state.isConnected !== false, wifi: unmetered && !expensive };
}

const randomId = () => {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  let id = '';
  for (let i = 0; i < 32; i++) id += Math.floor(Math.random() * 16).toString(16);
  return id;
};

export const downloads = new DownloadManager({
  platform: Platform.OS === 'ios' ? 'ios' : 'android',
  label: Device.modelName ?? null,
  files,
  api,
  problemOf: (error) => (error instanceof ApiError ? { status: error.status, code: error.code, message: error.message } : null),
  network: async () => toNet(await NetInfo.fetch()),
  onNetwork: (listener) => NetInfo.addEventListener((state) => listener(toNet(state))),
  randomId,
});

let started = false;
/** Once, from the root layout: the network, the app going to and from the background, and last time's leftovers. */
export function startDownloads(): void {
  if (started) return;
  started = true;
  void downloads.start();
  AppState.addEventListener('change', (next) => {
    if (next === 'active') downloads.foreground();
    else if (next === 'background') downloads.backgrounded();
  });
}

export function useDownloads(): Snapshot {
  return useSyncExternalStore(downloads.subscribe, downloads.getSnapshot, downloads.getSnapshot);
}
