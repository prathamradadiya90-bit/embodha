import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api, withCurrency } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { clock, greeting, todayLocal } from '../../lib/format';
import type { Home, Stats } from '../../lib/types';
import { ArrowUpRight, Body, Card, CircleBadge, CourseCard, ErrorView, Headline, Label, Loading, Muted, Screen, Section, Star, tileAt, TopBar } from '../../ui/components';
import { DailyClip, DailyPhoto } from '../../ui/daily';
import { colors, fonts, outline, radius, space } from '../../ui/theme';

export { ErrorBoundary } from '../../ui/error-boundary';

export default function Today() {
  const { signedIn, me } = useAuth();
  const home = useQuery({ queryKey: ['home', signedIn], queryFn: () => api<Home>(withCurrency(`/v1/home?date=${todayLocal()}`)) });
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => api<Stats>('/v1/me/stats'), enabled: signedIn });
  const bell = useQuery({
    queryKey: ['unread'],
    queryFn: () => api<{ unread: number }>('/v1/notifications/unread'),
    enabled: signedIn,
    refetchInterval: 60_000,
  });
  const unread = bell.data?.unread ?? 0;

  if (home.isPending) return <Loading />;
  if (home.isError) return <ErrorView onRetry={() => void home.refetch()} />;
  const { breathing, daily, dailyImage, dailyClip, continueWatching, freeCourse, newCourses, categories } = home.data;
  const firstName = me?.name?.split(' ')[0];
  const streak = stats.data?.streakDays ?? 0;

  return (
    <Screen tone="peach">
      <TopBar>
        <Pressable accessibilityRole="search" accessibilityLabel="Search" onPress={() => router.push('/search')} hitSlop={12}>
          <Ionicons name="search" size={22} color={colors.ink} />
        </Pressable>
        {signedIn ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={unread ? `Notifications, ${unread} unread` : 'Notifications'}
            onPress={() => router.push('/notifications')}
            hitSlop={12}
          >
            <Ionicons name="notifications-outline" size={23} color={colors.ink} />
            {unread ? <View style={styles.unreadDot} /> : null}
          </Pressable>
        ) : (
          <Pressable accessibilityRole="button" onPress={() => router.push('/sign-in')} hitSlop={12}>
            <Label>Sign in</Label>
          </Pressable>
        )}
      </TopBar>

      <View style={styles.hero}>
        <Headline
          lines={
            firstName
              ? [
                  [greeting(), 'thin'],
                  [`${firstName},`, 'heavy'],
                  ['breathe first', 'thin'],
                ]
              : [
                  [greeting(), 'thin'],
                  ['breathe', 'heavy'],
                  ['then begin', 'thin'],
                ]
          }
        />
        <View style={styles.badge}>
          <CircleBadge label="Today's breath" color={colors.surface} onPress={() => router.push('/breathe')} />
        </View>
      </View>

      <View style={styles.pill}>
        <Star size={14} color={colors.ink} />
        <Text style={styles.pillText}>{streak > 1 ? `${streak} days in a row` : streak === 1 ? 'Day one of your streak' : 'Your streak starts today'}</Text>
      </View>

      {signedIn && me && !me.profileComplete ? (
        <Card color={colors.lilac} onPress={() => router.push('/onboarding')} style={styles.block}>
          <Label>One more step</Label>
          <Body style={styles.gapTop}>Finish setting up your account so we can show the right prices and reminders.</Body>
        </Card>
      ) : null}

      <Card color={colors.cyan} onPress={() => router.push('/breathe')} style={[styles.block, styles.breath]}>
        <View style={styles.flex}>
          <Label>Play today's breath</Label>
          <Text style={styles.breathTitle}>{breathing?.name ?? 'Box breathing'}</Text>
          <Body>A minute or two. Eyes closed if you like.</Body>
        </View>
        <View style={styles.play}>
          <Ionicons name="play" size={24} color="#FFFFFF" style={{ marginLeft: 3 }} />
        </View>
      </Card>

      {daily?.text ? (
        <View style={styles.quote}>
          <Star size={34} color={colors.pink} style={styles.quoteStar} />
          <Label>Today's line</Label>
          <Text style={styles.quoteText}>{daily.text}</Text>
          {daily.author ? <Muted>— {daily.author}</Muted> : null}
        </View>
      ) : null}

      {dailyImage ? <DailyPhoto photo={dailyImage} /> : null}
      {dailyClip ? <DailyClip clip={dailyClip} /> : null}

      {continueWatching.length ? (
        <Section title="Pick up where you left off">
          <View style={styles.stack}>
            {continueWatching.map((item) => (
              <Card key={item.chapter.id} onPress={() => router.push(`/play/${item.chapter.id}`)} style={styles.continueRow}>
                <View style={styles.playSmall}>
                  <Ionicons name={item.chapter.type === 'audio' ? 'headset' : 'play'} size={18} color="#FFFFFF" />
                </View>
                <View style={styles.flex}>
                  <Text style={styles.continueTitle} numberOfLines={1}>
                    {item.chapter.title}
                  </Text>
                  <Muted>
                    {item.course.title} · at {clock(item.positionS)}
                  </Muted>
                </View>
              </Card>
            ))}
          </View>
        </Section>
      ) : null}

      {freeCourse ? (
        <Section title="Free for everyone">
          <CourseCard course={freeCourse} />
        </Section>
      ) : null}

      <Section title="Find your practice">
        <View style={styles.grid}>
          {[0, 1].map((column) => (
            <View key={column} style={[styles.column, column === 1 && styles.columnOffset]}>
              {categories
                .map((category, index) => ({ category, index }))
                .filter(({ index }) => index % 2 === column)
                .map(({ category, index }, i) => (
                  <Pressable
                    key={category.slug}
                    accessibilityRole="button"
                    onPress={() => router.push({ pathname: '/explore', params: { category: category.slug } })}
                    style={({ pressed }) => [styles.tile, { backgroundColor: tileAt(index), height: (i + column) % 2 ? 150 : 118 }, pressed && styles.pressed]}
                  >
                    <View style={styles.tileArrow}>
                      <ArrowUpRight />
                    </View>
                    <Text style={styles.tileText}>{category.name}</Text>
                  </Pressable>
                ))}
            </View>
          ))}
        </View>
      </Section>

      {newCourses.length ? (
        <Section title="New this month">
          <ScrollView horizontal removeClippedSubviews showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail} style={styles.railBleed}>
            {newCourses.map((course) => (
              <CourseCard key={course.id} course={course} width={220} />
            ))}
          </ScrollView>
        </Section>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  unreadDot: { position: 'absolute', top: -1, right: 0, width: 10, height: 10, borderRadius: 5, backgroundColor: colors.coral, borderWidth: 1.5, borderColor: colors.peach },
  hero: { minHeight: 200 },
  // Beside the streak pill, clear of the headline: a stamp on the page, not over the words.
  badge: { position: 'absolute', right: -space(1), bottom: -space(20) },
  pill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2),
    marginTop: space(6),
    borderWidth: outline,
    borderColor: colors.line,
    borderRadius: radius.pill,
    paddingHorizontal: space(4),
    paddingVertical: space(2),
  },
  pillText: { fontFamily: fonts.medium, fontSize: 14, color: colors.ink },
  block: { marginTop: space(6) },
  gapTop: { marginTop: space(1) },
  breath: { flexDirection: 'row', alignItems: 'center', gap: space(4), paddingVertical: space(6) },
  breathTitle: { fontFamily: fonts.heavy, fontSize: 36, lineHeight: 42, textTransform: 'uppercase', color: colors.ink, marginVertical: space(1) },
  play: { width: 58, height: 58, borderRadius: 29, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  quote: { marginTop: space(10), paddingTop: space(6), borderTopWidth: 1, borderTopColor: colors.hairline },
  quoteStar: { position: 'absolute', right: 0, top: space(5) },
  quoteText: { fontFamily: fonts.display, fontSize: 30, lineHeight: 36, color: colors.ink, marginTop: space(3), marginBottom: space(3), paddingRight: space(8) },
  stack: { gap: space(3) },
  continueRow: { flexDirection: 'row', alignItems: 'center', gap: space(3), padding: space(4) },
  playSmall: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  continueTitle: { fontFamily: fonts.bold, fontSize: 16, color: colors.ink },
  flex: { flex: 1 },
  grid: { flexDirection: 'row', gap: space(3) },
  column: { flex: 1, gap: space(3) },
  columnOffset: { marginTop: space(8) },
  tile: { borderRadius: radius.md + 4, borderWidth: outline, borderColor: colors.line, padding: space(4), justifyContent: 'flex-end' },
  tileArrow: { position: 'absolute', top: space(3), right: space(3) },
  tileText: { fontFamily: fonts.heavy, fontSize: 24, lineHeight: 28, textTransform: 'uppercase', color: colors.ink },
  pressed: { opacity: 0.75 },
  rail: { gap: space(4), paddingHorizontal: space(5) },
  railBleed: { marginHorizontal: -space(5) },
});
