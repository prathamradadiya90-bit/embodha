import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { api, withCurrency } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { Topic } from '../../lib/types';
import { CourseCard, ErrorView, H1, Loading, Muted, Screen } from '../../ui/components';
import { space } from '../../ui/theme';

export { ErrorBoundary } from '../../ui/error-boundary';

export default function TopicScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { signedIn } = useAuth();
  const query = useQuery({ queryKey: ['topic', slug, signedIn], queryFn: () => api<Topic>(withCurrency(`/v1/topics/${slug}`)) });

  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorView message={query.error.message} onRetry={() => void query.refetch()} />;
  const topic = query.data;

  return (
    <Screen edges={[]}>
      <Muted>{topic.category.name}</Muted>
      <H1>{topic.name}</H1>
      {topic.courses.length ? (
        <View style={styles.list}>
          {topic.courses.map((course) => (
            <CourseCard key={course.id} course={course} />
          ))}
        </View>
      ) : (
        <Muted>No courses in this topic yet.</Muted>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({ list: { gap: space(7), marginTop: space(5) } });
