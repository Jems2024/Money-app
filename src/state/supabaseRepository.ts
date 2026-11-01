import { SupabaseClient } from '@supabase/supabase-js';
import { CalendarDateISO, getMadridDateParts, PeriodMonthKey } from '../domain/dates/madrid';
import {
  Account,
  BalanceSnapshot,
  CanonicalTransaction,
  createAccount,
  ObligationReservation,
  SavingsReservation,
  SourceRecord,
} from '../domain/ledger';
import {
  BudgetPeriodAllocation,
  createBudgetAllocation,
  CrossPeriodRefundPolicy,
  PERSONAL_ENVELOPE_TEMPLATE_EUR,
} from '../domain/budgets';
import { AlertOutboxEvent, HandledThresholdRecord } from '../domain/alerts';
import {
  enforceCompositeReferenceOwnership,
  enforceRowOwnership,
  requireAuthenticatedUser,
} from '../server/security/rlsEnforcement';
import {
  AppUserState,
  createInitialUserState,
  isLegacyDefaultTemplateAllocation,
  normalizeLoadedUserState,
} from './appStore';

/**
 * STOP SPEND — Real Supabase Postgres Persistence Repository (`src/state/supabaseRepository.ts`)
 *
 * Maps domain entities (`Account`, `CanonicalTransaction`, `BudgetPeriodAllocation`,
 * `ObligationReservation`, `SavingsReservation`, `AlertOutboxEvent`, `HandledThresholdRecord`)
 * to and from the PostgreSQL schema in `supabase/migrations/20261030000001_stop_spend_schema_rls.sql`.
 *
 * Invariants:
 * 1. Never uses floating point; all `*_cents` columns are stored and retrieved as exact integer cents.
 * 2. Every read/write enforces authenticated `userId` ownership and composite FK checks.
 * 3. Connecting Supabase NEVER marks Enable Banking as connected; `bank_connections` remains
 *    `unconfigured` ("Sin configurar") until actual Enable Banking credentials & session exist.
 */

export interface DbCanonicalTransactionRow {
  id: string;
  user_id: string;
  account_id: string;
  type: CanonicalTransaction['type'];
  status: CanonicalTransaction['status'];
  amount_cents: number;
  currency: 'EUR';
  booking_date: CalendarDateISO;
  value_date: CalendarDateISO | null;
  occurred_at_utc: string | null;
  created_at_utc: string;
  description: string;
  merchant_normalized: string;
  user_note: string | null;
  category_id: string | null;
  category_source: CanonicalTransaction['categorySource'];
  category_confidence: number;
  category_explanation: string | null;
  scope: CanonicalTransaction['scope'];
  small_spending_tagged: boolean;
  linked_expense_id: string | null;
  transfer_pair_id: string | null;
  counterpart_account_id: string | null;
  untracked_owned_destination_label: string | null;
  settled_obligation_id: string | null;
  consumed_savings_reservation_id: string | null;
  superseded_by_transaction_id: string | null;
  review_status: CanonicalTransaction['reviewStatus'];
}

export function mapTransactionToDbRow(
  authenticatedUserId: string,
  tx: CanonicalTransaction,
  accountOwnerCheck?: { id: string; userId: string }
): DbCanonicalTransactionRow {
  const userId = enforceCompositeReferenceOwnership({
    authenticatedUserId,
    payloadClientUserId: tx.userId,
    referencedEntities: accountOwnerCheck
      ? [{ id: accountOwnerCheck.id, userId: accountOwnerCheck.userId, kind: 'account' }]
      : [],
  });

  return {
    id: tx.id,
    user_id: userId,
    account_id: tx.accountId,
    type: tx.type,
    status: tx.status,
    amount_cents: Number(tx.amountCents),
    currency: 'EUR',
    booking_date: tx.bookingDate,
    value_date: tx.valueDate,
    occurred_at_utc: tx.occurredAtUtc,
    created_at_utc: tx.createdAtUtc,
    description: tx.description,
    merchant_normalized: tx.merchantNormalized,
    user_note: tx.userNote,
    category_id: tx.categoryId,
    category_source: tx.categorySource,
    category_confidence: tx.categoryConfidence,
    category_explanation: tx.categoryExplanation,
    scope: tx.scope,
    small_spending_tagged: tx.smallSpendingTagged,
    linked_expense_id: tx.linkedExpenseId,
    transfer_pair_id: tx.transferPairId,
    counterpart_account_id: tx.counterpartAccountId,
    untracked_owned_destination_label: tx.untrackedOwnedDestinationLabel,
    settled_obligation_id: tx.settledObligationId,
    consumed_savings_reservation_id: tx.consumedSavingsReservationId,
    superseded_by_transaction_id: tx.supersededByTransactionId,
    review_status: tx.reviewStatus,
  };
}

