import { describe, it, expect } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import {
  deleteTransactionFromSupabase,
  fetchUserStateFromSupabase,
  persistBudgetAllocationToSupabase,
  persistTransactionToSupabase,
  updateTransactionInSupabase,
} from '../../src/state/supabaseRepository';
import { calculatePersonalEnvelopes, createBudgetAllocation } from '../../src/domain/budgets';
import { CanonicalTransaction } from '../../src/domain/ledger';
import { resolveBankConnectionStatusBadge } from '../../src/server/providers/enableBanking';
import {
  SecurityAccessDeniedError,
  UnauthenticatedAccessError,
} from '../../src/server/security/rlsEnforcement';

/**
 * In-memory Postgres + RLS simulator backing `@supabase/supabase-js` query builder interface
 * to test `supabaseRepository.ts` persistence, reload, re-signin, edit/undo, and RLS isolation.
 */
function createRlsEnforcedMockSupabase() {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    profiles: [],
    accounts: [],
    balance_snapshots: [],
    source_records: [],
    canonical_transactions: [],
    budget_allocations: [],
    obligations: [],
    savings_reservations: [],
    alert_handled_thresholds: [],
    alert_outbox: [],
    bank_connections: [],
  };

  let currentAuthUserId: string | null = null;

  const clientForUser = (activeUserId: string | null) => {
    currentAuthUserId = activeUserId;

    const from = (table: string) => {
      const rows = tables[table] ?? (tables[table] = []);
      let filterCols: Array<{ col: string; val: unknown }> = [];

      const applyFilters = () => {
        if (!currentAuthUserId) return [];
        return rows.filter(
          (r) =>
            r.user_id === currentAuthUserId &&
            filterCols.every((f) => r[f.col] === f.val)
        );
      };

      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filterCols.push({ col, val });
          return builder;
        },
        order: () => Promise.resolve({ data: applyFilters(), error: null }),
        maybeSingle: () =>
          Promise.resolve({ data: applyFilters()[0] ?? null, error: null }),
        then: (resolve: (res: { data: unknown[]; error: null }) => void) =>
          resolve({ data: applyFilters(), error: null }),
        upsert: async (
          payload: Record<string, unknown> | Array<Record<string, unknown>>,
          opts?: { onConflict?: string }
        ) => {
          if (!currentAuthUserId) {
            return { data: null, error: { message: 'RLS: unauthenticated' } };
          }
          const items = Array.isArray(payload) ? payload : [payload];
          const conflictCols = (opts?.onConflict ?? 'id').split(',');

          for (const item of items) {
            if (item.user_id !== currentAuthUserId) {
              return {
                data: null,
                error: { message: 'new row violates row-level security policy' },
              };
            }
            const idx = rows.findIndex((existing) =>
              conflictCols.every((c) => existing[c] === item[c])
            );
            if (idx >= 0) {
              rows[idx] = { ...rows[idx], ...item };
            } else {
              rows.push({ ...item });
            }
          }
          return { data: items, error: null };
        },
        update: (patch: Record<string, unknown>) => {
          const updateFilter: Array<{ col: string; val: unknown }> = [];
          const updateBuilder = {
            eq: (col: string, val: unknown) => {
              updateFilter.push({ col, val });
              if (updateFilter.length >= 2) {
                for (let i = 0; i < rows.length; i++) {
                  const r = rows[i]!;
                  if (
                    r.user_id === currentAuthUserId &&
                    updateFilter.every((f) => r[f.col] === f.val)
                  ) {
                    rows[i] = { ...r, ...patch };
                  }
                }
                return Promise.resolve({ error: null });
              }
              return updateBuilder;
            },
          };
          return updateBuilder;
        },
        delete: () => {
          const delFilter: Array<{ col: string; val: unknown }> = [];
          const delBuilder = {
            eq: (col: string, val: unknown) => {
              delFilter.push({ col, val });
              if (delFilter.length >= 2) {
                tables[table] = rows.filter(
                  (r) =>
                    !(
                      r.user_id === currentAuthUserId &&
                      delFilter.every((f) => r[f.col] === f.val)
                    )
                );
                return Promise.resolve({ error: null });
              }
              return delBuilder;
            },
          };
          return delBuilder;
        },
      };

      return builder;
    };

    return { from } as unknown as SupabaseClient;
  };

  return { clientForUser };
}

