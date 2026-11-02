/**
 * Supabase Edge Function: `bank-sync`
 * Runs paginated synchronization (`GET /accounts/{id}/balances` and `/transactions`)
 * for an active Enable Banking connection using per-connection locks and durable cursors.
 * Separates `isUserInitiated` interactive refreshes from unattended cron jobs.
 * Persists results to `balance_snapshots`, `source_records`, and `canonical_transactions`.
 */
import { createClient } from '@supabase/supabase-js';
import {
  EnableBankingAdapter,
  syncAccountPagesAtomically,
  SyncCursorState,
} from '../../../src/server/providers/enableBanking.ts';
import { requireAuthenticatedUser } from '../../../src/server/security/rlsEnforcement.ts';
import { Account, CanonicalTransaction, createAccount, SourceRecord } from '../../../src/domain/ledger/index.ts';
import { CalendarDateISO, getMadridDateParts } from '../../../src/domain/dates/madrid.ts';
import { mapTransactionToDbRow } from '../../../src/state/supabaseRepository.ts';

declare const Deno: {
  env: { get(key: string): string | undefined };
  serve: (handler: (req: Request) => Promise<Response> | Response) => void;
} | undefined;

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

export async function handleBankSyncRequest(params: {
  authenticatedUserId: string | null;
  isUserInitiated: boolean;
  mode: 'unconfigured' | 'sandbox' | 'production';
  appId: string;
  privateKeyPem: string;
  redirectUri: string;
  allowedOrigins: string[];
  account: Account;
  cursor: SyncCursorState;
  dateFrom: CalendarDateISO;
  dateTo: CalendarDateISO;
  existingSources: readonly SourceRecord[];
  existingTransactions: readonly CanonicalTransaction[];
  fetchImpl?: typeof fetch;
}) {
  const userId = requireAuthenticatedUser(params.authenticatedUserId);

  if (params.mode === 'unconfigured' || !params.appId || !params.privateKeyPem) {
    return {
      status: 400,
      body: {
        error: 'PROVIDER_UNCONFIGURED',
        messageSpanish:
          'Enable Banking está sin configurar. Configura ENABLE_BANKING_APP_ID y ENABLE_BANKING_PRIVATE_KEY_PEM cuando dispongas de acceso.',
      },
    };
  }

  if (!params.account.providerSessionAccountId) {
    return {
      status: 400,
      body: {
        error: 'NO_PROVIDER_SESSION_ACCOUNT',
        messageSpanish: 'La cuenta no tiene una sesión activa vinculada en Enable Banking.',
      },
    };
  }

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

  const syncResult = await syncAccountPagesAtomically({
    userId,
    account: params.account,
    cursor: params.cursor,
    targetDateFrom: params.dateFrom,
    targetDateTo: params.dateTo,
    isUserInitiated: params.isUserInitiated,
    existingSources: params.existingSources,
    existingTransactions: params.existingTransactions,
    fetchPage: (continuationKey) =>
      adapter.fetchAccountTransactionsPage({
        providerSessionAccountId: params.account.providerSessionAccountId!,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        continuationKey,
        isUserInitiated: params.isUserInitiated,
      }),
  });

  return {
    status: syncResult.success ? 200 : 502,
    body: syncResult,
  };
}

