/**
 * Supabase Edge Function: `scheduled-sync-and-alerts`
 * Unattended background orchestrator. Runs up to 4 times per day (per PSD2 RTS Article 10):
 * 1. Synchronizes active bank connections unattended (`isUserInitiated: false`).
 * 2. Re-evaluates monthly budget envelopes, gastos hormiga limits, and category budgets.
 * 3. Enqueues threshold crossing events into `alert_outbox`.
 * 4. Dispatches pending alerts via Web Push (respecting Europe/Madrid quiet hours).
 */
import { createClient } from '@supabase/supabase-js';
import { EnableBankingAdapter, syncAccountPagesAtomically, SyncCursorState } from '../../../src/server/providers/enableBanking.ts';
import { createAccount, SourceRecord, CanonicalTransaction } from '../../../src/domain/ledger/index.ts';
import { getMadridDateParts } from '../../../src/domain/dates/madrid.ts';
import { mapTransactionToDbRow } from '../../../src/state/supabaseRepository.ts';
import {
  evaluateBudgetThresholdCrossing,
  AlertOutboxEvent,
  HandledThresholdRecord,
} from '../../../src/domain/alerts/index.ts';
import { calculatePersonalEnvelopes, BudgetPeriodAllocation, createBudgetAllocation } from '../../../src/domain/budgets/index.ts';
import { dispatchPendingAlertOutbox, StoredPushSubscription } from '../alerts-dispatch/index.ts';

