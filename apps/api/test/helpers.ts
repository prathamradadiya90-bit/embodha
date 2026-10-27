import { PGlite } from '@electric-sql/pglite';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import path from 'node:path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { ENV } from '../src/config/config.module';
import { loadEnv } from '../src/config/env';
import { DB, Db } from '../src/db/db.module';
import * as schema from '../src/db/schema';
import { MailService } from '../src/mail/mail.service';

export const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  JWT_SECRET: 'test-jwt-secret-long-enough-for-the-check',
  CODE_SECRET: 'test-code-secret-long-enough-for-the-check',
  SIGNIN_CODES_PER_IP_PER_HOUR: '1000',
  BUNNY_STREAM_LIBRARY_ID: '12345',
  BUNNY_STREAM_API_KEY: 'test-key',
  BUNNY_STREAM_CDN_HOST: 'vz-test.b-cdn.net',
  BUNNY_STREAM_TOKEN_KEY: 'test-token-key',
  BUNNY_WEBHOOK_SECRET: 'hook-secret',
  REVIEW_ACCOUNT_EMAIL: 'review@embodha.test',
  REVIEW_ACCOUNT_CODE: '246810',
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'rzp-test-secret',
  RAZORPAY_WEBHOOK_SECRET: 'rzp-hook-secret',
  BUNNY_STORAGE_ZONE: 'test-zone',
  BUNNY_STORAGE_PASSWORD: 'test-storage-pass',
  BUNNY_AUDIO_CDN_HOST: 'audio-test.b-cdn.net',
  GOOGLE_PLAY_RTDN_SECRET: 'play-hook-secret-0123',
});

/** A real Postgres (PGlite, in memory) with every migration applied. */
export async function freshDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.join(__dirname, '..', 'drizzle') });
  return { client, db: db as unknown as Db };
}

export interface TestApp {
  app: INestApplication;
  db: Db;
  mail: MailService;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
  const { client, db } = await freshDb();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(ENV)
    .useValue(TEST_ENV)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  configureApp(app);
  await app.init();
  return {
    app,
    db,
    mail: app.get(MailService),
    http: () => request(app.getHttpServer()),
    close: async () => {
      await app.close();
      await client.close().catch(() => undefined);
    },
  };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export function latestMail(mail: MailService, to: string) {
  const found = [...mail.outbox].reverse().find((m) => m.to === to.trim().toLowerCase());
  if (!found) throw new Error(`No email was sent to ${to}`);
  return found;
}

export const codeFrom = (text: string) => /code is (\d{6})/.exec(text)![1];
export const linkTokenFrom = (text: string) => /token=([\w-]+)/.exec(text)![1];

export async function signIn(t: TestApp, email: string) {
  await t.http().post('/v1/auth/email/start').send({ email }).expect(200);
  const code = codeFrom(latestMail(t.mail, email).text);
  const res = await t.http().post('/v1/auth/email/verify').send({ email, code }).expect(200);
  return res.body as { accessToken: string; refreshToken: string; isNewUser: boolean };
}
