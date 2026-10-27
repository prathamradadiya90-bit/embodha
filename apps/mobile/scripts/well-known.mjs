// Writes the two files that let phones open the one-tap sign-in link (/auth/link) in the app instead of the browser,
// into the members' web app's build: .well-known/apple-app-site-association for iOS and .well-known/assetlinks.json
// for Android. The domain they're served from is EMBODHA_LINK_DOMAIN in the app's build.
//   APPLE_TEAM_ID=ABCDE12345 ANDROID_CERT_SHA256=AA:BB:... node scripts/well-known.mjs dist-web
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'dist-web'));
const { expo } = JSON.parse(readFileSync(path.join(root, 'app.json'), 'utf8'));

const team = (process.env.APPLE_TEAM_ID ?? '').trim();
const fingerprints = (process.env.ANDROID_CERT_SHA256 ?? '')
  .split(',')
  .map((f) => f.trim().toUpperCase())
  .filter(Boolean);

const problems = [];
if (!/^[A-Z0-9]{10}$/.test(team)) problems.push('APPLE_TEAM_ID: the 10-character team ID from developer.apple.com, Membership details');
if (!fingerprints.length || fingerprints.some((f) => !/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(f))) {
  problems.push('ANDROID_CERT_SHA256: the app signing certificate SHA-256 fingerprints (AA:BB:… , comma-separated), from Play Console, App integrity, and eas credentials');
}
if (problems.length) {
  console.error(`Can't write the sign-in link files without:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

const wellKnown = path.join(out, '.well-known');
mkdirSync(wellKnown, { recursive: true });
const appleSite = {
  applinks: {
    details: [{ appIDs: [`${team}.${expo.ios.bundleIdentifier}`], components: [{ '/': '/auth/link', comment: 'The one-tap sign-in link in emails' }] }],
  },
};
const androidLinks = [
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: expo.android.package, sha256_cert_fingerprints: fingerprints },
  },
];
writeFileSync(path.join(wellKnown, 'apple-app-site-association'), `${JSON.stringify(appleSite, null, 2)}\n`);
writeFileSync(path.join(wellKnown, 'assetlinks.json'), `${JSON.stringify(androidLinks, null, 2)}\n`);
console.log(`Wrote the sign-in link files for ${expo.ios.bundleIdentifier} and ${expo.android.package} into ${path.relative(process.cwd(), wellKnown) || '.'}`);
