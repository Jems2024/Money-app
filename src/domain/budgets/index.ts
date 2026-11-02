import {
  addCents,
  assertValidCents,
  Cents,
  divideCents,
  subtractCents,
} from '../money';
import {
  CalendarDateISO,
  getRemainingCalendarDaysInPeriod,
  getTransactionPeriodKey,
  PeriodMonthKey,
} from '../dates/madrid';
import {
  Account,
  BalanceSnapshot,
  CanonicalTransaction,
  getPersonalNetSpendImpactCents,
  ObligationReservation,
  SavingsReservation,
} from '../ledger';

export type CrossPeriodRefundPolicy = 'CREDIT_CURRENT_PERIOD' | 'ADJUST_ORIGINAL_PERIOD';

export interface HowItIsCalculatedBreakdown {
  title: string;
  accountScopeIncludedNames: string[];
  accountScopeExcludedNames: string[];
  periodKey: PeriodMonthKey;
  lastSyncUtc: string | null;
  isStaleSync: boolean;
  sourceTransactionCount: number;
  formulaSteps: Array<{ label: string; amountCents: Cents | null; note?: string }>;
  activeReservations: Array<{ name: string; remainingCents: Cents; type: 'obligation' | 'savings' }>;
  missingInformationWarnings: string[];
  uncertainties: string[];
}

/**
 * Optional onboarding template for Jared (Spain, EUR):
 * - Total personal envelope: 174,00 € (17400 cents)
 * - Protected personal savings: 80,00 € (8000 cents) -> NOT spendable!
 * - Spendable personal allowance: 94,00 € (9400 cents):
 *   - Small purchases ("Compras pequeñas"): 40,00 € (4000 cents)
 *   - Flexible personal spending ("Gasto flexible"): 54,00 € (5400 cents)
 *
 * Invariant: Never seeded as actual income or bank balances; requires explicit user confirmation.
 */
export const PERSONAL_ENVELOPE_TEMPLATE_EUR = {
  totalPersonalAllocationCents: 17400,
  protectedSavingsAllocationCents: 8000,
  totalSpendableAllocationCents: 9400,
  smallPurchasesAllocationCents: 4000,
  flexibleSpendingAllocationCents: 5400,
} as const;

export interface BudgetPeriodAllocation {
  id: string;
  userId: string;
  periodKey: PeriodMonthKey;
  confirmedByUser: boolean;
  totalPersonalAllocatedCents: Cents; // e.g., 17400 (174.00 EUR)
  protectedSavingsAllocatedCents: Cents; // e.g., 8000 (80.00 EUR)
  smallPurchasesAllocatedCents: Cents; // e.g., 4000 (40.00 EUR)
  flexibleSpendingAllocatedCents: Cents; // e.g., 5400 (54.00 EUR)
  rolloverFromPreviousCents: Cents; // Explicit rollover (can be positive or negative per policy, default 0)
  manualAdjustmentsCents: Cents;
  categoryAllocationsCents: Record<string, Cents>;
  scopeMode?: 'personal_only' | 'all_spending';
  selectedAccountIds?: string[];
  repeatMonthly?: boolean;
}

/**
 * Creates a validated budget period allocation, verifying that protected savings + spendable
 * sub-envelopes reconcile to `totalPersonalAllocatedCents`.
 */
export function createBudgetAllocation(params: {
  id: string;
  userId: string;
  periodKey: PeriodMonthKey;
  confirmedByUser: boolean;
  protectedSavingsAllocatedCents: Cents;
  smallPurchasesAllocatedCents: Cents;
  flexibleSpendingAllocatedCents: Cents;
  rolloverFromPreviousCents?: Cents;
  manualAdjustmentsCents?: Cents;
  categoryAllocationsCents?: Record<string, Cents>;
  scopeMode?: 'personal_only' | 'all_spending';
  selectedAccountIds?: string[];
  repeatMonthly?: boolean;
}): BudgetPeriodAllocation {
  assertValidCents(params.protectedSavingsAllocatedCents);
  assertValidCents(params.smallPurchasesAllocatedCents);
  assertValidCents(params.flexibleSpendingAllocatedCents);

  if (
    params.protectedSavingsAllocatedCents < 0 ||
    params.smallPurchasesAllocatedCents < 0 ||
    params.flexibleSpendingAllocatedCents < 0
  ) {
    throw new Error('Las asignaciones de presupuesto no pueden ser negativas.');
  }

  const rollover = assertValidCents(params.rolloverFromPreviousCents ?? 0);
  const adjustments = assertValidCents(params.manualAdjustmentsCents ?? 0);
  const totalPersonalAllocatedCents = addCents(
    params.protectedSavingsAllocatedCents,
    addCents(params.smallPurchasesAllocatedCents, params.flexibleSpendingAllocatedCents)
  );

  return {
    id: params.id,
    userId: params.userId,
    periodKey: params.periodKey,
    confirmedByUser: params.confirmedByUser,
    totalPersonalAllocatedCents,
    protectedSavingsAllocatedCents: params.protectedSavingsAllocatedCents,
    smallPurchasesAllocatedCents: params.smallPurchasesAllocatedCents,
    flexibleSpendingAllocatedCents: params.flexibleSpendingAllocatedCents,
    rolloverFromPreviousCents: rollover,
    manualAdjustmentsCents: adjustments,
    categoryAllocationsCents: params.categoryAllocationsCents ?? {},
    scopeMode: params.scopeMode ?? 'personal_only',
    selectedAccountIds: params.selectedAccountIds ?? [],
    repeatMonthly: Boolean(params.repeatMonthly),
  };
}

