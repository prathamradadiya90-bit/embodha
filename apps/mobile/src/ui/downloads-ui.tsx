import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { downloads, sizeLabel, type CourseInfo, type Item, type Snapshot } from '../lib/downloads';
import type { ChapterRow, CourseDetail } from '../lib/types';
import { Button, confirmAsync, Muted } from './components';
import { colors, fonts, space } from './theme';

type Waiting = Snapshot['waiting'];

/** The course as the download manager keeps it: enough to list its downloads and step through them offline. */
export function courseInfo(course: CourseDetail): CourseInfo {
  return {
    id: course.id,
    slug: course.slug,
    title: course.title,
    instructor: course.instructor.displayName,
    chapters: course.chapters.map((c) => ({ id: c.id, title: c.title, type: c.type, durationS: c.durationS })),
  };
}

const WAITING_WORDS: Record<Exclude<NonNullable<Waiting>, 'blocked'>, string> = {
  paused: 'Paused',
  offline: 'Waiting for a connection',
  wifi: 'Waiting for Wi-Fi',
  background: 'Carries on when Embodha is open',
  retrying: 'Trying again shortly',
};

/** Why the queue isn't moving, in a few words, or null when it is. */
export function waitingWords(snapshot: Pick<Snapshot, 'waiting' | 'block'>): string | null {
  if (!snapshot.waiting) return null;
  if (snapshot.waiting === 'blocked') return snapshot.block?.code === 'space' ? 'On hold: no room on this phone' : 'On hold: phone limit reached';
  return WAITING_WORDS[snapshot.waiting];
}

/**
 * What a chapter's download is up to, in a few words, for the line under its title. The course page leaves the size
 * out to keep the line short; the Downloads screen gives it.
 */
export function downloadNote(item: Item | undefined, snapshot: Pick<Snapshot, 'waiting' | 'block'>, withSize = false): string {
  if (!item) return '';
  if (item.state === 'done') return withSize ? `Downloaded · ${sizeLabel(item.written)}` : 'Downloaded';
  if (item.state === 'failed') return item.problem?.code === 'missing' ? 'Not on this phone any more' : "Didn't download";
  if (item.state === 'downloading') return item.total ? `Downloading ${Math.floor((item.written / item.total) * 100)}%` : 'Downloading';
  return waitingWords(snapshot) ?? (item.state === 'paused' ? 'Paused' : 'Waiting to download');
}

/** The download button at the end of a chapter's row on the course page. */
export function ChapterDownload({ chapter, course, snapshot }: { chapter: ChapterRow; course: CourseDetail; snapshot: Snapshot }) {
  const item = snapshot.byChapter[chapter.id];
  if (!item && !chapter.downloadBytes) return null;
  const size = chapter.downloadBytes?.[snapshot.quality];

  const press = async () => {
    if (!item) {
      downloads.add([{ id: chapter.id, title: chapter.title, type: chapter.type, durationS: chapter.durationS }], courseInfo(course));
      return;
    }
    if (item.state === 'failed') {
      Alert.alert(chapter.title, item.problem?.message ?? "It didn't download.", [
        { text: 'Remove', style: 'destructive', onPress: () => void downloads.remove(chapter.id) },
        { text: 'Try again', onPress: () => downloads.retry(chapter.id) },
      ]);
      return;
    }
    const done = item.state === 'done';
    const ok = await confirmAsync(
      done ? 'Remove the download?' : 'Stop downloading?',
      done ? `${chapter.title} comes off this phone. It's still yours, and plays here whenever you're online.` : `${chapter.title} stops downloading, and what's saved so far is deleted.`,
      done ? 'Remove' : 'Stop',
    );
    if (ok) await downloads.remove(chapter.id);
  };

  const look = !item
    ? { icon: 'arrow-down-circle-outline' as const, color: colors.ink, label: `Download ${chapter.title}${size ? `, about ${sizeLabel(size)}` : ''}` }
    : item.state === 'done'
      ? { icon: 'arrow-down-circle' as const, color: colors.sage, label: `${chapter.title} is downloaded. Remove it` }
      : item.state === 'failed'
        ? { icon: 'alert-circle-outline' as const, color: colors.brand, label: `${chapter.title} didn't download. See why` }
        : item.state === 'downloading'
          ? null
          : { icon: 'time-outline' as const, color: colors.inkSoft, label: `${chapter.title} is waiting to download. Stop it` };

  return (
    <Pressable accessibilityRole="button" accessibilityLabel={look?.label ?? `Downloading ${chapter.title}. Stop it`} hitSlop={10} onPress={() => void press()} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
      {look ? <Ionicons name={look.icon} size={26} color={look.color} /> : <Progress item={item!} />}
    </Pressable>
  );
}

/** A small ring-ish meter: the share saved so far, as a number inside a circle. */
function Progress({ item }: { item: Item }) {
  const share = item.total ? Math.min(99, Math.floor((item.written / item.total) * 100)) : 0;
  return (
    <View style={styles.progress}>
      <Text style={styles.progressText}>{share}</Text>
    </View>
  );
}

/** Under the course's Start button: download every chapter, or what's happening with the ones already asked for. */
export function CourseDownloads({ course, snapshot }: { course: CourseDetail; snapshot: Snapshot }) {
  const saveable = course.chapters.filter((c) => c.downloadBytes);
  const mine = course.chapters.map((c) => snapshot.byChapter[c.id]).filter((i): i is Item => Boolean(i));
  if (!saveable.length && !mine.length) return null;

  const done = mine.filter((i) => i.state === 'done');
  const going = mine.filter((i) => i.state === 'queued' || i.state === 'downloading' || i.state === 'paused');
  const missing = saveable.filter((c) => !snapshot.byChapter[c.id] || snapshot.byChapter[c.id].state === 'failed');
  const bytes = missing.reduce((sum, c) => sum + (c.downloadBytes?.[snapshot.quality] ?? 0), 0);

  if (going.length) {
    const why = waitingWords(snapshot);
    const waiting = why ? ` · ${why}` : '';
    return (
      <View style={styles.course}>
        <Muted style={styles.center}>
          {done.length} of {done.length + going.length} {done.length + going.length === 1 ? 'chapter' : 'chapters'} downloaded{waiting}
        </Muted>
        {snapshot.waiting === 'wifi' || snapshot.block ? <Button variant="quiet" title="See downloads" onPress={() => router.push('/downloads')} /> : null}
      </View>
    );
  }
  if (!missing.length) {
    return (
      <View style={styles.course}>
        <Muted style={styles.center}>
          {done.length === 1 ? 'The chapter is' : `All ${done.length} chapters are`} on this phone, and play without a connection.
        </Muted>
        <Button variant="quiet" title="Downloads" onPress={() => router.push('/downloads')} />
      </View>
    );
  }
  const title = done.length ? `Download the other ${missing.length}` : missing.length === 1 ? 'Download it' : `Download all ${missing.length} chapters`;
  return (
    <Button
      variant="secondary"
      icon="arrow-down-circle-outline"
      title={bytes ? `${title} · ${sizeLabel(bytes)}` : title}
      onPress={() =>
        downloads.add(
          missing.map((c) => ({ id: c.id, title: c.title, type: c.type, durationS: c.durationS })),
          courseInfo(course),
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  button: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.5 },
  progress: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  progressText: { fontFamily: fonts.bold, fontSize: 10, color: colors.ink },
  course: { gap: space(1), alignItems: 'center' },
  center: { textAlign: 'center' },
});
