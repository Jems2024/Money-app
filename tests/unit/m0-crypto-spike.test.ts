import { describe, it, expect } from 'vitest';
import {
  signEnableBankingJwt,
  verifyRs256Jwt,
  signVapidJwt,
  generateOneTimeAuthState,
  sha256Hex,
  base64UrlToBytes,
} from '../../src/server/crypto/runtimeSpike';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

describe('M0 Runtime Spike — Web Crypto RS256 (Enable Banking) & ES256 (VAPID)', () => {
  it('generates and verifies an Enable Banking RS256 JWT with kid, iss, aud, iat, exp', async () => {
    const keyPair = await globalThis.crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify']
    );

    const pkcs8Der = await globalThis.crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    const pem = `-----BEGIN PRIVATE KEY-----\n${arrayBufferToBase64(pkcs8Der)}\n-----END PRIVATE KEY-----`;

    const appId = '11111111-2222-3333-4444-555555555555';
    const jwt = await signEnableBankingJwt({
      appId,
      privateKeyPem: pem,
      issuedAtSeconds: 1793400000,
      ttlSeconds: 600,
    });

    const verified = await verifyRs256Jwt(jwt, keyPair.publicKey);
    expect(verified.valid).toBe(true);
    expect(verified.header).toEqual({
      typ: 'JWT',
      alg: 'RS256',
      kid: appId,
    });
    expect(verified.payload).toEqual({
      iss: 'enablebanking.com',
      aud: 'api.enablebanking.com',
      iat: 1793400000,
      exp: 1793400600,
    });
  });

  it('signs a Web Push VAPID ES256 JWT over P-256 curve and rejects non-HTTPS origins', async () => {
    const ecKeyPair = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const privateJwk = await globalThis.crypto.subtle.exportKey('jwk', ecKeyPair.privateKey);

    const jwt = await signVapidJwt({
      audienceOrigin: 'https://web.push.apple.com/QH12345',
      subject: 'mailto:alertas@stopspend.example.com',
      privateKeyJwk: privateJwk,
      issuedAtSeconds: 1793400000,
      ttlSeconds: 3600,
    });

    const parts = jwt.split('.');
    expect(parts.length).toBe(3);
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1]!)));
    expect(payload.aud).toBe('https://web.push.apple.com');
    expect(payload.sub).toBe('mailto:alertas@stopspend.example.com');

    await expect(
      signVapidJwt({
        audienceOrigin: 'http://insecure.push.example.com',
        subject: 'mailto:test@example.com',
        privateKeyJwk: privateJwk,
      })
    ).rejects.toThrow(/HTTPS/i);
  });

  it('generates cryptographically random one-use state tokens and deterministic SHA-256 hashes', async () => {
    const s1 = await generateOneTimeAuthState();
    const s2 = await generateOneTimeAuthState();
    expect(s1.rawState).not.toBe(s2.rawState);
    expect(s1.rawState.length).toBeGreaterThanOrEqual(42);
    expect(await sha256Hex(s1.rawState)).toBe(s1.stateHashHex);
  });
});
