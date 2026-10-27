/**
 * Offline downloads on the phone: a queue that saves one chapter at a time, the list of what's saved, and the
 * check-ins that keep it playing. It's written against small interfaces (the files, the network, the API), so the
 * same code runs in the app, where downloads.native.ts wires it to expo-file-system and NetInfo, and in plain Node
 * for the tests.
 *
 * The rules, so the member is never surprised:
 * - Only one chapter saves at a time, in the order asked for, and only on Wi-Fi unless they allow mobile data.
 * - Every chapter is cleared with the server before it saves (a course they have, and a free place among their
 *   phones), and the link it gets lasts a few hours, so a paused download asks again.
 * - A saved chapter plays offline until the date the server gave. Each check-in moves that on, and says which to
 *   delete because access ended. Without a check-in the files stay, but don't play, until the phone is online again.
 * - The phone's storage is never filled to the brim: KEEP_FREE_BYTES always stay free.
 */

export type Quality = 'standard' | 'high';
export type ItemState = 'queued' | 'downloading' | 'paused' | 'done' | 'failed';

/** Why a download stopped for good, until the member tries again. */
export interface Problem {
  code: 'locked' | 'not_downloadable' | 'not_found' | 'missing' | 'failed';
  message: string;
}

export interface ChapterInfo {
  id: string;
  title: string;
  type: 'video' | 'audio';
  durationS: number | null;
}

export interface CourseInfo {
  id: string;
  slug: string;
  title: string;
  instructor: string | null;
  /** Every chapter of the course in order, downloaded or not, so offline the player knows what comes next. */
  chapters: ChapterInfo[];
}

export interface Item {
  chapterId: string;
  courseId: string;
  title: string;
  type: 'video' | 'audio';
  durationS: number | null;
  state: ItemState;
  /** The server has agreed to it. Only these go into a check-in. */
  registered: boolean;
  quality: Quality;
  height: number | null;
  /** The file's name in the downloads folder. Each attempt gets a new one. */
  file: string | null;
  /** Bytes saved so far; the full size once the server has said it. */
  written: number;
  total: number | null;
  /** The server's estimate, until the real size is known. */
  estimatedBytes: number | null;
  problem: Problem | null;
  /** Plays offline until then. */
  keepUntil: string | null;
  addedAt: string;
  doneAt: string | null;
  /** What the platform needs to carry on a paused download from where it stopped. */
  resume: unknown;
  attempt: number;
  /** Times in a row the file host turned the link down. */
  refusals: number;
  /** Where the member got to, kept on the phone for playing offline. */
  position: { s: number; at: string } | null;
}

/** Something that stops the whole queue until the member does something about it. */
export interface Block {
  code: 'device_limit' | 'space';
  message: string;
}

export interface Notice {
  id: string;
  text: string;
  at: string;
}

export interface Manifest {
  version: 1;
  /** A random ID for this phone's downloads, made again after every sign-out. The server counts phones by it. */
  deviceId: string;
  userId: string | null;
  quality: Quality;
  mobileData: boolean;
  /** The member pressed pause. */
  paused: boolean;
  block: Block | null;
  /** In the order they were asked for. */
  items: Item[];
  courses: Record<string, CourseInfo>;
  checkedAt: string | null;
  notices: Notice[];
}

export interface Net {
  connected: boolean;
  /** Wi-Fi or a cable: a connection that doesn't use up a data plan. */
  wifi: boolean;
}

export type TransferResult = { kind: 'done' } | { kind: 'paused'; resume: unknown };

export interface Transfer {
  result: Promise<TransferResult>;
  /** Stops it with what's saved so far kept; `result` resolves as paused. */
  pause(): void;
  /** Stops it for good; `result` rejects. */
  cancel(): void;
}

/**
 * How a transfer failed, as the files adapter reports it: the file host's HTTP status when it answered, and
 * anything that lets the next attempt carry on from the bytes already saved.
 */
export interface TransferFailure extends Error {
  status?: number;
  resume?: unknown;
}