// ============================================================================
// VIEW A: MONTHLY CASH FLOW
// ============================================================================

export interface MonthlyCashFlowResult {
  periodKey: PeriodMonthKey;
  scope: 'all_accounts' | 'personal_only';
  recognizedExternalIncomeCents: Cents;
  plannedUnreceivedIncomeCents: Cents; // Displayed separately, NEVER added to recognized income!
  grossExpensesCents: Cents;
  refundsAppliedCents: Cents;
  crossPeriodRefundsReceivedCents: Cents;
  netRealExpensesCents: Cents;
  netCashFlowCents: Cents; // recognizedExternalIncomeCents - netRealExpensesCents
  excludedInternalTransfersCount: number;
  excludedOpeningBalancesCount: number;
  unverifiedDepositsPendingReviewCents: Cents;
  refundPolicyUsed: CrossPeriodRefundPolicy;
  howItIsCalculated: HowItIsCalculatedBreakdown;
}

export function calculateMonthlyCashFlow(params: {
  periodKey: PeriodMonthKey;
  accounts: readonly Account[];
  transactions: readonly CanonicalTransaction[];
  plannedIncomeCents?: Cents;
  scope?: 'all_accounts' | 'personal_only';
  refundPolicy?: CrossPeriodRefundPolicy;
  lastSyncUtc?: string | null;
}): MonthlyCashFlowResult {
  const scope = params.scope ?? 'all_accounts';
  const refundPolicy = params.refundPolicy ?? 'CREDIT_CURRENT_PERIOD';
  const plannedUnreceivedIncomeCents = assertValidCents(params.plannedIncomeCents ?? 0);

  const txById = new Map<string, CanonicalTransaction>();
  for (const tx of params.transactions) {
    txById.set(tx.id, tx);
  }

  let recognizedExternalIncomeCents = 0;
  let grossExpensesCents = 0;
  let refundsAppliedCents = 0;
  let crossPeriodRefundsReceivedCents = 0;
  let excludedInternalTransfersCount = 0;
  let excludedOpeningBalancesCount = 0;
  let unverifiedDepositsPendingReviewCents = 0;
  let sourceTransactionCount = 0;

  for (const tx of params.transactions) {
    if (tx.status === 'superseded') {
      continue;
    }

    const txPeriod = getTransactionPeriodKey(tx);

    // Handle cross-period refunds when policy is ADJUST_ORIGINAL_PERIOD
    if (tx.type === 'refund') {
      const linkedExpense = tx.linkedExpenseId ? txById.get(tx.linkedExpenseId) : undefined;
      const originalPeriod = linkedExpense ? getTransactionPeriodKey(linkedExpense) : txPeriod;
      const isCrossPeriod = originalPeriod !== txPeriod;

      const targetPeriod =
        refundPolicy === 'ADJUST_ORIGINAL_PERIOD' ? originalPeriod : txPeriod;

      if (targetPeriod !== params.periodKey) {
        continue;
      }

      if (scope === 'personal_only' && tx.scope !== 'personal') {
        continue;
      }

      const refundMag = Math.abs(tx.amountCents);
      refundsAppliedCents = addCents(refundsAppliedCents, refundMag);
      if (isCrossPeriod) {
        crossPeriodRefundsReceivedCents = addCents(crossPeriodRefundsReceivedCents, refundMag);
      }
      sourceTransactionCount++;
      continue;
    }

    if (txPeriod !== params.periodKey) {
      continue;
    }

    if (tx.type === 'internal_transfer') {
      excludedInternalTransfersCount++;
      continue;
    }

    if (tx.type === 'opening_balance') {
      excludedOpeningBalancesCount++;
      continue;
    }

    if (tx.type === 'unknown' || tx.reviewStatus === 'requires_deposit_origin_review') {
      if (tx.amountCents > 0) {
        unverifiedDepositsPendingReviewCents = addCents(
          unverifiedDepositsPendingReviewCents,
          tx.amountCents
        );
      }
      continue;
    }

    if (tx.type === 'income') {
      // Only booked/confirmed external income counts as recognized income
      if (tx.status === 'booked') {
        recognizedExternalIncomeCents = addCents(
          recognizedExternalIncomeCents,
          Math.abs(tx.amountCents)
        );
        sourceTransactionCount++;
      }
      continue;
    }

    if (tx.type === 'expense') {
      if (scope === 'personal_only') {
        const impact = getPersonalNetSpendImpactCents(tx);
        grossExpensesCents = addCents(grossExpensesCents, impact.personalGrossExpenseCents);
      } else {
        grossExpensesCents = addCents(grossExpensesCents, Math.abs(tx.amountCents));
      }
      sourceTransactionCount++;
    }
  }

  // Refunds reduce net expenses (and never inflate income!)
  const netRealExpensesCents = subtractCents(grossExpensesCents, refundsAppliedCents);
  const netCashFlowCents = subtractCents(recognizedExternalIncomeCents, netRealExpensesCents);

  const uncertainties: string[] = [];
  if (unverifiedDepositsPendingReviewCents > 0) {
    uncertainties.push(
      `Hay ingresos en efectivo/depósitos sin clasificar (${unverifiedDepositsPendingReviewCents} céntimos) excluidos hasta confirmar su origen.`
    );
  }

  return {
    periodKey: params.periodKey,
    scope,
    recognizedExternalIncomeCents,
    plannedUnreceivedIncomeCents,
    grossExpensesCents,
    refundsAppliedCents,
    crossPeriodRefundsReceivedCents,
    netRealExpensesCents,
    netCashFlowCents,
    excludedInternalTransfersCount,
    excludedOpeningBalancesCount,
    unverifiedDepositsPendingReviewCents,
    refundPolicyUsed: refundPolicy,
    howItIsCalculated: {
      title: 'Flujo de caja mensual (Ingresos reales - Gastos netos)',
      accountScopeIncludedNames: params.accounts.map((a) => a.name),
      accountScopeExcludedNames: [],
      periodKey: params.periodKey,
      lastSyncUtc: params.lastSyncUtc ?? null,
      isStaleSync: false,
      sourceTransactionCount,
      formulaSteps: [
        {
          label: 'Ingresos externos reconocidos (asentados)',
          amountCents: recognizedExternalIncomeCents,
          note: 'Excluye saldo inicial, traspasos internos e ingresos previstos no cobrados.',
        },
        {
          label: 'Gastos brutos del periodo',
          amountCents: -grossExpensesCents,
        },
        {
          label: 'Devoluciones aplicadas (reducen gasto, no inflan ingresos)',
          amountCents: refundsAppliedCents,
          note:
            refundPolicy === 'CREDIT_CURRENT_PERIOD'
              ? 'Política activa: las devoluciones abonan el periodo en que se reciben.'
              : 'Política activa: las devoluciones ajustan el periodo de la compra original.',
        },
        {
          label: 'Flujo neto del mes',
          amountCents: netCashFlowCents,
        },
      ],
      activeReservations: [],
      missingInformationWarnings: [],
      uncertainties,
    },
  };
}