describe('Supabase Persistence, Reload, Edit/Undo, Budget Math & RLS Isolation (Point 7 & 9)', () => {
  const USER_JARED = '11111111-1111-1111-1111-111111111111';
  const USER_INTRUDER = '22222222-2222-2222-2222-222222222222';

  it('persists budget and expenses to Supabase, survives reload/re-signin, edits & undoes expenses, keeps Enable Banking unconfigured, and denies unauthenticated or cross-user access', async () => {
    const db = createRlsEnforcedMockSupabase();
    const jaredClient = db.clientForUser(USER_JARED);

    // 1. Initial sign-in & state load
    const initialState = await fetchUserStateFromSupabase(jaredClient, USER_JARED, 'Jared');
    expect(initialState.accounts).toHaveLength(3);

    // Point 9: Supabase setup alone MUST NOT present Enable Banking as connected!
    const bankBadge = resolveBankConnectionStatusBadge(initialState.bankConfig);
    expect(bankBadge.state).toBe('unconfigured');
    expect(bankBadge.badgeTextSpanish).toBe('Sin configurar');

    // 2. Confirm budget allocation (174 EUR total: 40 small, 54 flexible, 80 protected -> 94 spendable)
    const alloc = createBudgetAllocation({
      id: `bud_${initialState.currentPeriodKey}`,
      userId: USER_JARED,
      periodKey: initialState.currentPeriodKey,
      confirmedByUser: true,
      protectedSavingsAllocatedCents: 8000,
      smallPurchasesAllocatedCents: 4000,
      flexibleSpendingAllocatedCents: 5400,
    });
    await persistBudgetAllocationToSupabase({
      client: jaredClient,
      authenticatedUserId: USER_JARED,
      allocation: alloc,
    });

    // 3. Create an expense of 2,50 EUR (250 cents)
    const bankAccount = initialState.accounts.find((a) => a.type === 'bank')!;
    const expenseTx: CanonicalTransaction = {
      id: 'tx_sup_001',
      userId: USER_JARED,
      accountId: bankAccount.id,
      type: 'expense',
      status: 'provisional',
      amountCents: -250,
      currency: 'EUR',
      bookingDate: `${initialState.currentPeriodKey}-15` as `${number}-${string}-${string}`,
      valueDate: `${initialState.currentPeriodKey}-15` as `${number}-${string}-${string}`,
      occurredAtUtc: '2026-10-15T10:00:00Z',
      createdAtUtc: '2026-10-15T10:00:00Z',
      description: 'Café en terraza',
      merchantNormalized: 'CAFE EN TERRAZA',
      userNote: null,
      categoryId: 'coffee_snacks',
      categorySource: 'user_locked',
      categoryConfidence: 100,
      categoryExplanation: 'Manual',
      scope: 'personal',
      smallSpendingTagged: true,
      splits: [],
      linkedExpenseId: null,
      transferPairId: null,
      counterpartAccountId: null,
      untrackedOwnedDestinationLabel: null,
      settledObligationId: null,
      consumedSavingsReservationId: null,
      supersededByTransactionId: null,
      reviewStatus: 'none',
      sourceRecordIds: [],
    };

    await persistTransactionToSupabase({
      client: jaredClient,
      authenticatedUserId: USER_JARED,
      transaction: expenseTx,
      targetAccount: bankAccount,
    });

    // 4. Simulate reload and signing in again -> state is fetched from Supabase
    const reloadedState = await fetchUserStateFromSupabase(jaredClient, USER_JARED, 'Jared');
    expect(reloadedState.onboardingConfirmed).toBe(true);
    expect(reloadedState.transactions).toHaveLength(1);
    expect(reloadedState.transactions[0]?.amountCents).toBe(-250);

    // 5. Verify budget calculations on reloaded state (40 - 2.50 = 37.50 EUR; 94 - 2.50 = 91.50 EUR)
    const envAfterCreate = calculatePersonalEnvelopes({
      allocation: reloadedState.budgetAllocations[reloadedState.currentPeriodKey]!,
      transactions: reloadedState.transactions,
      accounts: reloadedState.accounts,
    });
    expect(envAfterCreate.smallPurchasesRemainingCents).toBe(3750);
    expect(envAfterCreate.spendableRemainingCents).toBe(9150);

    // 6. Edit the expense in Supabase (2,50 EUR -> 5,00 EUR) and verify budget updates to 35,00 EUR / 89,00 EUR
    const editedTx: CanonicalTransaction = {
      ...expenseTx,
      amountCents: -500,
      description: 'Café y tostada',
    };
    await updateTransactionInSupabase({
      client: jaredClient,
      authenticatedUserId: USER_JARED,
      transaction: editedTx,
    });

    const afterEditState = await fetchUserStateFromSupabase(jaredClient, USER_JARED, 'Jared');
    expect(afterEditState.transactions[0]?.amountCents).toBe(-500);
    expect(afterEditState.transactions[0]?.description).toBe('Café y tostada');

    const envAfterEdit = calculatePersonalEnvelopes({
      allocation: afterEditState.budgetAllocations[afterEditState.currentPeriodKey]!,
      transactions: afterEditState.transactions,
      accounts: afterEditState.accounts,
    });
    expect(envAfterEdit.smallPurchasesRemainingCents).toBe(3500);
    expect(envAfterEdit.spendableRemainingCents).toBe(8900);

    // 7. Denial of unauthenticated and cross-user access
    await expect(
      fetchUserStateFromSupabase(jaredClient, '', 'Anon')
    ).rejects.toThrow(UnauthenticatedAccessError);

    const intruderClient = db.clientForUser(USER_INTRUDER);
    // Intruder cannot edit or delete Jared's expense
    await expect(
      updateTransactionInSupabase({
        client: intruderClient,
        authenticatedUserId: USER_INTRUDER,
        transaction: editedTx,
      })
    ).rejects.toThrow(SecurityAccessDeniedError);

    await expect(
      deleteTransactionFromSupabase({
        client: intruderClient,
        authenticatedUserId: USER_INTRUDER,
        transaction: editedTx,
      })
    ).rejects.toThrow(SecurityAccessDeniedError);

    // Intruder cannot link a transaction to Jared's account (Composite FK Ownership)
    await expect(
      persistTransactionToSupabase({
        client: intruderClient,
        authenticatedUserId: USER_INTRUDER,
        transaction: { ...editedTx, id: 'tx_intruder', userId: USER_INTRUDER },
        targetAccount: bankAccount, // belongs to USER_JARED!
      })
    ).rejects.toThrow(SecurityAccessDeniedError);

    // Intruder querying Supabase sees 0 of Jared's transactions
    const intruderState = await fetchUserStateFromSupabase(intruderClient, USER_INTRUDER, 'Intruder');
    expect(intruderState.transactions).toHaveLength(0);

    // 8. Undo (delete) the expense as Jared and verify it is removed from Supabase
    const jaredClientAgain = db.clientForUser(USER_JARED);
    await deleteTransactionFromSupabase({
      client: jaredClientAgain,
      authenticatedUserId: USER_JARED,
      transaction: editedTx,
    });
    const afterUndoState = await fetchUserStateFromSupabase(jaredClientAgain, USER_JARED, 'Jared');
    expect(afterUndoState.transactions).toHaveLength(0);
  });
});
