/**
 * Supabase Edge Function: `bank-callback`
 * Validates and consumes the one-use authorization state against `app_private.bank_auth_states`,
 * exchanges the authorization code via `POST /sessions`, strips sensitive query parameters,
 * creates/updates discovered bank accounts & balances, and redirects or responds neutrally.
 */
import { createClient } from '@supabase/supabase-js';
import {
  EnableBankingAdapter,
  validateAndConsumeAuthStateCallback,
  AuthorizationStateRecord,
} from '../../../src/server/providers/enableBanking.ts';
import { sha256Hex } from '../../../src/server/crypto/runtimeSpike.ts';
import { getMadridDateParts } from '../../../src/domain/dates/madrid.ts';

declare const Deno: {
  env: { get(key: string): string | undefined };
  serve: (handler: (req: Request) => Promise<Response> | Response) => void;
} | undefined;

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export async function handleBankCallbackRequest(params: {
  rawStateFromQuery: string;
  codeFromQuery: string;
  storedStateRecords: readonly AuthorizationStateRecord[];
  authenticatedCallbackUserId?: string | null;
  currentCallbackUrl: string;
  mode: 'unconfigured' | 'sandbox' | 'production';
  appId: string;
  privateKeyPem: string;
  redirectUri: string;
  allowedOrigins: string[];
  fetchImpl?: typeof fetch;
}) {
  const consumed = await validateAndConsumeAuthStateCallback({
    rawStateFromQuery: params.rawStateFromQuery,
    codeFromQuery: params.codeFromQuery,
    storedRecords: params.storedStateRecords,
    authenticatedCallbackUserId: params.authenticatedCallbackUserId,
    currentCallbackUrl: params.currentCallbackUrl,
  });

  const adapter = new EnableBankingAdapter(
    {
      mode: params.mode,
      baseUrl: 'https://api.enablebanking.com',
      appId: params.appId,
      privateKeyPem: params.privateKeyPem,
      redirectUri: params.redirectUri,
      allowedOrigins: params.allowedOrigins,
    },
    params.fetchImpl
  );

  const session = await adapter.exchangeCodeForSession(params.codeFromQuery);

  return {
    status: 200,
    body: {
      initiatingUserId: consumed.consumedRecord.initiatingUserId,
      sanitizedBrowserPath: consumed.sanitizedBrowserPath,
      neutralCompletionMessageSpanish: consumed.neutralCompletionMessageSpanish,
      accountsDiscoveredCount: session.accounts.length,
      validUntilIso: session.validUntilIso,
    },
  };
}

if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') {
  Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders });
    }

    try {
      const url = new URL(req.url);
      let code = url.searchParams.get('code') ?? '';
      let rawState = url.searchParams.get('state') ?? '';

      if (req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        code = code || body.code || '';
        rawState = rawState || body.state || '';
      }

      if (!code || !rawState) {
        return new Response(
          JSON.stringify({
            error: 'MISSING_CALLBACK_PARAMS',
            messageSpanish: 'Faltan parámetros code o state en el retorno de CaixaBank.',
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
      const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
      const serviceClient = createClient(supabaseUrl, serviceRoleKey);

      // Validate & consume state atomically
      const stateHashHex = await sha256Hex(rawState);
      const { data: consumedRows, error: consumeErr } = await serviceClient.rpc(
        'consume_bank_auth_state',
        { p_state_hash_hex: stateHashHex }
      );

      if (consumeErr || !consumedRows || consumedRows.length === 0) {
        return new Response(
          JSON.stringify({
            error: 'INVALID_OR_CONSUMED_STATE',
            messageSpanish: 'El estado de autorización es inválido, expiró o ya fue consumido.',
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const stateRow = consumedRows[0];
      const initiatingUserId: string = stateRow.initiating_user_id;

      const appId = Deno.env.get('ENABLE_BANKING_APP_ID') ?? '';
      const privateKeyPem = Deno.env.get('ENABLE_BANKING_PRIVATE_KEY_PEM') ?? '';
      const mode = (Deno.env.get('ENABLE_BANKING_MODE') as 'production' | 'sandbox') ?? 'production';

      const adapter = new EnableBankingAdapter({
        mode,
        baseUrl: 'https://api.enablebanking.com',
        appId,
        privateKeyPem,
        redirectUri: stateRow.redirect_uri,
        allowedOrigins: [new URL(stateRow.redirect_uri).origin],
      });

      // Exchange code for session
      const session = await adapter.exchangeCodeForSession(code);
      const nowIso = new Date().toISOString();
      let hasSuccessfulBalanceRead = false;

      // Upsert discovered accounts and balances
      for (const acc of session.accounts) {
        const accountId = `acc_eb_${acc.providerSessionAccountId}`;

        await serviceClient.from('accounts').upsert(
          {
            id: accountId,
            user_id: initiatingUserId,
            name: acc.name,
            type: acc.productType ?? 'bank',
            currency: 'EUR',
            include_in_liquidity: acc.productType !== 'savings',
            is_owned: true,
            stable_identity_key: `enable_banking:${acc.ibanNormalized}`,
            provider_code: 'enable_banking',
            provider_session_account_id: acc.providerSessionAccountId,
            iban_masked: acc.ibanMasked,
            created_at: nowIso,
          },
          { onConflict: 'id,user_id' }
        );

        // Fetch initial balances
        try {
          const balances = await adapter.fetchAccountBalances({
            providerSessionAccountId: acc.providerSessionAccountId,
            isUserInitiated: true,
            fallbackDate: getMadridDateParts(nowIso).calendarDate,
          });
          for (const b of balances) {
            await serviceClient.from('balance_snapshots').insert({
              id: `snap_${Date.now()}_${acc.providerSessionAccountId}`,
              user_id: initiatingUserId,
              account_id: accountId,
              source: 'provider',
              balance_type: b.balanceType,
              amount_cents: b.amountCents,
              currency: 'EUR',
              reference_time_utc: nowIso,
              reference_booking_date: b.referenceBookingDate,
              includes_pending_debits: b.includesPendingDebits,
            });
            hasSuccessfulBalanceRead = true;
          }
        } catch {
          // If balance fetch fails initially, sync will retry
        }
      }

      // Update bank connection record
      await serviceClient.from('bank_connections').upsert(
        {
          id: `conn_caixabank_${initiatingUserId}`,
          user_id: initiatingUserId,
          provider_code: 'enable_banking',
          environment_mode: mode,
          aspsp_country: stateRow.aspsp_country,
          aspsp_name: stateRow.aspsp_name,
          status: 'connected',
          has_valid_session: true,
          has_successful_real_read: hasSuccessfulBalanceRead,
          last_sync_at: hasSuccessfulBalanceRead ? nowIso : null,
          provider_session_id: session.sessionId,
          last_error_spanish: hasSuccessfulBalanceRead ? null : 'Sesión autorizada. Pendiente de sincronizar saldo.',
          updated_at: nowIso,
        },
        { onConflict: 'id' }
      );

      // Handle GET vs POST return
      if (req.method === 'GET') {
        const clientReturnUrl = new URL(stateRow.redirect_uri);
        clientReturnUrl.searchParams.delete('code');
        clientReturnUrl.searchParams.delete('state');
        clientReturnUrl.searchParams.set('bank_connected', 'true');
        return Response.redirect(clientReturnUrl.toString(), 302);
      }

      return new Response(
        JSON.stringify({
          success: true,
          accountsDiscoveredCount: session.accounts.length,
          validUntilIso: session.validUntilIso,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({ error: 'CALLBACK_FAILED', messageSpanish: msg }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  });
}
