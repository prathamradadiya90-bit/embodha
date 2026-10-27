// Points the modules under test at the stand-ins, so they run in plain Node.
const here = new URL('./', import.meta.url);
const mock = (file) => ({ url: new URL(file, here).href, shortCircuit: true });
const from = (context, file) => Boolean(context.parentURL?.includes(file));

export async function resolve(specifier, context, next) {
  if (specifier === 'expo-iap') return mock('expo-iap.mjs');
  if (specifier === 'expo-constants') return mock('expo-constants.mjs');
  if (specifier === 'react-native') return mock('react-native.mjs');
  if (specifier === 'expo-device') return mock('expo-device.mjs');
  if (specifier === './api' && (from(context, '/src/lib/store.native.ts') || from(context, '/src/lib/analytics.ts') || from(context, '/src/lib/crashes.ts') || from(context, '/src/lib/beats.ts')))
    return mock('api.mjs');
  if (specifier === './beat-store' && from(context, '/src/lib/beats.ts')) return mock('beat-store.mjs');
  if (specifier === './crash-store' && from(context, '/src/lib/crashes.ts')) return mock('crash-store.mjs');
  if (specifier === './storage' && from(context, '/src/lib/analytics.ts')) return mock('storage.mjs');
  return next(specifier, context);
}