export function mapDbRowToTransaction(row: DbCanonicalTransactionRow): CanonicalTransaction {
  return {
    id: row.id,
    userId: row.user_id,
    accountId: row.account_id,
    type: row.type,
    status: row.status,
    amountCents: Number(row.amount_cents),
    currency: 'EUR',
    bookingDate: row.booking_date,
    valueDate: row.value_date,
    occurredAtUtc: row.occurred_at_utc,
    createdAtUtc: row.created_at_utc,
    description: row.description,
    merchantNormalized: row.merchant_normalized,
    userNote: row.user_note,
    categoryId: row.category_id,
    categorySource: row.category_source,
    categoryConfidence: Number(row.category_confidence),
    categoryExplanation: row.category_explanation,
    scope: row.scope,
    smallSpendingTagged: Boolean(row.small_spending_tagged),
    splits: [],
    linkedExpenseId: row.linked_expense_id,
    transferPairId: row.transfer_pair_id,
    counterpartAccountId: row.counterpart_account_id,
    untrackedOwnedDestinationLabel: row.untracked_owned_destination_label,
    settledObligationId: row.settled_obligation_id,
    consumedSavingsReservationId: row.consumed_savings_reservation_id,
    supersededByTransactionId: row.superseded_by_transaction_id,
    reviewStatus: row.review_status,
    sourceRecordIds: [],
  };
}

/**
 * Loads the complete user financial state from Supabase Postgres (`zsnvclyoypabmgqqaizj`).
 * If the user has just enrolled and has no accounts yet, provisions the 3 default owned accounts
 * with zero invented balances (keeping liquidity honestly `null` / "Desconocido").
 */