export interface FileStore {
  readManifest(): string | null;
  writeManifest(text: string): void;
  /** File names in the downloads folder. */
  list(): string[];
  /** Null when there's no such file. */
  size(name: string): number | null;
  remove(name: string): void;
  /** What the player opens. */
  uri(name: string): string;
  /** Null when the phone won't say. */
  freeBytes(): number | null;
  download(job: { url: string; name: string; resume: unknown; background: boolean; onProgress: (written: number, total: number) => void }): Transfer;
}

/** What an error from the API said, or null when the request never got an answer (offline, or the server unreachable). */
export interface ApiProblem {
  status: number;
  code: string;
  message: string;
}

export interface DownloadDeps {
  platform: 'ios' | 'android';
  /** The phone's model, so the member can tell their phones apart. */
  label: string | null;
  files: FileStore;
  api: <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;
  problemOf: (error: unknown) => ApiProblem | null;
  network: () => Promise<Net>;
  onNetwork: (listener: (net: Net) => void) => () => void;
  randomId: () => string;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/** What screens read. A new object after every change, so React sees it. */
export interface Snapshot {
  ready: boolean;
  signedIn: boolean;
  deviceId: string;
  items: Item[];
  byChapter: Record<string, Item>;
  courses: Record<string, CourseInfo>;
  quality: Quality;
  mobileData: boolean;
  paused: boolean;
  block: Block | null;
  notices: Notice[];
  /** Why chapters in the queue aren't saving right now, or null when they are (or nothing is waiting). */
  waiting: 'paused' | 'blocked' | 'offline' | 'wifi' | 'background' | 'retrying' | null;
  /** The phone has a connection, as far as it knows. */
  online: boolean;
  usedBytes: number;
  freeBytes: number | null;
  checkedAt: string | null;
}

/** The answer to POST /v1/downloads. */
interface Offer {
  chapterId: string;
  url: string;
  expiresAt: string | null;
  kind: 'video' | 'audio';
  height: number | null;
  extension: string;
  estimatedBytes: number | null;
  keepUntil: string;
  chapter: ChapterInfo;
  course: CourseInfo;
}

type Verdict = { chapterId: string; keep: true; keepUntil: string } | { chapterId: string; keep: false; reason: 'gone' | 'subscription_ended' | 'access_ended' | 'replaced' | 'device_removed' };

/** Always left free on the phone, so a full course never fills it to the point other apps misbehave. */
export const KEEP_FREE_BYTES = 300_000_000;
/** Room asked for on top of the server's estimate, since a video can come out bigger than its bitrate says. */
const HEADROOM = 1.2;
/** How often the phone checks in while it's online: often enough that a refund or a lapsed subscription shows soon. */
export const CHECK_EVERY_MS = 6 * 3600_000;
const FIRST_RETRY_MS = 30_000;
const LONGEST_RETRY_MS = 10 * 60_000;

const MISSING: Problem = { code: 'missing', message: 'Not on this phone any more. Download it again.' };

/** "640 MB", "1.2 GB": decimal units, the way phones count their storage. */
export function sizeLabel(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 10e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(0.1, bytes / 1e6).toFixed(1)} MB`;
}

const chapterWord = (n: number) => (n === 1 ? 'chapter' : 'chapters');

export class DownloadManager {
  private readonly deps: DownloadDeps;
  private m: Manifest;
  private snap: Snapshot;
  private readonly listeners = new Set<() => void>();
  private net: Net = { connected: true, wifi: true };
  private started = false;
  private background = false;
  private active: { item: Item; transfer: Transfer; stopping: 'pause' | 'remove' | null } | null = null;
  private pumping: Promise<void> | null = null;
  private checking: Promise<void> | null = null;
  private coolUntil = 0;
  private retryDelay = FIRST_RETRY_MS;
  private retryTimer: unknown = null;
  private checkTimer: unknown = null;
  private lastEmit = 0;
  private emitTimer: unknown = null;
  private lastSave = 0;
  private stopNetwork: (() => void) | null = null;

  constructor(deps: DownloadDeps) {
    this.deps = deps;
    this.m = this.load();
    this.snap = this.snapshotNow();
  }

  /* ---------------------------------------------------------------- Reading */

  getSnapshot = (): Snapshot => this.snap;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** A saved chapter that may play offline now: finished, still on the phone, and inside its keep date. */
  playable(chapterId: string): { uri: string; item: Item; course: CourseInfo | null } | null {
    const found = this.saved(chapterId);
    if (!found || !found.item.keepUntil || Date.parse(found.item.keepUntil) <= this.now()) return null;
    return found;
  }

  /**
   * A saved chapter, whatever its keep date. Online, after the server has said the member may play it, the player
   * uses the saved file rather than streaming.
   */
  saved(chapterId: string): { uri: string; item: Item; course: CourseInfo | null } | null {
    const item = this.find(chapterId);
    if (!item || item.state !== 'done' || !item.file || this.deps.files.size(item.file) === null) return null;
    return { uri: this.deps.files.uri(item.file), item, course: this.m.courses[item.courseId] ?? null };
  }

  /* ---------------------------------------------------------------- Life cycle */

  /** Once, when the app starts: listens to the network and sets things straight after the app was last closed. */
  async start(): Promise<void> {
    if (this.stopNetwork) return;
    this.stopNetwork = this.deps.onNetwork((net) => this.networkChanged(net));
    this.net = await this.deps.network().catch(() => this.net);
    this.reconcile();
  }

  /**
   * Who is signed in, once the app knows; null when nobody is. Downloads belong to one member: when someone else
   * signs in, or nobody is, the phone's downloads are deleted.
   */
  async setUser(userId: string | null): Promise<void> {
    if (!userId || (this.m.userId && this.m.userId !== userId)) {
      if (this.m.items.length || this.m.userId) await this.wipe();
    }
    if (userId && this.m.userId !== userId) {
      this.m.userId = userId;
      this.save(true);
    }
    this.started = true;
    this.emit(true);
    if (userId) {
      void this.pump();
      void this.checkIn();
    }
  }

  foreground(): void {
    this.background = false;
    this.reconcile();
    void this.pump();
    void this.checkIn();
  }

  backgrounded(): void {
    this.background = true;
    this.enforce();
    this.save(true);
  }

  /** Signing out on purpose: the server frees this phone's place first, then everything here is deleted. */
  async forget(): Promise<void> {
    if (this.m.userId) await this.deps.api(`/v1/downloads/devices/${this.m.deviceId}`, { method: 'DELETE' }).catch(() => undefined);
    await this.wipe();
  }

  /** Deletes every download and starts afresh, with a new ID for the phone. */
  async wipe(): Promise<void> {
    this.stopActive('remove');
    for (const name of this.deps.files.list()) this.deps.files.remove(name);
    const settings = { quality: this.m.quality, mobileData: this.m.mobileData };
    this.m = { ...this.fresh(), ...settings };
    this.coolUntil = 0;
    this.save(true);
    this.emit(true);
  }

  /* ---------------------------------------------------------------- What the member does */

  /** Adds chapters to the end of the queue. Ones already saved or saving are left as they are; failed ones try again. */
  add(chapters: ChapterInfo[], course: CourseInfo): void {
    if (!this.m.userId) return;
    this.m.courses[course.id] = { ...this.m.courses[course.id], ...course };
    for (const chapter of chapters) {
      const existing = this.find(chapter.id);
      if (existing && existing.state !== 'failed') continue;
      if (existing) this.m.items.splice(this.m.items.indexOf(existing), 1);
      this.m.items.push({
        chapterId: chapter.id,
        courseId: course.id,
        title: chapter.title,
        type: chapter.type,
        durationS: chapter.durationS,
        state: 'queued',
        registered: existing?.registered ?? false,
        quality: this.m.quality,
        height: null,
        file: null,
        written: 0,
        total: null,
        estimatedBytes: null,
        problem: null,
        keepUntil: null,
        addedAt: this.iso(),
        doneAt: null,
        resume: null,
        attempt: existing?.attempt ?? 0,
        refusals: 0,
        position: existing?.position ?? null,
      });
    }
    if (this.m.block?.code === 'space') this.m.block = null; // they're trying again; look at the space again
    this.save(true);
    this.emit(true);
    void this.pump();
  }

  retry(chapterId?: string): void {
    for (const item of this.m.items) {
      if (item.state === 'failed' && (!chapterId || item.chapterId === chapterId)) {
        item.state = 'queued';
        item.problem = null;
        item.refusals = 0;
      }
    }
    this.m.block = null;
    this.m.paused = false;
    this.coolUntil = 0;
    this.save(true);
    this.emit(true);
    void this.pump();
  }

  async remove(chapterId: string): Promise<void> {
    await this.removeWhere((item) => item.chapterId === chapterId);
  }

  async removeCourse(courseId: string): Promise<void> {
    await this.removeWhere((item) => item.courseId === courseId);
  }

  async removeAll(): Promise<void> {
    await this.removeWhere(() => true);
  }

  pause(): void {
    this.m.paused = true;
    this.enforce();
    this.save(true);
    this.emit(true);
  }

  resume(): void {
    this.retry();
  }

  setQuality(quality: Quality): void {
    this.m.quality = quality;
    // Chapters not started yet go at the new quality; saved ones stay as they are.
    for (const item of this.m.items) if (item.state === 'queued' && !item.written) item.quality = quality;
    this.save(true);
    this.emit(true);
  }

  setMobileData(on: boolean): void {
    this.m.mobileData = on;
    // On an iPhone this changes how the download runs (only one that may use mobile data carries on in the
    // background), so a download under way stops and picks up again the new way.
    if (this.active && this.deps.platform === 'ios') this.stopActive('pause');
    this.enforce();
    this.save(true);
    this.emit(true);
    void this.pump();
  }

  /** The member has freed a place on another phone, or looked at what's blocking: try again. */
  unblock(): void {
    this.retry();
  }

  dismiss(noticeId: string): void {
    this.m.notices = this.m.notices.filter((n) => n.id !== noticeId);
    this.save(true);
    this.emit(true);
  }

  /** Where the member is in a saved chapter, for picking up offline. The player calls it with each heartbeat. */
  savePosition(chapterId: string, seconds: number): void {
    const item = this.find(chapterId);
    if (!item) return;
    item.position = { s: Math.max(0, Math.floor(seconds)), at: this.iso() };
    this.save(true);
  }

  /* ---------------------------------------------------------------- Check-ins */

  /**
   * Tells the server what's on the phone and hears back what to keep (until when) and what to delete. At most every
   * six hours unless forced; offline it simply waits for next time.
   */
  checkIn(force = false): Promise<void> {
    if (!this.m.userId || !this.net.connected) return Promise.resolve();
    if (!force && this.m.checkedAt && this.now() - Date.parse(this.m.checkedAt) < CHECK_EVERY_MS) return Promise.resolve();
    this.checking ??= (async () => {
      const held = this.m.items.filter((item) => item.registered);
      const deviceId = this.m.deviceId;
      try {
        const answer = await this.deps.api<{ checkedAt: string; chapters: Verdict[] }>('/v1/downloads/check', {
          method: 'POST',
          body: { deviceId, platform: this.deps.platform, ...(this.deps.label ? { label: this.deps.label } : {}), chapterIds: held.map((item) => item.chapterId) },
        });
        if (this.m.deviceId !== deviceId) return; // wiped meanwhile
        this.apply(answer.chapters);
        this.m.checkedAt = this.iso();
        this.save(true);
        this.emit(true);
        void this.pump(); // a replaced chapter downloads again
      } catch {
        // Offline, or signed out: the files stay, and the next check-in sorts it out.
      }
    })().finally(() => {
      this.checking = null; // after the assignment above, so a finished check-in never stays in place
    });
    return this.checking;
  }

  private apply(verdicts: Verdict[]) {
    const dropped = new Map<string, { course: CourseInfo | undefined; reason: string; chapters: number }>();
    for (const verdict of verdicts) {
      const item = this.find(verdict.chapterId);
      if (!item) continue;
      if (verdict.keep) {
        item.keepUntil = verdict.keepUntil;
        continue;
      }
      if (verdict.reason === 'replaced') {
        // The instructor uploaded a new version: fetch it again, the same way it was asked for.
        if (this.active?.item === item) this.stopActive('remove');
        if (item.file) this.deps.files.remove(item.file);
        Object.assign(item, { state: 'queued', registered: false, file: null, written: 0, total: null, resume: null, problem: null, doneAt: null });
        continue;
      }
      if (verdict.reason === 'device_removed') {
        for (const other of [...this.m.items]) this.drop(other);
        this.pruneCourses();
        this.notify('This phone was taken off your list of phones with downloads, so its downloads have been deleted. Download again any time.');
        return;
      }
      const key = `${item.courseId}:${verdict.reason}`;
      const entry = dropped.get(key) ?? { course: this.m.courses[item.courseId], reason: verdict.reason, chapters: 0 };
      entry.chapters += 1;
      dropped.set(key, entry);
      this.drop(item);
    }
    for (const { course, reason, chapters } of dropped.values()) {
      const why =
        reason === 'subscription_ended'
          ? course?.instructor
            ? `Your subscription to ${course.instructor} has ended.`
            : 'The subscription it came with has ended.'
          : reason === 'gone'
            ? 'It has been taken down.'
            : "The course isn't in your library any more.";
      this.notify(`${course?.title ?? 'A course'}: ${chapters} downloaded ${chapterWord(chapters)} came off this phone. ${why}`);
    }
    this.pruneCourses();
  }

  /* ---------------------------------------------------------------- The queue */

  private canRun(): boolean {
    return Boolean(this.m.userId) && this.waitingReason() === null;
  }

  private waitingReason(): Snapshot['waiting'] {
    if (!this.m.userId) return null;
    if (this.m.paused) return 'paused';
    if (this.m.block) return 'blocked';
    if (!this.net.connected) return 'offline';
    if (!this.net.wifi && !this.m.mobileData) return 'wifi';
    if (this.background && this.deps.platform === 'ios' && !this.backgroundSession()) return 'background';
    if (this.now() < this.coolUntil) return 'retrying';
    return null;
  }

  /** iPhones only carry a download on in the background when it may use mobile data: Wi-Fi only can't be promised there. */
  private backgroundSession(): boolean {
    return this.deps.platform === 'ios' && this.m.mobileData;
  }

  private next(): Item | undefined {
    return this.m.items.find((item) => item.state === 'queued' || item.state === 'paused');
  }

  private pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    if (!this.started || !this.m.userId || !this.canRun() || !this.next()) return Promise.resolve();
    this.pumping = (async () => {
      while (this.m.userId && this.canRun()) {
        const item = this.next();
        if (!item) break;
        if (!(await this.saveOne(item))) break;
      }
    })().finally(() => {
      this.pumping = null; // after the assignment, even if the loop had nothing to do
      this.emit(true);
    });
    // Something may have changed while the last chapter finished: look again once this run is over.
    return this.pumping.then(() => (this.canRun() && this.next() ? this.pump() : undefined));
  }

  /** Saves one chapter. True to go on to the next; false to stop until something changes. */
  private async saveOne(item: Item): Promise<boolean> {
    const { files } = this.deps;
    if (!item.registered) item.quality = this.m.quality;
    const deviceId = this.m.deviceId;

    let offer: Offer;
    try {
      offer = await this.deps.api<Offer>('/v1/downloads', {
        method: 'POST',
        body: { deviceId, platform: this.deps.platform, ...(this.deps.label ? { label: this.deps.label } : {}), chapterId: item.chapterId, quality: item.quality },
      });
    } catch (error) {
      if (!this.has(item)) return true;
      const problem = this.deps.problemOf(error);
      if (!problem || problem.status === 401 || problem.status === 429 || problem.status >= 500) return this.cool();
      if (problem.status === 409 && problem.code === 'device_limit') {
        this.m.block = { code: 'device_limit', message: problem.message };
        this.save(true);
        this.emit(true);
        return false;
      }
      const code = problem.status === 402 ? 'locked' : problem.status === 404 ? 'not_found' : problem.code === 'not_downloadable' ? 'not_downloadable' : 'failed';
      this.fail(item, { code, message: problem.message });
      return true;
    }
    if (!this.has(item) || this.m.deviceId !== deviceId) return true; // removed while asking
    this.retryDelay = FIRST_RETRY_MS; // the server answered: whatever goes wrong next starts the waits again

    Object.assign(item, {
      registered: true,
      title: offer.chapter.title,
      type: offer.chapter.type,
      durationS: offer.chapter.durationS,
      courseId: offer.course.id,
      height: offer.height,
      estimatedBytes: offer.estimatedBytes,
      keepUntil: offer.keepUntil,
    });
    this.m.courses[offer.course.id] = offer.course;

    const free = files.freeBytes();
    const needed = Math.round((offer.estimatedBytes ?? 0) * HEADROOM) - (item.state === 'paused' ? item.written : 0) + KEEP_FREE_BYTES;
    if (free !== null && free < needed) {
      const size = offer.estimatedBytes ? `about ${sizeLabel(offer.estimatedBytes)}` : 'more room';
      this.m.block = {
        code: 'space',
        message: `There isn't room for ${item.title}. It needs ${size}, and the phone has ${sizeLabel(Math.max(0, free))} free. Embodha always leaves ${sizeLabel(KEEP_FREE_BYTES)} free so the phone keeps working. Clear some space, then try again.`,
      };
      this.save(true);
      this.emit(true);
      return false;
    }

    const resuming = item.state === 'paused' && Boolean(item.file) && item.resume != null;
    if (!resuming) {
      if (item.file) files.remove(item.file);
      item.attempt += 1;
      item.file = `${item.chapterId}-${item.attempt}.${offer.extension}`;
      item.written = 0;
      item.total = null;
    }
    item.state = 'downloading';
    item.problem = null;
    this.save(true);
    this.emit(true);

    const transfer = files.download({
      url: offer.url,
      name: item.file!,
      resume: resuming ? item.resume : null,
      background: this.backgroundSession(),
      onProgress: (written, total) => this.progress(item, written, total),
    });
    item.resume = null;
    const active = { item, transfer, stopping: null as 'pause' | 'remove' | null };
    this.active = active;
    try {
      const result = await transfer.result;
      if (this.active === active) this.active = null;
      if (!this.has(item) || active.stopping === 'remove') return true;
      if (result.kind === 'paused') {
        item.state = 'paused';
        item.resume = result.resume;
        this.save(true);
        this.emit(true);
        return false;
      }
      const size = files.size(item.file!);
      if (!size || (item.total && size < item.total)) {
        // Came out short: start it again from the beginning, after a pause.
        files.remove(item.file!);
        Object.assign(item, { state: 'queued', file: null, written: 0, total: null });
        return this.cool();
      }
      Object.assign(item, { state: 'done', written: size, total: size, doneAt: this.iso(), refusals: 0 });
      this.retryDelay = FIRST_RETRY_MS;
      this.save(true);
      this.emit(true);
      return true;
    } catch (error) {
      if (this.active === active) this.active = null;
      if (!this.has(item) || active.stopping === 'remove') {
        if (item.file) files.remove(item.file);
        return true;
      }
      const failure = error as TransferFailure;
      const status = typeof failure.status === 'number' ? failure.status : null;
      if (status === 401 || status === 403 || status === 410) {
        // The link ran out, or the host turned it down: once is a link that expired, so start again with a new one.
        item.refusals += 1;
        if (item.file) files.remove(item.file);
        Object.assign(item, { state: 'queued', file: null, written: 0, total: null });
        if (item.refusals >= 2) this.fail(item, { code: 'failed', message: "The download didn't go through. Try again in a while." });
        else this.save(true);
        return true;
      }
      if (status === 404) {
        if (item.file) files.remove(item.file);
        this.fail(item, { code: 'not_downloadable', message: "This chapter can't be downloaded yet. It still plays here as usual." });
        return true;
      }
      if (status !== null && status >= 400 && status < 500) {
        if (item.file) files.remove(item.file);
        this.fail(item, { code: 'failed', message: `The download didn't go through (the host said ${status}). Try again in a while.` });
        return true;
      }
      // The connection dropped, or the host was having trouble: keep what's saved, and carry on later.
      if (failure.resume != null && item.file) {
        item.state = 'paused';
        item.resume = failure.resume;
      } else {
        if (item.file) files.remove(item.file);
        Object.assign(item, { state: 'queued', file: null, written: 0, total: null });
      }
      this.save(true);
      this.emit(true);
      return this.net.connected ? this.cool() : false;
    }
  }

  private progress(item: Item, written: number, total: number) {
    item.written = written;
    if (total > 0) item.total = total;
    this.emit();
    this.save();
  }

  /** Waits before trying again, longer each time, so a server that's down isn't asked every second. */
  private cool(): false {
    this.coolUntil = this.now() + this.retryDelay;
    const wait = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, LONGEST_RETRY_MS);
    if (this.retryTimer) this.clearTimer(this.retryTimer);
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      this.coolUntil = 0;
      void this.pump();
    }, wait);
    this.emit(true);
    return false;
  }

  /** Stops a download that may no longer run: paused by the member, off Wi-Fi, or an iPhone gone to the background. */
  private enforce() {
    if (this.active && !this.active.stopping && !this.canRun()) this.stopActive('pause');
  }

  private stopActive(how: 'pause' | 'remove') {
    const active = this.active;
    if (!active) return;
    active.stopping = how;
    if (how === 'pause') active.transfer.pause();
    else active.transfer.cancel();
  }

  private networkChanged(net: Net) {
    const back = net.connected && !this.net.connected;
    this.net = net;
    this.enforce();
    if (back) this.coolUntil = 0;
    this.emit(true);
    void this.pump();
    if (back) void this.checkIn();
  }

  /**
   * After the app was closed, or the phone tidied up its storage: a download that was under way starts again (or
   * is kept, if it finished while the app was away), a saved chapter whose file has gone says so, and files nothing
   * refers to are deleted.
   */
  private reconcile() {
    const { files } = this.deps;
    for (const item of this.m.items) {
      if (this.active?.item === item) continue;
      const size = item.file ? files.size(item.file) : null;
      if (item.state === 'downloading') {
        if (size && item.total && size >= item.total) Object.assign(item, { state: 'done', written: size, total: size, doneAt: this.iso() });
        else {
          if (item.file) files.remove(item.file);
          Object.assign(item, { state: 'queued', file: null, written: 0, total: null, resume: null });
        }
      } else if (item.state === 'done' && !size) {
        Object.assign(item, { state: 'failed', file: null, written: 0, problem: MISSING });
      } else if (item.state === 'paused' && !size && item.resume == null) {
        // Nothing to carry on from (an iPhone keeps a paused download's bytes itself, with the resume data).
        Object.assign(item, { state: 'queued', file: null, written: 0, total: null, resume: null });
      }
    }
    const referred = new Set(this.m.items.map((item) => item.file).filter(Boolean));
    for (const name of files.list()) if (!referred.has(name)) files.remove(name);
    this.save(true);
    this.emit(true);
  }

  /* ---------------------------------------------------------------- Plumbing */

  private async removeWhere(match: (item: Item) => boolean) {
    const gone = this.m.items.filter(match);
    if (!gone.length) return;
    for (const item of gone) this.drop(item);
    this.pruneCourses();
    this.save(true);
    this.emit(true);
    void this.pump();
    // The server forgets them too; a phone left with none frees its place.
    if (this.checkTimer) this.clearTimer(this.checkTimer);
    this.checkTimer = this.setTimer(() => {
      this.checkTimer = null;
      void this.checkIn(true);
    }, 1500);
  }

  /** Deletes one download, file and all. */
  private drop(item: Item) {
    if (this.active?.item === item) this.stopActive('remove');
    if (item.file) this.deps.files.remove(item.file);
    this.m.items = this.m.items.filter((i) => i !== item);
  }

  private fail(item: Item, problem: Problem) {
    Object.assign(item, { state: 'failed', problem, resume: null });
    this.save(true);
    this.emit(true);
  }

  private notify(text: string) {
    this.m.notices = [{ id: this.deps.randomId(), text, at: this.iso() }, ...this.m.notices].slice(0, 10);
  }

  private pruneCourses() {
    const used = new Set(this.m.items.map((item) => item.courseId));
    for (const id of Object.keys(this.m.courses)) if (!used.has(id)) delete this.m.courses[id];
  }

  private find(chapterId: string) {
    return this.m.items.find((item) => item.chapterId === chapterId);
  }

  private has(item: Item) {
    return this.m.items.includes(item);
  }

  private fresh(): Manifest {
    return { version: 1, deviceId: this.deps.randomId(), userId: null, quality: 'standard', mobileData: false, paused: false, block: null, items: [], courses: {}, checkedAt: null, notices: [] };
  }

  private load(): Manifest {
    try {
      const text = this.deps.files.readManifest();
      const saved = text ? (JSON.parse(text) as Manifest) : null;
      if (saved?.version === 1 && typeof saved.deviceId === 'string' && Array.isArray(saved.items)) return saved;
    } catch {
      // unreadable: start again
    }
    return this.fresh();
  }

  /** To disk at once for changes that matter, and at most every few seconds for progress and places. */
  private save(now = false) {
    if (!now && this.now() - this.lastSave < 3000) return;
    this.lastSave = this.now();
    try {
      this.deps.files.writeManifest(JSON.stringify(this.m));
    } catch {
      // A full disk: the next save tries again.
    }
  }

  private emit(now = false) {
    if (!now && this.now() - this.lastEmit < 250) {
      this.emitTimer ??= this.setTimer(() => {
        this.emitTimer = null;
        this.emit(true);
      }, 250);
      return;
    }
    this.lastEmit = this.now();
    this.snap = this.snapshotNow();
    for (const listener of [...this.listeners]) listener();
  }

  private snapshotNow(): Snapshot {
    const items = this.m.items.map((item) => ({ ...item }));
    const hasWork = items.some((item) => item.state === 'queued' || item.state === 'paused' || item.state === 'downloading');
    return {
      ready: this.started,
      signedIn: Boolean(this.m.userId),
      deviceId: this.m.deviceId,
      items,
      byChapter: Object.fromEntries(items.map((item) => [item.chapterId, item])),
      courses: { ...this.m.courses },
      quality: this.m.quality,
      mobileData: this.m.mobileData,
      paused: this.m.paused,
      block: this.m.block,
      notices: this.m.notices,
      waiting: hasWork ? this.waitingReason() : null,
      online: this.net.connected,
      usedBytes: items.reduce((sum, item) => sum + (item.state === 'done' ? item.written : 0), 0),
      freeBytes: this.deps.files.freeBytes(),
      checkedAt: this.m.checkedAt,
    };
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  private iso() {
    return new Date(this.now()).toISOString();
  }

  private setTimer(run: () => void, ms: number) {
    return (this.deps.setTimer ?? ((fn: () => void, wait: number) => setTimeout(fn, wait)))(run, ms);
  }

  private clearTimer(timer: unknown) {
    (this.deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>)))(timer);
  }
}
