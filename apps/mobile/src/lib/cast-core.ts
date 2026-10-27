/**
 * Playing a chapter on a TV with Chromecast, without the Cast SDK in it: what the TV is told to play, trying the
 * other HLS segment format when the TV can't read the first, turning the TV's progress into the same heartbeats the
 * phone's own player sends, and keeping track of the connection for the screens. cast.native.ts plugs in
 * react-native-google-cast; the tests plug in a pretend TV.
 *
 * The TV plays Google's Default Media Receiver, so nothing has to be registered with Google. It fetches the same
 * signed link the phone streams from: a downloaded chapter is cast from the stream, never from the phone's file.
 *
 * Only the phone watches the TV. A phone in the background still hears when the TV pauses, finishes or stops (on
 * Android; iOS stops the app), and when the app comes back the TV's position says how far it got meanwhile. A TV
 * switched off while nobody was looking takes that stretch with it.
 */

export interface Castable {
  chapterId: string;
  type: 'video' | 'audio';
  title: string;
  course: { slug: string; title: string };
  durationS: number | null;
  /** The signed link the TV fetches. Null offline, when there's nothing it could fetch. */
  streamUrl: string | null;
  thumbnailUrl: string | null;
}

/** The parts of a Cast load request the app uses, in the Cast SDK's own shape and values. */
export interface CastRequest {
  autoplay: boolean;
  startTime: number;
  mediaInfo: {
    /** The chapter's ID: receivers load contentUrl when it's given, and keep contentId as the item's own ID. */
    contentId: string;
    contentUrl: string;
    contentType: string;
    streamType: 'buffered';
    streamDuration?: number;
    hlsSegmentFormat?: 'TS' | 'FMP4';
    hlsVideoSegmentFormat?: 'MPEG2-TS' | 'FMP4';
    metadata: {
      type: 'movie' | 'musicTrack';
      title: string;
      subtitle?: string;
      albumTitle?: string;
      artist?: string;
      images: { url: string }[];
    };
    /** Read back from the TV's status: which chapter it is, and which phone sent it (a random tag, nothing more). */
    customData: { chapterId: string; courseSlug: string; sender: string };
  };
}

export type TvState = 'idle' | 'loading' | 'buffering' | 'playing' | 'paused';
export type IdleReason = 'cancelled' | 'error' | 'finished' | 'interrupted';

export interface CastClient {
  loadMedia(request: CastRequest): Promise<void>;
}

