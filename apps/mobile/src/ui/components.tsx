import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { memo, ReactNode } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, StyleProp, StyleSheet, Text, TextStyle, View, ViewStyle } from 'react-native';
import { Edge, SafeAreaView } from 'react-native-safe-area-context';
import { useDownloads } from '../lib/downloads';
import { minutes } from '../lib/format';
import type { CourseCard as Course } from '../lib/types';
import { colors, fonts, Ground, outline, radius, space, tiles } from './theme';

type IconName = keyof typeof Ionicons.glyphMap;
type TextProps = { children: ReactNode; style?: StyleProp<TextStyle> };

export function hash(value: string) {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return h;
}

/** A bright tile colour that stays the same for the same name. */
export const tileFor = (seed: string, offset = 0) => tiles[(hash(seed) + offset) % tiles.length];

/** For a run of tiles side by side: steps through the brights so no two neighbours share a colour. */
const sequence = [colors.green, colors.orange, colors.violet, colors.cyan, colors.yellow, colors.pink, colors.coral, colors.sand];
export const tileAt = (i: number) => sequence[i % sequence.length];
/** The same idea in pastels, for things that aren't ready yet. */
const pastels = [colors.peach, colors.mint, colors.sky, colors.butter, '#F9DCEA'];
export const pastelAt = (i: number) => pastels[i % pastels.length];

