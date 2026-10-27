import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { TvNow } from '../lib/cast';
import { clock } from '../lib/format';
import { Button, Muted } from './components';
import { colors, fonts, radius, space } from './theme';

/**
 * In the player's place while a chapter is on the TV: what the TV is doing, where it's got to, and the buttons, which
 * work the TV. The phone's own player waits underneath, paused.
 */
export function TvPanel({
  kind,
  deviceName,
  tv,
  durationS,
  sending,
  failed,
  otherOnTv,
  onPlay,
  onPause,
  onSeekBy,
  onSend,
  onPlayHere,
  onStop,
}: {
  kind: 'video' | 'audio';
  deviceName: string | null;
  /** This chapter on the TV, or null when it isn't (yet, or any more). */
  tv: TvNow | null;
  durationS: number | null;
  sending: boolean;
  failed: boolean;
  /** The TV has moved on to something else. */
  otherOnTv: boolean;
  onPlay: () => void;
  onPause: () => void;
  onSeekBy: (seconds: number) => void;
  /** Puts this chapter on the TV (again). */
  onSend: () => void;
  onPlayHere: () => void;
  onStop: () => void;
}) {
  const name = deviceName ?? 'the TV';
  const Name = deviceName ?? 'The TV'; // starting a sentence
  const playing = tv ? tv.state === 'playing' || tv.state === 'buffering' || tv.state === 'loading' : false;
  const length = tv?.durationS ?? durationS ?? 0;
  const position = tv ? Math.min(tv.positionS, length || tv.positionS) : 0;

  let line: string;
  if (failed) line = `${Name} couldn't play this chapter.`;
  else if (sending && !tv) line = `Starting on ${name}…`;
  else if (tv?.finished) line = `Finished on ${name}`;
  else if (tv?.state === 'paused') line = `Paused on ${name}`;
  else if (tv) line = `Playing on ${name}`;
  else if (otherOnTv) line = `${Name} has moved on to something else.`;
  else line = `Nothing's playing on ${name}.`;

  return (
    <View style={styles.panel}>
      <View style={[styles.screen, kind === 'video' ? styles.wide : styles.square]} accessibilityLiveRegion="polite">
        <MaterialIcons name={failed ? 'cast' : 'cast-connected'} size={44} color={colors.moon} />
        <Text style={styles.line} numberOfLines={2}>
          {line}
        </Text>
        {sending && !tv ? <ActivityIndicator color={colors.moon} /> : null}
        {failed ? <Text style={styles.hint}>Try once more, or play it here on the phone.</Text> : null}
      </View>

      {tv ? (
        <>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${length ? Math.min(100, (position / length) * 100) : 0}%` }]} />
          </View>
          <View style={styles.times}>
            <Muted>{clock(position)}</Muted>
            <Muted>{length ? clock(length) : ''}</Muted>
          </View>
          {tv.finished ? (
            <Button variant="secondary" icon="refresh-outline" title={`Play it again on ${name}`} onPress={onSend} />
          ) : (
            <View style={styles.controls}>
              <Pressable accessibilityRole="button" accessibilityLabel="Back 15 seconds on the TV" onPress={() => onSeekBy(-15)} hitSlop={12}>
                <Ionicons name="play-back-outline" size={32} color={colors.ink} />
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={playing ? 'Pause the TV' : 'Play on the TV'} onPress={playing ? onPause : onPlay} hitSlop={8}>
                <Ionicons name={playing ? 'pause-circle' : 'play-circle'} size={72} color={colors.maroon} />
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Forward 15 seconds on the TV" onPress={() => onSeekBy(15)} hitSlop={12}>
                <Ionicons name="play-forward-outline" size={32} color={colors.ink} />
              </Pressable>
            </View>
          )}
        </>
      ) : null}

      {!tv && !sending ? (
        <View style={styles.actions}>
          <Button title={failed ? 'Try again' : `Play this on ${name}`} icon={failed ? 'refresh-outline' : undefined} onPress={onSend} />
          <Button variant="secondary" icon="phone-portrait-outline" title="Play on this phone" onPress={onPlayHere} />
        </View>
      ) : null}

      <Button variant="quiet" title="Stop playing on the TV" onPress={onStop} />
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: space(4) },
  screen: { backgroundColor: colors.night, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', gap: space(3), padding: space(5) },
  wide: { width: '100%', aspectRatio: 16 / 9 },
  square: { alignSelf: 'center', width: 220, minHeight: 220, borderRadius: radius.lg },
  line: { fontFamily: fonts.medium, fontSize: 17, lineHeight: 23, color: colors.moon, textAlign: 'center' },
  hint: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20, color: colors.mist, textAlign: 'center' },
  track: { alignSelf: 'stretch', height: 4, borderRadius: 2, backgroundColor: colors.hairline, overflow: 'hidden' },
  fill: { height: 4, backgroundColor: colors.maroon },
  times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -space(2) },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space(8) },
  actions: { gap: space(3) },
});