export async function fetchUserStateFromSupabase(
  client: SupabaseClient,
  authenticatedUserId: string,
  displayNameFallback: string = 'Jared'
): Promise<AppUserState> {
  const userId = requireAuthenticatedUser(authenticatedUserId);
  const baseState = createInitialUserState(userId, displayNameFallback);
  const periodKey = getMadridDateParts(new Date().toISOString()).periodKey;

  const [
    profileRes,
    accountsRes,
    snapshotsRes,
    sourcesRes,
    txsRes,
    budgetsRes,
    obligationsRes,
    savingsRes,
    handledRes,
    outboxRes,
    bankConnRes,
  ] = await Promise.all([
    client.from('profiles').select('*').eq('user_id', userId).maybeSingle(),
    client.from('accounts').select('*').eq('user_id', userId).order('created_at', { ascending: true }),
    client.from('balance_snapshots').select('*').eq('user_id', userId),
    client.from('source_records').select('*').eq('user_id', userId),
    client
      .from('canonical_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at_utc', { ascending: false }),
    client.from('budget_allocations').select('*').eq('user_id', userId),
    client.from('obligations').select('*').eq('user_id', userId),
    client.from('savings_reservations').select('*').eq('user_id', userId),
    client.from('alert_handled_thresholds').select('*').eq('user_id', userId),
    client.from('alert_outbox').select('*').eq('user_id', userId).order('created_at_utc', { ascending: true }),
    client.from('bank_connections').select('*').eq('user_id', userId).maybeSingle(),
  ]);

  // Provision initial profile and empty accounts if not yet present in DB
  let accounts: Account[] = [];
  if (accountsRes.data && accountsRes.data.length > 0) {
    accounts = accountsRes.data.map((r) =>
      createAccount({
        id: String(r.id),
        userId: String(r.user_id),
        name: String(r.name),
        type: r.type as Account['type'],
        currency: 'EUR',
        includeInLiquidity: Boolean(r.include_in_liquidity),
        isOwned: Boolean(r.is_owned),
        stableIdentityKey: r.stable_identity_key ?? null,
        providerCode: r.provider_code ?? null,
        providerSessionAccountId: r.provider_session_account_id ?? null,
        ibanMasked: r.iban_masked ?? null,
        createdAtUtc: String(r.created_at),
      })
    );
  } else {
    accounts = baseState.accounts;
    await client.from('profiles').upsert({
      user_id: userId,
      display_name: displayNameFallback,
      locale: 'es-ES',
      timezone: 'Europe/Madrid',
      currency: 'EUR',
      onboarding_confirmed: false,
    });
    await client.from('accounts').upsert(
      accounts.map((a) => ({
        id: a.id,
        user_id: userId,
        name: a.name,
        type: a.type,
        currency: 'EUR',
        include_in_liquidity: a.includeInLiquidity,
        is_owned: a.isOwned,
        provider_code: a.providerCode,
      }))
    );
  }

  const snapshots: BalanceSnapshot[] = (snapshotsRes.data ?? []).map((s) => ({
    id: String(s.id),
    userId: String(s.user_id),
    accountId: String(s.account_id),
    source: s.source as BalanceSnapshot['source'],
    balanceType: s.balance_type as BalanceSnapshot['balanceType'],
    amountCents: Number(s.amount_cents),
    currency: 'EUR',
    referenceTimeUtc: String(s.reference_time_utc),
    referenceBookingDate: s.reference_booking_date as CalendarDateISO,
    includesPendingDebits: Boolean(s.includes_pending_debits),
  }));

  const sourceRecords: SourceRecord[] = (sourcesRes.data ?? []).map((sr) => ({
    id: String(sr.id),
    userId: String(sr.user_id),
    accountId: String(sr.account_id),
    sourceType: sr.source_type as SourceRecord['sourceType'],
    providerCode: sr.provider_code ?? null,
    sourceExternalId: sr.source_external_id ?? null,
    importBatchId: sr.import_batch_id ?? null,
    originalDescription: String(sr.original_description),
    bookingDate: sr.booking_date as CalendarDateISO,
    valueDate: (sr.value_date as CalendarDateISO | null) ?? null,
    occurredAtUtc: sr.occurred_at_utc ? String(sr.occurred_at_utc) : null,
    receivedAtServerUtc: String(sr.received_at_server_utc),
    status: sr.status as SourceRecord['status'],
    currency: 'EUR',
    amountCents: Number(sr.amount_cents),
    counterpartyName: sr.counterparty_name ?? null,
    counterpartyIbanNormalized: sr.counterparty_iban_normalized ?? null,
    remittanceInfo: sr.remittance_info ?? null,
    normalizationVersion: Number(sr.normalization_version ?? 1),
    provenance: String(sr.provenance),
  }));

  const transactions: CanonicalTransaction[] = (txsRes.data ?? []).map((row) =>
    mapDbRowToTransaction(row as DbCanonicalTransactionRow)
  );

  const budgetAllocations: Record<PeriodMonthKey, BudgetPeriodAllocation> = {};
  for (const b of budgetsRes.data ?? []) {
    const pk = String(b.period_key) as PeriodMonthKey;
    const alloc = createBudgetAllocation({
      id: String(b.id),
      userId: String(b.user_id),
      periodKey: pk,
      confirmedByUser: Boolean(b.confirmed_by_user),
      protectedSavingsAllocatedCents: Number(b.protected_savings_allocated_cents),
      smallPurchasesAllocatedCents: Number(b.small_purchases_allocated_cents),
      flexibleSpendingAllocatedCents: Number(b.flexible_spending_allocated_cents),
      rolloverFromPreviousCents: Number(b.rollover_from_previous_cents ?? 0),
      manualAdjustmentsCents: Number(b.manual_adjustments_cents ?? 0),
    });
    if (!alloc.confirmedByUser && isLegacyDefaultTemplateAllocation(alloc)) {
      continue;
    }
    budgetAllocations[pk] = alloc;
  }

  const obligations: ObligationReservation[] = (obligationsRes.data ?? []).map((o) => ({
    id: String(o.id),
    userId: String(o.user_id),
    name: String(o.name),
    periodKey: String(o.period_key),
    expectedAmountCents: Number(o.expected_amount_cents),
    paidAmountCents: Number(o.paid_amount_cents),
    status: o.status as ObligationReservation['status'],
    dueDate: (o.due_date as CalendarDateISO | null) ?? null,
    settledTransactionIds: [],
  }));

  const savingsReservations: SavingsReservation[] = (savingsRes.data ?? []).map((sr) => ({
    id: String(sr.id),
    userId: String(sr.user_id),
    name: String(sr.name),
    periodKey: String(sr.period_key),
    protectedAmountCents: Number(sr.protected_amount_cents),
    transferredToExcludedAccountCents: Number(sr.transferred_to_excluded_account_cents),
    status: sr.status as SavingsReservation['status'],
  }));

  const handledThresholds: HandledThresholdRecord[] = (handledRes.data ?? []).map((h) => ({
    idempotencyKey: String(h.idempotency_key),
    userId: String(h.user_id),
    budgetId: String(h.budget_id),
    periodKey: String(h.period_key) as PeriodMonthKey,
    thresholdPercent: Number(h.threshold_percent),
    resolution: h.resolution as HandledThresholdRecord['resolution'],
    recordedAtUtc: String(h.recorded_at_utc),
  }));

  const alertOutbox: AlertOutboxEvent[] = (outboxRes.data ?? []).map((e) => ({
    id: String(e.id),
    idempotencyKey: String(e.idempotency_key),
    clientNotificationTag: String(e.client_notification_tag),
    userId: String(e.user_id),
    budgetId: String(e.budget_id),
    budgetName: String(e.budget_name),
    periodKey: String(e.period_key) as PeriodMonthKey,
    thresholdPercent: Number(e.threshold_percent),
    lowerThresholdsCrossedAndMarkedHandled: [],
    budgetAllocatedCents: Number(e.budget_allocated_cents),
    spentAfterCents: Number(e.spent_after_cents),
    remainingAfterCents: Number(e.remaining_after_cents),
    inAppTitleSpanish: String(e.in_app_title_spanish),
    inAppBodySpanish: String(e.in_app_body_spanish),
    pushPayload: e.push_payload as AlertOutboxEvent['pushPayload'],
    deliveryState: e.delivery_state as AlertOutboxEvent['deliveryState'],
    seenByUserAtUtc: e.seen_by_user_at_utc ? String(e.seen_by_user_at_utc) : null,
    createdAtUtc: String(e.created_at_utc),
  }));

  const onboardingConfirmed = Boolean(budgetAllocations[periodKey]?.confirmedByUser);
  const bankConn = bankConnRes.data;
  const bankMode =
    bankConn?.environment_mode === 'sandbox' || bankConn?.environment_mode === 'production'
      ? bankConn.environment_mode
      : 'unconfigured';

  const isBankConnected =
    bankMode !== 'unconfigured' &&
    Boolean(bankConn?.has_valid_session) &&
    Boolean(bankConn?.has_successful_real_read) &&
    bankConn?.status !== 'session_revoked';

  const hasExistingActivity =
    transactions.length > 0 ||
    snapshots.length > 0 ||
    Object.values(budgetAllocations).some((a) => a.confirmedByUser) ||
    isBankConnected ||
    Boolean(profileRes.data?.onboarding_confirmed);

  return normalizeLoadedUserState(
    {
      ...baseState,
      userId,
      displayName: String(profileRes.data?.display_name ?? displayNameFallback),
      currentPeriodKey: periodKey,
      bankOnboardingCompleted: hasExistingActivity,
      bankConnectedChoice: isBankConnected
        ? 'connected'
        : hasExistingActivity
          ? 'skipped'
          : 'pending',
      onboardingConfirmed,
      refundPolicy:
        (profileRes.data?.refund_cross_period_policy as CrossPeriodRefundPolicy | undefined) ??
        'CREDIT_CURRENT_PERIOD',
      rememberedAccountId:
        accounts.find((a) => a.type === 'bank')?.id ??
        accounts[0]?.id ??
        baseState.rememberedAccountId,
      accounts,
      snapshots,
      sourceRecords,
      transactions,
      budgetAllocations,
      obligations,
      savingsReservations,
      handledThresholds,
      alertOutbox,
      bankConfig: {
        mode: bankMode,
        hasValidSession: Boolean(bankConn?.has_valid_session),
        hasSuccessfulRealRead: Boolean(bankConn?.has_successful_real_read),
        localSyncPaused: Boolean(bankConn?.local_sync_paused),
        sessionRevoked: bankConn?.status === 'session_revoked',
        lastSyncUtc: bankConn?.last_sync_at ? String(bankConn.last_sync_at) : null,
        lastSyncError: bankConn?.last_error_spanish ? String(bankConn.last_error_spanish) : null,
      },
    },
    displayNameFallback
  );
}

