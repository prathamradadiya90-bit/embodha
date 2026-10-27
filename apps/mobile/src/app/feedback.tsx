import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, StyleSheet, TextInput, View } from 'react-native';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Body, Button, H1, Muted, Screen } from '../ui/components';
import { SiteLinks } from '../ui/site-links';
import { colors, radius, space } from '../ui/theme';

export { ErrorBoundary } from '../ui/error-boundary';

const platform = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web';
const appVersion = Constants.expoConfig?.version ?? null;
/** The model, never the name someone gave their phone. */
const device = Device.modelName ?? (platform === 'web' ? Device.osName : null) ?? null;
const phone = [device, platform === 'ios' ? `iOS ${Device.osVersion ?? ''}`.trim() : platform === 'android' ? `Android ${Device.osVersion ?? ''}`.trim() : null].filter(Boolean).join(', ');

/** You, Feedback: a message to the team, with the app version and phone model so a report can be traced. */
export default function Feedback() {
  const { signedIn, me } = useAuth();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  if (!signedIn || !me) {
    return (
      <Screen edges={['bottom']}>
        <H1>Send feedback</H1>
        <Body style={styles.lead}>Sign in first, so the team can write back. Or reach us through the support page.</Body>
        <Button title="Sign in" onPress={() => router.replace('/sign-in')} />
        <SiteLinks pages={['support']} style={styles.links} />
      </Screen>
    );
  }

  if (sent) {
    return (
      <Screen edges={['bottom']}>
        <H1>Thank you</H1>
        <Body style={styles.lead}>It's with the team. If we need to ask you something, we'll write to {me.email}.</Body>
        <Button title="Done" onPress={() => router.back()} />
      </Screen>
    );
  }

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/v1/feedback', { method: 'POST', body: { message: text.trim(), platform, appVersion, osVersion: Device.osVersion ?? null, device } });
      setSent(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't send that. Check your connection and try again; your message is still here.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen edges={['bottom']}>
      <H1>Send feedback</H1>
      <Body style={styles.lead}>
        Something broken, confusing, or working well? Say what you were doing when it happened, and which course or chapter if it's about one.
      </Body>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="I was on the second chapter when…"
        placeholderTextColor={colors.inkSoft}
        multiline
        maxLength={2000}
        autoFocus
        style={styles.input}
        accessibilityLabel="Your feedback"
      />
      <Muted style={styles.note}>
        {platform === 'web'
          ? `Sent with the web app's version (${appVersion ?? 'unknown'})${device ? ` and your system (${device})` : ''}.`
          : `Sent with your app version (${appVersion ?? 'unknown'})${phone ? ` and phone (${phone})` : ''}.`}{' '}
        Replies come to {me.email}.
      </Muted>
      {error ? <Body style={styles.error}>{error}</Body> : null}
      <View style={styles.actions}>
        <Button title="Send" onPress={() => void send()} loading={busy} disabled={text.trim().length < 3} />
        <Button variant="quiet" title="Cancel" onPress={() => router.back()} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  lead: { marginBottom: space(5), color: colors.inkSoft },
  input: {
    minHeight: 160,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    padding: space(3),
    fontSize: 16,
    lineHeight: 22,
    color: colors.ink,
    backgroundColor: colors.surface,
    textAlignVertical: 'top',
  },
  note: { marginTop: space(3) },
  error: { marginTop: space(3), color: colors.brand },
  actions: { marginTop: space(6), gap: space(2) },
  links: { marginTop: space(6) },
});
