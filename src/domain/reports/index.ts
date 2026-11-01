import {
  addCents,
  Cents,
  centsToSpanishDecimal,
  formatEur,
  subtractCents,
} from '../money';
import {
  CalendarDateISO,
  getDaysInMonth,
  getMadridDateParts,
  getTransactionPeriodKey,
  PeriodMonthKey,
} from '../dates/madrid';
import {
  Account,
  BalanceSnapshot,
  CanonicalTransaction,
  getPersonalNetSpendImpactCents,
  SourceRecord,
} from '../ledger';
import { BudgetPeriodAllocation, CrossPeriodRefundPolicy } from '../budgets';
import { DEFAULT_SPANISH_CATEGORIES } from '../categorization';
import { sanitizeCsvCellForExport } from '../csv';

export type ReportAccountScope = 'all_owned' | 'bank_only' | string;

export interface CategorySpendSummary {
  categoryId: string;
  categoryNameSpanish: string;
  netExpenseCents: Cents;
  grossExpenseCents: Cents;
  refundsCents: Cents;
  transactionCount: number;
  percentageOfTotal: number;
  categoryLimitCents: Cents | null;
  categoryRemainingCents: Cents | null;
}

export interface MonthlyReportBudgetComparison {
  configured: boolean;
  monthlyLimitCents: Cents;
  spentInBudgetScopeCents: Cents;
  remainingCents: Cents;
  usedPercent: number;
  scopeMode: 'personal_only' | 'all_spending';
  selectedAccountNames: string[];
  excludedNonPersonalCount: number;
  excludedNonPersonalCents: Cents;
}

export interface MonthlyReportDataCoverage {
  hasAnyTransactions: boolean;
  minBookingDate: CalendarDateISO | null;
  maxBookingDate: CalendarDateISO | null;
  monthStartDate: CalendarDateISO;
  monthEndDate: CalendarDateISO;
  totalDaysInMonth: number;
  isIncompleteHistory: boolean;
  coverageNoticeSpanish: string;
  lastSyncUtc: string | null;
}

export interface ReportTransactionItem {
  transaction: CanonicalTransaction;
  accountName: string;
  accountIbanMasked: string | null;
  categoryNameSpanish: string;
  sourceLabelSpanish: string;
  statusLabelSpanish: string;
  includedInExpenseTotals: boolean;
  exclusionReasonSpanish: string | null;
}

export interface MonthlyFinancialReport {
  periodKey: PeriodMonthKey;
  periodLabelSpanish: string;
  generatedAtUtc: string;
  generatedAtMadridFormatted: string;
  accountScope: ReportAccountScope;
  accountScopeLabelSpanish: string;
  includedAccounts: Account[];
  totalExternalIncomeCents: Cents;
  grossExpensesCents: Cents;
  refundsAppliedCents: Cents;
  totalNetExpensesCents: Cents;
  /** Income minus Net Expenses (explicitly distinct from bank balance!) */
  monthlyResultCents: Cents;
  internalTransfersCount: number;
  internalTransfersTotalCents: Cents;
  internalTransfers: CanonicalTransaction[];
  pendingTransactionsCount: number;
  pendingTransactionsExpenseCents: Cents;
  nonPersonalTransactionsCount: number;
  nonPersonalExpensesCents: Cents;
  unclassifiedOrReviewCount: number;
  unclassifiedOrReviewCents: Cents;
  categoryBreakdown: CategorySpendSummary[];
  largestExpenses: ReportTransactionItem[];
  allScopedTransactions: ReportTransactionItem[];
  budgetComparison: MonthlyReportBudgetComparison | null;
  dataCoverage: MonthlyReportDataCoverage;
}

const SPANISH_MONTH_NAMES: Record<string, string> = {
  '01': 'enero',
  '02': 'febrero',
  '03': 'marzo',
  '04': 'abril',
  '05': 'mayo',
  '06': 'junio',
  '07': 'julio',
  '08': 'agosto',
  '09': 'septiembre',
  '10': 'octubre',
  '11': 'noviembre',
  '12': 'diciembre',
};

export function formatPeriodMonthLabelSpanish(periodKey: PeriodMonthKey): string {
  const [yyyy, mm] = periodKey.split('-');
  const monthName = SPANISH_MONTH_NAMES[mm ?? ''] ?? mm ?? '';
  return `${monthName.charAt(0).toUpperCase()}${monthName.slice(1)} ${yyyy}`;
}