const isHls = (url: string) => /\.m3u8(?:[?#]|$)/i.test(url);

export function contentTypeOf(url: string, type: 'video' | 'audio'): string {
  if (isHls(url)) return 'application/x-mpegURL';
  const ext = /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  if (ext === 'webm') return type === 'audio' ? 'audio/webm' : 'video/webm';
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'm4a' || type === 'audio') return 'audio/mp4';
  return 'video/mp4';
}

/**
 * The load request for a chapter, starting where the member is. Bunny's HLS comes in MPEG-TS segments, which the
 * receiver reads without being told; `segments: 'fmp4'` is the second try, for a library that makes fMP4.
 */
export function castRequest(chapter: Castable, startS: number, segments: 'ts' | 'fmp4' = 'ts', sender = ''): CastRequest {
  if (!chapter.streamUrl) throw new Error('This chapter has no stream to cast.');
  const images = chapter.thumbnailUrl ? [{ url: chapter.thumbnailUrl }] : [];
  return {
    autoplay: true,
    startTime: Math.max(0, Math.floor(startS)),
    mediaInfo: {
      contentId: chapter.chapterId,
      contentUrl: chapter.streamUrl,
      contentType: contentTypeOf(chapter.streamUrl, chapter.type),
      streamType: 'buffered',
      ...(chapter.durationS ? { streamDuration: chapter.durationS } : {}),
      ...(segments === 'fmp4' && isHls(chapter.streamUrl) ? { hlsSegmentFormat: 'FMP4' as const, hlsVideoSegmentFormat: 'FMP4' as const } : {}),
      // A video is a film to the receiver; audio is a track, which gets a music-style screen with the artwork.
      metadata:
        chapter.type === 'video'
          ? { type: 'movie', title: chapter.title, subtitle: chapter.course.title, images }
          : { type: 'musicTrack', title: chapter.title, albumTitle: chapter.course.title, artist: 'Embodha', images },
      customData: { chapterId: chapter.chapterId, courseSlug: chapter.course.slug, sender },
    },
  };
}

export type LoadOutcome = { result: 'sent' } | { result: 'failed'; error: string } | { result: 'superseded' };

/**
 * Sends chapters to the TV. When the TV turns an HLS stream down, it asks once more saying the segments are fMP4,
 * and only then gives up. A chapter sent while another was still loading wins: the first one's failure, which is
 * usually just the TV saying it was replaced, isn't retried.
 */
export class CastLoader {
  private seq = 0;

  async play(client: CastClient, chapter: Castable, startS: number, sender = ''): Promise<LoadOutcome> {
    const seq = ++this.seq;
    const tries: ('ts' | 'fmp4')[] = chapter.streamUrl && isHls(chapter.streamUrl) ? ['ts', 'fmp4'] : ['ts'];
    let error = '';
    for (const segments of tries) {
      try {
        await client.loadMedia(castRequest(chapter, startS, segments, sender));
        return seq === this.seq ? { result: 'sent' } : { result: 'superseded' };
      } catch (reason) {
        if (seq !== this.seq) return { result: 'superseded' };
        error = reason instanceof Error ? reason.message : String(reason ?? '');
      }
    }
    return { result: 'failed', error };
  }
}

export interface Beat {
  chapterId: string;
  positionS: number;
  seconds: number;
  at: string;
}

export interface TrackerDeps {
  addBeat(beat: Beat): void;
  sendBeats(): Promise<unknown>;
  /** The chapter played to its end on the TV. */
  complete(chapterId: string): void;
  now?: () => number;
}

const BEAT_EVERY_MS = 30_000;
/** The most a single heartbeat may carry; the server turns down more. */
const MOST_PER_BEAT_S = 120;

/**
 * The TV's progress as heartbeats: one every 30 seconds while a chapter is on the TV, with how far it got and how
 * long it actually played, and a last one when the chapter changes, finishes or the session ends.
 *
 * Between two readings, the TV played as far as its position moved, but never longer than the clock says passed:
 * skipping ahead isn't practice, and nor is moving while paused. Readings come about once a second while the app is
 * open, and with every change the TV reports. After the phone has been asleep, the first reading makes up the time
 * in between, and goes up as several beats spread over it, as the phone would have sent them.
 */
export class CastTracker {
  private readonly deps: TrackerDeps;
  private chapterId: string | null = null;
  private position = 0;
  private playing = false;
  private readingAt = 0;
  private lastSentPosition = 0;
  private lastBeatAt = 0;
  private played = 0;
  private finished = new Set<string>();

  constructor(deps: TrackerDeps) {
    this.deps = deps;
  }

  /** A reading from the TV: which chapter, where it is, and whether it's playing. Null: nothing of ours is on. */
  progress(chapterId: string | null, positionS: number, playing: boolean): void {
    const now = this.now();
    if (chapterId !== this.chapterId) {
      this.flush();
      this.chapterId = chapterId;
      this.position = positionS;
      this.playing = playing;
      this.readingAt = now;
      this.lastSentPosition = Math.floor(positionS);
      this.played = 0;
      this.lastBeatAt = now;
      return;
    }
    if (!chapterId) return;
    const moved = positionS - this.position;
    // A TV that's playing moves. One that says it's playing and hasn't moved is repeating an old status (iOS does,
    // waking up), so it keeps the time of the reading before: otherwise it would swallow the stretch slept through.
    if (moved === 0 && playing && this.playing) return this.maybeBeat(now);
    const elapsed = Math.max(0, (now - this.readingAt) / 1000);
    if (this.playing || playing) this.played += Math.max(0, Math.min(moved, elapsed + 0.25));
    this.position = positionS;
    this.playing = playing;
    this.readingAt = now;
    this.maybeBeat(now);
  }

  /** The TV reached the end of a chapter. Counted once, however many statuses repeat it. */
  ended(chapterId: string): void {
    if (this.finished.has(chapterId)) return;
    this.finished.add(chapterId);
    if (chapterId === this.chapterId) this.flush();
    this.deps.complete(chapterId);
  }

  /** The session ended or the app is going to the background: what's been played goes up now. */
  flush(): void {
    this.beat();
  }

  /** Signed out: forget what was being counted, without sending it. */
  reset(): void {
    this.chapterId = null;
    this.played = 0;
  }

  private maybeBeat(now: number) {
    if (now - this.lastBeatAt >= BEAT_EVERY_MS) this.beat();
  }

  private beat() {
    if (!this.chapterId) return;
    const seconds = Math.max(0, Math.round(this.played));
    const position = Math.max(0, Math.floor(this.position));
    // Nothing new: no beat, and the next one still covers everything since the last that went.
    if (seconds === 0 && position === this.lastSentPosition) return;
    const now = this.now();
    const since = this.lastBeatAt;
    this.lastBeatAt = now;
    const parts = Math.max(1, Math.ceil(seconds / MOST_PER_BEAT_S));
    const each = Math.floor(seconds / parts);
    for (let i = 1; i <= parts; i++) {
      const last = i === parts;
      this.deps.addBeat({
        chapterId: this.chapterId,
        positionS: last ? position : Math.floor(this.lastSentPosition + ((position - this.lastSentPosition) * i) / parts),
        seconds: last ? seconds - each * (parts - 1) : each,
        at: new Date(last ? now : since + ((now - since) * i) / parts).toISOString(),
      });
    }
    this.played -= seconds;
    this.lastSentPosition = position;
    void this.deps.sendBeats();
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }
}

/* --------------------------------------------------------------------------------------------- The connection */

/** Where the phone stands with TVs. 'unavailable': casting can't work here (no Google Play services, say). */
export type Connection = 'unavailable' | 'noDevices' | 'notConnected' | 'connecting' | 'connected';

/** A status from the TV, in the app's terms. */
export interface MediaUpdate {
  /** The Embodha chapter on the TV; null for nothing, or for something that isn't ours. */
  chapterId: string | null;
  /** The tag of the phone that sent it. */
  sender: string | null;
  state: TvState | null;
  idleReason: IdleReason | null;
  positionS: number;
  durationS: number | null;
}

export interface RemoteMedia extends CastClient {
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(options: { position: number; relative?: boolean }): Promise<void>;
  /** Where the TV is now, worked out on the phone from its last status. Null with nothing loaded. */
  position(): Promise<number | null>;
  /** The last status the phone has, which can be old just after the app wakes. */
  status(): Promise<MediaUpdate | null>;
  /** Asks the TV for a fresh status, which arrives through onStatus. */
  requestStatus(): Promise<void>;
  onStatus(listener: (update: MediaUpdate | null) => void): () => void;
}

export type SessionEvent = 'started' | 'resumed' | 'suspended' | 'ended';

/** What a cast library has to offer. cast.native.ts makes one from react-native-google-cast. */
export interface CastPort {
  connection(): Promise<Connection>;
  onConnection(listener: (connection: Connection) => void): () => void;
  /** The TV the phone is connected to now, by name, or null. */
  session(): Promise<{ name: string | null } | null>;
  /** 'suspended': the phone lost touch for a while (iOS in the background); the TV carries on. */
  onSession(listener: (event: SessionEvent, device: { name: string | null } | null) => void): () => void;
  media: RemoteMedia;
  /** Leaves the TV, stopping what it plays. */
  endSession(): Promise<void>;
}

/** What the TV has on, when it's an Embodha chapter. */
export interface TvNow {
  chapterId: string;
  state: TvState;
  positionS: number;
  durationS: number | null;
  /** Played to its end. */
  finished: boolean;
}

export interface CastSnapshot {
  connection: Connection;
  /** The TV's name, like "Living room TV", while connected. */
  deviceName: string | null;
  /** Counts up with each new connection, so a screen can tell a new one from the same one coming back. */
  session: number;
  /** The phone has asked the TV what it has on since connecting. A screen waits for this before sending. */
  checked: boolean;
  tv: TvNow | null;
  /** The chapter being sent to the TV. */
  sending: string | null;
  /** The chapter the TV couldn't play. */
  failed: string | null;
}

export interface Timers {
  every(ms: number, run: () => void): () => void;
  after(ms: number, run: () => void): () => void;
}

const realTimers: Timers = {
  every(ms, run) {
    const id = setInterval(run, ms);
    return () => clearInterval(id);
  },
  after(ms, run) {
    const id = setTimeout(run, ms);
    return () => clearTimeout(id);
  },
};

export interface ControllerDeps {
  tracker: TrackerDeps;
  /** This install's tag for what it sends, so a phone counts only what it put on the TV. */
  sender(): Promise<string>;
  /** A chapter went to the TV (for analytics). */
  sent?(chapter: Castable, startS: number): void;
  /** The TV couldn't play a chapter (for analytics). */
  failed?(chapterId: string, type: 'video' | 'audio' | null, message: string): void;
  timers?: Timers;
  now?: () => number;
}

export const NOT_CASTING: CastSnapshot = { connection: 'unavailable', deviceName: null, session: 0, checked: false, tv: null, sending: null, failed: null };

/** How long a session that went quiet in the background may take to come back before it's taken as over. */
const RESUME_GRACE_MS = 10_000;
/**
 * Just after waking, the phone works the TV's position out from the status it had before it slept, which is right
 * only if nothing happened meanwhile. For this long, the count waits for what the TV itself reports.
 */
const SETTLE_MS = 3000;
/** The longest the phone waits for the TV to answer "what have you got on?". */
const ASK_MS = 2000;

/** Waits for a promise, or for ms, whichever comes first, and never fails. */
function within(promise: Promise<unknown>, ms: number, timers: Timers): Promise<void> {
  return new Promise((resolve) => {
    const stop = timers.after(ms, resolve);
    const done = () => {
      stop();
      resolve();
    };
    promise.then(done, done);
  });
}

/**
 * The phone's side of casting, for the whole app: whether there's a TV, what it has on, sending chapters and the
 * buttons, and counting what the TV plays. Screens read it through a snapshot, as with downloads.
 */
export class CastController {
  private snapshot: CastSnapshot = NOT_CASTING;
  private readonly listeners = new Set<() => void>();
  private readonly loader = new CastLoader();
  private readonly tracker: CastTracker;
  private readonly timers: Timers;
  private castState: Connection = 'unavailable';
  /** Whether the SDK has said anything yet, so the answers to the first questions don't overrule it. */
  private heardState = false;
  private heardSession = false;
  private connected = false;
  private suspended = false;
  private foreground = true;
  private tracking = false;
  private quietUntil = 0;
  /** The TV's chapter came from this phone, so it's this phone's to count. */
  private mine = false;
  private tag: string | null = null;
  private lastSent: { chapterId: string; type: 'video' | 'audio' } | null = null;
  private readonly durations = new Map<string, number | null>();
  private stopPolling: (() => void) | null = null;
  private stopGrace: (() => void) | null = null;
  private started = false;
  private readonly port: CastPort;
  private readonly deps: ControllerDeps;

  constructor(port: CastPort, deps: ControllerDeps) {
    this.port = port;
    this.deps = deps;
    this.tracker = new CastTracker({ ...deps.tracker, now: deps.tracker.now ?? deps.now });
    this.timers = deps.timers ?? realTimers;
  }

  getSnapshot = (): CastSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.deps.sender().then(
      (tag) => {
        this.tag = tag;
      },
      () => undefined,
    );
    this.port.onConnection((connection) => {
      this.heardState = true;
      this.connectionChanged(connection);
    });
    this.port.onSession((event, device) => {
      this.heardSession = true;
      this.sessionEvent(event, device);
    });
    this.port.media.onStatus((update) => this.statusChanged(update, true));
    this.port.connection().then(
      (connection) => {
        if (!this.heardState) this.connectionChanged(connection, false);
      },
      () => {
        if (!this.heardState) this.connectionChanged('unavailable', false);
      },
    );
    // Opened while already connected (the app was restarted mid-class, say).
    this.port.session().then(
      (device) => {
        if (device && !this.heardSession && !this.connected) this.sessionEvent('resumed', device);
      },
      () => undefined,
    );
  }

  /** Signed in: count what this phone puts on the TV. Signed out: stop, and drop what wasn't sent. */
  setTracking(on: boolean): void {
    if (on === this.tracking) return;
    this.tracking = on;
    if (!on) this.tracker.reset();
  }

  setForeground(active: boolean): void {
    if (active === this.foreground) return;
    this.foreground = active;
    if (!active) {
      this.pollStop();
      this.tracker.flush();
      return;
    }
    if (this.connected) void this.refresh(true);
    if (this.suspended) this.awaitResume();
    this.pollUpdate();
  }

  /** Puts a chapter on the TV, from startS seconds. False if it didn't go (no TV, nothing to stream, it failed). */
  async send(chapter: Castable, startS: number): Promise<boolean> {
    if (!this.connected || this.suspended || !chapter.streamUrl) return false;
    this.durations.set(chapter.chapterId, chapter.durationS);
    this.lastSent = { chapterId: chapter.chapterId, type: chapter.type };
    this.set({ sending: chapter.chapterId, failed: this.snapshot.failed === chapter.chapterId ? null : this.snapshot.failed });
    const tag = this.tag ?? (this.tag = await this.deps.sender().catch(() => ''));
    const outcome = await this.loader.play(this.port.media, chapter, startS, tag);
    if (outcome.result === 'superseded') return false;
    const sending = this.snapshot.sending === chapter.chapterId ? null : this.snapshot.sending;
    if (!this.connected) {
      this.set({ sending });
      return false;
    }
    if (outcome.result === 'failed') {
      this.set({ sending, failed: chapter.chapterId });
      this.deps.failed?.(chapter.chapterId, chapter.type, outcome.error);
      return false;
    }
    this.set({ sending });
    this.deps.sent?.(chapter, startS);
    return true;
  }

  play(): Promise<void> {
    return this.control((media) => media.play(), 'playing');
  }

  pause(): Promise<void> {
    return this.control((media) => media.pause(), 'paused');
  }

  seekBy(seconds: number): Promise<void> {
    return this.control((media) => media.seek({ position: seconds, relative: true }));
  }

  seekTo(positionS: number): Promise<void> {
    return this.control((media) => media.seek({ position: Math.max(0, positionS) }));
  }

  /** Stops the TV and leaves it. */
  async stop(): Promise<void> {
    if (!this.connected) return;
    await this.port.endSession().catch(() => undefined);
  }

  /* ------------------------------------------------------------------------------------------------- inside */

  private async control(action: (media: RemoteMedia) => Promise<void>, optimistic?: TvState) {
    if (!this.connected) return;
    // The button changes at once; the TV's own status follows a moment later and has the last word.
    const tv = this.snapshot.tv;
    if (optimistic && tv && tv.state !== 'idle') {
      this.set({ tv: { ...tv, state: optimistic } });
      this.pollUpdate();
    }
    await action(this.port.media).catch(() => undefined);
  }

  private connectionChanged(connection: Connection, live = true) {
    this.castState = connection;
    // A session that went without saying so. Not while suspended: iOS reports odd states on its way back.
    if (live && this.connected && !this.suspended && (connection === 'notConnected' || connection === 'noDevices' || connection === 'unavailable')) {
      this.ended();
      return;
    }
    this.set({});
  }

  private sessionEvent(event: SessionEvent, device: { name: string | null } | null) {
    if (event === 'ended') return this.ended();
    if (event === 'suspended') {
      if (!this.connected) return;
      this.suspended = true;
      this.pollStop();
      this.tracker.flush();
      if (this.foreground) this.awaitResume();
      this.set({});
      return;
    }
    const isNew = !this.connected;
    this.connected = true;
    this.suspended = false;
    this.stopGrace?.();
    this.stopGrace = null;
    this.set({
      deviceName: device?.name ?? this.snapshot.deviceName,
      session: isNew ? this.snapshot.session + 1 : this.snapshot.session,
      ...(isNew ? { checked: false } : {}),
    });
    void this.refresh(event === 'resumed');
  }

  private ended() {
    const wasConnected = this.connected;
    this.connected = false;
    this.suspended = false;
    // The SDK may not have caught up yet; it says so when it does.
    if (this.castState === 'connected') this.castState = 'notConnected';
    this.mine = false;
    this.stopGrace?.();
    this.stopGrace = null;
    this.pollStop();
    // The last beat for what was on, and nothing more for it.
    if (wasConnected) this.tracker.progress(null, 0, false);
    this.set({ deviceName: null, checked: false, tv: null, sending: null, failed: null });
  }

  /** Back in the foreground with the session still quiet: give it a moment, then ask whether it's there at all. */
  private awaitResume() {
    this.stopGrace?.();
    this.stopGrace = this.timers.after(RESUME_GRACE_MS, () => {
      this.stopGrace = null;
      if (!this.suspended) return;
      this.port.session().then(
        (device) => (device ? this.sessionEvent('resumed', device) : this.ended()),
        () => this.ended(),
      );
    });
  }

  /** What the TV has on now: the phone's last status for the screen at once, then a fresh one for counting. */
  private async refresh(waking: boolean) {
    if (waking) this.quietUntil = this.clock() + SETTLE_MS;
    const cached = await this.port.media.status().catch(() => null);
    if (cached) this.statusChanged(cached, false);
    await within(this.port.media.requestStatus(), ASK_MS, this.timers);
    if (this.connected) this.set({ checked: true });
  }

  private statusChanged(update: MediaUpdate | null, live: boolean) {
    if (!this.connected) return;
    const chapterId = update?.chapterId ?? null;
    let tv: TvNow | null = null;
    if (update?.state && chapterId) {
      const finished = update.state === 'idle' && update.idleReason === 'finished';
      const durationS = update.durationS ?? this.durations.get(chapterId) ?? null;
      tv = { chapterId, state: update.state, positionS: finished && durationS ? durationS : update.positionS, durationS, finished };
    }
    let { failed } = this.snapshot;
    if (tv && failed === tv.chapterId && (tv.state === 'playing' || tv.state === 'paused' || tv.state === 'buffering')) failed = null;
    // Stopped with an error once it had started: the stream ran out, or the TV lost its connection. (While a chapter
    // is being sent, the loader is the judge.)
    if (live && update?.state === 'idle' && update.idleReason === 'error' && !this.snapshot.sending) {
      const id = chapterId ?? this.lastSent?.chapterId ?? null;
      if (id && failed !== id) {
        failed = id;
        this.deps.failed?.(id, this.lastSent?.chapterId === id ? this.lastSent.type : null, 'stopped with an error');
      }
    }
    this.set({ tv, failed });
    if (live) this.count(update, tv);
    this.pollUpdate();
  }

  private count(update: MediaUpdate | null, tv: TvNow | null) {
    this.mine = Boolean(tv && this.tag && update?.sender === this.tag);
    if (!this.tracking) return;
    if (!tv || !this.mine) return this.tracker.progress(null, 0, false);
    if (tv.state === 'loading') return; // no position worth reading yet
    if (tv.state === 'idle') {
      if (!tv.finished) return this.tracker.progress(null, 0, false);
      this.tracker.progress(tv.chapterId, tv.positionS, false);
      this.tracker.ended(tv.chapterId);
      return;
    }
    this.tracker.progress(tv.chapterId, tv.positionS, tv.state === 'playing');
  }

  private pollUpdate() {
    const tv = this.snapshot.tv;
    const want = this.connected && !this.suspended && this.foreground && Boolean(tv && (tv.state === 'playing' || tv.state === 'buffering'));
    if (want && !this.stopPolling) this.stopPolling = this.timers.every(1000, () => void this.pollOnce());
    else if (!want) this.pollStop();
  }

  private pollStop() {
    this.stopPolling?.();
    this.stopPolling = null;
  }

  private async pollOnce() {
    const before = this.snapshot.tv;
    if (!before) return;
    const position = await this.port.media.position().catch(() => null);
    const tv = this.snapshot.tv;
    if (position === null || !Number.isFinite(position) || !tv || tv.chapterId !== before.chapterId || tv.state === 'idle') return;
    this.set({ tv: { ...tv, positionS: position } });
    const settled = this.clock() >= this.quietUntil;
    if (settled && this.tracking && this.mine && tv.state !== 'loading') this.tracker.progress(tv.chapterId, position, tv.state === 'playing');
  }

  private clock() {
    return (this.deps.now ?? Date.now)();
  }

  private set(change: Partial<CastSnapshot>) {
    const connection: Connection = this.connected ? 'connected' : this.castState === 'connected' ? 'connecting' : this.castState;
    const next = { ...this.snapshot, ...change, connection };
    const same = (Object.keys(next) as (keyof CastSnapshot)[]).every((key) => next[key] === this.snapshot[key]);
    if (same) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}
