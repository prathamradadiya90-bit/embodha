import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { downloads, downloadsSupported, sizeLabel, useDownloads, type Item, type Snapshot } from '../lib/downloads';
import { Body, Button, Card, Chip, confirmAsync, H1, H2, Muted, notify, Screen, Section } from '../ui/components';
import { downloadNote } from '../ui/downloads-ui';
import { colors, fonts, space } from '../ui/theme';

export { ErrorBoundary } from '../ui/error-boundary';

interface Phones {
  limit: number;
  keepDays: number;
  devices: { id: string; platform: 'ios' | 'android'; label: string | null; checkedAt: string; chapters: number; counts: boolean; thisPhone: boolean }[];
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const phoneName = (d: { label: string | null; platform: 'ios' | 'android' }) => d.label ?? (d.platform === 'ios' ? 'An iPhone' : 'An Android phone');

export default function DownloadsScreen() {
  const { signedIn } = useAuth();
  const saved = useDownloads();

  if (!downloadsSupported) {
    return (
      <Screen edges={['bottom']}>
        <H1>Downloads</H1>
        <Body>Downloads are in the Embodha app for iPhone and Android. In a browser, chapters stream.</Body>
      </Screen>
    );
  }
  if (!signedIn) {
    return (
      <Screen edges={['bottom']}>
        <H1>Downloads</H1>
        <Body style={styles.gap}>Sign in, and the chapters of courses you have can be kept on this phone to play without a connection.</Body>
        <Button title="Sign in" onPress={() => router.push('/sign-in')} />
      </Screen>
    );
  }

  const done = saved.items.filter((i) => i.state === 'done');
  const courses = groupByCourse(saved.items);
  const soonest = done.map((i) => i.keepUntil).filter((v): v is string => Boolean(v)).sort()[0];
  const lapsed = soonest ? Date.parse(soonest) <= Date.now() : false;

  return (
    <Screen edges={['bottom']}>
      <H1>Downloads</H1>
      <Muted>
        {[saved.usedBytes ? `${sizeLabel(saved.usedBytes)} on this phone` : 'Nothing on this phone yet', saved.freeBytes !== null ? `${sizeLabel(saved.freeBytes)} free` : null]
          .filter(Boolean)
          .join(' · ')}
      </Muted>

      {saved.notices.map((notice) => (
        <Card key={notice.id} color={colors.butter} style={[styles.spaced, styles.row]}>
          <Body style={styles.flex}>{notice.text}</Body>
          <Pressable accessibilityLabel="Dismiss" hitSlop={10} onPress={() => downloads.dismiss(notice.id)}>
            <Ionicons name="close" size={20} color={colors.ink} />
          </Pressable>
        </Card>
      ))}

      {lapsed ? (
        <Card color={colors.peach} style={styles.spaced}>
          <Body>{saved.online ? 'Checking your downloads with Embodha…' : `Your downloads need a connection: they played offline until ${day(soonest!)}. Go online once and they play for another month.`}</Body>
        </Card>
      ) : null}

      <Queue snapshot={saved} />

      {courses.map(({ courseId, items }) => {
        const course = saved.courses[courseId];
        const bytes = items.reduce((sum, i) => sum + (i.state === 'done' ? i.written : 0), 0);
        return (
          <View key={courseId} style={styles.course}>
            <Pressable accessibilityRole="link" onPress={() => course && router.push(`/course/${course.slug}`)}>
              <H2 style={styles.courseTitle}>{course?.title ?? 'A course'}</H2>
            </Pressable>
            <Muted>{[course?.instructor, bytes ? sizeLabel(bytes) : null].filter(Boolean).join(' · ')}</Muted>
            {items.map((item) => (
              <ChapterLine key={item.chapterId} item={item} snapshot={saved} />
            ))}
            <Button
              variant="quiet"
              title="Remove this course's downloads"
              onPress={() =>
                void confirmAsync('Remove these downloads?', `${course?.title ?? 'The course'} comes off this phone. It's still yours, and plays whenever you're online.`, 'Remove').then(
                  (ok) => ok && downloads.removeCourse(courseId),
                )
              }
            />
          </View>
        );
      })}

      {!saved.items.length ? (
        <Card style={styles.spaced}>
          <Body>Nothing downloaded yet.</Body>
          <Muted>On a course you have, tap the arrow next to a chapter, or download them all from under the Start button. They play without a connection: on a flight, in the hills, in a basement studio.</Muted>
        </Card>
      ) : null}

      <Section title="Settings">
        <Card>
          <Body>Quality</Body>
          <Muted>
            {saved.quality === 'standard'
              ? 'Standard: about 12 MB for each minute of video. Sharp on a phone.'
              : 'High: about 23 MB for each minute of video. Sharper on a tablet or a TV.'}{' '}
            Audio chapters are the same either way, about 1 MB a minute.
          </Muted>
          <View style={styles.chips}>
            <Chip label="Standard" selected={saved.quality === 'standard'} onPress={() => downloads.setQuality('standard')} />
            <Chip label="High" selected={saved.quality === 'high'} onPress={() => downloads.setQuality('high')} />
          </View>
        </Card>
        <Card style={[styles.spaced, styles.row]}>
          <View style={styles.flex}>
            <Body>Download over mobile data</Body>
            <Muted>
              {saved.mobileData
                ? 'On: downloads use mobile data when there is no Wi-Fi.'
                : Platform.OS === 'ios'
                  ? 'Off: downloads wait for Wi-Fi, and run while Embodha is open.'
                  : 'Off: downloads wait for Wi-Fi.'}
            </Muted>
          </View>
          <Switch value={saved.mobileData} onValueChange={(on) => downloads.setMobileData(on)} trackColor={{ true: colors.maroon, false: colors.line }} thumbColor="#FFFFFF" />
        </Card>
      </Section>

      <PhonesSection snapshot={saved} />

      <Muted style={styles.footnote}>
        Downloads play without a connection for 30 days after the phone was last online, and every time Embodha opens online that starts again. They come off the phone when you sign out, and when a
        course stops being yours.
      </Muted>
      {saved.items.length ? (
        <View style={styles.actions}>
          <Button
            variant="quiet"
            title="Delete all downloads"
            onPress={() => void confirmAsync('Delete all downloads?', 'Everything saved on this phone is deleted. Your courses stay yours.', 'Delete').then((ok) => ok && downloads.removeAll())}
          />
        </View>
      ) : null}
    </Screen>
  );
}

/** What's downloading now, what's waiting, and why it might be stuck. */
function Queue({ snapshot }: { snapshot: Snapshot }) {
  const going = snapshot.items.filter((i) => i.state === 'queued' || i.state === 'downloading' || i.state === 'paused');
  if (!going.length && !snapshot.block) return null;
  const current = going.find((i) => i.state === 'downloading');
  const rest = going.length - (current ? 1 : 0);
  const why = snapshot.block
    ? snapshot.block.message
    : snapshot.waiting === 'wifi'
      ? 'Waiting for Wi-Fi. Switch on mobile data below to download now.'
      : snapshot.waiting === 'offline'
        ? 'Waiting for a connection.'
        : snapshot.waiting === 'background'
          ? 'Downloads carry on when Embodha is open. With mobile data on, they also run in the background.'
          : snapshot.waiting === 'retrying'
            ? "Couldn't reach Embodha just now. Trying again shortly."
            : snapshot.waiting === 'paused'
              ? 'Paused.'
              : null;
  return (
    <Card color={snapshot.block ? colors.peach : colors.mint} style={styles.spaced}>
      {current ? (
        <>
          <Body>{current.title}</Body>
          <Muted>
            {current.total ? `${Math.floor((current.written / current.total) * 100)}% of ${sizeLabel(current.total)}` : 'Starting'}
            {rest ? ` · ${rest} more after it` : ''}
          </Muted>
        </>
      ) : (
        <Body>{going.length === 1 ? 'One chapter to download' : `${going.length} chapters to download`}</Body>
      )}
      {why ? <Muted style={styles.why}>{why}</Muted> : null}
      <View style={styles.queueActions}>
        {snapshot.block ? (
          <Button variant="secondary" title="Try again" onPress={() => downloads.unblock()} />
        ) : snapshot.paused ? (
          <Button variant="secondary" title="Resume" onPress={() => downloads.resume()} />
        ) : (
          <Button variant="secondary" title="Pause" onPress={() => downloads.pause()} />
        )}
      </View>
    </Card>
  );
}

function ChapterLine({ item, snapshot }: { item: Item; snapshot: Snapshot }) {
  const failed = item.state === 'failed';
  return (
    <View style={styles.chapter}>
      <Ionicons
        name={
          item.state === 'done' ? (item.type === 'audio' ? 'headset-outline' : 'videocam-outline') : failed ? 'alert-circle-outline' : item.state === 'downloading' ? 'arrow-down-circle-outline' : 'time-outline'
        }
        size={20}
        color={failed ? colors.brand : colors.ink}
      />
      <Pressable style={styles.flex} disabled={item.state !== 'done'} onPress={() => router.push(`/play/${item.chapterId}`)} accessibilityRole="button">
        <Text style={styles.chapterTitle}>{item.title}</Text>
        <Muted>{failed ? (item.problem?.message ?? "Didn't download.") : downloadNote(item, snapshot, true)}</Muted>
      </Pressable>
      {failed ? (
        <Pressable accessibilityLabel={`Try ${item.title} again`} hitSlop={8} onPress={() => downloads.retry(item.chapterId)}>
          <Ionicons name="refresh" size={20} color={colors.ink} />
        </Pressable>
      ) : null}
      <Pressable accessibilityLabel={`Remove ${item.title}`} hitSlop={8} onPress={() => void downloads.remove(item.chapterId)}>
        <Ionicons name="trash-outline" size={20} color={colors.inkSoft} />
      </Pressable>
    </View>
  );
}

/** The member's phones with downloads, so a full set can make room: remove one, and its place frees up now. */
function PhonesSection({ snapshot }: { snapshot: Snapshot }) {
  const queryClient = useQueryClient();
  const phones = useQuery({
    queryKey: ['download-phones', snapshot.deviceId],
    queryFn: () => api<Phones>(`/v1/downloads/devices?deviceId=${encodeURIComponent(snapshot.deviceId)}`),
    enabled: snapshot.online,
    retry: false,
  });
  const others = phones.data?.devices.filter((d) => !d.thisPhone) ?? [];
  if (!snapshot.block && !others.length) return null;

  const remove = async (device: Phones['devices'][number]) => {
    const name = phoneName(device);
    const ok = await confirmAsync(`Remove ${name}?`, `Its downloads are deleted from it the next time it's online, and its place frees up now.`, 'Remove');
    if (!ok) return;
    try {
      await api(`/v1/downloads/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['download-phones'] });
      if (snapshot.block?.code === 'device_limit') downloads.unblock();
    } catch (error) {
      notify("Couldn't remove it", error instanceof Error ? error.message : 'Try again in a moment.');
    }
  };

  return (
    <Section title="Your phones">
      <Muted style={styles.why}>
        {phones.data
          ? `Downloads can be on ${phones.data.limit} phones at a time. A phone that hasn't been online for ${phones.data.keepDays} days doesn't count.`
          : snapshot.online
            ? 'Looking…'
            : 'Go online to see the phones your downloads are on.'}
      </Muted>
      {phones.data?.devices.map((device) => (
        <Card key={device.id} style={[styles.spaced, styles.row]}>
          <View style={styles.flex}>
            <Body>
              {phoneName(device)}
              {device.thisPhone ? ' (this phone)' : ''}
            </Body>
            <Muted>
              {device.chapters} {device.chapters === 1 ? 'chapter' : 'chapters'}
              {device.thisPhone ? '' : ` · last online ${day(device.checkedAt)}${device.counts ? '' : ", so it doesn't count"}`}
            </Muted>
          </View>
          {device.thisPhone ? null : <Button variant="secondary" title="Remove" onPress={() => void remove(device)} />}
        </Card>
      ))}
    </Section>
  );
}

function groupByCourse(items: Item[]) {
  const groups: { courseId: string; items: Item[] }[] = [];
  for (const item of items) {
    const group = groups.find((g) => g.courseId === item.courseId);
    if (group) group.items.push(item);
    else groups.push({ courseId: item.courseId, items: [item] });
  }
  return groups;
}

const styles = StyleSheet.create({
  gap: { marginVertical: space(4) },
  spaced: { marginTop: space(3) },
  row: { flexDirection: 'row', alignItems: 'center', gap: space(3) },
  flex: { flex: 1 },
  course: { marginTop: space(8) },
  courseTitle: { marginBottom: space(1) },
  chapter: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingVertical: space(3), borderBottomWidth: 1, borderBottomColor: colors.hairline },
  chapterTitle: { fontFamily: fonts.medium, fontSize: 16, color: colors.ink, marginBottom: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginTop: space(3) },
  why: { marginTop: space(2) },
  queueActions: { marginTop: space(3), alignItems: 'flex-start' },
  footnote: { marginTop: space(10) },
  actions: { marginTop: space(4) },
});
