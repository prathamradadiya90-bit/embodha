// The store build's settings (app.config.ts) and the sign-in link files for the web app (scripts/well-known.mjs).
// Run: npm test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { withEmbodha } from '../app.config.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = JSON.parse(readFileSync(path.join(root, 'app.json'), 'utf8')).expo;
const store = { APP_VARIANT: 'production', EXPO_PUBLIC_API_URL: 'https://api.example.com', EXPO_PUBLIC_SITE_URL: 'https://example.com', EMBODHA_LINK_DOMAIN: 'app.example.com' };

test('a store build refuses to go without the API, the website and the sign-in link domain', () => {
  assert.throws(() => withEmbodha(base, { APP_VARIANT: 'production' }), /EXPO_PUBLIC_API_URL[\s\S]*EXPO_PUBLIC_SITE_URL[\s\S]*EMBODHA_LINK_DOMAIN/);
  assert.throws(() => withEmbodha(base, { ...store, EXPO_PUBLIC_API_URL: 'http://api.example.com' }), /EXPO_PUBLIC_API_URL/);
  assert.throws(() => withEmbodha(base, { ...store, EMBODHA_LINK_DOMAIN: 'https://app.example.com/' }), /bare domain/);
  // Internal builds only need the API; local development needs nothing.
  assert.throws(() => withEmbodha(base, { APP_VARIANT: 'preview' }), /EXPO_PUBLIC_API_URL/);
  assert.doesNotThrow(() => withEmbodha(base, { APP_VARIANT: 'preview', EXPO_PUBLIC_API_URL: 'https://staging-api.example.com' }));
  assert.doesNotThrow(() => withEmbodha(base, {}));
});

test('a store build opens the one-tap link in the app, says it uses no special encryption, and declares its APIs', () => {
  const config = withEmbodha(base, store);
  assert.equal(config.ios.bundleIdentifier, 'com.embodha.app');
  assert.deepEqual(config.ios.associatedDomains, ['applinks:app.example.com']);
  assert.equal(config.ios.config.usesNonExemptEncryption, false);
  assert.deepEqual(config.android.intentFilters, [
    { action: 'VIEW', autoVerify: true, data: [{ scheme: 'https', host: 'app.example.com', pathPrefix: '/auth/link' }], category: ['BROWSABLE', 'DEFAULT'] },
  ]);
  const reasons = Object.fromEntries(config.ios.privacyManifests.NSPrivacyAccessedAPITypes.map((t) => [t.NSPrivacyAccessedAPIType, t.NSPrivacyAccessedAPITypeReasons]));
  assert.deepEqual(reasons.NSPrivacyAccessedAPICategoryUserDefaults, ['CA92.1']);
  assert.equal(config.ios.privacyManifests.NSPrivacyTracking, false);
  assert.deepEqual(config.android.blockedPermissions, ['android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE']);
  assert.equal(withEmbodha(base, {}).android.blockedPermissions, undefined); // local development keeps the template's
  // Everything else in app.json comes through untouched.
  assert.deepEqual(config.plugins, base.plugins);
  assert.equal(config.android.package, 'com.embodha.app');
});

test('the web app vouches for the app on /auth/link, for the right team, package and certificate', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'well-known-'));
  const script = path.join(root, 'scripts', 'well-known.mjs');
  const fingerprint = Array.from({ length: 32 }, (_, i) => (i * 7).toString(16).padStart(2, '0').slice(-2).toUpperCase()).join(':');
  const run = (env) => spawnSync(process.execPath, [script, out], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

  const refused = run({ APPLE_TEAM_ID: 'short' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /APPLE_TEAM_ID[\s\S]*ANDROID_CERT_SHA256/);

  assert.equal(run({ APPLE_TEAM_ID: 'ABCDE12345', ANDROID_CERT_SHA256: fingerprint.toLowerCase() }).status, 0);
  const apple = JSON.parse(readFileSync(path.join(out, '.well-known', 'apple-app-site-association'), 'utf8'));
  assert.deepEqual(apple.applinks.details[0].appIDs, ['ABCDE12345.com.embodha.app']);
  assert.equal(apple.applinks.details[0].components[0]['/'], '/auth/link');
  const android = JSON.parse(readFileSync(path.join(out, '.well-known', 'assetlinks.json'), 'utf8'));
  assert.equal(android[0].target.package_name, 'com.embodha.app');
  assert.deepEqual(android[0].target.sha256_cert_fingerprints, [fingerprint]);
});

test('Android keeps downloads out of Google backups, and an iPhone is never asked about Face ID', () => {
  // expo-secure-store's backup rules name what is backed up (settings, but not the sign-in in SecureStore), which
  // leaves out the app's files: gigabytes of downloads would break the 25 MB backup and come back without a sign-in.
  const entry = base.plugins.find((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) === 'expo-secure-store');
  assert.ok(entry, 'expo-secure-store must stay in app.json plugins');
  assert.notEqual(entry[1]?.configureAndroidBackup, false);
  assert.equal(entry[1]?.faceIDPermission, false); // the app never uses Face ID, so the store listing shouldn't ask
});

test('Chromecast plays Google’s own receiver, with the Android Cast SDK pinned and iOS told why it looks around', () => {
  const entry = base.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'react-native-google-cast');
  assert.ok(entry, 'react-native-google-cast must stay in app.json plugins');
  const options = entry[1];
  assert.equal(options.receiverAppId, 'CC1AD845'); // the Default Media Receiver: nothing registered with Google
  // Unpinned, the plugin takes whatever Cast SDK is newest on the day of the build.
  assert.match(options.androidPlayServicesCastFrameworkVersion, /^\d+\.\d+\.\d+$/);
  // Looking for TVs waits for the first tap on the Cast button, which is when iOS asks about the local network.
  assert.equal(options.iosStartDiscoveryAfterFirstTapOnCastButton, true);
  assert.match(base.ios.infoPlist.NSLocalNetworkUsageDescription, /cast button/i);
});