export function resolveProviderBalanceTypeLabelSpanish(
  balanceType: BalanceSnapshot['balanceType'] | null
): {
  shortLabelSpanish: string;
  detailSpanish: string;
  isAvailableBalance: boolean;
} {
  switch (balanceType) {
    case 'ITAV':
    case 'CLAV':
      return {
        shortLabelSpanish: 'Saldo disponible reportado por el banco',
        detailSpanish: `Tipo PSD2 ${balanceType} (saldo disponible)`,
        isAvailableBalance: true,
      };
    case 'CLBD':
    case 'ITBD':
      return {
        shortLabelSpanish: 'Saldo contable asentado reportado por el banco',
        detailSpanish: `Tipo PSD2 ${balanceType} (saldo contable asentado, sin descontar retenciones pendientes)`,
        isAvailableBalance: false,
      };
    case 'XPCD':
      return {
        shortLabelSpanish: 'Saldo previsto reportado por el banco',
        detailSpanish: 'Tipo PSD2 XPCD',
        isAvailableBalance: false,
      };
    case 'MANUAL':
    case 'OPENING':
      return {
        shortLabelSpanish: 'Saldo manual introducido por el usuario',
        detailSpanish: 'Registrado manualmente (sin lectura automática del banco)',
        isAvailableBalance: false,
      };
    default:
      return {
        shortLabelSpanish: 'Sin saldo bancario reportado',
        detailSpanish: 'Conecta tu banco para consultar tu saldo real',
        isAvailableBalance: false,
      };
  }
}

export interface BankBalanceSummary {
  connectionState: 'connected' | 'unconfigured' | 'disconnected' | 'stale_error';
  headlineStatusSpanish: string;
  selectedScope: 'all_bank' | string;
  selectedAccountName: string;
  bankName: string;
  ibanMasked: string | null;
  /** Actual balance returned by provider (or null when bank is not connected / no snapshot) */
  reportedBalanceCents: Cents | null;
  balanceType: BalanceSnapshot['balanceType'] | null;
  balanceTypeLabelSpanish: string;
  balanceTypeDetailSpanish: string;
  /** Optional secondary balance if both available and booked snapshots exist for the selected account */
  secondaryBookedBalanceCents: Cents | null;
  lastUpdatedUtc: string | null;
  lastUpdatedMadridFormatted: string | null;
  isStale: boolean;
  staleReasonSpanish: string | null;
  manualCashBalanceCents: Cents | null;
}

/**
 * Computes the prominent "Saldo en tu banco" card data for Home.
 * Invariants:
 * 1. Never presents a budget, forecast, or app estimate as a bank-reported balance.
 * 2. Never includes credit limits (`credit_card`) as owned money.
 * 3. When continuing without a bank connection and no provider balance exists, returns `reportedBalanceCents: null` ("Banco sin conectar").
 * 4. If synchronization fails, retains the last known balance and clearly flags its stale status and timestamp.
 */
