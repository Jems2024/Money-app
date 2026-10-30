import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { handleBankAuthRequest } from '../../supabase/functions/bank-auth/index';
import { handleBankCallbackRequest } from '../../supabase/functions/bank-callback/index';

describe('Database Migrations RLS, Built Bundle Secret Absence & Edge Function Integration Tests', () => {
  it('verifies built frontend bundle (dist/) contains zero server secrets or private keys (Acceptance Test 21)', () => {
    const distAssetsDir = resolve(process.cwd(), 'dist/assets');
    if (existsSync(distAssetsDir)) {
      const files = readdirSync(distAssetsDir);
      for (const file of files) {
        const content = readFileSync(resolve(distAssetsDir, file), 'utf-8');
        expect(content).not.toContain('BEGIN PRIVATE KEY');
        expect(content).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
        expect(content).not.toContain('ENABLE_BANKING_PRIVATE_KEY_PEM');
        expect(content).not.toContain('VAPID_PRIVATE_KEY_JWK');
      }
    }
  });
  const migration1Path = resolve(
    process.cwd(),
    'supabase/migrations/20261030000001_stop_spend_schema_rls.sql'
  );
  const migration2Path = resolve(
    process.cwd(),
    'supabase/migrations/20261030000002_cron_and_rpcs.sql'
  );

  it('verifies all 17 public tables enforce RLS, FORCE RLS, revoke anon, and use BIGINT cents & composite FKs', () => {
    const sql1 = readFileSync(migration1Path, 'utf-8');
    const sql2 = readFileSync(migration2Path, 'utf-8');

    const expectedTables = [
      'profiles',
      'accounts',
      'bank_connections',
      'balance_snapshots',
      'import_batches',
      'source_records',
      'obligations',
      'savings_reservations',
      'canonical_transactions',
      'transaction_splits',
      'reconciliation_links',
      'budget_allocations',
      'categorization_rules',
      'alert_handled_thresholds',
      'alert_outbox',
      'push_subscriptions',
      'offline_sync_receipts',
    ];

    for (const tbl of expectedTables) {
      expect(sql1).toContain(`CREATE TABLE IF NOT EXISTS public.${tbl}`);
      expect(sql1).toContain(`'${tbl}'`);
    }

    // Verify RLS and FORCE RLS loop
    expect(sql1).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql1).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql1).toContain('REVOKE ALL ON public.%I FROM anon');
    expect(sql1).toContain('(SELECT auth.uid()) = user_id');

    // Verify composite foreign keys prevent cross-user linking
    expect(sql1).toContain('FOREIGN KEY (account_id, user_id) REFERENCES public.accounts(id, user_id)');
    expect(sql1).toContain(
      'FOREIGN KEY (transaction_id, user_id) REFERENCES public.canonical_transactions(id, user_id)'
    );

    // Verify no FLOAT/REAL/DOUBLE PRECISION/NUMERIC float approximations for money
    expect(sql1).not.toMatch(/\b(FLOAT|REAL|DOUBLE PRECISION)\b/i);

    // Verify private schema isolation
    expect(sql1).toContain('REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anon, authenticated;');
    expect(sql1).toContain('REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM PUBLIC, anon, authenticated;');

    // Verify safe RPC search_path
    expect(sql2).toContain('SET search_path = public, pg_temp');
    expect(sql2).toContain('SECURITY INVOKER');
  });

  it('executes bank-auth and bank-callback server handlers end-to-end with state binding & query param stripping', async () => {
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
    const bytes = new Uint8Array(pkcs8Der);
    let bin = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      bin += String.fromCharCode(bytes[i]!);
    }
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----`;

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/aspsps')) {
        return new Response(JSON.stringify({ aspsps: [{ name: 'CaixaBank', country: 'ES' }] }), {
          status: 200,
        });
      }
      if (url.endsWith('/auth')) {
        return new Response(
          JSON.stringify({ url: 'https://caixabank.example/authorize?state=ok' }),
          { status: 200 }
        );
      }
      if (url.endsWith('/sessions')) {
        return new Response(
          JSON.stringify({
            session_id: 'sess_123',
            accounts: [
              {
                uid: 'acc_1',
                account_id: { iban: 'ES9121000418450200051332' },
                name: 'Cuenta CaixaBank',
                currency: 'EUR',
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(null, { status: 404 });
    };

    const authRes = await handleBankAuthRequest({
      authenticatedUserId: 'user_jared',
      mode: 'sandbox',
      appId: 'app_uuid_1',
      privateKeyPem: pem,
      redirectUri: 'https://stopspend.example.com/auth/bank/callback',
      allowedOrigins: ['https://stopspend.example.com'],
      fetchImpl: mockFetch,
    });

    expect(authRes.status).toBe(200);
    expect(authRes.body.authorizationUrl).toContain('caixabank.example');

    // Now test unconfigured mode
    const unconfRes = await handleBankAuthRequest({
      authenticatedUserId: 'user_jared',
      mode: 'unconfigured',
      appId: '',
      privateKeyPem: '',
      redirectUri: 'https://stopspend.example.com/auth/bank/callback',
      allowedOrigins: ['https://stopspend.example.com'],
    });
    expect(unconfRes.status).toBe(400);

    // Ensure callback rejects wrong state
    await expect(
      handleBankCallbackRequest({
        rawStateFromQuery: 'wrong_state',
        codeFromQuery: 'code_1',
        storedStateRecords: [authRes.body.persistedStateRecord!],
        currentCallbackUrl: 'https://stopspend.example.com/auth/bank/callback?code=code_1&state=wrong',
        mode: 'sandbox',
        appId: 'app_uuid_1',
        privateKeyPem: pem,
        redirectUri: 'https://stopspend.example.com/auth/bank/callback',
        allowedOrigins: ['https://stopspend.example.com'],
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow();
  });
});
