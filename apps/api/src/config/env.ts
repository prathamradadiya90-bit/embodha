import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().default('postgres://embodha:embodha@localhost:5432/embodha'),

    JWT_SECRET: z.string().min(32, 'needs at least 32 characters'),
    CODE_SECRET: z.string().min(32, 'needs at least 32 characters'),
    ACCESS_TOKEN_TTL_S: z.coerce.number().int().positive().default(15 * 60),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(60),
    /** Staff can refund money and read members' details, so their sessions end after this long unused. */
    STAFF_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
    SIGNIN_CODE_TTL_S: z.coerce.number().int().positive().default(10 * 60),
    SIGNIN_CODES_PER_EMAIL_PER_HOUR: z.coerce.number().int().positive().default(5),
    SIGNIN_CODES_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(30),
    MIN_AGE: z.coerce.number().int().min(13).default(18),

    /** Where the one-tap link in sign-in emails goes: the members' web app, on the domain the phone apps claim for universal links. */
    WEB_URL: z.string().url().default('http://localhost:8081'),
    /** The public website (apps/site), whose pages the launch checklist looks for. Optional. */
    SITE_URL: z.string().url().optional(),
    CORS_ORIGINS: z.string().default('http://localhost:8081,http://localhost:5173'),

    MAIL_TRANSPORT: z.enum(['console', 'smtp']).default('console'),
    /** Where "Send feedback" from the app is emailed, as well as landing on admin's Feedback page. Optional. */
    FEEDBACK_EMAIL: z.string().email().optional(),
    /** Where the nightly money check writes when Razorpay's settlements don't match the books. */
    FINANCE_EMAIL: z.string().email().optional(),
    MAIL_FROM: z.string().default('Embodha <no-reply@example.com>'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    REVIEW_ACCOUNT_EMAIL: z.string().email().optional(),
    REVIEW_ACCOUNT_CODE: z.string().regex(/^\d{6}$/, 'must be six digits').optional(),

    BUNNY_STREAM_LIBRARY_ID: z.string().default(''),
    BUNNY_STREAM_API_KEY: z.string().default(''),
    BUNNY_STREAM_CDN_HOST: z.string().default(''),
    BUNNY_STREAM_TOKEN_KEY: z.string().default(''),
    BUNNY_WEBHOOK_SECRET: z.string().default(''),
    BUNNY_AUDIO_CDN_HOST: z.string().default(''),
    BUNNY_AUDIO_TOKEN_KEY: z.string().default(''),
    PLAYBACK_URL_TTL_S: z.coerce.number().int().positive().default(4 * 3600),
    // Offline downloads. A download's link works for DOWNLOAD_URL_TTL_S; the app asks for a fresh one when a download
    // outlasts it. An account keeps downloads on up to DOWNLOAD_DEVICE_LIMIT phones, and they play offline for
    // DOWNLOAD_KEEP_DAYS after the phone last checked in.
    DOWNLOAD_URL_TTL_S: z.coerce.number().int().positive().default(6 * 3600),
    DOWNLOAD_DEVICE_LIMIT: z.coerce.number().int().min(1).max(20).default(3),
    DOWNLOAD_KEEP_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    /**
     * Development only: the file a downloaded dev-sample chapter saves. The default sample is an HLS stream, which can't
     * be saved as one file; a dev sample that's already a single file (DEV_SAMPLE_VIDEO_URL=…/sample.mp4) downloads as is.
     */
    DEV_SAMPLE_DOWNLOAD_URL: z.string().url().optional(),
    // Audio chapters: the API normalises loudness with ffmpeg, then stores the file in this Bunny Storage zone.
    BUNNY_STORAGE_ZONE: z.string().default(''),
    BUNNY_STORAGE_PASSWORD: z.string().default(''),
    BUNNY_STORAGE_HOST: z.string().default('storage.bunnycdn.com'),

    NOTES_KEY: z
      .string()
      .regex(/^[A-Za-z0-9+/]{43}=$/, 'must be 32 random bytes in base64: openssl rand -base64 32')
      .optional(),
    EXPO_ACCESS_TOKEN: z.string().optional(),

    // Razorpay (Dashboard > Account & Settings > API keys, and Webhooks). Empty keys switch checkout off.
    RAZORPAY_KEY_ID: z.string().default(''),
    RAZORPAY_KEY_SECRET: z.string().default(''),
    RAZORPAY_WEBHOOK_SECRET: z.string().default(''),
    RAZORPAY_API_URL: z.string().url().default('https://api.razorpay.com/v1'),

    // App Store: an In-App Purchase key from App Store Connect (Users and Access > Integrations). Empty switches
    // purchases in the iOS app off. The key is the .p8 file's text; "\n" in place of line breaks is fine.
    APPLE_BUNDLE_ID: z.string().default('com.embodha.app'),
    APPLE_ISSUER_ID: z.string().default(''),
    APPLE_KEY_ID: z.string().default(''),
    APPLE_PRIVATE_KEY: z.string().default(''),
    // App Store Connect API team key (Users and Access > Integrations > App Store Connect API, role App Manager).
    // A different key from the In-App Purchase one above; with it the server makes and prices the products itself.
    APPLE_CONNECT_KEY_ID: z.string().default(''),
    APPLE_CONNECT_PRIVATE_KEY: z.string().default(''),
    /** The app's Apple ID, the number in App Store Connect's App Information. Looked up by bundle ID if empty. */
    APPLE_APP_ID: z.string().default(''),
    /** How often the server retries unfinished store products and checks on ones in review. 0 switches it off. */
    STORE_SYNC_MINUTES: z.coerce.number().int().min(0).max(1440).default(30),

    // Google Play: a service account's JSON key (as is, or base64), invited in Play Console with access to orders.
    // The notification secret goes at the end of the Pub/Sub push URL: /v1/webhooks/google?secret=...
    GOOGLE_PLAY_PACKAGE_NAME: z.string().default('com.embodha.app'),
    GOOGLE_PLAY_SERVICE_ACCOUNT: z.string().default(''),
    GOOGLE_PLAY_RTDN_SECRET: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    const problem = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (env.MAIL_TRANSPORT === 'smtp' && !env.SMTP_HOST) problem('SMTP_HOST', 'required when MAIL_TRANSPORT=smtp');
    if (Boolean(env.REVIEW_ACCOUNT_EMAIL) !== Boolean(env.REVIEW_ACCOUNT_CODE)) {
      problem('REVIEW_ACCOUNT_CODE', 'set REVIEW_ACCOUNT_EMAIL and REVIEW_ACCOUNT_CODE together, or neither');
    }
    if (env.APPLE_KEY_ID && (!env.APPLE_ISSUER_ID || !env.APPLE_PRIVATE_KEY)) problem('APPLE_PRIVATE_KEY', 'set the issuer ID and private key with the key ID');
    if (env.APPLE_CONNECT_KEY_ID && (!env.APPLE_ISSUER_ID || !env.APPLE_CONNECT_PRIVATE_KEY)) {
      problem('APPLE_CONNECT_PRIVATE_KEY', 'set the issuer ID and the App Store Connect private key with its key ID');
    }
    if (env.GOOGLE_PLAY_SERVICE_ACCOUNT && !serviceAccountLooksRight(env.GOOGLE_PLAY_SERVICE_ACCOUNT)) {
      problem('GOOGLE_PLAY_SERVICE_ACCOUNT', 'must be the JSON key file (or its base64), with client_email and private_key');
    }
    if (env.NODE_ENV === 'production') {
      if (env.MAIL_TRANSPORT === 'console') problem('MAIL_TRANSPORT', 'console would print sign-in codes into the logs; use smtp');
      if (!env.BUNNY_STREAM_TOKEN_KEY) problem('BUNNY_STREAM_TOKEN_KEY', 'paid video must go out on signed URLs');
      if (!env.BUNNY_WEBHOOK_SECRET) problem('BUNNY_WEBHOOK_SECRET', 'required so strangers cannot call the video webhook');
      if (!env.NOTES_KEY) problem('NOTES_KEY', 'private notes are encrypted with it; changing it later makes old notes unreadable');
      if (!env.WEB_URL.startsWith('https://')) problem('WEB_URL', "every sign-in email links here; set the members' web app's https address");
      if (env.RAZORPAY_KEY_ID && (!env.RAZORPAY_KEY_SECRET || !env.RAZORPAY_WEBHOOK_SECRET)) {
        problem('RAZORPAY_WEBHOOK_SECRET', 'set the key secret and webhook secret with the key ID');
      }
      if (env.GOOGLE_PLAY_SERVICE_ACCOUNT && env.GOOGLE_PLAY_RTDN_SECRET.length < 16) {
        problem('GOOGLE_PLAY_RTDN_SECRET', 'at least 16 characters, so strangers cannot post Play notifications');
      }
      const insecure = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter((o) => o && !o.startsWith('https://'));
      if (insecure.length) problem('CORS_ORIGINS', `only https origins in production, not ${insecure.join(', ')}`);
      if (env.BUNNY_STORAGE_ZONE && !env.BUNNY_AUDIO_TOKEN_KEY) problem('BUNNY_AUDIO_TOKEN_KEY', 'paid audio must go out on signed URLs');
    }
  });

export type Env = z.infer<typeof schema>;

/** Google's JSON key, pasted as is or base64-encoded. Null if it isn't one. */
export function parseServiceAccount(text: string): { client_email: string; private_key: string; token_uri?: string } | null {
  const raw = text.trim().startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8');
  try {
    const key = JSON.parse(raw) as { client_email?: unknown; private_key?: unknown; token_uri?: unknown };
    if (typeof key.client_email !== 'string' || typeof key.private_key !== 'string') return null;
    return { client_email: key.client_email, private_key: key.private_key, token_uri: typeof key.token_uri === 'string' ? key.token_uri : undefined };
  } catch {
    return null;
  }
}

function serviceAccountLooksRight(text: string) {
  return parseServiceAccount(text) !== null;
}

/** Reads and checks the environment once at boot. Empty values count as unset, so `.env` lines like `SMTP_HOST=` fall back to defaults. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n  ');
    throw new Error(`The environment is not valid:\n  ${problems}`);
  }
  return parsed.data;
}
