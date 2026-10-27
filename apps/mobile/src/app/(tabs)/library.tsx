import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { router } from 'expo-router';
import { Linking, StyleSheet, View } from 'react-native';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { downloadsSupported, sizeLabel, useDownloads } from '../../lib/downloads';
import { manageSubscriptionsUrl } from '../../lib/store';
import type { Library } from '../../lib/types';
import { Body, Button, Card, confirmAsync, CourseCard, ErrorView, H1, Loading, Muted, notify, Screen, Section, TopBar } from '../../ui/components';
import { space } from '../../ui/theme';

export { ErrorBoundary } from '../../ui/error-boundary';

export default function LibraryTab() {
  const { signedIn } = useAuth();
  const query = useQuery({ queryKey: ['library'], queryFn: () => api<Library>('/v1/library'), enabled: signedIn });

  if (!signedIn) {
    return (
      <Screen tone="sky">
        <TopBar />
        <H1>Your library</H1>
        <Body style={styles.gap}>Courses you buy or start live here, on every device you sign in on.</Body>
        <Button title="Sign in" onPress={() => router.push('/sign-in')} />
      </Screen>
    );
  }
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorView onRetry={() => void query.refetch()} />;
  const { courses, subscriptions } = query.data;

  return (
    <Screen tone="sky">
      <TopBar />
      <H1>Your library</H1>
      <OnThisPhone />
      {subscriptions.length ? (
        <Section title="Subscriptions">
          <View style={styles.stack}>
            {subscriptions.map((s) => (
              <Card key={s.id}>
                <Body>{s.instructor.displayName}</Body>
                <Muted>
                  {s.renews ? `Renews ${new Date(s.accessUntil).toLocaleDateString()}` : `Yours until ${new Date(s.accessUntil).toLocaleDateString()}, then it stops`}
                </Muted>
                {s.renews && s.channel === 'razorpay' ? <StopRenewing id={s.id} name={s.instructor.displayName} until={s.accessUntil} /> : null}
                {s.channel !== 'razorpay' ? <InStore channel={s.channel} renews={s.renews} /> : null}
              </Card>
            ))}
          </View>
        </Section>
      ) : null}
      <Section title="Courses">
        {courses.length ? (
          <View style={styles.stack}>
            {courses.map((course) => (
              <CourseCard key={course.id} course={course} />
            ))}
          </View>
        ) : (
          <Muted>Nothing here yet. Start the free course on Today and it will show up here.</Muted>
        )}
      </Section>
    </Screen>
  );
}

/** What's downloaded, as a way into the Downloads screen. Nothing in the web app, or before the first download. */
function OnThisPhone() {
  const saved = useDownloads();
  const done = saved.items.filter((item) => item.state === 'done');
  if (!downloadsSupported || !saved.items.length) return null;
  const courses = new Set(done.map((item) => item.courseId)).size;
  return (
    <Card onPress={() => router.push('/downloads')} style={styles.downloads}>
      <Body>On this phone</Body>
      <Muted>
        {done.length
          ? `${done.length} ${done.length === 1 ? 'chapter' : 'chapters'} from ${courses} ${courses === 1 ? 'course' : 'courses'}, ${sizeLabel(saved.usedBytes)}. They play without a connection.`
          : 'Downloading now.'}
      </Muted>
    </Card>
  );
}

const styles = StyleSheet.create({
  gap: { marginVertical: space(4) },
  stack: { gap: space(6) },
  downloads: { marginTop: space(2) },
});

/** Apple and Google bill these, so they're changed or stopped in the store, not here. */
function InStore({ channel, renews }: { channel: 'apple' | 'google'; renews: boolean }) {
  const store = channel === 'apple' ? 'the App Store' : 'Google Play';
  const url = manageSubscriptionsUrl(channel);
  if (!url) return <Muted>Billed by {store}. {renews ? 'You can stop it there.' : ''}</Muted>;
  return <Button variant="quiet" title={renews ? `Manage or stop it in ${store}` : `Open ${store} subscriptions`} onPress={() => void Linking.openURL(url)} />;
}

function StopRenewing({ id, name, until }: { id: string; name: string; until: string }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const stop = async () => {
    const date = new Date(until).toLocaleDateString();
    if (!(await confirmAsync(`Stop renewing ${name}?`, `You keep every course of theirs until ${date}. Nothing more is charged.`, 'Stop renewing'))) return;
    setBusy(true);
    try {
      await api(`/v1/me/subscriptions/${id}/cancel`, { method: 'POST' });
      await queryClient.invalidateQueries({ queryKey: ['library'] });
    } catch (error) {
      notify("Couldn't stop it", error instanceof Error ? error.message : 'Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };
  return <Button variant="quiet" title="Stop renewing" loading={busy} onPress={() => void stop()} />;
}
