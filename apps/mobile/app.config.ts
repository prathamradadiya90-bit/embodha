import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * The build settings that depend on where a build is going, on top of app.json.
 *
 * APP_VARIANT comes from the build profile in eas.json. The addresses come from the EAS environment
 * (`eas env:set`), so they never sit in the repository.
 * - production, for the App Store and Google Play: refuses to build without the API, the website and the domain the
 *   one-tap sign-in link opens. A store build without them can't sign anyone in, links to no privacy policy, and
 *   fails review.
 * - preview, internal builds for the team's own phones: needs the API.
 * - anything else (`expo start`, a local development build): no checks.
 */
export default ({ config }: ConfigContext): ExpoConfig => withEmbodha(config as ExpoConfig, process.env);

type Env = Record<string, string | undefined>;

/**
 * Required-reason APIs, as the app's own libraries declare them in their PrivacyInfo files (React Native, expo,
 * expo-application, expo-constants, expo-device, expo-file-system, expo-notifications). Apple doesn't always read the
 * files inside static libraries, so the app declares them again itself.
 */
const PRIVACY_MANIFEST = {
  NSPrivacyTracking: false,
  NSPrivacyAccessedAPITypes: [
    { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
    { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1', '0A2A.1', '3B52.1'] },
    { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime', NSPrivacyAccessedAPITypeReasons: ['35F9.1'] },
    { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace', NSPrivacyAccessedAPITypeReasons: ['E174.1', '85F4.1'] },
  ],
};

/**
 * Permissions the Expo template and libraries add that Embodha never uses. Store builds drop them, because Google Play
 * asks for a reason for each one, and "display over other apps" in particular draws a review.
 */
const UNUSED_ANDROID_PERMISSIONS = ['android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE'];

const isHttps = (url: string | undefined) => Boolean(url && /^https:\/\/[^/\s]+/.test(url));
/** A bare host like app.example.com: no scheme, no path, no port. */
const isHost = (host: string | undefined) => Boolean(host && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host));

export function withEmbodha(config: ExpoConfig, env: Env): ExpoConfig {
  const variant = env.APP_VARIANT ?? 'development';
  const linkDomain = env.EMBODHA_LINK_DOMAIN?.trim() || undefined;

  const missing: string[] = [];
  if (variant === 'production' || variant === 'preview') {
    if (!isHttps(env.EXPO_PUBLIC_API_URL)) missing.push('EXPO_PUBLIC_API_URL, the https address of the API');
  }
  if (variant === 'production') {
    if (!isHttps(env.EXPO_PUBLIC_SITE_URL)) missing.push('EXPO_PUBLIC_SITE_URL, the https address of the website, for the privacy policy and terms the stores ask for');
    if (!isHost(linkDomain)) missing.push("EMBODHA_LINK_DOMAIN, the members' web app's domain (like app.example.com), which the one-tap sign-in link opens");
  }
  if (linkDomain && !isHost(linkDomain)) missing.push(`EMBODHA_LINK_DOMAIN should be a bare domain like app.example.com, not ${linkDomain}`);
  if (missing.length) {
    throw new Error(`A ${variant} build needs:\n  ${missing.join('\n  ')}\nSet them with eas env:set; apps/mobile/README.md has the commands.`);
  }

  return {
    ...config,
    ios: {
      ...config.ios,
      // HTTPS only, which Apple counts as exempt, so App Store Connect doesn't ask about export compliance each time.
      config: { ...config.ios?.config, usesNonExemptEncryption: false },
      privacyManifests: PRIVACY_MANIFEST,
      ...(linkDomain ? { associatedDomains: [`applinks:${linkDomain}`] } : {}),
    },
    android: {
      ...config.android,
      ...(variant === 'production' || variant === 'preview' ? { blockedPermissions: UNUSED_ANDROID_PERMISSIONS } : {}),
      ...(linkDomain
        ? {
            // The one-tap link in sign-in emails opens the app instead of the browser, once the domain vouches for it.
            intentFilters: [
              {
                action: 'VIEW',
                autoVerify: true,
                data: [{ scheme: 'https', host: linkDomain, pathPrefix: '/auth/link' }],
                category: ['BROWSABLE', 'DEFAULT'],
              },
            ],
          }
        : {}),
    },
  };
}
