import { loadEnv } from './env';

/** Everything production insists on, filled in. */
const production = {
  NODE_ENV: 'production',
  JWT_SECRET: 'prod-jwt-secret-long-enough-for-the-check',
  CODE_SECRET: 'prod-code-secret-long-enough-for-the-check',
  MAIL_TRANSPORT: 'smtp',
  SMTP_HOST: 'smtp.example.com',
  BUNNY_STREAM_TOKEN_KEY: 'stream-token-key',
  BUNNY_WEBHOOK_SECRET: 'webhook-secret',
  NOTES_KEY: Buffer.alloc(32, 7).toString('base64'),
  CORS_ORIGINS: 'https://studio.example.com,https://app.example.com',
  WEB_URL: 'https://app.example.com',
};

describe('the production guard', () => {
  it('boots with everything set', () => {
    expect(loadEnv(production).WEB_URL).toBe('https://app.example.com');
  });

  it("won't send sign-in emails whose link points at a developer's machine", () => {
    const { WEB_URL: _unset, ...rest } = production;
    expect(() => loadEnv(rest)).toThrow(/WEB_URL: every sign-in email links here/);
    expect(() => loadEnv({ ...production, WEB_URL: 'http://app.example.com' })).toThrow(/WEB_URL/);
  });
});