// ============================================================================
// VIEW B: PERSONAL ENVELOPES ("¿Cuánto me queda en mi presupuesto personal?")
// ============================================================================

export interface PersonalEnvelopesResult {
  periodKey: PeriodMonthKey;
  confirmedByUser: boolean;
  /** Total envelope allocation (e.g., 174,00 € = 94,00 € spendable + 80,00 € protected savings) */
  totalPersonalAllocatedCents: Cents;
  protectedSavingsAllocatedCents: Cents;
  /** Spendable base + rollover + manual adjustments (excludes the 80 € protected savings!) */
  spendableAllocatedCents: Cents;
  smallPurchasesAllocatedCents: Cents;
  flexibleSpendingAllocatedCents: Cents;
  /** Booked + pending/provisional personal net spending (counted once!) */
  totalPersonalNetSpentCents: Cents;
  bookedPersonalSpentCents: Cents;
  pendingOrProvisionalPersonalSpentCents: Cents;
  smallPurchasesNetSpentCents: Cents;
  flexiblePersonalNetSpentCents: Cents;
  /** Remaining amounts (can be negative if overspent — NEVER clamped to zero!) */
  spendableRemainingCents: Cents;
  smallPurchasesRemainingCents: Cents;
  flexibleSpendingRemainingCents: Cents;
  /** Usage percentages (0..100+, null if allocation is 0) */
  spendableUsedPercent: number | null;
  smallPurchasesUsedPercent: number | null;
  /** Daily pacing guide (remaining spendable / remaining calendar days in Madrid including today) */
  dailyPacingGuideCents: Cents | null;
  remainingCalendarDaysIncludingToday: number;
  howItIsCalculated: HowItIsCalculatedBreakdown;
}