if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') {
  Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders });
    }

    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
      const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
      const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
      const authHeader = req.headers.get('Authorization') ?? '';

      if (!authHeader) {
        return new Response(
          JSON.stringify({
            error: 'UNAUTHENTICATED',
            messageSpanish: 'Debes iniciar sesión para sincronizar tu banco.',
          }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const {
        data: { user },
        error: authError,
      } = await userClient.auth.getUser();

      if (authError || !user) {
        return new Response(
          JSON.stringify({
            error: 'UNAUTHENTICATED',
            messageSpanish: 'Sesión no válida o expirada.',
          }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const serviceClient = createClient(supabaseUrl, serviceRoleKey);

      // Verify active bank connection
      const { data: bankConn } = await serviceClient
        .from('bank_connections')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();

      if (!bankConn || !bankConn.has_valid_session) {
        return new Response(
          JSON.stringify({
            error: 'NO_VALID_SESSION',
            messageSpanish: 'La cuenta no tiene una sesión activa vinculada en CaixaBank.',
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const appId = Deno.env.get('ENABLE_BANKING_APP_ID') ?? '';
      const privateKeyPem = Deno.env.get('ENABLE_BANKING_PRIVATE_KEY_PEM') ?? '';
      const mode = (Deno.env.get('ENABLE_BANKING_MODE') as 'production' | 'sandbox') ?? 'production';

      if (!appId || !privateKeyPem) {
        return new Response(
          JSON.stringify({
            error: 'PROVIDER_UNCONFIGURED',
            messageSpanish: 'La conexión bancaria todavía no está disponible en el servidor.',
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Fetch user's bank accounts
      const { data: dbAccounts } = await serviceClient
        .from('accounts')
        .select('*')
        .eq('user_id', user.id)
        .eq('provider_code', 'enable_banking');

      if (!dbAccounts || dbAccounts.length === 0) {
        return new Response(
          JSON.stringify({
            error: 'NO_BANK_ACCOUNTS',
            messageSpanish: 'No se encontraron cuentas bancarias sincronizables.',
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const adapter = new EnableBankingAdapter({
        mode,
        baseUrl: 'https://api.enablebanking.com',
        appId,
        privateKeyPem,
        redirectUri: '',
        allowedOrigins: [],
      });

      const nowIso = new Date().toISOString();
      const madridNow = getMadridDateParts(nowIso);
      const todayDate = madridNow.calendarDate;

      // 30 days window
      const dateFromMs = Date.now() - 30 * 24 * 3600 * 1000;
      const dateFrom = getMadridDateParts(new Date(dateFromMs).toISOString()).calendarDate;

      let totalNewTransactions = 0;
      let anyAccountSucceeded = false;
      let anyAccountFailed = false;
      let lastAccountError: string | null = null;

      for (const rawAcc of dbAccounts) {
        if (!rawAcc.provider_session_account_id) continue;

        const account = createAccount({
          id: rawAcc.id,
          userId: rawAcc.user_id,
          name: rawAcc.name,
          type: rawAcc.type,
          currency: 'EUR',
          includeInLiquidity: rawAcc.include_in_liquidity,
          isOwned: rawAcc.is_owned,
          providerCode: rawAcc.provider_code,
          providerSessionAccountId: rawAcc.provider_session_account_id,
          ibanMasked: rawAcc.iban_masked,
        });

        // 1. Fetch & persist latest balances
        try {
          const balances = await adapter.fetchAccountBalances({
            providerSessionAccountId: account.providerSessionAccountId!,
            isUserInitiated: true,
            fallbackDate: todayDate,
          });
          for (const b of balances) {
            await serviceClient.from('balance_snapshots').insert({
              id: `snap_${Date.now()}_${account.id}`,
              user_id: user.id,
              account_id: account.id,
              source: 'provider',
              balance_type: b.balanceType,
              amount_cents: b.amountCents,
              currency: 'EUR',
              reference_time_utc: nowIso,
              reference_booking_date: b.referenceBookingDate,
              includes_pending_debits: b.includesPendingDebits,
            });
          }
        } catch (balErr: unknown) {
          const balMsg = balErr instanceof Error ? balErr.message : String(balErr);
          await serviceClient
            .from('bank_connections')
            .update({ last_error_spanish: `Error de saldo: ${balMsg}`, updated_at: nowIso })
            .eq('user_id', user.id);
        }

        // 2. Load existing sources & transactions to guarantee atomic idempotent sync
        const { data: existingSourcesRaw } = await serviceClient
          .from('source_records')
          .select('*')
          .eq('user_id', user.id)
          .eq('account_id', account.id);

        const { data: existingTxsRaw } = await serviceClient
          .from('canonical_transactions')
          .select('*')
          .eq('user_id', user.id)
          .eq('account_id', account.id);

        const existingSources: SourceRecord[] = (existingSourcesRaw ?? []).map((s) => ({
          id: s.id,
          userId: s.user_id,
          accountId: s.account_id,
          sourceType: s.source_type,
          providerCode: s.provider_code,
          sourceExternalId: s.source_external_id,
          importBatchId: s.import_batch_id,
          originalDescription: s.original_description,
          bookingDate: s.booking_date,
          valueDate: s.value_date,
          occurredAtUtc: s.occurred_at_utc,
          receivedAtServerUtc: s.received_at_server_utc,
          status: s.status,
          currency: 'EUR',
          amountCents: Number(s.amount_cents),
          counterpartyName: s.counterparty_name,
          counterpartyIbanNormalized: s.counterparty_iban_normalized,
          remittanceInfo: s.remittance_info,
          normalizationVersion: Number(s.normalization_version ?? 1),
          provenance: s.provenance,
        }));

        const existingTransactions: CanonicalTransaction[] = (existingTxsRaw ?? []).map((r) => ({
          id: r.id,
          userId: r.user_id,
          accountId: r.account_id,
          type: r.type,
          status: r.status,
          amountCents: Number(r.amount_cents),
          currency: 'EUR',
          bookingDate: r.booking_date,
          valueDate: r.value_date,
          occurredAtUtc: r.occurred_at_utc,
          createdAtUtc: r.created_at_utc,
          description: r.description,
          merchantNormalized: r.merchant_normalized,
          userNote: r.user_note,
          categoryId: r.category_id,
          categorySource: r.category_source,
          categoryConfidence: Number(r.category_confidence),
          categoryExplanation: r.category_explanation,
          scope: r.scope,
          smallSpendingTagged: Boolean(r.small_spending_tagged),
          splits: [],
          linkedExpenseId: r.linked_expense_id,
          transferPairId: r.transfer_pair_id,
          counterpartAccountId: r.counterpart_account_id,
          untrackedOwnedDestinationLabel: r.untracked_owned_destination_label,
          settledObligationId: r.settled_obligation_id,
          consumedSavingsReservationId: r.consumed_savings_reservation_id,
          supersededByTransactionId: r.superseded_by_transaction_id,
          reviewStatus: r.review_status,
          sourceRecordIds: [],
        }));

        // Cursor
        const cursor: SyncCursorState = {
          connectionId: bankConn.id,
          lastSuccessfulBookingDate: null,
          lastSuccessfulSyncUtc: bankConn.last_sync_at ? String(bankConn.last_sync_at) : null,
          isLocked: false,
          lastErrorSpanish: null,
        };

        const syncResult = await syncAccountPagesAtomically({
          userId: user.id,
          account,
          cursor,
          targetDateFrom: dateFrom,
          targetDateTo: todayDate,
          isUserInitiated: true,
          existingSources,
          existingTransactions,
          fetchPage: (continuationKey) =>
            adapter.fetchAccountTransactionsPage({
              providerSessionAccountId: account.providerSessionAccountId!,
              dateFrom,
              dateTo: todayDate,
              continuationKey,
              isUserInitiated: true,
            }),
        });

        if (syncResult.success) {
          anyAccountSucceeded = true;
          // Persist updated source records
          for (const src of syncResult.sourceRecords) {
            await serviceClient.from('source_records').upsert(
              {
                id: src.id,
                user_id: user.id,
                account_id: account.id,
                source_type: src.sourceType,
                provider_code: src.providerCode,
                source_external_id: src.sourceExternalId,
                import_batch_id: src.importBatchId,
                original_description: src.originalDescription,
                booking_date: src.bookingDate,
                value_date: src.valueDate,
                occurred_at_utc: src.occurredAtUtc,
                received_at_server_utc: src.receivedAtServerUtc,
                status: src.status,
                currency: 'EUR',
                amount_cents: src.amountCents,
                counterparty_name: src.counterpartyName,
                counterparty_iban_normalized: src.counterpartyIbanNormalized,
                remittance_info: src.remittanceInfo,
                normalization_version: src.normalizationVersion,
                provenance: src.provenance,
              },
              { onConflict: 'id' }
            );
          }

          // Persist canonical transactions
          for (const tx of syncResult.transactions) {
            const dbRow = mapTransactionToDbRow(user.id, tx);
            await serviceClient
              .from('canonical_transactions')
              .upsert(dbRow, { onConflict: 'id' });
          }

          totalNewTransactions += Math.max(0, syncResult.transactions.length - existingTransactions.length);
        } else {
          anyAccountFailed = true;
          const failureMsg = syncResult.updatedCursor.lastErrorSpanish ?? 'Fallo al sincronizar transacciones con CaixaBank.';
          lastAccountError = failureMsg;
          await serviceClient
            .from('bank_connections')
            .update({
              last_error_spanish: failureMsg,
              updated_at: nowIso,
            })
            .eq('user_id', user.id);
        }
      }

      if (anyAccountSucceeded && !anyAccountFailed) {
        // Full success: all accounts synced cleanly
        await serviceClient
          .from('bank_connections')
          .update({
            last_sync_at: nowIso,
            last_error_spanish: null,
            has_successful_real_read: true,
            updated_at: nowIso,
          })
          .eq('user_id', user.id);

        return new Response(
          JSON.stringify({
            success: true,
            status: 'full_success',
            newTransactionsCount: Math.max(0, totalNewTransactions),
            syncedAtUtc: nowIso,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      } else if (anyAccountSucceeded && anyAccountFailed) {
        // Partial success: at least one account succeeded, one failed
        await serviceClient
          .from('bank_connections')
          .update({
            last_sync_at: nowIso,
            last_error_spanish: `Sincronización parcial: ${lastAccountError ?? 'alguna cuenta no pudo completarse.'}`,
            has_successful_real_read: true,
            updated_at: nowIso,
          })
          .eq('user_id', user.id);

        return new Response(
          JSON.stringify({
            success: true,
            status: 'partial_success',
            newTransactionsCount: Math.max(0, totalNewTransactions),
            syncedAtUtc: nowIso,
            warningSpanish: `Sincronización parcial: ${lastAccountError}`,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      } else {
        // Complete failure: do not clear error, do not mark successful real read, preserve valid data
        await serviceClient
          .from('bank_connections')
          .update({
            last_error_spanish: lastAccountError ?? 'No se pudo sincronizar ninguna cuenta con CaixaBank.',
            updated_at: nowIso,
          })
          .eq('user_id', user.id);

        return new Response(
          JSON.stringify({
            success: false,
            status: 'failed',
            error: 'SYNC_FAILED',
            messageSpanish: lastAccountError ?? 'No se pudo sincronizar ninguna cuenta con CaixaBank. Se conservan los datos anteriores.',
          }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({ error: 'SYNC_FAILED', messageSpanish: msg }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  });
}