export function Screen({ children, scroll = true, edges = ['top'], tone = 'paper' }: { children: ReactNode; scroll?: boolean; edges?: Edge[]; tone?: Ground }) {
  const ground = { backgroundColor: colors[tone] };
  return (
    <SafeAreaView edges={edges} style={[styles.screen, ground]}>
      {scroll ? (
        <ScrollView contentContainerStyle={styles.screenBody} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.screenBody, styles.fill]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

/** The wordmark on the left, actions on the right, and a hairline under both that runs edge to edge. */
export function TopBar({ children }: { children?: ReactNode }) {
  return (
    <View style={styles.topBar}>
      <View style={styles.wordmark}>
        <Star size={15} color={colors.ink} />
        <Text style={styles.wordmarkText}>embodha</Text>
      </View>
      <View style={styles.topActions}>{children}</View>
    </View>
  );
}

export const H1 = ({ children, style }: TextProps) => <Text style={[styles.h1, style]}>{children}</Text>;
export const H2 = ({ children, style }: TextProps) => <Text style={[styles.h2, style]}>{children}</Text>;
export const Body = ({ children, style }: TextProps) => <Text style={[styles.body, style]}>{children}</Text>;
export const Muted = ({ children, style }: TextProps) => <Text style={[styles.muted, style]}>{children}</Text>;
/** Small spaced capitals, for the line above a heading or a tile. */
export const Label = ({ children, style }: TextProps) => <Text style={[styles.label, style]}>{children}</Text>;

/** A headline in the house style: thin capitals and heavy condensed capitals, line by line. */
export function Headline({ lines, style }: { lines: [string, 'thin' | 'heavy'][]; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={style} accessibilityRole="header">
      {lines.map(([text, kind], i) => (
        <Text key={i} style={kind === 'thin' ? styles.thinLine : styles.heavyLine}>
          {text}
        </Text>
      ))}
    </View>
  );
}

/** Eight points: two squares, one turned. The mark next to the wordmark, and a flourish on headings. */
export function Star({ size, color, style }: { size: number; color: string; style?: StyleProp<ViewStyle> }) {
  const side = size / Math.SQRT2;
  const square = { position: 'absolute' as const, width: side, height: side, left: (size - side) / 2, top: (size - side) / 2, backgroundColor: color };
  return (
    <View style={[{ width: size, height: size }, style]} pointerEvents="none">
      <View style={square} />
      <View style={[square, { transform: [{ rotate: '45deg' }] }]} />
    </View>
  );
}

export const ArrowUpRight = ({ size = 18, color = colors.ink }: { size?: number; color?: string }) => (
  <Ionicons name="arrow-forward" size={size} color={color} style={{ transform: [{ rotate: '-45deg' }] }} />
);

const buttonLook: Record<'primary' | 'secondary' | 'quiet', { box: ViewStyle; color: string }> = {
  primary: { box: { backgroundColor: colors.ink, borderWidth: outline, borderColor: colors.ink }, color: '#FFFFFF' },
  secondary: { box: { backgroundColor: 'transparent', borderWidth: outline, borderColor: colors.ink }, color: colors.ink },
  quiet: { box: { backgroundColor: 'transparent', minHeight: 40 }, color: colors.ink },
};

export function Button({
  title,
  onPress,
  variant = 'primary',
  icon,
  disabled,
  loading,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'quiet';
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
}) {
  const look = buttonLook[variant];
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [styles.button, look.box, (pressed || disabled) && styles.dimmed]}
    >
      {loading ? (
        <ActivityIndicator color={look.color} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={18} color={look.color} /> : null}
          <Text style={[variant === 'quiet' ? styles.quietText : styles.buttonText, { color: look.color }]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

/** A flat card with an ink outline. Give it a colour and it becomes a tile. */
export function Card({ children, style, onPress, color }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; color?: string }) {
  const body = <View style={[styles.card, color ? { backgroundColor: color } : null, style]}>{children}</View>;
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => pressed && styles.pressed}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

export function Chip({ label, selected, onPress }: { label: string; selected?: boolean; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]} accessibilityState={{ selected }}>
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

/** A round, outlined call to action, set at a slight angle, like a stamp on the page. */
export function CircleBadge({ label, onPress, size = 116, color = colors.peach, angle = -12 }: { label: string; onPress: () => void; size?: number; color?: string; angle?: number }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.badge, { width: size, height: size, borderRadius: size / 2, backgroundColor: color, transform: [{ rotate: `${angle}deg` }] }, pressed && styles.pressed]}
    >
      <Text style={styles.badgeText}>{label}</Text>
      <ArrowUpRight size={20} />
    </Pressable>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

/** The instructor's artwork, or until there is some, a bright tile with the title's first letter cut off at the edge. */
export function Cover({ seed, uri, height = 140, title }: { seed: string; uri?: string | null; height?: number; title?: string }) {
  // expo-image keeps covers in memory and on disk, and decodes them at the size shown, which matters on phones with little memory.
  if (uri) return <Image source={uri} style={[styles.cover, { height }]} contentFit="cover" cachePolicy="memory-disk" recyclingKey={uri} transition={150} />;
  const h = hash(seed);
  const letter = (title ?? seed).replace(/[^A-Za-z]/g, '').charAt(0).toUpperCase() || 'E';
  const glyph = height * 1.25;
  return (
    <View style={[styles.cover, { height, backgroundColor: tiles[h % tiles.length] }]}>
      <Text style={[styles.coverLetter, { fontSize: glyph, lineHeight: glyph * 1.02, right: -glyph * 0.08, bottom: -glyph * 0.3 }]}>{letter}</Text>
      <Star size={height * 0.22} color={h % 2 ? '#FFFFFF' : colors.ink} style={{ position: 'absolute', left: space(4), top: space(4) }} />
    </View>
  );
}

export const CourseCard = memo(function CourseCard({ course, width }: { course: Course; width?: number }) {
  const length = minutes(course.totalDurationS) || `${course.chapterCount} chapters`;
  const status = course.isFree ? 'Free' : course.unlocked ? 'In your library' : (course.price?.display ?? '');
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(`/course/${course.slug}`)}
      style={({ pressed }) => [width ? { width } : null, pressed && styles.pressed]}
    >
      <Cover seed={course.slug} title={course.title} uri={course.coverUrl} height={width ? 128 : 170} />
      <Text style={[styles.cardTitle, width ? styles.cardTitleSmall : null]} numberOfLines={2}>
        {course.title}
      </Text>
      <Text style={styles.cardMeta} numberOfLines={1}>
        {course.instructor.displayName} · {length}
      </Text>
      {status ? (
        <View style={styles.statusPill}>
          <Text style={styles.statusText}>{status}</Text>
        </View>
      ) : null}
    </Pressable>
  );
});

export const Loading = () => (
  <View style={styles.center}>
    <ActivityIndicator color={colors.ink} />
  </View>
);

export function ErrorView({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  // Offline, the browser-style "Network request failed" helps nobody; saying so, and where the downloads are, does.
  const saved = useDownloads();
  const offline = !saved.online;
  const hasDownloads = saved.items.some((item) => item.state === 'done');
  return (
    <View style={styles.center}>
      <Body style={styles.centerText}>
        {offline
          ? hasDownloads
            ? "You're offline. Your downloads still play."
            : "You're offline. Connect to the internet and try again."
          : (message ?? "Couldn't load this. Check your connection and try again.")}
      </Body>
      {offline && hasDownloads ? <Button title="Your downloads" onPress={() => router.push('/downloads')} /> : null}
      {onRetry ? <Button variant="secondary" title="Try again" onPress={onRetry} /> : null}
    </View>
  );
}

type BrowserDialogs = { confirm(message: string): boolean; alert(message: string): void };
const browser = () => globalThis as unknown as BrowserDialogs;

export function notify(title: string, message: string) {
  if (Platform.OS === 'web') browser().alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}

export function confirmAsync(title: string, message: string, confirmLabel: string): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(browser().confirm(`${title}\n\n${message}`));
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: confirmLabel, style: 'destructive', onPress: () => resolve(true) },
    ]),
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  screenBody: { paddingHorizontal: space(5), paddingTop: space(2), paddingBottom: space(14) },
  fill: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: -space(5),
    paddingHorizontal: space(5),
    paddingBottom: space(3),
    marginBottom: space(6),
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  wordmark: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  wordmarkText: { fontFamily: fonts.bold, fontSize: 21, letterSpacing: -0.8, color: colors.ink },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: space(4) },
  h1: { fontFamily: fonts.display, fontSize: 40, lineHeight: 44, letterSpacing: -0.5, color: colors.ink, textTransform: 'uppercase', marginBottom: space(3) },
  h2: { fontFamily: fonts.display, fontSize: 28, lineHeight: 32, color: colors.ink, textTransform: 'uppercase', marginBottom: space(3) },
  thinLine: { fontFamily: fonts.display, fontSize: 46, lineHeight: 50, letterSpacing: -1, color: colors.ink, textTransform: 'uppercase' },
  heavyLine: { fontFamily: fonts.heavy, fontSize: 60, lineHeight: 66, letterSpacing: -0.5, color: colors.ink, textTransform: 'uppercase' },
  body: { fontFamily: fonts.body, fontSize: 16, lineHeight: 24, color: colors.ink },
  muted: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20, color: colors.inkSoft },
  label: { fontFamily: fonts.bold, fontSize: 12, letterSpacing: 1.4, textTransform: 'uppercase', color: colors.ink },
  button: { minHeight: 54, borderRadius: radius.pill, paddingHorizontal: space(6), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space(2) },
  buttonText: { fontFamily: fonts.heavy, fontSize: 17, letterSpacing: 0.8, textTransform: 'uppercase' },
  quietText: { fontFamily: fonts.bold, fontSize: 15, textDecorationLine: 'underline' },
  dimmed: { opacity: 0.45 },
  pressed: { opacity: 0.75, transform: [{ scale: 0.99 }] },
  card: { backgroundColor: colors.surface, borderRadius: radius.md + 4, padding: space(5), borderWidth: outline, borderColor: colors.line },
  chip: { paddingHorizontal: space(4), paddingVertical: space(2), borderRadius: radius.pill, borderWidth: outline, borderColor: colors.line },
  chipSelected: { backgroundColor: colors.ink },
  chipText: { fontFamily: fonts.medium, fontSize: 14, color: colors.ink },
  chipTextSelected: { color: '#FFFFFF' },
  badge: { borderWidth: outline, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', padding: space(3), gap: 2 },
  badgeText: { fontFamily: fonts.heavy, fontSize: 15, lineHeight: 18, letterSpacing: 0.6, textTransform: 'uppercase', textAlign: 'center', color: colors.ink },
  section: { marginTop: space(12) },
  sectionTitle: { fontFamily: fonts.display, fontSize: 32, lineHeight: 34, color: colors.ink, textTransform: 'uppercase', marginBottom: space(4) },
  cover: { borderRadius: radius.md + 4, overflow: 'hidden', width: '100%', borderWidth: outline, borderColor: colors.line },
  coverLetter: { position: 'absolute', fontFamily: fonts.display, color: colors.ink },
  cardTitle: { fontFamily: fonts.heavy, fontSize: 24, lineHeight: 28, color: colors.ink, textTransform: 'uppercase', marginTop: space(3) },
  cardTitleSmall: { fontSize: 19, lineHeight: 23 },
  cardMeta: { fontFamily: fonts.body, fontSize: 13, color: colors.inkSoft, marginTop: 2 },
  statusPill: { alignSelf: 'flex-start', marginTop: space(2), borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: space(3), paddingVertical: 3 },
  statusText: { fontFamily: fonts.medium, fontSize: 12, color: colors.ink },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(6), gap: space(4), backgroundColor: colors.paper },
  centerText: { textAlign: 'center' },
});
