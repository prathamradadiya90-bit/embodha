import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { fail } from '../common/errors';

const base64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

/**
 * Reads a PEM private key from an environment variable. Hosting dashboards often turn line breaks into "\n",
 * and some people paste the file base64-encoded, so both are accepted.
 */
export function readPrivateKey(text: string): KeyObject {
  const pem = text.includes('-----BEGIN') ? text.replace(/\\n/g, '\n') : Buffer.from(text, 'base64').toString('utf8');
  return createPrivateKey(pem);
}

/**
 * A signed JWT. ES256 is what Apple's App Store Server API wants, with the signature as raw r||s (not DER);
 * RS256 is what Google's OAuth token endpoint wants for a service account.
 */
export function signJwt(alg: 'ES256' | 'RS256', key: KeyObject, payload: Record<string, unknown>, header: Record<string, string> = {}) {
  const data = `${base64url(JSON.stringify({ alg, typ: 'JWT', ...header }))}.${base64url(JSON.stringify(payload))}`;
  const signature = sign('sha256', Buffer.from(data), alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key);
  return `${data}.${base64url(signature)}`;
}

/**
 * The payload of a JWS without checking its signature. Only for data fetched from Apple over its own authenticated
 * API, or to read a transaction ID out of a pushed notification before asking Apple about it directly.
 */
export function readJws<T>(jws: unknown): T {
  const parts = typeof jws === 'string' ? jws.split('.') : [];
  if (parts.length !== 3) throw fail(400, 'bad_jws', 'That is not a signed App Store payload.');
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as T;
  } catch {
    throw fail(400, 'bad_jws', 'That is not a signed App Store payload.');
  }
}