/**
 * Persists a newly created canonical transaction (and any emitted threshold alerts) to Supabase Postgres.
 */
export async function persistTransactionToSupabase(params: {
  client: SupabaseClient;
  authenticatedUserId: string;
  transaction: CanonicalTransaction;
  targetAccount: Account;
  newHandledThresholds?: readonly HandledThresholdRecord[];
  newAlertEvents?: readonly AlertOutboxEvent[];
}): Promise<void> {
  const row = mapTransactionToDbRow(
    params.authenticatedUserId,
    params.transaction,
    params.targetAccount
  );

  const { error: txErr } = await params.client
    .from('canonical_transactions')
    .upsert(row, { onConflict: 'id' });
  if (txErr) {
    throw new Error(`Error al guardar movimiento en Supabase: ${txErr.message}`);
  }

  if (params.newHandledThresholds && params.newHandledThresholds.length > 0) {
    await params.client.from('alert_handled_thresholds').upsert(
      params.newHandledThresholds.map((h) => ({
        idempotency_key: h.idempotencyKey,
        user_id: params.authenticatedUserId,
        budget_id: h.budgetId,
        period_key: h.periodKey,
        threshold_percent: h.thresholdPercent,
        resolution: h.resolution,
        recorded_at_utc: h.recordedAtUtc,
      })),
      { onConflict: 'idempotency_key' }
    );
  }

  if (params.newAlertEvents && params.newAlertEvents.length > 0) {
    await params.client.from('alert_outbox').upsert(
      params.newAlertEvents.map((e) => ({
        id: e.id,
        idempotency_key: e.idempotencyKey,
        client_notification_tag: e.clientNotificationTag,
        user_id: params.authenticatedUserId,
        budget_id: e.budgetId,
        budget_name: e.budgetName,
        period_key: e.periodKey,
        threshold_percent: e.thresholdPercent,
        budget_allocated_cents: e.budgetAllocatedCents,
        spent_after_cents: e.spentAfterCents,
        remaining_after_cents: e.remainingAfterCents,
        in_app_title_spanish: e.inAppTitleSpanish,
        in_app_body_spanish: e.inAppBodySpanish,
        push_payload: e.pushPayload,
        delivery_state: e.deliveryState,
        seen_by_user_at_utc: e.seenByUserAtUtc,
        created_at_utc: e.createdAtUtc,
      })),
      { onConflict: 'idempotency_key' }
    );
  }
}