export function calculatePersonalEnvelopes(params: {
  allocation: BudgetPeriodAllocation;
  transactions: readonly CanonicalTransaction[];
  accounts: readonly Account[];
  nowInstantUtc?: Date | string;
  refundPolicy?: CrossPeriodRefundPolicy;
  lastSyncUtc?: string | null;
}): PersonalEnvelopesResult {
  const { allocation } = params;
  const refundPolicy = params.refundPolicy ?? 'CREDIT_CURRENT_PERIOD';
  const nowInstant = params.nowInstantUtc ?? new Date().toISOString();

  const baseSpendable = addCents(
    allocation.smallPurchasesAllocatedCents,
    allocation.flexibleSpendingAllocatedCents
  );
  const spendableAllocatedCents = addCents(
    baseSpendable,
    addCents(allocation.rolloverFromPreviousCents, allocation.manualAdjustmentsCents)
  );

  const txById = new Map<string, CanonicalTransaction>();
  for (const tx of params.transactions) {
    txById.set(tx.id, tx);
  }

  let bookedPersonalSpentCents = 0;
  let pendingOrProvisionalPersonalSpentCents = 0;
  let totalRefundCreditCents = 0;
  let smallPurchasesNetSpentCents = 0;
  let sourceTransactionCount = 0;
  let duplicateReviewCount = 0;

  for (const tx of params.transactions) {
    if (tx.status === 'superseded') {
      continue;
    }

    const txPeriod = getTransactionPeriodKey(tx);

    if (tx.type === 'refund') {
      const linkedExpense = tx.linkedExpenseId ? txById.get(tx.linkedExpenseId) : undefined;
      const originalPeriod = linkedExpense ? getTransactionPeriodKey(linkedExpense) : txPeriod;
      const targetPeriod =
        refundPolicy === 'ADJUST_ORIGINAL_PERIOD' ? originalPeriod : txPeriod;
      if (targetPeriod !== allocation.periodKey) {
        continue;
      }

      const impact = getPersonalNetSpendImpactCents(tx);
      if (impact.personalRefundCreditCents > 0) {
        totalRefundCreditCents = addCents(totalRefundCreditCents, impact.personalRefundCreditCents);
        smallPurchasesNetSpentCents = addCents(
          smallPurchasesNetSpentCents,
          impact.smallPurchaseGrossCents // negative for refunds tagged smallSpending
        );
        sourceTransactionCount++;
      }
      continue;
    }

    if (txPeriod !== allocation.periodKey) {
      continue;
    }

    if (tx.reviewStatus === 'requires_duplicate_review') {
      duplicateReviewCount++;
    }

    if (tx.type === 'expense') {
      const impact = getPersonalNetSpendImpactCents(tx);
      if (impact.personalGrossExpenseCents > 0) {
        if (tx.status === 'booked') {
          bookedPersonalSpentCents = addCents(
            bookedPersonalSpentCents,
            impact.personalGrossExpenseCents
          );
        } else {
          // pending or provisional counted once as commitment
          pendingOrProvisionalPersonalSpentCents = addCents(
            pendingOrProvisionalPersonalSpentCents,
            impact.personalGrossExpenseCents
          );
        }
        smallPurchasesNetSpentCents = addCents(
          smallPurchasesNetSpentCents,
          impact.smallPurchaseGrossCents
        );
        sourceTransactionCount++;
      }
    }
  }

  const grossPersonalSpentCents = addCents(
    bookedPersonalSpentCents,
    pendingOrProvisionalPersonalSpentCents
  );
  // Invariant (Acceptance Test 10 & 16): A small purchase of 2.50 EUR is part of grossPersonalSpentCents
  // (counted ONCE in the 94 EUR spendable budget and ONCE in the 40 EUR small-purchases sub-envelope).
  const totalPersonalNetSpentCents = subtractCents(grossPersonalSpentCents, totalRefundCreditCents);
  const flexiblePersonalNetSpentCents = subtractCents(
    totalPersonalNetSpentCents,
    smallPurchasesNetSpentCents
  );

  // Never clamp deficits to zero!
  const spendableRemainingCents = subtractCents(
    spendableAllocatedCents,
    totalPersonalNetSpentCents
  );
  const smallPurchasesRemainingCents = subtractCents(
    allocation.smallPurchasesAllocatedCents,
    smallPurchasesNetSpentCents
  );
  const flexibleBaseWithAdjustments = addCents(
    allocation.flexibleSpendingAllocatedCents,
    addCents(allocation.rolloverFromPreviousCents, allocation.manualAdjustmentsCents)
  );
  const flexibleSpendingRemainingCents = subtractCents(
    flexibleBaseWithAdjustments,
    flexiblePersonalNetSpentCents
  );

  const spendableUsedPercent =
    spendableAllocatedCents > 0
      ? Math.round((totalPersonalNetSpentCents / spendableAllocatedCents) * 1000) / 10
      : null;

  const smallPurchasesUsedPercent =
    allocation.smallPurchasesAllocatedCents > 0
      ? Math.round(
          (smallPurchasesNetSpentCents / allocation.smallPurchasesAllocatedCents) * 1000
        ) / 10
      : null;

  const calendarInfo = getRemainingCalendarDaysInPeriod(allocation.periodKey, nowInstant);
  const dailyPacingGuideCents =
    calendarInfo.remainingDaysIncludingToday > 0 && spendableRemainingCents > 0
      ? divideCents(spendableRemainingCents, calendarInfo.remainingDaysIncludingToday, 'FLOOR')
      : spendableRemainingCents <= 0
        ? 0
        : null;

  const uncertainties: string[] = [];
  if (duplicateReviewCount > 0) {
    uncertainties.push(
      `Hay ${duplicateReviewCount} movimiento(s) con posible duplicado pendiente de revisión.`
    );
  }
  if (!allocation.confirmedByUser) {
    uncertainties.push('Presupuesto en plantilla pendiente de confirmación por el usuario.');
  }

  return {
    periodKey: allocation.periodKey,
    confirmedByUser: allocation.confirmedByUser,
    totalPersonalAllocatedCents: allocation.totalPersonalAllocatedCents,
    protectedSavingsAllocatedCents: allocation.protectedSavingsAllocatedCents,
    spendableAllocatedCents,
    smallPurchasesAllocatedCents: allocation.smallPurchasesAllocatedCents,
    flexibleSpendingAllocatedCents: allocation.flexibleSpendingAllocatedCents,
    totalPersonalNetSpentCents,
    bookedPersonalSpentCents,
    pendingOrProvisionalPersonalSpentCents,
    smallPurchasesNetSpentCents,
    flexiblePersonalNetSpentCents,
    spendableRemainingCents,
    smallPurchasesRemainingCents,
    flexibleSpendingRemainingCents,
    spendableUsedPercent,
    smallPurchasesUsedPercent,
    dailyPacingGuideCents,
    remainingCalendarDaysIncludingToday: calendarInfo.remainingDaysIncludingToday,
    howItIsCalculated: {
      title: 'Sobres de presupuesto personal (Gasto disponible vs Ahorro protegido)',
      accountScopeIncludedNames: params.accounts.map((a) => a.name),
      accountScopeExcludedNames: [],
      periodKey: allocation.periodKey,
      lastSyncUtc: params.lastSyncUtc ?? null,
      isStaleSync: false,
      sourceTransactionCount,
      formulaSteps: [
        {
          label: 'Asignación personal total del periodo',
          amountCents: allocation.totalPersonalAllocatedCents,
        },
        {
          label: 'Menos: Ahorro personal protegido (no gastable)',
          amountCents: -allocation.protectedSavingsAllocatedCents,
          note: 'Este importe está protegido y nunca suma como dinero para gastar.',
        },
        {
          label: 'Más/Menos: Rollover y ajustes explícitos',
          amountCents: addCents(
            allocation.rolloverFromPreviousCents,
            allocation.manualAdjustmentsCents
          ),
        },
        {
          label: 'Igual a: Presupuesto personal gastable',
          amountCents: spendableAllocatedCents,
        },
        {
          label: 'Menos: Gasto personal asentado (neto de devoluciones)',
          amountCents: -subtractCents(bookedPersonalSpentCents, totalRefundCreditCents),
        },
        {
          label: 'Menos: Compras pendientes / provisionales (contadas una sola vez)',
          amountCents: -pendingOrProvisionalPersonalSpentCents,
        },
        {
          label: 'Restante en presupuesto personal gastable',
          amountCents: spendableRemainingCents,
        },
      ],
      activeReservations: [
        {
          name: 'Ahorro personal protegido',
          remainingCents: allocation.protectedSavingsAllocatedCents,
          type: 'savings',
        },
      ],
      missingInformationWarnings: [],
      uncertainties,
    },
  };
}

