import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { track } from '../lib/analytics';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { BUNDLED_PATTERNS, phasesOf, SMALL, totalSeconds } from '../lib/breathing';
import type { BreathingPattern, Stats } from '../lib/types';
import { colors, radius, serif, space } from '../ui/theme';

export { ErrorBoundary } from '../ui/error-boundary';

type State = 'ready' | 'running' | 'paused' | 'done';

const tick = () => {
  if (Platform.OS !== 'web') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
};

/** A shape that grows on the in-breath and shrinks on the out-breath, with a haptic tap at each change so it works eyes-closed. */
export default function Breathe() {
  const { launch } = useLocalSearchParams<{ launch?: string }>();
  const { signedIn } = useAuth();
  const queryClient = useQueryClient();
  const patternsQuery = useQuery({ queryKey: ['patterns'], queryFn: () => api<BreathingPattern[]>('/v1/breathing/patterns'), staleTime: Infinity });
  const patterns = patternsQuery.data?.length ? patternsQuery.data : BUNDLED_PATTERNS;

  const [slug, setSlug] = useState(patterns[0].slug);
  const pattern = patterns.find((p) => p.slug === slug) ?? patterns[0];
  const phases = useMemo(() => phasesOf(pattern), [pattern]);
  const [state, setState] = useState<State>('ready');
  const [round, setRound] = useState(1);
  const [index, setIndex] = useState(0);
  const [remaining, setRemaining] = useState(phases[0].seconds);
  const [stats, setStats] = useState<Stats | null>(null);
  const scale = useRef(new Animated.Value(SMALL)).current;

  const reset = (next: BreathingPattern = pattern) => {
    setState('ready');
    setRound(1);
    setIndex(0);
    setRemaining(phasesOf(next)[0].seconds);
    scale.setValue(SMALL);
  };

  // Each phase (and each resume) animates from wherever the shape is to the phase's size, over the time left.
  useEffect(() => {
    if (state !== 'running') return;
    const animation = Animated.timing(scale, {
      toValue: phases[index].scaleTo,
      duration: remaining * 1000,
      easing: Easing.inOut(Easing.sin),
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start();
    const timer = setInterval(() => setRemaining((r) => r - 1), 1000);
    return () => {
      clearInterval(timer);
      animation.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, index, round]);

  useEffect(() => {
    if (state !== 'running' || remaining > 0) return;
    if (index + 1 < phases.length) {
      setIndex(index + 1);
      setRemaining(phases[index + 1].seconds);
      tick();
    } else if (round < pattern.rounds) {
      setRound(round + 1);
      setIndex(0);
      setRemaining(phases[0].seconds);
      tick();
    } else {
      setState('done');
      if (Platform.OS !== 'web') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (signedIn) {
        api<Stats>('/v1/breathing/sessions', { method: 'POST', body: { patternId: pattern.id, seconds: totalSeconds(pattern) } })
          .then((result) => {
            setStats(result);
            void queryClient.invalidateQueries({ queryKey: ['stats'] });
          })
          .catch(() => undefined);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining, state]);

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const phase = phases[index];

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.top}>
        <Pressable accessibilityLabel="Close" onPress={close} hitSlop={12}>
          <Ionicons name="close" size={28} color={colors.mist} />
        </Pressable>
        {launch && state !== 'done' ? (
          <Pressable onPress={close} hitSlop={12}>
            <Text style={styles.skip}>Skip</Text>
          </Pressable>
        ) : null}
      </View>

      {state === 'done' ? (
        <View style={styles.middle}>
          <Text style={styles.doneTitle}>Nicely done.</Text>
          <Text style={styles.doneText}>
            {stats ? (stats.streakDays > 1 ? `That's a ${stats.streakDays}-day streak.` : 'Day one of your streak.') : 'Notice how you feel before you move on.'}
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.patterns}>
            {patterns.map((p) => (
              <Pressable
                key={p.slug}
                disabled={state === 'running'}
                onPress={() => {
                  setSlug(p.slug);
                  reset(p);
                }}
                style={[styles.patternChip, p.slug === pattern.slug && styles.patternChipOn]}
              >
                <Text style={[styles.patternText, p.slug === pattern.slug && styles.patternTextOn]}>{p.name}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.middle}>
            <View style={styles.ring}>
              <Animated.View style={[styles.circle, { transform: [{ scale }] }]} />
              {/* Only a number goes inside: at its smallest the circle is too narrow for words. */}
              <View style={styles.circleLabel}>
                {state === 'ready' ? (
                  <Text style={styles.length}>{Math.max(1, Math.round(totalSeconds(pattern) / 60))} min</Text>
                ) : (
                  <Text style={styles.count}>{remaining}</Text>
                )}
              </View>
            </View>
            <Text style={styles.phase}>{state === 'ready' ? pattern.name : phase.label}</Text>
            <Text style={styles.roundText}>
              {state === 'ready' ? pattern.description : `Round ${round} of ${pattern.rounds}`}
            </Text>
          </View>
        </>
      )}

      <View style={styles.bottom}>
        {state === 'done' ? (
          <Pressable style={styles.primary} onPress={close}>
            <Text style={styles.primaryText}>Back to today</Text>
          </Pressable>
        ) : (
          <Pressable
            style={styles.primary}
            onPress={() => {
              if (state === 'running') setState('paused');
              else {
                if (state === 'ready') {
                  tick();
                  track('breath_start', { pattern: pattern.slug, onLaunch: Boolean(launch) });
                }
                setState('running');
              }
            }}
          >
            <Text style={styles.primaryText}>{state === 'running' ? 'Pause' : state === 'paused' ? 'Resume' : 'Begin'}</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

const SIZE = 260;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.night },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: space(5), paddingTop: space(2) },
  skip: { color: colors.mist, fontSize: 16 },
  patterns: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space(2), paddingHorizontal: space(5), marginTop: space(4) },
  patternChip: { paddingHorizontal: space(3), paddingVertical: space(2), borderRadius: radius.pill, borderWidth: 1, borderColor: colors.nightLine },
  patternChipOn: { backgroundColor: colors.nightLine },
  patternText: { color: colors.mist, fontSize: 13 },
  patternTextOn: { color: '#FFFFFF' },
  middle: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space(8) },
  ring: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, borderWidth: 1, borderColor: colors.nightLine, alignItems: 'center', justifyContent: 'center' },
  circle: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, backgroundColor: colors.moon, opacity: 0.92 },
  circleLabel: { position: 'absolute', alignItems: 'center', pointerEvents: 'none' },
  length: { fontSize: 18, color: colors.night },
  count: { fontSize: 34, fontWeight: '300', color: colors.night },
  phase: { fontFamily: serif, fontSize: 28, color: '#FFFFFF', marginTop: space(10), textAlign: 'center' },
  roundText: { color: colors.mist, fontSize: 15, lineHeight: 21, marginTop: space(2), textAlign: 'center', minHeight: 42 },
  doneTitle: { fontFamily: serif, fontSize: 34, color: '#FFFFFF', marginBottom: space(3) },
  doneText: { color: colors.mist, fontSize: 17, textAlign: 'center' },
  bottom: { padding: space(6) },
  primary: { backgroundColor: colors.moon, borderRadius: radius.pill, minHeight: 54, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: colors.night, fontSize: 17, fontWeight: '600' },
});
