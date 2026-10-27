import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Body, Button, H1, Loading, Screen } from '../../ui/components';
import { space } from '../../ui/theme';

export { ErrorBoundary } from '../../ui/error-boundary';

/**
 * The one-tap link in the sign-in email: `<WEB_URL>/auth/link?token=…`. With universal links (iOS) and app links
 * (Android) set up for the web domain, tapping it on the phone opens this screen, which signs the member straight in.
 */
export default function SignInLink() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { verifyLink } = useAuth();
  const [error, setError] = useState<string | null>(token ? null : 'This link is missing its sign-in code.');
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    verifyLink(token)
      .then((profile) => router.replace(profile.profileComplete ? '/' : '/onboarding'))
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : "Couldn't reach Embodha. Check your connection."));
  }, [token, verifyLink]);

  if (!error) return <Loading />;
  return (
    <Screen>
      <H1>That link didn't work</H1>
      <Body style={{ marginBottom: space(6) }}>{error}</Body>
      <Button title="Sign in with a code instead" onPress={() => router.replace('/sign-in')} />
    </Screen>
  );
}
