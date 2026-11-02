import { describe, it, expect } from 'vitest';
import {
  evaluateBudgetThresholdCrossing,
  DEFAULT_BUDGET_THRESHOLDS,
  HandledThresholdRecord,
  AlertOutboxEvent,
} from '../../src/domain/alerts/index';
import {
  createBudgetAllocation,
  calculatePersonalEnvelopes,
} from '../../src/domain/budgets/index';
import {
  createAccount,
  CanonicalTransaction,
} from '../../src/domain/ledger/index';
import { normalizeLoadedUserState } from '../../src/state/appStore';
import { PeriodMonthKey } from '../../src/domain/dates/madrid';

describe('Gastos Hormiga, Category Allocations & Monthly Repeat Budget Tests', () => {
  it('acceptance example: 40 € small purchases limit, 28 € before + 3 € expense = 31 € emits single 75% alert, suppressing 50%', () => {
    const userId = 'user_jared';
    const periodKey: PeriodMonthKey = '2026-11';
    const smallPurchasesLimitCents = 4000; // 40.00 EUR
    const spentBeforeCents = 2800; // 28.00 EUR (70%)
    const newExpenseCents = 300; // 3.00 EUR
    const spentAfterCents = spentBeforeCents + newExpenseCents; // 31.00 EUR (77.5%)

    const existingHandled: HandledThresholdRecord[] = [];
    const existingOutbox: AlertOutboxEvent[] = [];

    const result = evaluateBudgetThresholdCrossing({
      userId,
      budgetId: 'small_purchases_total',
      budgetName: 'Gastos hormiga',
      periodKey,
      budgetAllocatedCents: smallPurchasesLimitCents,
      spentBeforeCents,
      spentAfterCents,
      thresholds: DEFAULT_BUDGET_THRESHOLDS, // [50, 75, 90, 100]
      existingHandledRecords: existingHandled,
      existingOutboxEvents: existingOutbox,
    });

    // Must emit exactly one alert
    expect(result.emittedEvent).not.toBeNull();
    expect(result.emittedEvent?.thresholdPercent).toBe(75);
    expect(result.emittedEvent?.budgetId).toBe('small_purchases_total');
    expect(result.emittedEvent?.spentAfterCents).toBe(3100);
    expect(result.emittedEvent?.remainingAfterCents).toBe(900); // 9.00 EUR remaining

    // 50% must be marked as suppressed by higher jump
    const suppressed50 = result.updatedHandledRecords.find((r) => r.thresholdPercent === 50);
    expect(suppressed50).toBeDefined();
    expect(suppressed50?.resolution).toBe('suppressed_by_higher_jump');

    // 75% must be marked as emitted
    const emitted75 = result.updatedHandledRecords.find((r) => r.thresholdPercent === 75);
    expect(emitted75).toBeDefined();
    expect(emitted75?.resolution).toBe('emitted_alert');

    // Idempotency: re-evaluating with the same spend must NOT emit another alert
    const reeval = evaluateBudgetThresholdCrossing({
      userId,
      budgetId: 'small_purchases_total',
      budgetName: 'Gastos hormiga',
      periodKey,
      budgetAllocatedCents: smallPurchasesLimitCents,
      spentBeforeCents: spentAfterCents,
      spentAfterCents: spentAfterCents,
      existingHandledRecords: result.updatedHandledRecords,
      existingOutboxEvents: result.updatedOutboxEvents,
    });

    expect(reeval.emittedEvent).toBeNull();
  });

  it('calculates personal envelopes with separate small purchases sub-envelope', () => {
    const alloc = createBudgetAllocation({
      id: 'bud_2026-11',
      userId: 'user_jared',
      periodKey: '2026-11',
      confirmedByUser: true,
      protectedSavingsAllocatedCents: 0,
      smallPurchasesAllocatedCents: 4000, // 40 EUR
      flexibleSpendingAllocatedCents: 46000, // 460 EUR (total 500 EUR)
      scopeMode: 'personal_only',
      selectedAccountIds: ['acc_main'],
      repeatMonthly: true,
      categoryAllocationsCents: { restaurants: 15000 },
    });

    expect(alloc.totalPersonalAllocatedCents).toBe(50000);
    expect(alloc.smallPurchasesAllocatedCents).toBe(4000);
    expect(alloc.flexibleSpendingAllocatedCents).toBe(46000);
    expect(alloc.repeatMonthly).toBe(true);
    expect(alloc.scopeMode).toBe('personal_only');

    const account = createAccount({
      id: 'acc_main',
      userId: 'user_jared',
      name: 'CaixaBank Nómina',
      type: 'bank',
      currency: 'EUR',
      includeInLiquidity: true,
      isOwned: true,
    });

    // Small expense tagged as small spending
    const tx1: CanonicalTransaction = {
      id: 'tx_coffee',
      userId: 'user_jared',
      accountId: 'acc_main',
      type: 'expense',
      status: 'booked',
      amountCents: -250, // 2.50 EUR
      currency: 'EUR',
      bookingDate: '2026-11-03',
      valueDate: '2026-11-03',
      occurredAtUtc: '2026-11-03T09:15:00Z',
      createdAtUtc: '2026-11-03T09:15:00Z',
      description: 'Café solo',
      merchantNormalized: 'Cafetería',
      userNote: null,
      categoryId: 'bars_cafes',
      categorySource: 'user_rule',
      categoryConfidence: 100,
      categoryExplanation: null,
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

    // Normal expense not small spending
    const tx2: CanonicalTransaction = {
      id: 'tx_supermarket',
      userId: 'user_jared',
      accountId: 'acc_main',
      type: 'expense',
      status: 'booked',
      amountCents: -3500, // 35.00 EUR
      currency: 'EUR',
      bookingDate: '2026-11-04',
      valueDate: '2026-11-04',
      occurredAtUtc: '2026-11-04T18:30:00Z',
      createdAtUtc: '2026-11-04T18:30:00Z',
      description: 'Compra semanal',
      merchantNormalized: 'Mercadona',
      userNote: null,
      categoryId: 'supermarket',
      categorySource: 'user_rule',
      categoryConfidence: 100,
      categoryExplanation: null,
      scope: 'personal',
      smallSpendingTagged: false,
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

    const env = calculatePersonalEnvelopes({
      allocation: alloc,
      transactions: [tx1, tx2],
      accounts: [account],
    });

    // Total spendable: 2.50 + 35.00 = 37.50 EUR (3750 cents)
    expect(env.totalPersonalNetSpentCents).toBe(3750);
    expect(env.spendableRemainingCents).toBe(50000 - 3750);

    // Small purchases: 2.50 EUR (250 cents)
    expect(env.smallPurchasesNetSpentCents).toBe(250);
    expect(env.smallPurchasesRemainingCents).toBe(4000 - 250);
  });

  it('normalizes and automatically carries forward repeatMonthly budget to new month', () => {
    const prevAlloc = createBudgetAllocation({
      id: 'bud_2026-10',
      userId: 'user_jared',
      periodKey: '2026-10',
      confirmedByUser: true,
      protectedSavingsAllocatedCents: 0,
      smallPurchasesAllocatedCents: 4000,
      flexibleSpendingAllocatedCents: 50000,
      repeatMonthly: true,
      scopeMode: 'personal_only',
      selectedAccountIds: ['acc_caixa'],
      categoryAllocationsCents: { restaurants: 10000 },
    });

    // Load state into new month '2026-11' where no budget was explicitly created yet
    const loaded = normalizeLoadedUserState(
      {
        userId: 'user_jared',
        budgetAllocations: {
          '2026-10': prevAlloc,
        },
      },
      'Jared',
      '2026-11-02T12:00:00.000Z'
    );

    // Budget for 2026-11 should be automatically created from 2026-10 repeat preferences
    const active = loaded.budgetAllocations['2026-11'];
    expect(active).toBeDefined();
    expect(active?.confirmedByUser).toBe(true);
    expect(active?.totalPersonalAllocatedCents).toBe(54000);
    expect(active?.smallPurchasesAllocatedCents).toBe(4000);
    expect(active?.flexibleSpendingAllocatedCents).toBe(50000);
    expect(active?.repeatMonthly).toBe(true);
    expect(active?.categoryAllocationsCents.restaurants).toBe(10000);
    expect(loaded.budgetScopeMode).toBe('personal_only');
    expect(loaded.budgetSelectedAccountIds).toEqual(['acc_caixa']);
  });
});
