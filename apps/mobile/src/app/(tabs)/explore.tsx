import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../../lib/api';
import type { Category } from '../../lib/types';
import { ArrowUpRight, Chip, ErrorView, Loading, pastelAt, Screen, Star, tileAt, TopBar } from '../../ui/components';
import { colors, fonts, outline, radius, space } from '../../ui/theme';

export { ErrorBoundary } from '../../ui/error-boundary';

export default function Explore() {
  const { category } = useLocalSearchParams<{ category?: string }>();
  const query = useQuery({ queryKey: ['categories'], queryFn: () => api<Category[]>('/v1/categories') });

  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorView onRetry={() => void query.refetch()} />;
  const shown = category ? query.data.filter((c) => c.slug === category) : query.data;

  return (
    <Screen tone="lilac">
      <TopBar />
      <View>
        <Text style={styles.giant} numberOfLines={1} adjustsFontSizeToFit>
          Explore
        </Text>
        <Star size={46} color={colors.pink} style={styles.star} />
      </View>
      <Text style={styles.sub}>A practice for every kind of day</Text>

      <Pressable accessibilityRole="search" onPress={() => router.push('/search')} style={({ pressed }) => [styles.search, pressed && { opacity: 0.8 }]}>
        <Ionicons name="search" size={18} color={colors.ink} />
        <Text style={styles.searchText}>Courses, topics, teachers</Text>
      </Pressable>

      <View style={styles.chips}>
        <Chip label="All" selected={!category} onPress={() => router.setParams({ category: '' })} />
        {query.data.map((c) => (
          <Chip key={c.slug} label={c.name} selected={c.slug === category} onPress={() => router.setParams({ category: c.slug })} />
        ))}
      </View>

      {shown.map((c, n) => (
        <View key={c.slug} style={styles.section}>
          <Text style={styles.sectionTitle}>{c.name}</Text>
          <View style={styles.grid}>
            {c.topics.map((topic, i) => {
              const open = topic.courseCount > 0;
              return (
                <Pressable
                  key={topic.slug}
                  accessibilityRole="button"
                  onPress={() => router.push(`/topic/${topic.slug}`)}
                  style={({ pressed }) => [
                    styles.tile,
                    { backgroundColor: open ? tileAt(i + n * 3) : pastelAt(i + n), minHeight: i % 3 === 0 ? 138 : 116 },
                    pressed && { opacity: 0.75 },
                  ]}
                >
                  <View style={styles.arrow}>
                    <ArrowUpRight />
                  </View>
                  <Text style={styles.tileTitle}>{topic.name}</Text>
                  <Text style={styles.tileMeta}>{open ? `${topic.courseCount} ${topic.courseCount === 1 ? 'course' : 'courses'}` : 'Coming soon'}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  giant: { fontFamily: fonts.display, fontSize: 92, lineHeight: 96, letterSpacing: -2, color: colors.ink, textTransform: 'uppercase', marginLeft: -4 },
  star: { position: 'absolute', right: 0, top: 0 },
  sub: { fontFamily: fonts.display, fontSize: 28, lineHeight: 32, color: colors.ink, textTransform: 'uppercase', marginTop: space(1), maxWidth: 300 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2),
    backgroundColor: colors.surface,
    borderWidth: outline,
    borderColor: colors.line,
    borderRadius: radius.pill,
    paddingHorizontal: space(5),
    paddingVertical: space(4),
    marginTop: space(6),
  },
  searchText: { fontFamily: fonts.body, fontSize: 16, color: colors.inkSoft },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginTop: space(4) },
  section: { marginTop: space(10) },
  sectionTitle: { fontFamily: fonts.heavy, fontSize: 30, lineHeight: 36, color: colors.ink, textTransform: 'uppercase', marginBottom: space(4) },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space(3) },
  tile: { width: '48%', flexGrow: 1, borderRadius: radius.md + 4, borderWidth: outline, borderColor: colors.line, padding: space(4), justifyContent: 'flex-end' },
  arrow: { position: 'absolute', top: space(3), right: space(3) },
  tileTitle: { fontFamily: fonts.heavy, fontSize: 21, lineHeight: 25, textTransform: 'uppercase', color: colors.ink, paddingRight: space(4) },
  tileMeta: { fontFamily: fonts.medium, fontSize: 13, color: colors.ink, marginTop: 2 },
});