export function calculateBankBalanceCardSummary(params: {
  accounts: readonly Account[];
  snapshots: readonly BalanceSnapshot[];
  transactions: readonly CanonicalTransaction[];
  selectedBankScope: 'all_bank' | string;
  bankConfig: {
    mode: 'unconfigured' | 'sandbox' | 'production';
    hasValidSession: boolean;
    hasSuccessfulRealRead: boolean;
    localSyncPaused: boolean;
    sessionRevoked: boolean;
    lastSyncUtc: string | null;
    lastSyncError: string | null;
  };
  nowInstantUtc?: string;
  staleThresholdHours?: number;
}): BankBalanceSummary {
  const nowMs = new Date(params.nowInstantUtc ?? new Date().toISOString()).getTime();
  const staleHours = params.staleThresholdHours ?? 24;

  // Owned bank accounts only (never credit_card or cash)
  const ownedBankAccounts = params.accounts.filter(
    (a) => a.isOwned && a.type === 'bank'
  );

  const targetBankAccounts =
    params.selectedBankScope === 'all_bank'
      ? ownedBankAccounts
      : ownedBankAccounts.filter((a) => a.id === params.selectedBankScope);

  const primaryAccount = targetBankAccounts[0] ?? ownedBankAccounts[0] ?? null;

  // Calculate separate manual cash balance (if any cash transactions or snapshots exist)
  const cashAccounts = params.accounts.filter((a) => a.isOwned && a.type === 'cash');
  let manualCashBalanceCents: Cents | null = null;
  for (const cashAcc of cashAccounts) {
    const cashSnaps = params.snapshots
      .filter((s) => s.accountId === cashAcc.id)
      .sort(
        (a, b) =>
          new Date(b.referenceTimeUtc).getTime() - new Date(a.referenceTimeUtc).getTime()
      );
    const cashTxs = params.transactions.filter(
      (t) => t.accountId === cashAcc.id && t.status !== 'superseded'
    );
    if (cashSnaps.length > 0 || cashTxs.length > 0) {
      const latestSnap = cashSnaps[0] ?? null;
      let accBal = latestSnap ? latestSnap.amountCents : 0;
      for (const tx of cashTxs) {
        if (!latestSnap || tx.bookingDate > latestSnap.referenceBookingDate) {
          accBal = addCents(accBal, tx.amountCents);
        }
      }
      manualCashBalanceCents = addCents(manualCashBalanceCents ?? 0, accBal);
    }
  }

  // Gather latest snapshots for the selected bank account(s)
  let totalReportedBankCents: Cents | null = null;
  let primaryBalanceType: BalanceSnapshot['balanceType'] | null = null;
  let secondaryBookedBalanceCents: Cents | null = null;
  let latestSnapshotTimeUtc: string | null = null;

  for (const acc of targetBankAccounts) {
    const accSnaps = params.snapshots
      .filter((s) => s.accountId === acc.id)
      .sort(
        (a, b) =>
          new Date(b.referenceTimeUtc).getTime() - new Date(a.referenceTimeUtc).getTime()
      );
    if (accSnaps.length === 0) {
      continue;
    }

    // Prefer available balance (ITAV/CLAV) as primary if present at latest sync, while keeping booked (CLBD/ITBD) as secondary info
    const latestAvailable = accSnaps.find(
      (s) => s.balanceType === 'ITAV' || s.balanceType === 'CLAV'
    );
    const latestBooked = accSnaps.find(
      (s) => s.balanceType === 'CLBD' || s.balanceType === 'ITBD'
    );
    const chosenSnap = latestAvailable ?? accSnaps[0]!;

    totalReportedBankCents = addCents(totalReportedBankCents ?? 0, chosenSnap.amountCents);
    if (!primaryBalanceType) {
      primaryBalanceType = chosenSnap.balanceType;
    }
    if (
      targetBankAccounts.length === 1 &&
      latestAvailable &&
      latestBooked &&
      latestAvailable.id !== latestBooked.id
    ) {
      secondaryBookedBalanceCents = latestBooked.amountCents;
    }

    if (
      !latestSnapshotTimeUtc ||
      new Date(chosenSnap.referenceTimeUtc).getTime() >
        new Date(latestSnapshotTimeUtc).getTime()
    ) {
      latestSnapshotTimeUtc = chosenSnap.referenceTimeUtc;
    }
  }

  const effectiveLastSyncUtc = params.bankConfig.lastSyncUtc ?? latestSnapshotTimeUtc;
  const ageExceedsThreshold =
    effectiveLastSyncUtc !== null &&
    nowMs - new Date(effectiveLastSyncUtc).getTime() > staleHours * 3600 * 1000;

  const hasSyncError = Boolean(params.bankConfig.lastSyncError);
  const isStale =
    totalReportedBankCents !== null && (hasSyncError || ageExceedsThreshold);

  let staleReasonSpanish: string | null = null;
  if (hasSyncError) {
    staleReasonSpanish = `Fallo en la última actualización: ${params.bankConfig.lastSyncError}. Se conserva el último saldo conocido.`;
  } else if (ageExceedsThreshold) {
    staleReasonSpanish =
      'Hace más de 24 horas desde la última lectura bancaria verificada.';
  }

  const isConnected =
    params.bankConfig.mode !== 'unconfigured' &&
    params.bankConfig.hasValidSession &&
    params.bankConfig.hasSuccessfulRealRead &&
    !params.bankConfig.sessionRevoked;

  let connectionState: BankBalanceSummary['connectionState'] = 'disconnected';
  let headlineStatusSpanish = 'Banco sin conectar';

  if (isStale) {
    connectionState = 'stale_error';
    headlineStatusSpanish = 'Saldo desactualizado';
  } else if (isConnected && totalReportedBankCents !== null) {
    connectionState = 'connected';
    headlineStatusSpanish =
      params.bankConfig.mode === 'sandbox'
        ? 'Conectado (Entorno de pruebas)'
        : 'Conectado con CaixaBank';
  } else if (totalReportedBankCents !== null && primaryBalanceType === 'MANUAL') {
    connectionState = 'disconnected';
    headlineStatusSpanish = 'Banco sin conectar (Saldo manual)';
  } else if (params.bankConfig.mode === 'unconfigured') {
    connectionState = 'unconfigured';
    headlineStatusSpanish = 'Banco sin conectar';
  }

  const labelInfo = resolveProviderBalanceTypeLabelSpanish(primaryBalanceType);
  const lastUpdatedMadridFormatted = effectiveLastSyncUtc
    ? new Date(effectiveLastSyncUtc).toLocaleString('es-ES', {
        timeZone: 'Europe/Madrid',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  return {
    connectionState,
    headlineStatusSpanish,
    selectedScope: params.selectedBankScope,
    selectedAccountName:
      params.selectedBankScope === 'all_bank' && ownedBankAccounts.length > 1
        ? `Todas las cuentas bancarias (${ownedBankAccounts.length})`
        : (primaryAccount?.name ?? 'Cuenta CaixaBank'),
    bankName: 'CaixaBank',
    ibanMasked:
      params.selectedBankScope === 'all_bank' && ownedBankAccounts.length > 1
        ? null
        : (primaryAccount?.ibanMasked ?? null),
    reportedBalanceCents: totalReportedBankCents,
    balanceType: primaryBalanceType,
    balanceTypeLabelSpanish: labelInfo.shortLabelSpanish,
    balanceTypeDetailSpanish: labelInfo.detailSpanish,
    secondaryBookedBalanceCents,
    lastUpdatedUtc: effectiveLastSyncUtc,
    lastUpdatedMadridFormatted,
    isStale,
    staleReasonSpanish,
    manualCashBalanceCents,
  };
}

/**
 * Generates the complete Monthly Financial Report for a given `periodKey` and `accountScope`.
 */
export function generateMonthlyFinancialReport(params: {
  periodKey: PeriodMonthKey;
  accountScope: ReportAccountScope;
  accounts: readonly Account[];
  transactions: readonly CanonicalTransaction[];
  sourceRecords?: readonly SourceRecord[];
  budgetAllocation?: BudgetPeriodAllocation | null;
  budgetScopeMode?: 'personal_only' | 'all_spending';
  budgetSelectedAccountIds?: readonly string[];
  refundPolicy?: CrossPeriodRefundPolicy;
  lastSyncUtc?: string | null;
  nowInstantUtc?: string;
}): MonthlyFinancialReport {
  const nowUtc = params.nowInstantUtc ?? new Date().toISOString();
  const refundPolicy = params.refundPolicy ?? 'CREDIT_CURRENT_PERIOD';
  const budgetScopeMode = params.budgetScopeMode ?? 'personal_only';

  // Resolve included accounts (never include credit_card liabilities as owned cash accounts)
  const ownedAccounts = params.accounts.filter(
    (a) => a.isOwned && a.type !== 'credit_card'
  );

  let includedAccounts: Account[];
  let accountScopeLabelSpanish: string;

  if (params.accountScope === 'all_owned') {
    includedAccounts = ownedAccounts;
    accountScopeLabelSpanish = `Todas las cuentas propias (${includedAccounts.map((a) => a.name).join(', ')})`;
  } else if (params.accountScope === 'bank_only') {
    includedAccounts = ownedAccounts.filter((a) => a.type === 'bank');
    accountScopeLabelSpanish = `Solo cuentas bancarias (${includedAccounts.map((a) => a.name).join(', ')})`;
  } else {
    const specific = ownedAccounts.find((a) => a.id === params.accountScope);
    includedAccounts = specific ? [specific] : ownedAccounts;
    accountScopeLabelSpanish = specific
      ? `${specific.name}${specific.ibanMasked ? ` (${specific.ibanMasked})` : ''}`
      : 'Cuentas propias';
  }

  const includedAccountIds = new Set(includedAccounts.map((a) => a.id));
  const accountById = new Map(params.accounts.map((a) => [a.id, a]));
  const sourceById = new Map((params.sourceRecords ?? []).map((s) => [s.id, s]));
  const txById = new Map(params.transactions.map((t) => [t.id, t]));

  let totalExternalIncomeCents = 0;
  let grossExpensesCents = 0;
  let refundsAppliedCents = 0;
  let internalTransfersCount = 0;
  let internalTransfersTotalCents = 0;
  const internalTransfers: CanonicalTransaction[] = [];
  let pendingTransactionsCount = 0;
  let pendingTransactionsExpenseCents = 0;
  let nonPersonalTransactionsCount = 0;
  let nonPersonalExpensesCents = 0;
  let unclassifiedOrReviewCount = 0;
  let unclassifiedOrReviewCents = 0;

  const catTotals = new Map<
    string,
    { grossCents: Cents; refundsCents: Cents; count: number }
  >();
  const allScopedTransactions: ReportTransactionItem[] = [];
  const expenseItemsForRanking: ReportTransactionItem[] = [];

  let minBookingDate: CalendarDateISO | null = null;
  let maxBookingDate: CalendarDateISO | null = null;

  const sortedTxs = [...params.transactions].sort((a, b) =>
    b.bookingDate.localeCompare(a.bookingDate)
  );

  for (const tx of sortedTxs) {
    if (tx.status === 'superseded') {
      continue;
    }
    if (!includedAccountIds.has(tx.accountId)) {
      continue;
    }

    const txPeriod = getTransactionPeriodKey(tx);
    const linkedExpense = tx.linkedExpenseId ? txById.get(tx.linkedExpenseId) : undefined;
    const originalPeriod = linkedExpense ? getTransactionPeriodKey(linkedExpense) : txPeriod;
    const effectivePeriod =
      tx.type === 'refund' && refundPolicy === 'ADJUST_ORIGINAL_PERIOD'
        ? originalPeriod
        : txPeriod;

    if (effectivePeriod !== params.periodKey) {
      continue;
    }

    if (!minBookingDate || tx.bookingDate < minBookingDate) {
      minBookingDate = tx.bookingDate;
    }
    if (!maxBookingDate || tx.bookingDate > maxBookingDate) {
      maxBookingDate = tx.bookingDate;
    }

    const acc = accountById.get(tx.accountId);
    const catObj = DEFAULT_SPANISH_CATEGORIES.find((c) => c.id === tx.categoryId);
    const catName =
      tx.type === 'internal_transfer'
        ? 'Traspaso interno'
        : tx.type === 'income'
          ? 'Ingresos'
          : (catObj?.nameSpanish ?? 'Sin clasificar');

    // Determine source label from sourceRecords or id prefix
    const firstSource = tx.sourceRecordIds[0]
      ? sourceById.get(tx.sourceRecordIds[0])
      : undefined;
    const sourceLabelSpanish =
      firstSource?.sourceType === 'provider'
        ? 'Banco (PSD2)'
        : firstSource?.sourceType === 'csv' || tx.sourceRecordIds.some((id) => id.includes('csv'))
          ? 'Extracto CSV'
          : 'Entrada manual';

    const statusLabelSpanish =
      tx.status === 'booked'
        ? 'Asentado'
        : tx.status === 'pending'
          ? 'Pendiente en banco'
          : 'Provisional (Manual)';

    if (tx.status === 'pending' || tx.status === 'provisional') {
      pendingTransactionsCount++;
      if (tx.amountCents < 0) {
        pendingTransactionsExpenseCents = addCents(
          pendingTransactionsExpenseCents,
          Math.abs(tx.amountCents)
        );
      }
    }

    if (
      tx.type === 'unknown' ||
      tx.reviewStatus !== 'none' ||
      (tx.type === 'expense' && !tx.categoryId)
    ) {
      unclassifiedOrReviewCount++;
      unclassifiedOrReviewCents = addCents(
        unclassifiedOrReviewCents,
        Math.abs(tx.amountCents)
      );
    }

    if (tx.type === 'internal_transfer') {
      internalTransfersCount++;
      internalTransfersTotalCents = addCents(
        internalTransfersTotalCents,
        Math.abs(tx.amountCents)
      );
      internalTransfers.push(tx);
      allScopedTransactions.push({
        transaction: tx,
        accountName: acc?.name ?? tx.accountId,
        accountIbanMasked: acc?.ibanMasked ?? null,
        categoryNameSpanish: 'Traspaso interno entre cuentas',
        sourceLabelSpanish,
        statusLabelSpanish,
        includedInExpenseTotals: false,
        exclusionReasonSpanish:
          'Excluido de ingresos y gastos por ser traspaso entre cuentas propias',
      });
      continue;
    }

    if (tx.type === 'opening_balance') {
      allScopedTransactions.push({
        transaction: tx,
        accountName: acc?.name ?? tx.accountId,
        accountIbanMasked: acc?.ibanMasked ?? null,
        categoryNameSpanish: 'Saldo inicial',
        sourceLabelSpanish,
        statusLabelSpanish,
        includedInExpenseTotals: false,
        exclusionReasonSpanish: 'Saldo de apertura (no es ingreso ni gasto del mes)',
      });
      continue;
    }

    if (tx.type === 'unknown' || tx.reviewStatus === 'requires_deposit_origin_review') {
      allScopedTransactions.push({
        transaction: tx,
        accountName: acc?.name ?? tx.accountId,
        accountIbanMasked: acc?.ibanMasked ?? null,
        categoryNameSpanish: 'Pendiente de clasificar',
        sourceLabelSpanish,
        statusLabelSpanish,
        includedInExpenseTotals: false,
        exclusionReasonSpanish: 'Excluido hasta confirmar origen del abono/movimiento',
      });
      continue;
    }

    if (tx.type === 'income') {
      if (tx.status === 'booked') {
        totalExternalIncomeCents = addCents(
          totalExternalIncomeCents,
          Math.abs(tx.amountCents)
        );
      }
      allScopedTransactions.push({
        transaction: tx,
        accountName: acc?.name ?? tx.accountId,
        accountIbanMasked: acc?.ibanMasked ?? null,
        categoryNameSpanish: 'Ingresos',
        sourceLabelSpanish,
        statusLabelSpanish,
        includedInExpenseTotals: tx.status === 'booked',
        exclusionReasonSpanish:
          tx.status !== 'booked' ? 'Ingreso pendiente de asentar' : null,
      });
      continue;
    }

    if (tx.type === 'refund') {
      const mag = Math.abs(tx.amountCents);
      refundsAppliedCents = addCents(refundsAppliedCents, mag);
      const catKey = tx.categoryId ?? 'unclassified';
      const prev = catTotals.get(catKey) ?? { grossCents: 0, refundsCents: 0, count: 0 };
      catTotals.set(catKey, {
        grossCents: prev.grossCents,
        refundsCents: addCents(prev.refundsCents, mag),
        count: prev.count + 1,
      });
      allScopedTransactions.push({
        transaction: tx,
        accountName: acc?.name ?? tx.accountId,
        accountIbanMasked: acc?.ibanMasked ?? null,
        categoryNameSpanish: `${catName} (Devolución)`,
        sourceLabelSpanish,
        statusLabelSpanish,
        includedInExpenseTotals: true,
        exclusionReasonSpanish: null,
      });
      continue;
    }

    if (tx.type === 'expense') {
      const mag = Math.abs(tx.amountCents);
      grossExpensesCents = addCents(grossExpensesCents, mag);

      if (tx.scope === 'non_personal') {
        nonPersonalTransactionsCount++;
        nonPersonalExpensesCents = addCents(nonPersonalExpensesCents, mag);
      }

      const catKey = tx.categoryId ?? 'unclassified';
      const prev = catTotals.get(catKey) ?? { grossCents: 0, refundsCents: 0, count: 0 };
      catTotals.set(catKey, {
        grossCents: addCents(prev.grossCents, mag),
        refundsCents: prev.refundsCents,
        count: prev.count + 1,
      });

      const item: ReportTransactionItem = {
        transaction: tx,
        accountName: acc?.name ?? tx.accountId,
        accountIbanMasked: acc?.ibanMasked ?? null,
        categoryNameSpanish: catName,
        sourceLabelSpanish,
        statusLabelSpanish,
        includedInExpenseTotals: true,
        exclusionReasonSpanish: null,
      };
      allScopedTransactions.push(item);
      expenseItemsForRanking.push(item);
    }
  }

  const totalNetExpensesCents = subtractCents(grossExpensesCents, refundsAppliedCents);
  const monthlyResultCents = subtractCents(totalExternalIncomeCents, totalNetExpensesCents);

  // Category Breakdown sorted by net expense descending
  const categoryLimits = params.budgetAllocation?.categoryAllocationsCents ?? {};
  const categoryBreakdown: CategorySpendSummary[] = [];
  for (const [catId, totals] of catTotals.entries()) {
    const netCents = Math.max(0, subtractCents(totals.grossCents, totals.refundsCents));
    const catObj = DEFAULT_SPANISH_CATEGORIES.find((c) => c.id === catId);
    const catName = catObj?.nameSpanish ?? 'Sin clasificar';
    const pct =
      totalNetExpensesCents > 0
        ? Math.round((netCents / totalNetExpensesCents) * 1000) / 10
        : 0;
    const limitCents =
      categoryLimits[catId] !== undefined && categoryLimits[catId]! > 0
        ? categoryLimits[catId]!
        : null;
    categoryBreakdown.push({
      categoryId: catId,
      categoryNameSpanish: catName,
      netExpenseCents: netCents,
      grossExpenseCents: totals.grossCents,
      refundsCents: totals.refundsCents,
      transactionCount: totals.count,
      percentageOfTotal: pct,
      categoryLimitCents: limitCents,
      categoryRemainingCents: limitCents !== null ? subtractCents(limitCents, netCents) : null,
    });
  }
  categoryBreakdown.sort((a, b) => b.netExpenseCents - a.netExpenseCents);

  // Top 5 Largest Expenses
  const largestExpenses = [...expenseItemsForRanking]
    .sort((a, b) => Math.abs(b.transaction.amountCents) - Math.abs(a.transaction.amountCents))
    .slice(0, 5);

  // Budget Comparison ONLY when a user-confirmed budget exists for this month
  let budgetComparison: MonthlyReportBudgetComparison | null = null;
  if (params.budgetAllocation && params.budgetAllocation.confirmedByUser) {
    const monthlyLimitCents = addCents(
      params.budgetAllocation.smallPurchasesAllocatedCents,
      params.budgetAllocation.flexibleSpendingAllocatedCents
    );
    const budgetAccountIds =
      params.budgetSelectedAccountIds && params.budgetSelectedAccountIds.length > 0
        ? new Set(params.budgetSelectedAccountIds)
        : includedAccountIds;

    let spentInBudgetScopeCents = 0;
    let excludedNonPersonalCount = 0;
    let excludedNonPersonalCents = 0;

    for (const item of allScopedTransactions) {
      const tx = item.transaction;
      if (!budgetAccountIds.has(tx.accountId)) continue;
      if (tx.type === 'expense') {
        if (budgetScopeMode === 'personal_only') {
          const impact = getPersonalNetSpendImpactCents(tx);
          spentInBudgetScopeCents = addCents(
            spentInBudgetScopeCents,
            impact.personalGrossExpenseCents
          );
          if (tx.scope === 'non_personal') {
            excludedNonPersonalCount++;
            excludedNonPersonalCents = addCents(
              excludedNonPersonalCents,
              Math.abs(tx.amountCents)
            );
          }
        } else {
          spentInBudgetScopeCents = addCents(
            spentInBudgetScopeCents,
            Math.abs(tx.amountCents)
          );
        }
      } else if (tx.type === 'refund') {
        if (budgetScopeMode === 'personal_only') {
          const impact = getPersonalNetSpendImpactCents(tx);
          spentInBudgetScopeCents = subtractCents(
            spentInBudgetScopeCents,
            impact.personalRefundCreditCents
          );
        } else {
          spentInBudgetScopeCents = subtractCents(
            spentInBudgetScopeCents,
            Math.abs(tx.amountCents)
          );
        }
      }
    }

    const remainingCents = subtractCents(monthlyLimitCents, spentInBudgetScopeCents);
    const usedPercent =
      monthlyLimitCents > 0
        ? Math.round((spentInBudgetScopeCents / monthlyLimitCents) * 1000) / 10
        : 0;

    const selectedAccountNames = params.accounts
      .filter((a) => budgetAccountIds.has(a.id))
      .map((a) => a.name);

    budgetComparison = {
      configured: true,
      monthlyLimitCents,
      spentInBudgetScopeCents,
      remainingCents,
      usedPercent,
      scopeMode: budgetScopeMode,
      selectedAccountNames,
      excludedNonPersonalCount,
      excludedNonPersonalCents,
    };
  }

  // Data coverage & incomplete history check
  const totalDaysInMonth = getDaysInMonth(params.periodKey);
  const monthStartDate = `${params.periodKey}-01` as CalendarDateISO;
  const monthEndDate = `${params.periodKey}-${String(totalDaysInMonth).padStart(
    2,
    '0'
  )}` as CalendarDateISO;
  const currentMadrid = getMadridDateParts(nowUtc);

  const hasAnyTransactions = allScopedTransactions.length > 0;
  let isIncompleteHistory = false;
  let coverageNoticeSpanish: string;

  if (!hasAnyTransactions) {
    isIncompleteHistory = true;
    coverageNoticeSpanish =
      'Sin datos importados ni registrados en este mes. La ausencia de movimientos en la app no confirma que el gasto real haya sido 0,00 €.';
  } else {
    const startsAfterFirstWeek =
      minBookingDate !== null && Number(minBookingDate.slice(8, 10)) > 5;
    const isPastMonth = params.periodKey < currentMadrid.periodKey;
    const endsBeforeLastWeekInPastMonth =
      isPastMonth &&
      maxBookingDate !== null &&
      Number(maxBookingDate.slice(8, 10)) < totalDaysInMonth - 5;

    if (startsAfterFirstWeek || endsBeforeLastWeekInPastMonth) {
      isIncompleteHistory = true;
      coverageNoticeSpanish = `Cobertura parcial de movimientos: datos registrados desde ${minBookingDate} hasta ${maxBookingDate} (el mes completo comprende del ${monthStartDate} al ${monthEndDate}).`;
    } else {
      coverageNoticeSpanish = `Movimientos registrados desde ${minBookingDate} hasta ${maxBookingDate}.`;
    }
  }

  const generatedAtMadridFormatted = new Date(nowUtc).toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return {
    periodKey: params.periodKey,
    periodLabelSpanish: formatPeriodMonthLabelSpanish(params.periodKey),
    generatedAtUtc: nowUtc,
    generatedAtMadridFormatted,
    accountScope: params.accountScope,
    accountScopeLabelSpanish,
    includedAccounts,
    totalExternalIncomeCents,
    grossExpensesCents,
    refundsAppliedCents,
    totalNetExpensesCents,
    monthlyResultCents,
    internalTransfersCount,
    internalTransfersTotalCents,
    internalTransfers,
    pendingTransactionsCount,
    pendingTransactionsExpenseCents,
    nonPersonalTransactionsCount,
    nonPersonalExpensesCents,
    unclassifiedOrReviewCount,
    unclassifiedOrReviewCents,
    categoryBreakdown,
    largestExpenses,
    allScopedTransactions,
    budgetComparison,
    dataCoverage: {
      hasAnyTransactions,
      minBookingDate,
      maxBookingDate,
      monthStartDate,
      monthEndDate,
      totalDaysInMonth,
      isIncompleteHistory,
      coverageNoticeSpanish,
      lastSyncUtc: params.lastSyncUtc ?? null,
    },
  };
}

/**
 * Exports a MonthlyFinancialReport to a Spanish CSV document with summary totals and transaction table.
 * Protects every text field against CSV formula injection (`=`, `+`, `-`, `@`).
 */
export function exportMonthlyReportToCsv(report: MonthlyFinancialReport): string {
  const lines: string[] = [];

  lines.push(
    [
      'Informe mensual STOP SPEND',
      sanitizeCsvCellForExport(report.periodLabelSpanish),
      sanitizeCsvCellForExport(report.accountScopeLabelSpanish),
      sanitizeCsvCellForExport(`Generado: ${report.generatedAtMadridFormatted}`),
    ].join(';')
  );
  lines.push(
    [
      'Resumen del mes (EUR)',
      `Ingresos externos;${centsToSpanishDecimal(report.totalExternalIncomeCents)}`,
      `Gastos netos;${centsToSpanishDecimal(report.totalNetExpensesCents)}`,
      `Resultado (Ingresos - Gastos);${centsToSpanishDecimal(report.monthlyResultCents)}`,
      `Traspasos internos excluidos (${report.internalTransfersCount});${centsToSpanishDecimal(report.internalTransfersTotalCents)}`,
    ].join(';')
  );

  if (report.budgetComparison) {
    lines.push(
      [
        'Presupuesto del mes (EUR)',
        `Límite mensual;${centsToSpanishDecimal(report.budgetComparison.monthlyLimitCents)}`,
        `Gastado;${centsToSpanishDecimal(report.budgetComparison.spentInBudgetScopeCents)}`,
        `Te quedan;${centsToSpanishDecimal(report.budgetComparison.remainingCents)}`,
      ].join(';')
    );
  }

  lines.push(
    `Cobertura de datos;${sanitizeCsvCellForExport(report.dataCoverage.coverageNoticeSpanish)}`
  );
  lines.push('');

  lines.push(
    'Fecha contable;Cuenta;Concepto / Comercio;Categoría;Importe (EUR);Moneda;Tipo;Estado;Origen;Ámbito;Incluido en totales;Nota'
  );

  for (const item of report.allScopedTransactions) {
    const tx = item.transaction;
    const accLabel = item.accountIbanMasked
      ? `${item.accountName} (${item.accountIbanMasked})`
      : item.accountName;
    lines.push(
      [
        tx.bookingDate,
        sanitizeCsvCellForExport(accLabel),
        sanitizeCsvCellForExport(tx.description),
        sanitizeCsvCellForExport(item.categoryNameSpanish),
        centsToSpanishDecimal(tx.amountCents),
        tx.currency,
        tx.type,
        sanitizeCsvCellForExport(item.statusLabelSpanish),
        sanitizeCsvCellForExport(item.sourceLabelSpanish),
        tx.scope === 'personal' ? 'Personal' : 'No personal',
        item.includedInExpenseTotals ? 'Sí' : 'No',
        sanitizeCsvCellForExport(tx.userNote ?? item.exclusionReasonSpanish ?? ''),
      ].join(';')
    );
  }

  return lines.join('\n');
}

export { formatEur };