// ============================================================================
// VIEW C: ESTIMATED UNCOMMITTED LIQUIDITY ("Liquidez libre estimada")
// ============================================================================

export interface AccountLiquidityContribution {
  accountId: string;
  accountName: string;
  accountType: Account['type'];
  snapshotUsed: BalanceSnapshot | null;
  baseBalanceCents: Cents | null;
  postSnapshotBookedDeltaCents: Cents;
  unreflectedPendingDebitsSubtractedCents: Cents;
  estimatedCurrentFundsCents: Cents | null;
}

export interface EstimatedLiquidityResult {
  /**
   * `null` when no trustworthy starting balance or snapshot exists on included accounts.
   * Invariant (Acceptance Test 23): Unknown is `null`, NEVER `0` or an invented balance!
   */
  uncommittedLiquidityCents: Cents | null;
  totalIncludedOwnedFundsCents: Cents | null;
  unpaidObligationsReservedCents: Cents;
  retainedSavingsReservationsCents: Cents;
  accountContributions: AccountLiquidityContribution[];
  hasMaterialUncertainty: boolean;
  isStaleSync: boolean;
  howItIsCalculated: HowItIsCalculatedBreakdown;
}

export function calculateEstimatedUncommittedLiquidity(params: {
  accounts: readonly Account[];
  snapshots: readonly BalanceSnapshot[];
  transactions: readonly CanonicalTransaction[];
  obligations: readonly ObligationReservation[];
  savingsReservations: readonly SavingsReservation[];
  periodKey: PeriodMonthKey;
  lastSyncUtc?: string | null;
  nowInstantUtc?: string;
  staleThresholdHours?: number;
}): EstimatedLiquidityResult {
  const includedAccounts = params.accounts.filter(
    (a) => a.isOwned && a.includeInLiquidity && a.type !== 'credit_card'
  );
  const excludedAccounts = params.accounts.filter(
    (a) => !a.isOwned || !a.includeInLiquidity || a.type === 'credit_card'
  );

  const missingWarnings: string[] = [];
  const uncertainties: string[] = [];

  const nowMs = new Date(params.nowInstantUtc ?? new Date().toISOString()).getTime();
  const staleHours = params.staleThresholdHours ?? 24;
  const isStaleSync =
    params.lastSyncUtc != null
      ? nowMs - new Date(params.lastSyncUtc).getTime() > staleHours * 3600 * 1000
      : false;

  if (includedAccounts.length === 0) {
    missingWarnings.push('No hay cuentas propias incluidas en el alcance de liquidez.');
  }

  const accountContributions: AccountLiquidityContribution[] = [];
  let anyAccountHasKnownFunds = false;
  let anyIncludedAccountMissingBase = false;
  let totalIncludedOwnedFundsCents = 0;

  for (const account of includedAccounts) {
    // Find latest snapshot for this account
    const accountSnapshots = params.snapshots
      .filter((s) => s.accountId === account.id)
      .sort(
        (a, b) =>
          new Date(b.referenceTimeUtc).getTime() - new Date(a.referenceTimeUtc).getTime()
      );
    const latestSnapshot = accountSnapshots[0] ?? null;

    const accountTxs = params.transactions.filter(
      (tx) => tx.accountId === account.id && tx.status !== 'superseded'
    );

    const hasOpeningTx = accountTxs.some((tx) => tx.type === 'opening_balance');

    // Invariant (Acceptance Test 23): If a bank account has no BalanceSnapshot and no opening_balance,
    // its balance is UNKNOWN (`null`), not 0!
    // For a cash account (`type === 'cash'`), if there is an opening_balance or recorded cash movements,
    // or a snapshot, we can compute it; if there are zero snapshots and zero movements on all accounts, liquidity is unknown.
    if (!latestSnapshot && !hasOpeningTx && accountTxs.length === 0) {
      anyIncludedAccountMissingBase = true;
      missingWarnings.push(
        `La cuenta "${account.name}" no tiene saldo inicial ni instantánea bancaria verificada.`
      );
      accountContributions.push({
        accountId: account.id,
        accountName: account.name,
        accountType: account.type,
        snapshotUsed: null,
        baseBalanceCents: null,
        postSnapshotBookedDeltaCents: 0,
        unreflectedPendingDebitsSubtractedCents: 0,
        estimatedCurrentFundsCents: null,
      });
      continue;
    }

    if (!latestSnapshot && !hasOpeningTx && account.type === 'bank') {
      // Bank account with expense/income movements but no starting balance -> unknown total liquidity!
      anyIncludedAccountMissingBase = true;
      missingWarnings.push(
        `La cuenta bancaria "${account.name}" tiene movimientos pero carece de saldo inicial o instantánea bancaria.`
      );
      accountContributions.push({
        accountId: account.id,
        accountName: account.name,
        accountType: account.type,
        snapshotUsed: null,
        baseBalanceCents: null,
        postSnapshotBookedDeltaCents: 0,
        unreflectedPendingDebitsSubtractedCents: 0,
        estimatedCurrentFundsCents: null,
      });
      continue;
    }

    anyAccountHasKnownFunds = true;
    const baseBalanceCents = latestSnapshot ? latestSnapshot.amountCents : 0;
    let postSnapshotBookedDeltaCents = 0;
    let unreflectedPendingDebitsSubtractedCents = 0;

    for (const tx of accountTxs) {
      if (tx.reviewStatus === 'requires_duplicate_review') {
        uncertainties.push(
          `Movimiento "${tx.description}" (${tx.amountCents} céntimos) pendiente de revisión por posible duplicado.`
        );
      }
      if (tx.reviewStatus === 'requires_deposit_origin_review') {
        uncertainties.push(
          `Ingreso "${tx.description}" (${tx.amountCents} céntimos) pendiente de confirmar origen.`
        );
        // Do not count unverified deposits as safe spendable funds until reviewed
        continue;
      }

      if (tx.status === 'booked') {
        if (!latestSnapshot) {
          postSnapshotBookedDeltaCents = addCents(postSnapshotBookedDeltaCents, tx.amountCents);
        } else {
          // Only apply booked movements that occurred strictly after the snapshot reference
          const afterSnapshot =
            tx.occurredAtUtc !== null
              ? new Date(tx.occurredAtUtc).getTime() >
                new Date(latestSnapshot.referenceTimeUtc).getTime()
              : tx.bookingDate > latestSnapshot.referenceBookingDate;
          if (afterSnapshot) {
            postSnapshotBookedDeltaCents = addCents(postSnapshotBookedDeltaCents, tx.amountCents);
          }
        }
      } else if (tx.status === 'pending' || tx.status === 'provisional') {
        // Subtract pending/provisional debits ONLY when the snapshot does not already reflect them
        // (or when the provisional debit was entered after the snapshot).
        if (tx.amountCents < 0) {
          const alreadyReflectedInSnapshot =
            latestSnapshot !== null &&
            latestSnapshot.includesPendingDebits &&
            tx.status === 'pending' &&
            (tx.occurredAtUtc === null ||
              new Date(tx.occurredAtUtc).getTime() <=
                new Date(latestSnapshot.referenceTimeUtc).getTime());

          if (!alreadyReflectedInSnapshot) {
            unreflectedPendingDebitsSubtractedCents = addCents(
              unreflectedPendingDebitsSubtractedCents,
              Math.abs(tx.amountCents)
            );
          }
        }
      }
    }

    const estimatedCurrentFundsCents = subtractCents(
      addCents(baseBalanceCents, postSnapshotBookedDeltaCents),
      unreflectedPendingDebitsSubtractedCents
    );

    totalIncludedOwnedFundsCents = addCents(
      totalIncludedOwnedFundsCents,
      estimatedCurrentFundsCents
    );

    accountContributions.push({
      accountId: account.id,
      accountName: account.name,
      accountType: account.type,
      snapshotUsed: latestSnapshot,
      baseBalanceCents,
      postSnapshotBookedDeltaCents,
      unreflectedPendingDebitsSubtractedCents,
      estimatedCurrentFundsCents,
    });
  }

  // Calculate unpaid obligations (commitments)
  const activeReservations: HowItIsCalculatedBreakdown['activeReservations'] = [];
  let unpaidObligationsReservedCents = 0;
  for (const ob of params.obligations) {
    if (ob.status === 'cancelled' || ob.status === 'settled') {
      continue;
    }
    const residual = Math.max(0, subtractCents(ob.expectedAmountCents, ob.paidAmountCents));
    if (residual > 0) {
      unpaidObligationsReservedCents = addCents(unpaidObligationsReservedCents, residual);
      activeReservations.push({
        name: ob.name,
        remainingCents: residual,
        type: 'obligation',
      });
    }
  }

  // Calculate retained savings reservations:
  // Invariant (Acceptance Test 9):
  // - If savings are transferred to an EXCLUDED savings account, the bank balance already decreased by `transferredToExcludedAccountCents`,
  //   and the reservation is consumed by that same amount (`protectedAmountCents - transferredToExcludedAccountCents`), avoiding double subtraction!
  // - If the savings account is INCLUDED in the account scope, the transferred money is still inside `totalIncludedOwnedFundsCents`,
  //   so we retain the full `protectedAmountCents` once.
  const anySavingsAccountIncluded = includedAccounts.some((a) => a.type === 'savings');
  let retainedSavingsReservationsCents = 0;

  for (const sr of params.savingsReservations) {
    const residualProtected = anySavingsAccountIncluded
      ? sr.protectedAmountCents
      : Math.max(0, subtractCents(sr.protectedAmountCents, sr.transferredToExcludedAccountCents));

    if (residualProtected > 0) {
      retainedSavingsReservationsCents = addCents(
        retainedSavingsReservationsCents,
        residualProtected
      );
      activeReservations.push({
        name: sr.name,
        remainingCents: residualProtected,
        type: 'savings',
      });
    }
  }

  const isUnknownLiquidity = !anyAccountHasKnownFunds || anyIncludedAccountMissingBase;
  const uncommittedLiquidityCents = isUnknownLiquidity
    ? null
    : subtractCents(
        subtractCents(totalIncludedOwnedFundsCents, unpaidObligationsReservedCents),
        retainedSavingsReservationsCents
      );

  return {
    uncommittedLiquidityCents,
    totalIncludedOwnedFundsCents: isUnknownLiquidity ? null : totalIncludedOwnedFundsCents,
    unpaidObligationsReservedCents,
    retainedSavingsReservationsCents,
    accountContributions,
    hasMaterialUncertainty: uncertainties.length > 0 || isStaleSync,
    isStaleSync,
    howItIsCalculated: {
      title: 'Liquidez libre estimada (Fondos propios - Obligaciones y ahorro protegido)',
      accountScopeIncludedNames: includedAccounts.map((a) => a.name),
      accountScopeExcludedNames: excludedAccounts.map((a) => a.name),
      periodKey: params.periodKey,
      lastSyncUtc: params.lastSyncUtc ?? null,
      isStaleSync,
      sourceTransactionCount: params.transactions.filter((t) => t.status !== 'superseded').length,
      formulaSteps: [
        {
          label: 'Fondos propios estimados en cuentas incluidas',
          amountCents: isUnknownLiquidity ? null : totalIncludedOwnedFundsCents,
          note: 'Concilia instantáneas bancarias con movimientos posteriores y cargos pendientes no reflejados.',
        },
        {
          label: 'Menos: Obligaciones y recibos reservados pendientes de pago',
          amountCents: -unpaidObligationsReservedCents,
        },
        {
          label: 'Menos: Ahorro reservado retenido en cuentas incluidas',
          amountCents: -retainedSavingsReservationsCents,
          note: anySavingsAccountIncluded
            ? 'La cuenta de ahorro está incluida en el alcance; se retiene el 100% del ahorro protegido una vez.'
            : 'El ahorro ya traspasado a una cuenta de ahorro excluida consume su reserva para no restarse dos veces.',
        },
        {
          label: 'Igual a: Liquidez libre no comprometida',
          amountCents: uncommittedLiquidityCents,
        },
      ],
      activeReservations,
      missingInformationWarnings: missingWarnings,
      uncertainties,
    },
  };
}

