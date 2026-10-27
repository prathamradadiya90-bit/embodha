import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEvent, useEventListener } from 'expo';
import { router, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoAirPlayButton, VideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { track } from '../../lib/analytics';
import { api, ApiError, withCurrency } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { addBeat, pendingBeats, sendBeats } from '../../lib/beats';
import { cast, castSupported, useCast, type Castable } from '../../lib/cast';
import { downloads } from '../../lib/downloads';
import { clock } from '../../lib/format';
import { connection } from '../../lib/network';
import { startClock, type StartReading } from '../../lib/start-clock';
import type { Locked, Playback } from '../../lib/types';
import { CastButton } from '../../ui/cast-button';
import { useBuyCourse, useSubscribe } from '../../ui/checkout';
import { Body, Button, ErrorView, H1, H2, Loading, Muted, Screen } from '../../ui/components';
import { Notes } from '../../ui/notes';
import { SiteLinks } from '../../ui/site-links';
import { colors, radius, space } from '../../ui/theme';
import { TvPanel } from '../../ui/tv-panel';

export { ErrorBoundary } from '../../ui/error-boundary';

export default function PlayScreen() {
  const { chapterId } = useLocalSearchParams<{ chapterId: string }>();
  const timing = useStartTiming(chapterId);
  const query = useQuery({
    queryKey: ['playback', chapterId],
    queryFn: async () => {
      const playback = await loadPlayback(chapterId);
      timing.answered(playback);
      return playback;
    },
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  useEffect(() => {
    if (query.isError) timing.cancel(); // locked, still processing, or offline: nothing was trying to play
  }, [query.isError, timing]);

  if (query.isPending) return <Loading />;
  if (query.isError) {
    const error = query.error;
    if (error instanceof ApiError && error.status === 402) return <LockedView locked={error.body as unknown as Locked} />;
    if (error instanceof ApiError && error.status === 409) {
      return <ErrorView message="This chapter is still being prepared. Try again in a few minutes." onRetry={() => void query.refetch()} />;
    }
    return <ErrorView message={error.message} onRetry={() => void query.refetch()} />;
  }
  // A new chapter gets a fresh player, so "start where you left off" runs again.
  return <Player key={query.data.chapterId} playback={query.data} timing={timing} />;
}

type Timing = ReturnType<typeof useStartTiming>;

/** How long to wait for the server before playing a saved chapter from what its download keeps. */
const SAVED_WAIT_MS = 4000;

/**
 * The chapter to play. A chapter saved on the phone plays from there: online, once the server has said the member
 * may (and where they left off); offline, or when the server is slow to answer, from what the download keeps.
 */
async function loadPlayback(chapterId: string): Promise<Playback> {
  const offline = downloads.playable(chapterId);
  const ask = async () => {
    if (pendingBeats()) await sendBeats(); // so the place the server gives back counts what was played offline
    return api<Playback>(withCurrency(`/v1/chapters/${chapterId}/playback`));
  };
  try {
    const playback = await (offline ? within(ask(), SAVED_WAIT_MS) : ask());
    const saved = downloads.saved(chapterId);
    // A TV can't reach the phone's file: it streams, whichever the phone plays.
    return saved ? { ...playback, url: saved.uri, streamUrl: playback.url, saved: true } : { ...playback, streamUrl: playback.url };
  } catch (error) {
    if (error instanceof ApiError) {
      // No longer the member's (a refund, a subscription that ran out): the check-in takes the download off.
      if (error.status === 402 && downloads.saved(chapterId)) void downloads.checkIn(true);
      throw error;
    }
    if (offline) return fromDownload(offline);
    throw error;
  }
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The server took too long to answer.')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** A saved chapter offline: the details the download kept, and the next chapter only if that one is saved too. */
function fromDownload({ uri, item, course }: NonNullable<ReturnType<typeof downloads.playable>>): Playback {
  const order = course?.chapters ?? [];
  const at = order.findIndex((c) => c.id === item.chapterId);
  const next = at < 0 ? undefined : order.slice(at + 1).find((c) => downloads.playable(c.id));
  return {
    chapterId: item.chapterId,
    type: item.type,
    title: item.title,
    course: { slug: course?.slug ?? '', title: course?.title ?? '' },
    next: next ? { id: next.id, title: next.title } : null,
    url: uri,
    streamUrl: null,
    expiresAt: null,
    durationS: item.durationS,
    resumePositionS: item.position?.s ?? 0,
    thumbnailUrl: null,
    saved: true,
    offline: true,
  };
}

/**
 * How long this chapter takes to start, sent as a video_start event (see lib/start-clock.ts): from opening the
 * player to the first frame, or the first sound of an audio chapter, with the connection the phone was on.
 * Leaving before it starts sends the wait, marked abandoned. A chapter that won't play sends video_error instead.
 */
function useStartTiming(chapterId: string) {
  const timing = useMemo(() => {
    const clock = startClock();
    const network = connection();
    let kind = 'unknown';
    let resumed = false;
    let saved = false;
    let mounted = false;
    const send = (reading: StartReading | null) => {
      if (!reading) return;
      void network.then(({ network: type, generation }) =>
        track('video_start', {
          chapterId,
          ms: reading.ms,
          ...(reading.apiMs !== null ? { apiMs: reading.apiMs } : {}),
          kind,
          network: type,
          generation,
          resumed,
          abandoned: reading.abandoned,
          // Played from a download: the network had no part in how long it took.
          ...(saved ? { saved: true } : {}),
        }),
      );
    };
    return {
      answered(playback: Playback) {
        kind = playback.type;
        resumed = resumePoint(playback) !== null;
        saved = Boolean(playback.saved);
        clock.answered();
      },
      started: () => send(clock.started()),
      cancel: () => clock.cancel(),
      failed(message?: string) {
        clock.cancel();
        void network.then(({ network: type, generation }) => track('video_error', { chapterId, kind, message: (message ?? '').slice(0, 120), network: type, generation }));
      },
      mount() {
        mounted = true;
      },
      unmount() {
        mounted = false;
        // A development-mode double render unmounts and mounts again at once; only a real exit counts.
        setTimeout(() => {
          if (!mounted) send(clock.left());
        }, 0);
      },
    };
  }, [chapterId]);
  useEffect(() => {
    timing.mount();
    return () => timing.unmount();
  }, [timing]);
  return timing;
}

/** Where to pick up: the saved place, unless it's the first few seconds or the last fifteen. */
function resumePoint(playback: Playback): number | null {
  const at = playback.resumePositionS;
  const nearEnd = playback.durationS !== null && at > playback.durationS - 15;
  return at > 5 && !nearEnd ? at : null;
}

function Player({ playback, timing }: { playback: Playback; timing: Timing }) {
  const { signedIn } = useAuth();
  const player = useVideoPlayer(playback.url, (p) => {
    p.timeUpdateEventInterval = 1;
    // Start as soon as 1.5 seconds are in (Android), and don't hold more than 20 seconds ahead: quicker starts on
    // slow 4G, and less memory taken on low-end phones.
    p.bufferOptions = { minBufferForPlayback: 1.5, preferredForwardBufferDuration: 20 };
    // Keeps playing with the screen locked, with lock-screen controls.
    p.staysActiveInBackground = true;
    p.showNowPlayingNotification = true;
  });
  const tv = useTv(player, playback, timing);
  useStartWhenReady(player, playback, tv.hold, tv.tvPlace);
  // On the TV, the TV's own count takes over (lib/cast-core.ts); the phone's sends its last beat as it hands over.
  useHeartbeats(player, playback.chapterId, signedIn && !tv.showing, Boolean(playback.saved));
  // An audio chapter has no frames: its start is the first sound.
  useEventListener(player, 'playingChange', ({ isPlaying }) => {
    if (isPlaying && playback.type !== 'video') timing.started();
  });
  useEventListener(player, 'statusChange', ({ status, error }) => {
    if (status === 'error') timing.failed(error?.message);
  });
  // Reaching the end counts as done even if a few seconds were skipped along the way.
  useEventListener(player, 'playToEnd', () => {
    if (signedIn) void api(`/v1/chapters/${playback.chapterId}/complete`, { method: 'POST' }).catch(() => undefined);
  });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const { currentTime } = useEvent(player, 'timeUpdate', {
    currentTime: player.currentTime,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0,
  });
  const duration = playback.durationS ?? 0;
  const next = playback.next;

  return (
    <Screen edges={['bottom']}>
      {tv.showing ? (
        <TvPanel
          kind={playback.type}
          deviceName={tv.deviceName}
          tv={tv.here}
          durationS={playback.durationS}
          sending={tv.sending}
          failed={tv.failed}
          otherOnTv={tv.otherOnTv}
          onPlay={() => void cast.play()}
          onPause={() => void cast.pause()}
          onSeekBy={(seconds) => void cast.seekBy(seconds)}
          onSend={tv.sendAgain}
          onPlayHere={tv.playHere}
          onStop={() => void cast.stop()}
        />
      ) : playback.type === 'video' ? (
        <VideoView player={player} style={styles.video} nativeControls allowsPictureInPicture contentFit="contain" onFirstFrameRender={timing.started} />
      ) : (
        <View style={styles.audio}>
          {/* An invisible view gives the web build an element to play through; phones play audio without one. */}
          <VideoView player={player} style={styles.hidden} nativeControls={false} />
          <View style={styles.audioArt}>
            <Ionicons name="headset-outline" size={56} color={colors.moon} />
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${duration ? Math.min(100, (currentTime / duration) * 100) : 0}%` }]} />
          </View>
          <View style={styles.times}>
            <Muted>{clock(currentTime)}</Muted>
            <Muted>{duration ? clock(duration) : ''}</Muted>
          </View>
          <View style={styles.controls}>
            <Pressable accessibilityLabel="Back 15 seconds" onPress={() => player.seekBy(-15)}>
              <Ionicons name="play-back-outline" size={32} color={colors.ink} />
            </Pressable>
            <Pressable accessibilityLabel={isPlaying ? 'Pause' : 'Play'} onPress={() => (isPlaying ? player.pause() : player.play())}>
              <Ionicons name={isPlaying ? 'pause-circle' : 'play-circle'} size={72} color={colors.maroon} />
            </Pressable>
            <Pressable accessibilityLabel="Forward 15 seconds" onPress={() => player.seekBy(15)}>
              <Ionicons name="play-forward-outline" size={32} color={colors.ink} />
            </Pressable>
          </View>
        </View>
      )}

      <View style={styles.info}>
        <View style={styles.courseRow}>
          <Pressable style={styles.courseLink} accessibilityRole="link" onPress={() => router.push(`/course/${playback.course.slug}`)}>
            <Muted>{playback.course.title}</Muted>
          </Pressable>
          {/* A video's own controls have AirPlay in them; an audio chapter has no controls from iOS, so it gets the button. */}
          {playback.type === 'audio' && Platform.OS === 'ios' && !tv.showing ? (
            <VideoAirPlayButton style={styles.route} tint={colors.ink} activeTint={colors.brand} prioritizeVideoDevices={false} />
          ) : null}
          {tv.canCast ? <CastButton color={colors.ink} /> : null}
        </View>
        <H2>{playback.title}</H2>
        {!signedIn ? <Muted style={styles.note}>Sign in to save your place and keep your streak.</Muted> : null}
        {playback.offline ? <Muted style={styles.note}>Playing from your downloads. Your place and practice go up when you're back online.</Muted> : null}
        {tv.connected && !tv.showing ? <Button variant="secondary" icon="tv-outline" title={`Play on ${tv.deviceName ?? 'the TV'}`} onPress={tv.backToTv} /> : null}
        {next ? (
          <Button variant="secondary" icon="play-skip-forward-outline" title={`Next: ${next.title}`} onPress={() => router.replace(`/play/${next.id}`)} />
        ) : null}
      </View>
      {signedIn && !playback.offline ? (
        <Notes
          chapterId={playback.chapterId}
          currentTime={tv.showing && tv.here ? tv.here.positionS : currentTime}
          onSeek={(seconds) => {
            if (tv.showing) void cast.seekTo(seconds);
            else player.currentTime = seconds;
          }}
        />
      ) : null}
    </Screen>
  );
}

/**
 * This chapter and the TV, when the phone is connected to one (lib/cast-core.ts has the rest). The chapter goes to
 * the TV from where the member is, once per connection, unless the TV already has it (the app reopened mid-class);
 * the phone's player waits, paused, with its lock-screen controls hidden so the two can't both play. Once the TV has
 * had the chapter, the phone never starts it on its own: leaving the TV, it moves to where the TV got to and waits
 * there. "Play on this phone" keeps the connection and brings the chapter back; "Play on" the TV sends it again.
 */
function useTv(player: VideoPlayer, playback: Playback, timing: Timing) {
  const now = useCast();
  const castable = useMemo<Castable | null>(
    () =>
      castSupported && playback.streamUrl
        ? {
            chapterId: playback.chapterId,
            type: playback.type,
            title: playback.title,
            course: playback.course,
            durationS: playback.durationS,
            streamUrl: playback.streamUrl,
            thumbnailUrl: playback.thumbnailUrl,
          }
        : null,
    [playback],
  );
  const connected = castable !== null && now.connection === 'connected';
  const [onPhone, setOnPhone] = useState(false);
  const showing = connected && !onPhone;
  const theTv = now.tv;
  const here = theTv && theTv.chapterId === playback.chapterId && (theTv.state !== 'idle' || theTv.finished) ? theTv : null;

  // Read when the phone's player becomes ready, and kept once set: only "Play on this phone" lets it go.
  const hold = useRef(showing);
  useEffect(() => {
    if (showing) hold.current = true;
  }, [showing]);

  // Where the phone is, from its own updates: on the web, its position reads 0 as soon as its view is gone, which is
  // the moment the TV takes over.
  const phoneAt = useRef(0);
  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    phoneAt.current = currentTime;
  });
  const moveTo = useCallback(
    (seconds: number) => {
      phoneAt.current = seconds;
      try {
        player.currentTime = seconds;
      } catch {
        // released
      }
    },
    [player],
  );

  /** Where to start the TV from: where the phone is, or where the member left off. */
  const from = useCallback(() => {
    let live = 0;
    try {
      live = player.currentTime;
    } catch {
      // released
    }
    const at = live > 1 ? live : phoneAt.current;
    return at > 1 ? at : (resumePoint(playback) ?? 0);
  }, [player, playback]);

  const sentIn = useRef(0);
  useEffect(() => {
    if (!castable || !connected || !now.checked || sentIn.current === now.session) return;
    sentIn.current = now.session;
    setOnPhone(false);
    if (theTv?.chapterId === playback.chapterId && theTv.state !== 'idle') return; // already on: follow it
    void cast.send(castable, from());
  }, [castable, connected, now.checked, now.session, theTv, playback.chapterId, from]);

  useEffect(() => {
    if (!showing) return;
    timing.cancel(); // the phone isn't starting this one
    try {
      player.pause();
      player.showNowPlayingNotification = false;
    } catch {
      // released
    }
    return () => {
      try {
        player.showNowPlayingNotification = true;
      } catch {
        // released as the screen closed
      }
    };
  }, [showing, player, timing]);

  // Where the TV has got to: the phone picks up there when the TV is left (and when its player is first ready, if
  // that's later, as on the web).
  const tvPlace = useRef<number | null>(null);
  useEffect(() => {
    if (here) tvPlace.current = here.finished ? (here.durationS ?? here.positionS) : here.positionS;
  }, [here]);
  useEffect(() => {
    if (!showing && tvPlace.current !== null) moveTo(tvPlace.current);
  }, [showing, moveTo]);

  return {
    castable,
    /** Casting works on this phone (Google Play services on Android) and there's a stream to send. */
    canCast: castable !== null && now.connection !== 'unavailable',
    connected,
    showing,
    hold,
    tvPlace,
    here,
    deviceName: now.deviceName,
    sending: now.sending === playback.chapterId,
    failed: now.failed === playback.chapterId,
    otherOnTv: Boolean(theTv && theTv.chapterId !== playback.chapterId),
    sendAgain: () => {
      if (castable) void cast.send(castable, here?.finished ? 0 : (here?.positionS ?? from()));
    },
    playHere: () => {
      hold.current = false;
      if (tvPlace.current !== null) moveTo(tvPlace.current);
      try {
        player.play();
      } catch {
        // released
      }
      setOnPhone(true);
    },
    backToTv: () => {
      if (!castable) return;
      const at = from();
      try {
        player.pause();
      } catch {
        // released
      }
      setOnPhone(false);
      void cast.send(castable, at);
    },
  };
}

/**
 * Seeks to where the member left off and starts, once the media can play. Waiting for "ready" matters on the web,
 * where the player has no <video> element to start until the view mounts. A chapter the TV has had is held: the
 * phone goes to where the TV got to (or the member's place, if the TV hasn't reported yet) and waits there.
 */
function useStartWhenReady(player: VideoPlayer, playback: Playback, hold: { current: boolean }, tvPlace: { current: number | null }) {
  const started = useRef(false);
  const start = useCallback(() => {
    if (started.current) return;
    started.current = true;
    const at = tvPlace.current ?? resumePoint(playback);
    if (at !== null) player.currentTime = at;
    if (!hold.current) player.play();
  }, [player, playback, hold, tvPlace]);
  useEventListener(player, 'statusChange', ({ status }) => {
    if (status === 'readyToPlay') start();
  });
  useEffect(() => {
    if (player.status === 'readyToPlay') start();
  }, [player, start]);
}

/**
 * Every 30 seconds, a heartbeat: where the member is and how long they actually played. Seeking doesn't count as
 * watching. Each one waits on the phone until the server has it (lib/beats.ts), so time played offline counts too.
 * A saved chapter also keeps the place in its download, for picking up offline.
 */
function useHeartbeats(player: VideoPlayer, chapterId: string, enabled: boolean, saved: boolean) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let played = 0;
    let position = 0;
    let lastSentPosition = 0;

    const tick = setInterval(() => {
      try {
        position = Math.floor(player.currentTime);
        if (player.playing) played += 1;
      } catch {
        // the player was released; the last beat uses the last known values
      }
    }, 1000);

    const beat = () => {
      // Opening a chapter and leaving without playing or moving through it isn't progress.
      if (played === 0 && position === lastSentPosition) return false;
      addBeat({ chapterId, positionS: position, seconds: Math.min(120, played), at: new Date().toISOString() });
      if (saved) downloads.savePosition(chapterId, position);
      played = 0;
      lastSentPosition = position;
      return true;
    };

    const every = setInterval(() => {
      if (beat()) void sendBeats();
    }, 30_000);
    return () => {
      clearInterval(tick);
      clearInterval(every);
      beat();
      // Send what's left, then refresh the screens that show progress (course ticks, Continue on Today, streak).
      void sendBeats().finally(() => {
        for (const key of ['course', 'home', 'library', 'stats', 'reviews']) void queryClient.invalidateQueries({ queryKey: [key] });
      });
    };
  }, [player, chapterId, enabled, saved, queryClient]);
}

function LockedView({ locked }: { locked: Locked }) {
  const { buy, busy } = useBuyCourse();
  const { subscribe, busy: subscribing } = useSubscribe();
  useEffect(() => {
    track('locked_view', { courseId: locked.course.id, guest: locked.requiresAccount });
  }, [locked.course.id, locked.requiresAccount]);
  return (
    <Screen edges={[]}>
      <View style={styles.lockIcon}>
        <Ionicons name="lock-closed-outline" size={28} color={colors.maroon} />
      </View>
      <H1>This chapter is part of {locked.course.title}</H1>
      <Body style={styles.lockLead}>Unlock the course once and keep it, or subscribe to the instructor for everything they teach.</Body>
      <View style={styles.lockActions}>
        {locked.requiresAccount ? <Button title="Sign in first" onPress={() => router.push('/sign-in')} /> : null}
        {locked.price ? (
          <Button
            variant={locked.requiresAccount ? 'secondary' : 'primary'}
            title={`Unlock the course for ${locked.price.display}`}
            loading={busy}
            onPress={() => void buy({ id: locked.course.id, title: locked.course.title })}
          />
        ) : null}
        {locked.instructorSubscription?.price ? (
          <>
            <Button variant="secondary" title={`Subscribe for ${locked.instructorSubscription.price.display} a month`} loading={subscribing} onPress={() => void subscribe(locked.instructor)} />
            <SiteLinks pages={['terms', 'privacy']} />
          </>
        ) : null}
        <Button variant="quiet" title="See the course" onPress={() => router.replace(`/course/${locked.course.slug}`)} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  video: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000000', borderRadius: radius.sm },
  audio: { alignItems: 'center', gap: space(5), paddingVertical: space(4) },
  hidden: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  audioArt: { width: 200, height: 200, borderRadius: radius.lg, backgroundColor: colors.night, alignItems: 'center', justifyContent: 'center' },
  progressTrack: { alignSelf: 'stretch', height: 4, borderRadius: 2, backgroundColor: colors.hairline, overflow: 'hidden' },
  progressFill: { height: 4, backgroundColor: colors.maroon },
  times: { alignSelf: 'stretch', flexDirection: 'row', justifyContent: 'space-between' },
  controls: { flexDirection: 'row', alignItems: 'center', gap: space(8) },
  info: { marginTop: space(6), gap: space(1) },
  courseRow: { flexDirection: 'row', alignItems: 'center', gap: space(3), minHeight: 30 },
  courseLink: { flex: 1 },
  route: { width: 30, height: 30 },
  note: { marginBottom: space(4) },
  lockIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.maroonSoft, alignItems: 'center', justifyContent: 'center', marginBottom: space(5) },
  lockLead: { color: colors.inkSoft, marginBottom: space(6) },
  lockActions: { gap: space(3) },
});
