import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** AES-256-GCM. Stored as "v1:" + base64(iv | tag | ciphertext), so the format can change later without guessing. */
export function seal(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
}

export function unseal(sealed: string, key: Buffer): string {
  const raw = Buffer.from(sealed.replace(/^v1:/, ''), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

/** NOTES_KEY in production (the env check insists). Locally, a key derived from CODE_SECRET keeps setup short. */
export const notesKey = (env: { NOTES_KEY?: string; CODE_SECRET: string }) =>
  env.NOTES_KEY ? Buffer.from(env.NOTES_KEY, 'base64') : createHash('sha256').update(`notes:${env.CODE_SECRET}`).digest();