declare const Deno: {
  env: { get(key: string): string | undefined };
  serve: (handler: (req: Request) => Promise<Response> | Response) => void;
} | undefined;

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') {
  Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders });
    }

    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
      const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
      if (!supabaseUrl || !serviceRoleKey) {
        return new Response(
          JSON.stringify({ error: 'MISSING_SERVICE_CONFIG', messageSpanish: 'Configuración de servicio no disponible.' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Security: verify request caller is authorized with service_role or valid secret
      const authHeader = req.headers.get('authorization') ?? '';
      const token = authHeader.replace(/^Bearer\s+/i, '');
      if (token !== serviceRoleKey && !token.startsWith('eyJ')) {
        return new Response(
          JSON.stringify({ error: 'UNAUTHORIZED', messageSpanish: 'Llamada no autorizada.' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const serviceClient = createClient(supabaseUrl, serviceRoleKey);
      const nowIso = new Date().toISOString();
      const madridNow = getMadridDateParts(nowIso);
      const currentPeriodKey = madridNow.periodKey;
      const todayDate = madridNow.calendarDate;
      const dateFromMs = Date.now() - 30 * 24 * 3600 * 1000;
      const dateFrom = getMadridDateParts(new Date(dateFromMs).toISOString()).calendarDate;

      const ebAppId = Deno.env.get('ENABLE_BANKING_APP_ID') ?? '';
      const ebKeyPem = Deno.env.get('ENABLE_BANKING_PRIVATE_KEY_PEM') ?? '';
      const ebMode = (Deno.env.get('ENABLE_BANKING_MODE') as 'sandbox' | 'production' | undefined) ?? 'sandbox';

      let syncedConnectionsCount = 0;
      let evaluatedBudgetsCount = 0;
      let newlyEmittedAlertsCount = 0;

      // 1. Fetch active connections
      const { data: activeConns } = await serviceClient
        .from('bank_connections')
        .select('*')
        .eq('status', 'connected')
        .eq('has_valid_session', true)
        .eq('local_sync_paused', false);

      if (ebAppId && ebKeyPem && activeConns && activeConns.length > 0) {
        const adapter = new EnableBankingAdapter({
          mode: ebMode,
          baseUrl: 'https://api.enablebanking.com',
          appId: ebAppId,
          privateKeyPem: ebKeyPem,
          redirectUri: '',
          allowedOrigins: [],
        });

        for (const conn of activeConns) {
          const userId = conn.user_id;

          const { data: dbAccounts } = await serviceClient
            .from('accounts')
            .select('*')
            .eq('user_id', userId)
            .not('provider_session_account_id', 'is', null);

          if (!dbAccounts || dbAccounts.length === 0) continue;

          let anySuccess = false;

          for (const rawAcc of dbAccounts) {
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

            // Fetch balances unattended
            try {
              const balances = await adapter.fetchAccountBalances({
                providerSessionAccountId: account.providerSessionAccountId!,
                isUserInitiated: false,
                fallbackDate: todayDate,
              });
              for (const b of balances) {
                await serviceClient.from('balance_snapshots').insert({
                  id: `snap_${Date.now()}_${account.id}`,
                  user_id: userId,
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
            } catch {
              // Unattended balance fetch retry on next window
            }

            // Sync transactions unattended
            const { data: existingSourcesRaw } = await serviceClient
              .from('source_records')
              .select('*')
              .eq('user_id', userId)
              .eq('account_id', account.id);

            const { data: existingTxsRaw } = await serviceClient
              .from('canonical_transactions')
              .select('*')
              .eq('user_id', userId)
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
              occurredAtUtc: s.occurredAtUtc,
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

            const cursor: SyncCursorState = {
              connectionId: conn.id,
              lastSuccessfulBookingDate: null,
              lastSuccessfulSyncUtc: conn.last_sync_at ? String(conn.last_sync_at) : null,
              isLocked: false,
              lastErrorSpanish: null,
            };

            const syncResult = await syncAccountPagesAtomically({
              userId,
              account,
              cursor,
              targetDateFrom: dateFrom,
              targetDateTo: todayDate,
              isUserInitiated: false, // Unattended PSD2 RTS
              existingSources,
              existingTransactions,
              fetchPage: (continuationKey) =>
                adapter.fetchAccountTransactionsPage({
                  providerSessionAccountId: account.providerSessionAccountId!,
                  dateFrom,
                  dateTo: todayDate,
                  continuationKey,
                  isUserInitiated: false,
                }),
            });

            if (syncResult.success) {
              anySuccess = true;
              for (const src of syncResult.sourceRecords) {
                await serviceClient.from('source_records').upsert(
                  {
                    id: src.id,
                    user_id: userId,
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

              for (const tx of syncResult.transactions) {
                const dbRow = mapTransactionToDbRow(userId, tx);
                await serviceClient.from('canonical_transactions').upsert(dbRow, { onConflict: 'id' });
              }
            }
          }

          if (anySuccess) {
            await serviceClient
              .from('bank_connections')
              .update({
                last_sync_at: nowIso,
                last_error_spanish: null,
                has_successful_real_read: true,
                updated_at: nowIso,
              })
              .eq('id', conn.id);
            syncedConnectionsCount++;
          }
        }
      }

      // 2. Budget threshold evaluation for all users with confirmed budgets in current period
      const { data: budgetRows } = await serviceClient
        .from('budget_allocations')
        .select('*')
        .eq('period_key', currentPeriodKey)
        .eq('confirmed_by_user', true);

      for (const b of budgetRows ?? []) {
        evaluatedBudgetsCount++;
        const userId = b.user_id;

        const alloc = createBudgetAllocation({
          id: b.id,
          userId,
          periodKey: currentPeriodKey,
          confirmedByUser: true,
          protectedSavingsAllocatedCents: Number(b.protected_savings_allocated_cents),
          smallPurchasesAllocatedCents: Number(b.small_purchases_allocated_cents),
          flexibleSpendingAllocatedCents: Number(b.flexible_spending_allocated_cents),
          rolloverFromPreviousCents: Number(b.rollover_from_previous_cents ?? 0),
          manualAdjustmentsCents: Number(b.manual_adjustments_cents ?? 0),
          categoryAllocationsCents: (b.category_allocations_cents as Record<string, number> | undefined) ?? {},
          scopeMode: (b.scope_mode as 'personal_only' | 'all_spending' | undefined) ?? 'personal_only',
          selectedAccountIds: (b.selected_account_ids as string[] | undefined) ?? [],
          repeatMonthly: Boolean(b.repeat_monthly),
        });

        // Load transactions & accounts
        const { data: userTxsRaw } = await serviceClient
          .from('canonical_transactions')
          .select('*')
          .eq('user_id', userId);

        const { data: userAccountsRaw } = await serviceClient
          .from('accounts')
          .select('*')
          .eq('user_id', userId);

        const userAccounts = (userAccountsRaw ?? []).map((a) =>
          createAccount({
            id: a.id,
            userId: a.user_id,
            name: a.name,
            type: a.type,
            currency: 'EUR',
            includeInLiquidity: a.include_in_liquidity,
            isOwned: a.is_owned,
            providerCode: a.provider_code,
            providerSessionAccountId: a.provider_session_account_id,
            ibanMasked: a.iban_masked,
          })
        );

        const userTxs: CanonicalTransaction[] = (userTxsRaw ?? []).map((r) => ({
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

        const envelopes = calculatePersonalEnvelopes({
          allocation: alloc,
          transactions: userTxs,
          accounts: userAccounts,
        });

        // Load existing handled and outbox
        const { data: handledRows } = await serviceClient
          .from('alert_handled_thresholds')
          .select('*')
          .eq('user_id', userId);

        const { data: outboxRows } = await serviceClient
          .from('alert_outbox')
          .select('*')
          .eq('user_id', userId);

        const handledRecords: HandledThresholdRecord[] = (handledRows ?? []).map((h) => ({
          idempotencyKey: h.idempotency_key,
          userId: h.user_id,
          budgetId: h.budget_id,
          periodKey: h.period_key,
          thresholdPercent: h.threshold_percent,
          resolution: h.resolution,
          recordedAtUtc: h.recorded_at_utc,
        }));

        const outboxEvents: AlertOutboxEvent[] = (outboxRows ?? []).map((e) => ({
          id: e.id,
          idempotencyKey: e.idempotency_key,
          clientNotificationTag: e.client_notification_tag,
          userId: e.user_id,
          budgetId: e.budget_id,
          budgetName: e.budget_name,
          periodKey: e.period_key,
          thresholdPercent: e.threshold_percent,
          lowerThresholdsCrossedAndMarkedHandled: [],
          budgetAllocatedCents: e.budget_allocated_cents,
          spentAfterCents: e.spent_after_cents,
          remainingAfterCents: e.remaining_after_cents,
          inAppTitleSpanish: e.in_app_title_spanish,
          inAppBodySpanish: e.in_app_body_spanish,
          pushPayload: e.push_payload,
          deliveryState: e.delivery_state,
          seenByUserAtUtc: e.seen_by_user_at_utc,
          createdAtUtc: e.created_at_utc,
        }));

        // Evaluate total budget
        const totalEval = evaluateBudgetThresholdCrossing({
          userId,
          budgetId: 'personal_spendable_total',
          budgetName: 'Presupuesto del mes',
          periodKey: currentPeriodKey,
          budgetAllocatedCents: envelopes.spendableAllocatedCents,
          spentBeforeCents: envelopes.totalPersonalNetSpentCents,
          spentAfterCents: envelopes.totalPersonalNetSpentCents,
          existingHandledRecords: handledRecords,
          existingOutboxEvents: outboxEvents,
          nowInstantUtc: nowIso,
          quietHoursConfig: { enabled: true, startHour: 22, endHour: 8 },
        });

        // Evaluate small purchases if set
        let nextHandled = totalEval.updatedHandledRecords;
        let nextOutbox = totalEval.updatedOutboxEvents;

        if (alloc.smallPurchasesAllocatedCents > 0) {
          const smallEval = evaluateBudgetThresholdCrossing({
            userId,
            budgetId: 'small_purchases_total',
            budgetName: 'Gastos hormiga',
            periodKey: currentPeriodKey,
            budgetAllocatedCents: alloc.smallPurchasesAllocatedCents,
            spentBeforeCents: envelopes.smallPurchasesNetSpentCents,
            spentAfterCents: envelopes.smallPurchasesNetSpentCents,
            existingHandledRecords: nextHandled,
            existingOutboxEvents: nextOutbox,
            nowInstantUtc: nowIso,
            quietHoursConfig: { enabled: true, startHour: 22, endHour: 8 },
          });
          nextHandled = smallEval.updatedHandledRecords;
          nextOutbox = smallEval.updatedOutboxEvents;
        }

        // Persist newly handled records
        const newHandled = nextHandled.filter(
          (nh) => !handledRecords.some((eh) => eh.idempotencyKey === nh.idempotencyKey)
        );
        for (const h of newHandled) {
          await serviceClient.from('alert_handled_thresholds').upsert(
            {
              idempotency_key: h.idempotencyKey,
              user_id: h.userId,
              budget_id: h.budgetId,
              period_key: h.periodKey,
              threshold_percent: h.thresholdPercent,
              resolution: h.resolution,
              recorded_at_utc: h.recordedAtUtc,
            },
            { onConflict: 'idempotency_key' }
          );
        }

        // Persist newly emitted alerts
        const newEvents = nextOutbox.filter(
          (ne) => !outboxEvents.some((ee) => ee.idempotencyKey === ne.idempotencyKey)
        );
        for (const ev of newEvents) {
          await serviceClient.from('alert_outbox').upsert(
            {
              id: ev.id,
              idempotency_key: ev.idempotencyKey,
              client_notification_tag: ev.clientNotificationTag,
              user_id: ev.userId,
              budget_id: ev.budgetId,
              budget_name: ev.budgetName,
              period_key: ev.periodKey,
              threshold_percent: ev.thresholdPercent,
              budget_allocated_cents: ev.budgetAllocatedCents,
              spent_after_cents: ev.spentAfterCents,
              remaining_after_cents: ev.remainingAfterCents,
              in_app_title_spanish: ev.inAppTitleSpanish,
              in_app_body_spanish: ev.inAppBodySpanish,
              push_payload: ev.pushPayload,
              delivery_state: ev.deliveryState,
              created_at_utc: ev.createdAtUtc,
            },
            { onConflict: 'idempotency_key' }
          );
          newlyEmittedAlertsCount++;
        }
      }

      // 3. Dispatch pending alerts via VAPID Web Push
      const vapidSubject = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@stopspend.example.com';
      const vapidKeyJson = Deno.env.get('VAPID_PRIVATE_KEY_JWK');
      let dispatchedCount = 0;

      if (vapidKeyJson) {
        const vapidPrivateKeyJwk = JSON.parse(vapidKeyJson);
        const { data: outboxRowsToDispatch } = await serviceClient
          .from('alert_outbox')
          .select('*')
          .in('delivery_state', ['generated', 'queued_quiet_hours', 'failed_transient']);

        const { data: activeSubsRaw } = await serviceClient
          .from('push_subscriptions')
          .select('*')
          .eq('is_active', true);

        const subscriptions: StoredPushSubscription[] = (activeSubsRaw ?? []).map((s) => ({
          id: s.id,
          userId: s.user_id,
          endpoint: s.endpoint,
          p256dhKey: s.p256dh_key,
          authSecret: s.auth_secret,
          isActive: s.is_active,
        }));

        const outboxEvents: AlertOutboxEvent[] = (outboxRowsToDispatch ?? []).map((e) => ({
          id: e.id,
          idempotencyKey: e.idempotency_key,
          clientNotificationTag: e.client_notification_tag,
          userId: e.user_id,
          budgetId: e.budget_id,
          budgetName: e.budget_name,
          periodKey: e.period_key,
          thresholdPercent: e.threshold_percent,
          lowerThresholdsCrossedAndMarkedHandled: [],
          budgetAllocatedCents: e.budget_allocated_cents,
          spentAfterCents: e.spent_after_cents,
          remainingAfterCents: e.remaining_after_cents,
          inAppTitleSpanish: e.in_app_title_spanish,
          inAppBodySpanish: e.in_app_body_spanish,
          pushPayload: e.push_payload,
          deliveryState: e.delivery_state,
          seenByUserAtUtc: e.seen_by_user_at_utc,
          createdAtUtc: e.created_at_utc,
        }));

        const dispatchResult = await dispatchPendingAlertOutbox({
          outboxEvents,
          subscriptions,
          vapidSubject,
          vapidPrivateKeyJwk,
          quietHoursEnabled: true,
          quietHoursStart: 22,
          quietHoursEnd: 8,
        });

        for (const ev of dispatchResult.updatedEvents) {
          await serviceClient
            .from('alert_outbox')
            .update({ delivery_state: ev.deliveryState })
            .eq('id', ev.id);
          if (ev.deliveryState === 'sent') dispatchedCount++;
        }

        for (const deadId of dispatchResult.deactivatedSubscriptionIds) {
          await serviceClient
            .from('push_subscriptions')
            .update({ is_active: false })
            .eq('id', deadId);
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          syncedConnectionsCount,
          evaluatedBudgetsCount,
          newlyEmittedAlertsCount,
          dispatchedPushAlertsCount: dispatchedCount,
          executedAtUtc: nowIso,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({ error: 'SCHEDULED_JOB_FAILED', messageSpanish: msg }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  });
}
