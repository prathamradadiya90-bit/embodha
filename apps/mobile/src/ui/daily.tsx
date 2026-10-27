import { Ionicons } from '@expo/vector-icons';
import { useEventListener } from 'expo';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { clock } from '../lib/format';
import type { Home } from '../lib/types';
import { Body, Label, Muted } from './components';
import { colors, outline, radius, space } from './theme';

/** The photo of the day, full width, at its own shape (within reason), with its caption and credit. */
export function DailyPhoto({ photo }: { photo: NonNullable<Home['dailyImage']> }) {
  const ratio = photo.width && photo.height ? Math.min(Math.max(photo.width / photo.height, 0.8), 2) : 1.5;
  return (
    <View style={styles.block}>
      <Label>Today's picture</Label>
      <Image
        source={{ uri: photo.url }}
        style={[styles.frame, { aspectRatio: ratio }]}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={200}
        accessibilityLabel={photo.caption ?? "Today's picture"}
      />
      {photo.caption ? <Body style={styles.caption}>{photo.caption}</Body> : null}
      {photo.credit ? <Muted>Photo: {photo.credit}</Muted> : null}
    </View>
  );
}

/** The video of the day: a still with a play button, so nothing downloads until someone taps it. */
export function DailyClip({ clip }: { clip: NonNullable<Home['dailyClip']> }) {
  const [playing, setPlaying] = useState(false);
  return (
    <View style={styles.block}>
      <Label>Today's moment{clip.durationS ? ` · ${clock(clip.durationS)}` : ''}</Label>
      {playing ? (
        <ClipPlayer url={clip.url} />
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel="Play today's moment" onPress={() => setPlaying(true)} style={({ pressed }) => [styles.frame, styles.video, pressed && styles.pressed]}>
          {clip.thumbnailUrl ? <Image source={{ uri: clip.thumbnailUrl }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" /> : null}
          <View style={styles.play}>
            <Ionicons name="play" size={26} color="#FFFFFF" style={{ marginLeft: 3 }} />
          </View>
        </Pressable>
      )}
      {clip.caption ? <Body style={styles.caption}>{clip.caption}</Body> : null}
    </View>
  );
}

function ClipPlayer({ url }: { url: string }) {
  const player = useVideoPlayer(url);
  // Start once it can actually play (calling play() before then is ignored on the web), and only once, so a pause sticks.
  const started = useRef(false);
  useEventListener(player, 'statusChange', ({ status }) => {
    if (status !== 'readyToPlay' || started.current) return;
    started.current = true;
    player.play();
  });
  return <VideoView player={player} style={[styles.frame, styles.video]} nativeControls contentFit="contain" />;
}

const styles = StyleSheet.create({
  block: { marginTop: space(10), gap: space(3) },
  frame: { width: '100%', borderRadius: radius.md + 4, borderWidth: outline, borderColor: colors.line, overflow: 'hidden', backgroundColor: colors.sand },
  video: { aspectRatio: 16 / 9, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  play: { width: 58, height: 58, borderRadius: 29, backgroundColor: colors.ink, borderWidth: 2, borderColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  caption: { marginTop: space(1) },
  pressed: { opacity: 0.85 },
});
