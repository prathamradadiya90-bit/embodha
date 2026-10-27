import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { api, withCurrency } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { CourseCard as Course } from '../lib/types';
import { Chip, CourseCard, ErrorView, Loading, Muted, Screen, Section } from '../ui/components';
import { colors, radius, space } from '../ui/theme';

export { ErrorBoundary } from '../ui/error-boundary';

interface Results {
  courses: Course[];
  topics: { slug: string; name: string; category: string }[];
}

/** Searches course titles, descriptions, topics and instructor names as you type. */
export default function Search() {
  const { signedIn } = useAuth();
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setTerm(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);

  const query = useQuery({
    queryKey: ['search', term, signedIn],
    queryFn: () => api<Results>(withCurrency(`/v1/search?q=${encodeURIComponent(term)}`)),
    enabled: term.length >= 2,
  });

  return (
    <Screen edges={[]}>
      <View style={styles.box}>
        <Ionicons name="search" size={20} color={colors.inkSoft} />
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Try “sleep”, “back” or a teacher's name"
          placeholderTextColor={colors.inkSoft}
          autoFocus
          autoCorrect={false}
          returnKeyType="search"
          style={styles.input}
          accessibilityLabel="Search"
        />
      </View>
      {term.length < 2 ? (
        <Muted style={styles.hint}>Type at least two letters.</Muted>
      ) : query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorView onRetry={() => void query.refetch()} />
      ) : !query.data.courses.length && !query.data.topics.length ? (
        <Muted style={styles.hint}>Nothing matches “{term}” yet. New courses arrive every month.</Muted>
      ) : (
        <>
          {query.data.topics.length ? (
            <Section title="Topics">
              <View style={styles.chips}>
                {query.data.topics.map((topic) => (
                  <Chip key={topic.slug} label={`${topic.name} · ${topic.category}`} onPress={() => router.push(`/topic/${topic.slug}`)} />
                ))}
              </View>
            </Section>
          ) : null}
          {query.data.courses.length ? (
            <Section title="Courses">
              <View style={styles.list}>
                {query.data.courses.map((course) => (
                  <CourseCard key={course.id} course={course} />
                ))}
              </View>
            </Section>
          ) : null}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'center', gap: space(2), backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: space(4) },
  input: { flex: 1, fontSize: 17, color: colors.ink, paddingVertical: space(3) },
  hint: { marginTop: space(5) },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  list: { gap: space(7) },
});
