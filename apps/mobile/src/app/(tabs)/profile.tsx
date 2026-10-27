import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Switch, Text, View } from 'react-native';
import { setSharingUsage, sharingUsage } from '../../lib/analytics';
import { api } from '../../lib/api';
import { stateName } from '../../lib/india';
import { useAuth } from '../../lib/auth';
import { downloadsSupported, sizeLabel, useDownloads } from '../../lib/downloads';
import { syncPushToken } from '../../lib/push';
import { inAppStore, restoreStorePurchases, storeName } from '../../lib/store';
import type { Stats } from '../../lib/types';
import { Body, Button, Card, Chip, confirmAsync, H1, Muted, notify, Screen, Section, TopBar } from '../../ui/components';
import { SiteLinks } from '../../ui/site-links';
import { colors, fonts, space } from '../../ui/theme';

export { ErrorBoundary } from '../../ui/error-boundary';

export default function Profile() {
  const { signedIn, me, updateMe, signOut, deleteAccount } = useAuth();
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => api<Stats>('/v1/me/stats'), enabled: signedIn });
  const purchases = useQuery({ queryKey: ['purchases'], queryFn: () => api<Purchase[]>('/v1/me/purchases'), enabled: signedIn });
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [sharing, setSharing] = useState<boolean | null>(null);
  const queryClient = useQueryClient();
  const saved = useDownloads();
  useEffect(() => {
    void sharingUsage().then(setSharing);
  }, []);

  if (!signedIn || !me) {
    return (
      <Screen tone="butter">
        <TopBar />
        <H1>You</H1>
        <Body style={styles.gap}>Sign in to keep your streak, progress and courses on every device. It takes an email address and a six-digit code.</Body>
        <Button title="Sign in or create an account" onPress={() => router.push('/sign-in')} />
        <SiteLinks pages={['privacy', 'terms', 'support']} style={styles.siteLinks} />
      </Screen>
    );
  }

  const restore = async () => {
    setRestoring(true);
    try {
      const { restored, failed } = await restoreStorePurchases();
      await queryClient.invalidateQueries();
      if (restored) notify('Restored', `${restored === 1 ? 'One purchase is' : `${restored} purchases are`} back in your library.${failed ? ' Some others belong to a different Embodha account.' : ''}`);
      else if (failed) notify('Nothing restored', `What ${storeName} has belongs to a different Embodha account. Sign in with that one to use it.`);
      else notify('Nothing to restore', `${storeName} has no Embodha purchases for this phone's account.`);
    } catch (error) {
      notify("Couldn't restore", error instanceof Error ? error.message : 'Try again in a moment.');
    } finally {
      setRestoring(false);
    }
  };

  const exportData = async () => {
    setExporting(true);
    try {
      const done = await api<{ to: string }>('/v1/me/export', { method: 'POST' });
      notify('On its way', `We've emailed everything Embodha holds about you to ${done.to}. It's a file any text editor opens.`);
    } catch (error) {
      notify("Couldn't send it", error instanceof Error ? error.message : 'Try again in a moment.');
    } finally {
      setExporting(false);
    }
  };

  const reminder = me.preferences.reminderTime;
  const setReminder = async (time: string | null) => {
    try {
      await updateMe({ reminderTime: time });
      // A reminder is a push, so turning one on is when to ask the phone for permission.
      if (time && Platform.OS !== 'web' && !(await syncPushToken(true))) {
        notify('Reminders need notifications', 'Allow notifications for Embodha in your phone settings, and the reminder will start arriving.');
      }
    } catch (error) {
      notify("Couldn't change the reminder", error instanceof Error ? error.message : 'Try again in a moment.');
    }
  };

  const remove = async () => {
    const ok = await confirmAsync(
      'Delete your account?',
      'We sign you out everywhere now, stop your subscriptions renewing, and erase your data after 30 days. Sign back in before then to keep it.',
      'Delete',
    );
    if (!ok) return;
    setBusy(true);
    try {
      const closing = await deleteAccount();
      const day = new Date(closing.deleteAfter).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
      const apple = closing.appStoreSubscriptions;
      notify(
        'Your account is closing',
        `It will be erased on ${day}. Sign in before then if you change your mind.` +
          (apple
            ? ` ${apple === 1 ? 'One subscription is' : `${apple} subscriptions are`} billed by Apple, and only you can stop ${apple === 1 ? 'it' : 'them'}: on your iPhone, open Settings, tap your name, then Subscriptions.`
            : ''),
      );
    } catch (error) {
      notify("Couldn't delete the account", error instanceof Error ? error.message : 'Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen tone="butter">
      <TopBar />
      <H1>{me.name ?? 'You'}</H1>
      <Muted>{me.email}</Muted>

      <View style={styles.statsRow}>
        <Card color={colors.green} style={styles.stat}>
          <Text style={styles.statNumber}>{stats.data?.streakDays ?? '–'}</Text>
          <Muted>{stats.data?.streakDays === 1 ? 'day' : 'days'} in a row</Muted>
        </Card>
        <Card color={colors.orange} style={styles.stat}>
          <Text style={styles.statNumber}>{stats.data?.totalMinutes ?? '–'}</Text>
          <Muted>{stats.data?.totalMinutes === 1 ? 'minute' : 'minutes'} practised</Muted>
        </Card>
      </View>

      <Section title="Settings">
        <Card style={styles.settingRow}>
          <View style={styles.flex}>
            <Body>Your details</Body>
            <Muted>{[me.country === 'IN' ? (stateName(me.state) ?? 'India') : me.country, me.birthYear ? `born ${me.birthYear}` : null].filter(Boolean).join(' · ')}</Muted>
          </View>
          <Button variant="secondary" title="Change" onPress={() => router.push('/onboarding?edit=1')} />
        </Card>
        <Card style={[styles.settingRow, styles.spaced]}>
          <View style={styles.flex}>
            <Body>Start the day with a breath</Body>
            <Muted>The first time you open the app each day.</Muted>
          </View>
          <Switch
            value={me.preferences.breathOnLaunch}
            onValueChange={(value) => void updateMe({ breathOnLaunch: value })}
            trackColor={{ true: colors.maroon, false: colors.line }}
            thumbColor="#FFFFFF"
            {...webThumb}
          />
        </Card>
        <Card style={styles.spaced}>
          <Body>Daily reminder</Body>
          <Muted>
            {reminder
              ? `At ${timeLabel(reminder)} your time, on days you haven't practised yet.`
              : 'Off. Pick a time and we\u2019ll nudge you, only on days you haven\u2019t practised.'}
          </Muted>
          <View style={styles.chips}>
            {REMINDER_TIMES.map((time) => (
              <Chip key={time ?? 'off'} label={time ? timeLabel(time) : 'Off'} selected={reminder === time} onPress={() => void setReminder(time)} />
            ))}
          </View>
        </Card>
        {Platform.OS !== 'web' ? (
          <Card style={[styles.settingRow, styles.spaced]}>
            <View style={styles.flex}>
              <Body>Notifications</Body>
              <Muted>New courses, events and the occasional note from the Embodha team.</Muted>
            </View>
            <Button
              variant="secondary"
              title="Turn on"
              onPress={() =>
                void syncPushToken(true).then((on) =>
                  notify(on ? 'Notifications are on' : "Notifications aren't on", on ? "You'll hear from us now and then." : 'You can allow them for Embodha in your phone settings.'),
                )
              }
            />
          </Card>
        ) : null}
        {downloadsSupported ? (
          <Card style={[styles.settingRow, styles.spaced]}>
            <View style={styles.flex}>
              <Body>Downloads</Body>
              <Muted>
                {saved.usedBytes ? `${sizeLabel(saved.usedBytes)} on this phone. ` : ''}
                {saved.mobileData ? 'Over Wi-Fi or mobile data' : 'Over Wi-Fi only'}, {saved.quality === 'high' ? 'high' : 'standard'} quality.
              </Muted>
            </View>
            <Button variant="secondary" title="Open" onPress={() => router.push('/downloads')} />
          </Card>
        ) : null}
        {inAppStore ? (
          <Card style={[styles.settingRow, styles.spaced]}>
            <View style={styles.flex}>
              <Body>Restore purchases</Body>
              <Muted>New phone, or bought something before you signed in? This finds it in {storeName}.</Muted>
            </View>
            <Button variant="secondary" title="Restore" loading={restoring} onPress={() => void restore()} />
          </Card>
        ) : null}
        <Card style={[styles.settingRow, styles.spaced]}>
          <View style={styles.flex}>
            <Body>Share how you use the app</Body>
            <Muted>Which screens you open, what you start, how long videos take to load, and crash reports. Never your notes or anything you type. Only Embodha sees it.</Muted>
          </View>
          <Switch
            value={sharing ?? true}
            disabled={sharing === null}
            onValueChange={(value) => {
              setSharing(value);
              void setSharingUsage(value);
            }}
            trackColor={{ true: colors.maroon, false: colors.line }}
            thumbColor="#FFFFFF"
            {...webThumb}
          />
        </Card>
        <Card style={[styles.settingRow, styles.spaced]}>
          <View style={styles.flex}>
            <Body>Your data</Body>
            <Muted>A copy of everything Embodha holds about you, sent to your email.</Muted>
          </View>
          <Button variant="secondary" title="Email it" loading={exporting} onPress={() => void exportData()} />
        </Card>
      </Section>

      {purchases.data?.length ? (
        <Section title="Purchases">
          {purchases.data.some((p) => p.invoiceNo) ? <Muted style={styles.note}>Each invoice was emailed to you as a PDF. Apple and Google send their own receipts.</Muted> : null}
          {purchases.data.map((p) => (
            <Card key={p.id} style={styles.purchase}>
              <Body>{p.item}</Body>
              <Muted>
                {p.amount.display} · {p.at ? new Date(p.at).toLocaleDateString() : ''}
                {p.invoiceNo ? ` · Invoice ${p.invoiceNo}` : p.channel === 'apple' ? ' · App Store' : p.channel === 'google' ? ' · Google Play' : ''}
                {p.test ? ' · Test purchase' : ''}
                {p.status === 'refunded' ? ' · Refunded' : ''}
              </Muted>
            </Card>
          ))}
        </Section>
      ) : null}

      <Section title="Feedback">
        <Card style={styles.settingRow}>
          <View style={styles.flex}>
            <Body>Write to the team</Body>
            <Muted>Something broken, confusing, or working well? Your app version and phone model go with it.</Muted>
          </View>
          <Button variant="secondary" title="Write" onPress={() => router.push('/feedback')} />
        </Card>
      </Section>

      <View style={styles.actions}>
        <Button variant="secondary" title="Sign out" onPress={() => void signOut()} />
        <Button variant="quiet" title="Delete account" onPress={() => void remove()} loading={busy} />
      </View>
      <SiteLinks pages={['privacy', 'terms', 'support']} style={styles.siteLinks} />
    </Screen>
  );
}

/** A few sensible times rather than a clock face: first thing, mid-morning, lunch, after work, before bed. */
const REMINDER_TIMES = [null, '07:00', '09:00', '13:00', '18:30', '21:30'];
const timeLabel = (time: string) => {
  const [hour, minute] = time.split(':').map(Number);
  return `${hour % 12 || 12}${minute ? `:${String(minute).padStart(2, '0')}` : ''} ${hour < 12 ? 'am' : 'pm'}`;
};

interface Purchase {
  id: string;
  course: { slug: string; title: string } | null;
  item: string;
  amount: { display: string };
  channel: 'razorpay' | 'apple' | 'google';
  test: boolean;
  invoiceNo: string | null;
  at: string | null;
  status: 'captured' | 'refunded' | 'partially_refunded' | 'failed';
}

// React Native Web colours the "on" thumb with its own prop; phones use thumbColor for both states.
const webThumb = Platform.OS === 'web' ? ({ activeThumbColor: '#FFFFFF' } as object) : {};

const styles = StyleSheet.create({
  gap: { marginVertical: space(4) },
  statsRow: { flexDirection: 'row', gap: space(3), marginTop: space(6) },
  stat: { flex: 1 },
  statNumber: { fontFamily: fonts.heavy, fontSize: 48, lineHeight: 56, color: colors.ink },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginTop: space(3) },
  settingRow: { flexDirection: 'row', alignItems: 'center', gap: space(3) },
  spaced: { marginTop: space(3) },
  purchase: { marginBottom: space(2) },
  note: { marginBottom: space(3) },
  flex: { flex: 1 },
  actions: { marginTop: space(10), gap: space(2) },
  siteLinks: { marginTop: space(8) },
});
