import { router } from 'expo-router';
import { useState } from 'react';
import { Image, StyleSheet, TextInput, View } from 'react-native';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { SITE_URL } from '../lib/site';
import { Body, Button, H1, Muted, Screen } from '../ui/components';
import { SiteLink } from '../ui/site-links';
import { colors, radius, space } from '../ui/theme';

export { ErrorBoundary } from '../ui/error-boundary';

const messageOf = (error: unknown) => (error instanceof ApiError ? error.message : "Couldn't reach Embodha. Check your connection.");

export default function SignIn() {
  const { startSignIn, verify } = useAuth();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      await startSignIn(email.trim());
      setCode('');
      setStep('code');
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const checkCode = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      const profile = await verify(email.trim(), value);
      if (!profile.profileComplete) router.replace('/onboarding');
      else if (router.canGoBack()) router.back();
      else router.replace('/');
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen edges={['bottom']}>
      <Image source={require('../../assets/logo.jpg')} style={styles.logo} />
      {step === 'email' ? (
        <>
          <H1>Sign in or create your account</H1>
          <Body style={styles.lead}>We'll email you a six-digit code. There's no password to remember.</Body>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={colors.inkSoft}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
            returnKeyType="send"
            onSubmitEditing={() => void sendCode()}
            style={styles.input}
          />
          {error ? <Body style={styles.error}>{error}</Body> : null}
          <Button title="Email me a code" onPress={() => void sendCode()} loading={busy} disabled={!/^\S+@\S+\.\S+$/.test(email.trim())} />
          {SITE_URL ? (
            <Muted style={styles.hint}>
              By continuing, you agree to our <SiteLink page="terms">Terms of use</SiteLink> and <SiteLink page="privacy">Privacy policy</SiteLink>.
            </Muted>
          ) : null}
        </>
      ) : (
        <>
          <H1>Check your email</H1>
          <Body style={styles.lead}>We sent a code to {email.trim()}. It works for 10 minutes.</Body>
          <TextInput
            value={code}
            onChangeText={(value) => {
              const digits = value.replace(/\D/g, '').slice(0, 6);
              setCode(digits);
              if (digits.length === 6) void checkCode(digits);
            }}
            placeholder="123456"
            placeholderTextColor={colors.inkSoft}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            maxLength={6}
            style={[styles.input, styles.codeInput]}
          />
          {error ? <Body style={styles.error}>{error}</Body> : null}
          <Button title="Sign in" onPress={() => void checkCode(code)} loading={busy} disabled={code.length !== 6} />
          <View style={styles.links}>
            <Button variant="quiet" title="Send a new code" onPress={() => void sendCode()} />
            <Button variant="quiet" title="Use a different email" onPress={() => setStep('email')} />
          </View>
          <Muted style={styles.hint}>Can't see it? Check spam, or tap the link in the same email if you're on this phone.</Muted>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  logo: { width: 64, height: 64, borderRadius: 16, marginBottom: space(6) },
  lead: { marginBottom: space(6), color: colors.inkSoft },
  input: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, paddingHorizontal: space(4), paddingVertical: space(3), fontSize: 18, color: colors.ink, marginBottom: space(4) },
  codeInput: { fontSize: 28, letterSpacing: 10, textAlign: 'center' },
  error: { color: colors.maroon, marginBottom: space(4) },
  links: { marginTop: space(2) },
  hint: { marginTop: space(4), textAlign: 'center' },
});
