import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, Text } from 'react-native';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import type { Bell } from '../lib/types';
import { Body, Card, ErrorView, Loading, Muted, Screen } from '../ui/components';
import { colors, space } from '../ui/theme';

export { ErrorBoundary } from '../ui/error-boundary';

export default function NotificationsScreen() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['bell'], queryFn: () => api<Bell>('/v1/notifications') });
  const unread = query.data?.unread ?? 0;

  // Opening the bell counts as reading what's in it. Unread ones keep their highlight until the next visit.
  useEffect(() => {
    if (!unread) return;
    void api('/v1/notifications/read', { method: 'POST', body: {} }).then(() => queryClient.invalidateQueries({ queryKey: ['unread'] }));
  }, [unread, queryClient]);

  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorView onRetry={() => void query.refetch()} />;

  return (
    <Screen edges={[]}>
      {query.data.items.length ? (
        query.data.items.map((item) => (
          <Card
            key={item.id}
            style={[styles.item, !item.readAt && styles.unread]}
            onPress={item.deepLink && item.deepLink !== '/notifications' ? () => router.push(item.deepLink!) : undefined}
          >
            <Text style={styles.title}>{item.title}</Text>
            <Body>{item.body}</Body>
            <Muted style={styles.when}>{ago(item.createdAt)}</Muted>
          </Card>
        ))
      ) : (
        <Muted>Nothing yet. News from Embodha and your instructors shows up here.</Muted>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  item: { marginBottom: space(3), gap: space(1) },
  unread: { borderColor: colors.maroon, backgroundColor: colors.maroonSoft },
  title: { fontSize: 16, fontWeight: '600', color: colors.ink },
  when: { marginTop: space(1) },
});