/**
 * Atomic operation: Paying a reserved bill (ObligationReservation) creates/marks the expense
 * and releases the corresponding amount of the obligation reservation in one step.
 * Supports full and partial payments with exact residual amounts (Acceptance Test 8).
 */
export function settleObligationWithPayment(params: {
  obligation: ObligationReservation;
  paymentTransaction: CanonicalTransaction;
}): {
  updatedObligation: ObligationReservation;
  updatedTransaction: CanonicalTransaction;
  residualReservedCents: Cents;
} {
  const paymentMagnitude = Math.abs(params.paymentTransaction.amountCents);
  assertValidCents(paymentMagnitude);
  if (paymentMagnitude <= 0) {
    throw new Error('El importe del pago de la obligación debe ser mayor que cero.');
  }

  const newPaidCents = addCents(params.obligation.paidAmountCents, paymentMagnitude);
  const residualReservedCents = Math.max(
    0,
    subtractCents(params.obligation.expectedAmountCents, newPaidCents)
  );
  const status: ObligationReservation['status'] =
    residualReservedCents === 0 ? 'settled' : 'partially_paid';

  const updatedObligation: ObligationReservation = {
    ...params.obligation,
    paidAmountCents: newPaidCents,
    status,
    settledTransactionIds: [
      ...params.obligation.settledTransactionIds,
      params.paymentTransaction.id,
    ],
  };

  const updatedTransaction: CanonicalTransaction = {
    ...params.paymentTransaction,
    settledObligationId: params.obligation.id,
  };

  return {
    updatedObligation,
    updatedTransaction,
    residualReservedCents,
  };
}

