import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { track } from '../../lib/analytics';
import { api, withCurrency } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { downloadsSupported, useDownloads } from '../../lib/downloads';
import { levelLabel, minutes } from '../../lib/format';
import type { AccessVia, ChapterRow, CourseDetail } from '../../lib/types';
import { useBuyCourse, useStorePrice, useSubscribe } from '../../ui/checkout';
import { Body, Button, Card, Cover, ErrorView, H1, H2, Loading, Muted, Screen } from '../../ui/components';
import { ChapterDownload, CourseDownloads, downloadNote } from '../../ui/downloads-ui';
import { Reviews } from '../../ui/reviews';
import { SiteLinks } from '../../ui/site-links';
import { colors, fonts, space } from '../../ui/theme';

export { ErrorBoundary } from '../../ui/error-boundary';

const accessLine: Record<AccessVia, string> = {
  free: 'Free for everyone',
  purchase: 'Yours to keep',
  grant: 'Added to your library by Embodha',
  subscription: 'Included in your subscription',
  instructor: 'Your course',
};

export default function CourseScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { signedIn } = useAuth();
  const query = useQuery({ queryKey: ['course', slug, signedIn], queryFn: () => api<CourseDetail>(withCurrency(`/v1/courses/${slug}`)) });
  const { buy, busy } = useBuyCourse();
  const { subscribe, busy: subscribing } = useSubscribe();
  const saved = useDownloads();
  // In the phone apps the store sets the price, in the member's own currency; show theirs once it loads.
  const forSale = Boolean(query.data && !query.data.access.unlocked);
  const storeCoursePrice = useStorePrice('course', query.data?.id, forSale && Boolean(query.data?.price));
  const storePlanPrice = useStorePrice('instructor', query.data?.instructor.id, forSale && Boolean(query.data?.instructorSubscription?.price));
  // Once per visit. "owned" covers free and subscribed too: a page someone already has isn't a chance to sell it.
  const viewed = query.data ? { courseId: query.data.id, slug: query.data.slug, owned: query.data.access.unlocked } : null;
  useEffect(() => {
    if (viewed) track('course_view', viewed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewed?.courseId]);

  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorView message={query.error.message} onRetry={() => void query.refetch()} />;
  const course = query.data;
  const next = course.chapters.find((c) => c.playable && !c.progress?.completed) ?? course.chapters.find((c) => c.playable);
  const preview = course.chapters.find((c) => c.isPreview);
  const open = (chapter: ChapterRow) => (chapter.playable ? router.push(`/play/${chapter.id}`) : void buy({ id: course.id, title: course.title }));
  const facts = [course.instructor.displayName, levelLabel(course.level), minutes(course.totalDurationS) || `${course.chapters.length} chapters`];
  // Downloads come with a course the member has, in the phone apps.
  const canSave = downloadsSupported && signedIn && course.access.unlocked;

  return (
    <Screen edges={[]}>
      <Cover seed={course.slug} uri={course.coverUrl} height={180} />
      <Muted style={styles.place}>
        {course.category.name} · {course.topic.name}
      </Muted>
      <H1>{course.title}</H1>
      <Body style={styles.facts}>{facts.filter(Boolean).join(' · ')}</Body>

      <View style={styles.actions}>
        {course.access.unlocked ? (
          <Button title={next?.progress ? 'Continue' : 'Start'} icon="play" disabled={!next} onPress={() => next && open(next)} />
        ) : (
          <>
            {course.price ? (
              <Button title={`Unlock for ${storeCoursePrice ?? course.price.display}`} loading={busy} onPress={() => void buy({ id: course.id, title: course.title })} />
            ) : null}
            {preview ? <Button variant="secondary" title="Play the free preview" icon="play" onPress={() => open(preview)} /> : null}
          </>
        )}
        {course.access.via ? <Muted style={styles.center}>{accessLine[course.access.via]}</Muted> : null}
        {canSave ? <CourseDownloads course={course} snapshot={saved} /> : null}
      </View>

      {!course.access.unlocked && course.instructorSubscription?.price ? (
        <Card color={colors.violet} style={styles.block}>
          <Text style={styles.offerTitle}>Or subscribe to {course.instructor.displayName}</Text>
          <Body>{storePlanPrice ?? course.instructorSubscription.price.display} a month for every course they teach, including new ones. Stop renewing any time.</Body>
          <View style={styles.subscribe}>
            <Button
              variant="secondary"
              title={`Subscribe for ${storePlanPrice ?? course.instructorSubscription.price.display} a month`}
              loading={subscribing}
              onPress={() => void subscribe({ id: course.instructor.id, displayName: course.instructor.displayName })}
            />
          </View>
          <SiteLinks pages={['terms', 'privacy']} align="start" style={styles.subscribe} />
        </Card>
      ) : null}

      {course.cautions ? (
        <Card color={colors.butter} style={[styles.block, styles.caution]}>
          <Ionicons name="information-circle-outline" size={22} color={colors.inkSoft} />
          <Body style={styles.flex}>{course.cautions}</Body>
        </Card>
      ) : null}

      {course.description ? <Body style={styles.block}>{course.description}</Body> : null}
      {course.equipment.length ? <Muted style={styles.block}>You'll need: {course.equipment.join(', ')}</Muted> : null}

      <H2 style={styles.chaptersTitle}>Chapters</H2>
      {course.chapters.map((chapter, i) => {
        const note = [
          chapter.type === 'audio' ? 'Audio' : 'Video',
          minutes(chapter.durationS),
          chapter.isPreview && !course.access.unlocked ? 'Free preview' : '',
          chapter.ready ? '' : 'Processing',
          canSave ? downloadNote(saved.byChapter[chapter.id], saved) : '',
        ].filter(Boolean);
        const iconName = chapter.progress?.completed ? 'checkmark-circle' : chapter.playable ? 'play-circle-outline' : 'lock-closed-outline';
        return (
          <Pressable key={chapter.id} accessibilityRole="button" onPress={() => open(chapter)} style={({ pressed }) => [styles.chapter, pressed && { opacity: 0.6 }]}>
            <Text style={styles.chapterNumber}>{i + 1}</Text>
            <View style={styles.flex}>
              <Text style={styles.chapterTitle}>{chapter.title}</Text>
              <Muted>{note.join(' · ')}</Muted>
            </View>
            {canSave ? <ChapterDownload chapter={chapter} course={course} snapshot={saved} /> : null}
            <Ionicons name={iconName} size={24} color={chapter.playable ? colors.maroon : colors.inkSoft} />
          </Pressable>
        );
      })}
      <Reviews slug={course.slug} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  place: { marginTop: space(5) },
  facts: { color: colors.inkSoft },
  actions: { marginVertical: space(6), gap: space(3) },
  center: { textAlign: 'center' },
  block: { marginBottom: space(5) },
  subscribe: { marginTop: space(3) },
  offerTitle: { fontFamily: fonts.heavy, fontSize: 24, lineHeight: 28, textTransform: 'uppercase', color: colors.ink, marginBottom: space(2) },
  caution: { flexDirection: 'row', gap: space(3), alignItems: 'flex-start' },
  flex: { flex: 1 },
  chaptersTitle: { marginTop: space(2) },
  chapter: { flexDirection: 'row', alignItems: 'center', gap: space(4), paddingVertical: space(4), borderBottomWidth: 1, borderBottomColor: colors.line },
  chapterNumber: { width: 30, fontFamily: fonts.heavy, fontSize: 22, color: colors.ink, textAlign: 'center' },
  chapterTitle: { fontFamily: fonts.medium, fontSize: 16, color: colors.ink, marginBottom: 2 },
});
