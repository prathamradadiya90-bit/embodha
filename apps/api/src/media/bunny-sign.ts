import { createHash } from 'node:crypto';

/**
 * Signature Bunny Stream expects on a TUS upload: hex SHA-256 of library id + API key + expiry + video id.
 * The browser gets the signature, never the key.
 */
export function tusSignature(libraryId: string, apiKey: string, expiresAt: number, videoId: string): string {
  return createHash('sha256').update(`${libraryId}${apiKey}${expiresAt}${videoId}`).digest('hex');
}

export interface SignOptions {
  url: string;
  securityKey: string;
  /** Unix seconds. */
  expires: number;
  /**
   * Sign a whole directory, e.g. `/<video guid>/`. The token then sits in the path, so the relative
   * segment URLs inside an HLS playlist inherit it. Leave out to sign one file.
   */
  tokenPath?: string;
}

/** Bunny CDN token authentication, following Bunny's published reference implementation. */
export function signBunnyUrl({ url, securityKey, expires, tokenPath }: SignOptions): string {
  const parsed = new URL(url);
  const params = new URLSearchParams(parsed.search);
  const signaturePath = tokenPath ?? decodeURIComponent(parsed.pathname);
  if (tokenPath) params.set('token_path', tokenPath);
  params.sort();

  let signedParams = '';
  let urlParams = '';
  for (const [key, value] of params) {
    if (!value) continue;
    signedParams += `${signedParams ? '&' : ''}${key}=${value}`;
    urlParams += `&${key}=${encodeURIComponent(value)}`;
  }

  const token = createHash('sha256')
    .update(`${securityKey}${signaturePath}${expires}${signedParams}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return tokenPath
    ? `${parsed.protocol}//${parsed.host}/bcdn_token=${token}${urlParams}&expires=${expires}${parsed.pathname}`
    : `${parsed.protocol}//${parsed.host}${parsed.pathname}?token=${token}${urlParams}&expires=${expires}`;
}
