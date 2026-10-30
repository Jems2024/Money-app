/**
 * Portable Web Crypto utilities compatible with both Supabase Edge Functions (Deno)
 * and Node.js 20+/24+ (`globalThis.crypto.subtle`).
 *
 * Verified in M0 spike:
 * 1. RS256 JWT signing for Enable Banking API authentication (`alg: RS256`, `kid: app_id`,
 *    `iss: "enablebanking.com"`, `aud: "api.enablebanking.com"`).
 * 2. ES256 (P-256) JWT signing for Web Push VAPID (RFC 8292).
 * 3. AES-256-GCM authenticated encryption for server-side secret storage.
 * 4. Cryptographically random one-use state generation and SHA-256 hashing.
 */

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function stringToBase64Url(str: string): string {
  return bytesToBase64Url(new TextEncoder().encode(str));
}

export function base64UrlToBytes(base64Url: string): Uint8Array {
  const padded = base64Url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function pemToPkcs8Der(pem: string): ArrayBuffer {
  const clean = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\\n/g, '')
    .replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export interface EnableBankingJwtOptions {
  appId: string; // UUID registered in Enable Banking Control Panel -> JWT header `kid`
  privateKeyPem: string; // PKCS#8 PEM RSA private key
  issuedAtSeconds?: number;
  ttlSeconds?: number; // Max 3600s recommended by Enable Banking
  issuer?: string;
  audience?: string;
}

/**
 * Signs an Enable Banking API Bearer JWT using RS256 via standard Web Crypto API.
 */
export async function signEnableBankingJwt(options: EnableBankingJwtOptions): Promise<string> {
  const ttl = options.ttlSeconds ?? 300;
  if (ttl <= 0 || ttl > 86400) {
    throw new Error('Invalid Enable Banking JWT TTL: must be between 1 and 86400 seconds');
  }
  const iat = options.issuedAtSeconds ?? Math.floor(Date.now() / 1000);
  const exp = iat + ttl;

  const header = {
    typ: 'JWT',
    alg: 'RS256',
    kid: options.appId,
  };

  const payload = {
    iss: options.issuer ?? 'enablebanking.com',
    aud: options.audience ?? 'api.enablebanking.com',
    iat,
    exp,
  };

  const signingInput = `${stringToBase64Url(JSON.stringify(header))}.${stringToBase64Url(JSON.stringify(payload))}`;
  const keyData = pemToPkcs8Der(options.privateKeyPem);

  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'pkcs8',
    keyData,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign']
  );

  const signatureBuffer = await globalThis.crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signatureBuffer))}`;
}

/**
 * Verifies an RS256 JWT against a public CryptoKey (used in unit/spike tests).
 */
export async function verifyRs256Jwt(jwt: string, publicKey: CryptoKey): Promise<{
  valid: boolean;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}> {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed JWT');
  }
  const [h, p, s] = parts as [string, string, string];
  const signingInput = new TextEncoder().encode(`${h}.${p}`);
  const sigBytes = base64UrlToBytes(s);
  const valid = await globalThis.crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    sigBytes as BufferSource,
    signingInput
  );
  const header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(h))) as Record<string, unknown>;
  const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(p))) as Record<string, unknown>;
  return { valid, header, payload };
}

/**
 * Signs a Web Push VAPID JWT (ES256 / P-256) per RFC 8292 using Web Crypto API.
 */
export async function signVapidJwt(params: {
  audienceOrigin: string;
  subject: string;
  privateKeyJwk: JsonWebKey;
  issuedAtSeconds?: number;
  ttlSeconds?: number;
}): Promise<string> {
  const parsedUrl = new URL(params.audienceOrigin);
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('VAPID audience origin must use HTTPS');
  }
  const aud = parsedUrl.origin;
  const iat = params.issuedAtSeconds ?? Math.floor(Date.now() / 1000);
  const exp = iat + (params.ttlSeconds ?? 43200); // 12h default

  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud,
    exp,
    sub: params.subject,
  };

  const signingInput = `${stringToBase64Url(JSON.stringify(header))}.${stringToBase64Url(JSON.stringify(payload))}`;
  const ecKey = await globalThis.crypto.subtle.importKey(
    'jwk',
    params.privateKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const signature = await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    ecKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/**
 * Generates a cryptographically random 256-bit state token (Base64URL) and its SHA-256 hex digest.
 */
export async function generateOneTimeAuthState(): Promise<{
  rawState: string;
  stateHashHex: string;
}> {
  const randomBytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(randomBytes);
  const rawState = bytesToBase64Url(randomBytes);
  const stateHashHex = await sha256Hex(rawState);
  return { rawState, stateHashHex };
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