/**
 * Atomic operation: Transferring earmarked savings from an included bank account to a savings
 * account creates the linked internal transfer legs and updates the savings reservation
 * (`transferredToExcludedAccountCents`) so it is never subtracted twice (Acceptance Test 9).
 */
export function transferReservedSavings(params: {
  idPrefix: string;
  userId: string;
  fromIncludedAccount: Account;
  toSavingsAccount: Account;
  reservation: SavingsReservation;
  transferAmountCents: Cents;
  bookingDate: CalendarDateISO;
}): {
  transferLegs: [CanonicalTransaction, CanonicalTransaction];
  updatedReservation: SavingsReservation;
} {
  assertValidCents(params.transferAmountCents);
  if (params.transferAmountCents <= 0) {
    throw new Error('El importe del traspaso de ahorro debe ser positivo.');
  }

  const pairId = `${params.idPrefix}_savings_pair`;
  const outLeg: CanonicalTransaction = {
    id: `${params.idPrefix}_out`,
    userId: params.userId,
    accountId: params.fromIncludedAccount.id,
    type: 'internal_transfer',
    status: 'booked',
    amountCents: -params.transferAmountCents,
    currency: 'EUR',
    bookingDate: params.bookingDate,
    valueDate: params.bookingDate,
    occurredAtUtc: null,
    createdAtUtc: new Date().toISOString(),
    description: `Traspaso a ahorro: ${params.reservation.name}`,
    merchantNormalized: 'TRASPASO AHORRO',
    userNote: null,
    categoryId: 'savings_transfer',
    categorySource: 'user_locked',
    categoryConfidence: 100,
    categoryExplanation: 'Traspaso interno de ahorro reservado',
    scope: 'non_personal',
    smallSpendingTagged: false,
    splits: [],
    linkedExpenseId: null,
    transferPairId: pairId,
    counterpartAccountId: params.toSavingsAccount.id,
    untrackedOwnedDestinationLabel: null,
    settledObligationId: null,
    consumedSavingsReservationId: params.reservation.id,
    supersededByTransactionId: null,
    reviewStatus: 'none',
    sourceRecordIds: [],
  };

  const inLeg: CanonicalTransaction = {
    ...outLeg,
    id: `${params.idPrefix}_in`,
    accountId: params.toSavingsAccount.id,
    amountCents: params.transferAmountCents,
    counterpartAccountId: params.fromIncludedAccount.id,
  };

  const newTransferred = !params.toSavingsAccount.includeInLiquidity
    ? addCents(params.reservation.transferredToExcludedAccountCents, params.transferAmountCents)
    : params.reservation.transferredToExcludedAccountCents;

  const updatedReservation: SavingsReservation = {
    ...params.reservation,
    transferredToExcludedAccountCents: newTransferred,
    status:
      newTransferred >= params.reservation.protectedAmountCents
        ? 'transferred_to_savings'
        : newTransferred > 0
          ? 'partially_transferred'
          : 'earmarked_in_included_account',
  };

  return {
    transferLegs: [outLeg, inLeg],
    updatedReservation,
  };
}

