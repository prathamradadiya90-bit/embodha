import type { CourseInfo, ChapterInfo, Item, Quality, Snapshot } from './downloads-core';

export type { CourseInfo, Item, Quality, Snapshot } from './downloads-core';
export { sizeLabel } from './downloads-core';

/** The web app streams only: a browser has nowhere safe to keep a course. The phone apps use downloads.native.ts. */
export const downloadsSupported = false;

const EMPTY: Snapshot = {
  ready: true,
  signedIn: false,
  deviceId: '',
  items: [],
  byChapter: {},
  courses: {},
  quality: 'standard',
  mobileData: false,
  paused: false,
  block: null,
  notices: [],
  waiting: null,
  online: true,
  usedBytes: 0,
  freeBytes: null,
  checkedAt: null,
};

const nothing = async () => undefined;

export const downloads = {
  getSnapshot: () => EMPTY,
  subscribe: () => () => undefined,
  playable: (_chapterId: string): { uri: string; item: Item; course: CourseInfo | null } | null => null,
  saved: (_chapterId: string): { uri: string; item: Item; course: CourseInfo | null } | null => null,
  start: nothing,
  setUser: (_userId: string | null) => nothing(),
  foreground: () => undefined,
  backgrounded: () => undefined,
  forget: nothing,
  wipe: nothing,
  add: (_chapters: ChapterInfo[], _course: CourseInfo) => undefined,
  retry: (_chapterId?: string) => undefined,
  remove: (_chapterId: string) => nothing(),
  removeCourse: (_courseId: string) => nothing(),
  removeAll: nothing,
  pause: () => undefined,
  resume: () => undefined,
  setQuality: (_quality: Quality) => undefined,
  setMobileData: (_on: boolean) => undefined,
  unblock: () => undefined,
  dismiss: (_noticeId: string) => undefined,
  savePosition: (_chapterId: string, _seconds: number) => undefined,
  checkIn: (_force?: boolean) => nothing(),
};

export function startDownloads(): void {}

export function useDownloads(): Snapshot {
  return EMPTY;
}