/**
 * Updates an edited transaction in Supabase Postgres, enforcing ownership.
 */
export async function updateTransactionInSupabase(params: {
  client: SupabaseClient;
  authenticatedUserId: string;
  transaction: CanonicalTransaction;
}): Promise<void> {
  enforceRowOwnership(params.authenticatedUserId, params.transaction, 'movimiento');
  const row = mapTransactionToDbRow(params.authenticatedUserId, params.transaction);

  const { error } = await params.client
    .from('canonical_transactions')
    .update({
      amount_cents: row.amount_cents,
      description: row.description,
      category_id: row.category_id,
      category_source: row.category_source,
      review_status: row.review_status,
    })
    .eq('id', row.id)
    .eq('user_id', params.authenticatedUserId);

  if (error) {
    throw new Error(`Error al actualizar movimiento en Supabase: ${error.message}`);
  }
}

/**
 * Deletes an undone transaction from Supabase Postgres, enforcing ownership.
 */
export async function deleteTransactionFromSupabase(params: {
  client: SupabaseClient;
  authenticatedUserId: string;
  transaction: CanonicalTransaction;
}): Promise<void> {
  enforceRowOwnership(params.authenticatedUserId, params.transaction, 'movimiento');

  const { error } = await params.client
    .from('canonical_transactions')
    .delete()
    .eq('id', params.transaction.id)
    .eq('user_id', params.authenticatedUserId);

  if (error) {
    throw new Error(`Error al deshacer movimiento en Supabase: ${error.message}`);
  }
}