// ============================================================================
// PURCHASE SIMULATOR ("¿Puedo comprar esto?")
// ============================================================================

export type PurchaseSimulationVerdict =
  | 'WITHIN_BUDGET_AND_LIQUIDITY'
  | 'WITHIN_BUDGET_STALE_OR_UNKNOWN_LIQUIDITY'
  | 'EXCEEDS_SUB_ENVELOPE'
  | 'EXCEEDS_TOTAL_BUDGET'
  | 'EXCEEDS_LIQUIDITY';

export interface PurchaseSimulationResult {
  amountCents: Cents;
  envelopeTarget: 'small_purchases' | 'flexible_personal';
  verdict: PurchaseSimulationVerdict;
  headlineSpanish: string;
  warningsSpanish: string[];
  targetEnvelopeBeforeCents: Cents;
  targetEnvelopeAfterCents: Cents;
  totalSpendableBeforeCents: Cents;
  totalSpendableAfterCents: Cents;
  liquidityBeforeCents: Cents | null;
  liquidityAfterCents: Cents | null;
  dailyPacingBeforeCents: Cents | null;
  dailyPacingAfterCents: Cents | null;
}

/**
 * Pure simulation of a potential purchase. NEVER mutates or persists transactions.
 */
export function simulatePurchase(params: {
  amountCents: Cents;
  envelopeTarget: 'small_purchases' | 'flexible_personal';
  envelopes: PersonalEnvelopesResult;
  liquidity: EstimatedLiquidityResult;
}): PurchaseSimulationResult {
  const amount = assertValidCents(params.amountCents);
  if (amount <= 0) {
    throw new Error('El importe a simular debe ser mayor que 0,00 €.');
  }

  const targetBefore =
    params.envelopeTarget === 'small_purchases'
      ? params.envelopes.smallPurchasesRemainingCents
      : params.envelopes.flexibleSpendingRemainingCents;
  const targetAfter = subtractCents(targetBefore, amount);

  const totalBefore = params.envelopes.spendableRemainingCents;
  const totalAfter = subtractCents(totalBefore, amount);

  const liqBefore = params.liquidity.uncommittedLiquidityCents;
  const liqAfter = liqBefore !== null ? subtractCents(liqBefore, amount) : null;

  const days = params.envelopes.remainingCalendarDaysIncludingToday;
  const dailyBefore = params.envelopes.dailyPacingGuideCents;
  const dailyAfter =
    days > 0 && totalAfter > 0
      ? divideCents(totalAfter, days, 'FLOOR')
      : totalAfter <= 0
        ? 0
        : null;

  const warningsSpanish: string[] = [];
  if (params.liquidity.isStaleSync) {
    warningsSpanish.push('Los datos bancarios no son recientes; el saldo real podría haber cambiado.');
  }
  if (params.liquidity.hasMaterialUncertainty) {
    warningsSpanish.push('Existen movimientos pendientes de revisión o sincronización antigua.');
  }
  if (liqBefore === null) {
    warningsSpanish.push(
      'Liquidez bancaria desconocida: la simulación evalúa solo tu presupuesto personal, sin poder verificar fondos en cuenta.'
    );
  }

  let verdict: PurchaseSimulationVerdict = 'WITHIN_BUDGET_AND_LIQUIDITY';
  let headlineSpanish = 'Encaja en tu presupuesto personal y liquidez estimada';

  if (totalAfter < 0) {
    verdict = 'EXCEEDS_TOTAL_BUDGET';
    headlineSpanish = 'Supera tu presupuesto personal gastable';
  } else if (targetAfter < 0) {
    verdict = 'EXCEEDS_SUB_ENVELOPE';
    headlineSpanish =
      params.envelopeTarget === 'small_purchases'
        ? 'Supera tu presupuesto de compras pequeñas'
        : 'Supera tu presupuesto de gasto flexible';
  } else if (liqAfter !== null && liqAfter < 0) {
    verdict = 'EXCEEDS_LIQUIDITY';
    headlineSpanish = 'Supera tu liquidez libre estimada en cuenta';
  } else if (liqBefore === null || params.liquidity.isStaleSync || params.liquidity.hasMaterialUncertainty) {
    verdict = 'WITHIN_BUDGET_STALE_OR_UNKNOWN_LIQUIDITY';
    headlineSpanish = 'Cabe en tu presupuesto, pero faltan datos bancarios recientes para confirmar liquidez';
  }

  return {
    amountCents: amount,
    envelopeTarget: params.envelopeTarget,
    verdict,
    headlineSpanish,
    warningsSpanish,
    targetEnvelopeBeforeCents: targetBefore,
    targetEnvelopeAfterCents: targetAfter,
    totalSpendableBeforeCents: totalBefore,
    totalSpendableAfterCents: totalAfter,
    liquidityBeforeCents: liqBefore,
    liquidityAfterCents: liqAfter,
    dailyPacingBeforeCents: dailyBefore,
    dailyPacingAfterCents: dailyAfter,
  };
}
