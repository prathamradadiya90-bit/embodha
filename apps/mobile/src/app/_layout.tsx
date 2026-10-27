import { Anton_400Regular } from '@expo-google-fonts/anton/400Regular';
import { DMSans_400Regular } from '@expo-google-fonts/dm-sans/400Regular';
import { DMSans_500Medium } from '@expo-google-fonts/dm-sans/500Medium';
import { DMSans_700Bold } from '@expo-google-fonts/dm-sans/700Bold';
import { Italiana_400Regular } from '@expo-google-fonts/italiana/400Regular';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Stack, type ErrorBoundaryProps } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { deviceIdentity, sharingUsage } from '../lib/analytics';
import { AuthProvider } from '../lib/auth';
import { installCrashReporting, reportScreenCrash } from '../lib/crashes';
import { AnalyticsBridge } from '../ui/analytics-bridge';
import { BreathOnLaunch } from '../ui/breath-on-launch';
import { CastBridge } from '../ui/cast-bridge';
import { DownloadsBridge } from '../ui/downloads-bridge';
import { PushBridge } from '../ui/push-bridge';
import { StoreBridge } from '../ui/store-bridge';
import { colors, fonts } from '../ui/theme';

// networkMode 'always': without a connection a screen says so (and points at the downloads) instead of waiting for
// one. The phones never report being offline to React Query anyway; a browser does, and used to spin forever.
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: 1, networkMode: 'always' } } });
void SplashScreen.preventAutoHideAsync().catch(() => undefined);
// Before anything else can go wrong. Development builds report nothing.
if (!__DEV__) installCrashReporting({ identity: deviceIdentity, sharing: sharingUsage });

export default function RootLayout() {
  // The splash stays up until the three typefaces are in, so nothing flashes in the system font.
  const [loaded, failed] = useFonts({ Italiana_400Regular, Anton_400Regular, DMSans_400Regular, DMSans_500Medium, DMSans_700Bold });
  const ready = loaded || Boolean(failed);
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => undefined);
  }, [ready]);
  if (!ready) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerShadowVisible: false,
            headerStyle: { backgroundColor: colors.paper },
            headerTintColor: colors.ink,
            headerTitle: '',
            headerTitleStyle: { fontFamily: fonts.bold },
            contentStyle: { backgroundColor: colors.paper },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="sign-in" options={{ presentation: 'modal' }} />
          <Stack.Screen name="onboarding" options={{ headerBackVisible: false, gestureEnabled: false }} />
          <Stack.Screen name="breathe" options={{ presentation: 'fullScreenModal', headerShown: false }} />
          <Stack.Screen name="search" options={{ animation: 'fade' }} />
          <Stack.Screen name="feedback" options={{ presentation: 'modal' }} />
        </Stack>
        <BreathOnLaunch />
        <PushBridge />
        <StoreBridge />
        <AnalyticsBridge />
        <DownloadsBridge />
        <CastBridge />
      </AuthProvider>
    </QueryClientProvider>
  );
}

/**
 * The last resort, if the app's frame itself fails (screens have their own, in src/ui/error-boundary.tsx). It
 * replaces everything, sign-in included, so it draws with plain parts only.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => {
    reportScreenCrash(error);
  }, [error]);
  return (
    <View style={boundary.page}>
      <Text style={boundary.title}>Embodha ran into a problem</Text>
      <Text style={boundary.body}>Try again. If it keeps happening, close the app and open it again.</Text>
      <Pressable accessibilityRole="button" onPress={() => void retry()} style={boundary.button}>
        <Text style={boundary.buttonText}>Try again</Text>
      </Pressable>
    </View>
  );
}

const boundary = StyleSheet.create({
  page: { flex: 1, justifyContent: 'center', padding: 24, gap: 12, backgroundColor: colors.paper },
  title: { fontSize: 24, fontWeight: '700', color: colors.ink },
  body: { fontSize: 16, lineHeight: 24, color: colors.inkSoft },
  button: { marginTop: 12, minHeight: 54, borderRadius: 999, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 17, fontWeight: '700', color: '#FFFFFF' },
});