/**
 * Persists a confirmed budget allocation and savings reservation to Supabase Postgres.
 */
export async function persistBudgetAllocationToSupabase(params: {
  client: SupabaseClient;
  authenticatedUserId: string;
  allocation: BudgetPeriodAllocation;
  savingsReservation?: SavingsReservation;
}): Promise<void> {
  enforceRowOwnership(params.authenticatedUserId, params.allocation, 'presupuesto');

  const { error: profErr } = await params.client
    .from('profiles')
    .upsert({
      user_id: params.authenticatedUserId,
      onboarding_confirmed: params.allocation.confirmedByUser,
      updated_at: new Date().toISOString(),
    });
  if (profErr) {
    throw new Error(`Error al actualizar perfil en Supabase: ${profErr.message}`);
  }

  const { error: budErr } = await params.client.from('budget_allocations').upsert(
    {
      id: params.allocation.id,
      user_id: params.authenticatedUserId,
      period_key: params.allocation.periodKey,
      confirmed_by_user: params.allocation.confirmedByUser,
      total_personal_allocated_cents: params.allocation.totalPersonalAllocatedCents,
      protected_savings_allocated_cents: params.allocation.protectedSavingsAllocatedCents,
      small_purchases_allocated_cents: params.allocation.smallPurchasesAllocatedCents,
      flexible_spending_allocated_cents: params.allocation.flexibleSpendingAllocatedCents,
      rollover_from_previous_cents: params.allocation.rolloverFromPreviousCents,
      manual_adjustments_cents: params.allocation.manualAdjustmentsCents,
    },
    { onConflict: 'user_id,period_key' }
  );
  if (budErr) {
    throw new Error(`Error al guardar presupuesto en Supabase: ${budErr.message}`);
  }

  if (params.savingsReservation) {
    await params.client.from('savings_reservations').upsert(
      {
        id: params.savingsReservation.id,
        user_id: params.authenticatedUserId,
        name: params.savingsReservation.name,
        period_key: params.savingsReservation.periodKey,
        protected_amount_cents: params.savingsReservation.protectedAmountCents,
        transferred_to_excluded_account_cents:
          params.savingsReservation.transferredToExcludedAccountCents,
        status: params.savingsReservation.status,
      },
      { onConflict: 'id' }
    );
  }
}

export { PERSONAL_ENVELOPE_TEMPLATE_EUR };
