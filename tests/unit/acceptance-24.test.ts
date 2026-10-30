import { describe, it, expect } from 'vitest';
import {
  addCents,
  formatEur,
  MoneyPrecisionError,
  parseMoneyToCents,
  UnsupportedCurrencyError,
} from '../../src/domain/money';
import {
  getMadridDateParts,
  getRemainingCalendarDaysInPeriod,
  isWithinMadridQuietHours,
} from '../../src/domain/dates/madrid';
import {
  CanonicalTransaction,
  computeLedgerAccountBalanceCents,
  createAccount,
  ObligationReservation,
  recordCashDepositIntoBank,
  SavingsReservation,
  SourceRecord,
  upsertProviderAccount,
  validateSplitsForTransaction,
} from '../../src/domain/ledger';
import {
  calculateEstimatedUncommittedLiquidity,
  calculateMonthlyCashFlow,
  calculatePersonalEnvelopes,
  createBudgetAllocation,
  PERSONAL_ENVELOPE_TEMPLATE_EUR,
  settleObligationWithPayment,
  simulatePurchase,
  transferReservedSavings,
} from '../../src/domain/budgets';
import {
  ingestAndReconcileSourceRecord,
  undoReconciliationLink,
} from '../../src/domain/reconciliation';
import {
  evaluateBudgetThresholdCrossing,
  validateSafeWebPushEndpoint,
} from '../../src/domain/alerts';
import {
  commitCsvImportBatch,
  exportTransactionsToSpanishCsv,
  previewCsvStatement,
  rollbackCsvImportBatch,
} from '../../src/domain/csv';
import {
  enqueueOfflineExpense,
  evaluateLogoutSafety,
  flushOfflineQueueForUser,
} from '../../src/domain/offline';
import {
  createBoundAuthState,
  resolveBankConnectionStatusBadge,
  selectExactInstitution,
  syncAccountPagesAtomically,
  validateAndConsumeAuthStateCallback,
} from '../../src/server/providers/enableBanking';
import {
  enforceCompositeReferenceOwnership,
  enforceRowOwnership,
  filterRowsByRls,
  SecurityAccessDeniedError,
  UnauthenticatedAccessError,
} from '../../src/server/security/rlsEnforcement';

const USER_JARED = 'user_jared_1';
const USER_OTHER = 'user_other_2';

function makeBaseTx(overrides: Partial<CanonicalTransaction> & { id: string; accountId: string; amountCents: number }): CanonicalTransaction {
  return {
    userId: USER_JARED,
    type: overrides.amountCents < 0 ? 'expense' : 'income',
    status: 'booked',
    currency: 'EUR',
    bookingDate: '2026-10-15',
    valueDate: '2026-10-15',
    occurredAtUtc: null,
    createdAtUtc: '2026-10-15T10:00:00Z',
    description: 'Movimiento prueba',
    merchantNormalized: 'MOVIMIENTO PRUEBA',
    userNote: null,
    categoryId: 'shopping_personal',
    categorySource: 'user_locked',
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
    ...overrides,
  };
}

describe('STOP SPEND — 24 Mandatory Acceptance Tests (Section 12)', () => {
  // 1. Exact cents
  it('Test 1: Exact cents (0.10 + 0.20 = 0.30, comma 2,50 -> 250, explicit precision & currency policy)', () => {
    const c10 = parseMoneyToCents('0.10');
    const c20 = parseMoneyToCents('0.20');
    expect(c10).toBe(10);
    expect(c20).toBe(20);
    expect(addCents(c10, c20)).toBe(30);
    expect(formatEur(addCents(c10, c20))).toBe('0,30\u00A0€');

    expect(parseMoneyToCents('2,50')).toBe(250);
    expect(parseMoneyToCents('1.250,50')).toBe(125050);

    // Invalid precision rejected by default policy ('REJECT')
    expect(() => parseMoneyToCents('2,505')).toThrow(MoneyPrecisionError);
    // Handled by explicit HALF_UP policy when specified
    expect(parseMoneyToCents('2,505', { rounding: 'HALF_UP' })).toBe(251);

    // Unsupported currency rejected
    expect(() => parseMoneyToCents('10,00', { currency: 'USD' })).toThrow(UnsupportedCurrencyError);
  });

  // 2. Cash salary & transfer to bank
  it('Test 2: Cash opening 0, salary +1,250 into cash, transfer 1,000 to bank -> income 1,250, cash 250, bank 1,000, combined 1,250, expenses 0', () => {
    const cashAcc = createAccount({ id: 'acc_cash', userId: USER_JARED, name: 'Efectivo', type: 'cash' });
    const bankAcc = createAccount({ id: 'acc_bank', userId: USER_JARED, name: 'CaixaBank', type: 'bank' });

    const salaryTx = makeBaseTx({
      id: 'tx_salary_cash',
      accountId: cashAcc.id,
      type: 'income',
      amountCents: 125000, // 1,250.00 EUR
      bookingDate: '2026-10-01',
      description: 'Nómina en efectivo',
    });

    const depositResult = recordCashDepositIntoBank({
      idPrefix: 'dep1',
      userId: USER_JARED,
      cashAccountId: cashAcc.id,
      bankAccountId: bankAcc.id,
      amountCents: 100000, // 1,000.00 EUR
      bookingDate: '2026-10-02',
      currentTrackedCashBalanceCents: 125000,
      confirmedOrigin: 'from_tracked_cash',
    });

    expect(depositResult.requiresUserReview).toBe(false);
    const allTxs = [salaryTx, ...depositResult.transactions];

    const cashBalance = computeLedgerAccountBalanceCents(cashAcc.id, allTxs, 0);
    const bankBalance = computeLedgerAccountBalanceCents(bankAcc.id, allTxs, 0);
    expect(cashBalance).toBe(25000); // 250.00 EUR
    expect(bankBalance).toBe(100000); // 1,000.00 EUR
    expect(addCents(cashBalance!, bankBalance!)).toBe(125000); // 1,250.00 EUR combined

    const cashFlow = calculateMonthlyCashFlow({
      periodKey: '2026-10',
      accounts: [cashAcc, bankAcc],
      transactions: allTxs,
    });
    expect(cashFlow.recognizedExternalIncomeCents).toBe(125000); // 1,250.00 EUR (not 2,250!)
    expect(cashFlow.netRealExpensesCents).toBe(0);
  });

  // 3. Deposit without a recorded source
  it('Test 3: Deposit without a recorded source -> review required, not a silently invented second salary', () => {
    const cashAcc = createAccount({ id: 'acc_cash', userId: USER_JARED, name: 'Efectivo', type: 'cash' });
    const bankAcc = createAccount({ id: 'acc_bank', userId: USER_JARED, name: 'CaixaBank', type: 'bank' });

    const res = recordCashDepositIntoBank({
      idPrefix: 'dep_unknown',
      userId: USER_JARED,
      cashAccountId: cashAcc.id,
      bankAccountId: bankAcc.id,
      amountCents: 50000, // 500 EUR deposit with 0 tracked cash
      bookingDate: '2026-10-05',
      currentTrackedCashBalanceCents: 0,
      confirmedOrigin: 'unconfirmed',
    });

    expect(res.requiresUserReview).toBe(true);
    expect(res.transactions[0]?.type).toBe('unknown');
    expect(res.transactions[0]?.reviewStatus).toBe('requires_deposit_origin_review');

    const cashFlow = calculateMonthlyCashFlow({
      periodKey: '2026-10',
      accounts: [cashAcc, bankAcc],
      transactions: res.transactions,
    });
    // Must NOT be counted as recognized income until user confirms origin!
    expect(cashFlow.recognizedExternalIncomeCents).toBe(0);
    expect(cashFlow.unverifiedDepositsPendingReviewCents).toBe(50000);
  });

  // 4. Manual bank expense 2.50 followed by matching bank record
  it('Test 4: Manual bank expense 2.50 followed by matching bank record -> one expense of 2.50, not 5.00; preserve user category & reversible audit', () => {
    const manualProvisional = makeBaseTx({
      id: 'tx_manual_1',
      accountId: 'acc_bank',
      status: 'provisional',
      amountCents: -250,
      bookingDate: '2026-10-10',
      description: 'Café cafetería',
      categoryId: 'coffee_snacks',
      userNote: 'Con amigos',
      smallSpendingTagged: true,
      sourceRecordIds: ['src_manual_1'],
    });

    const bankSource: SourceRecord = {
      id: 'src_bank_101',
      userId: USER_JARED,
      accountId: 'acc_bank',
      sourceType: 'provider',
      providerCode: 'enable_banking',
      sourceExternalId: 'eb_ref_999',
      importBatchId: null,
      originalDescription: 'CAFETERIA CENTRAL BARCELONA',
      bookingDate: '2026-10-11',
      valueDate: '2026-10-10',
      occurredAtUtc: null,
      receivedAtServerUtc: '2026-10-11T12:00:00Z',
      status: 'booked',
      currency: 'EUR',
      amountCents: -250,
      counterpartyName: 'CAFETERIA CENTRAL',
      counterpartyIbanNormalized: null,
      remittanceInfo: null,
      normalizationVersion: 1,
      provenance: 'enable_banking',
    };

    const reconciled = ingestAndReconcileSourceRecord({
      incomingSource: bankSource,
      existingSources: [],
      existingTransactions: [manualProvisional],
      existingAuditLinks: [],
    });

    expect(reconciled.action).toBe('reconciled_provisional_manual');
    const activeTxs = reconciled.transactions.filter((t) => t.status !== 'superseded');
    expect(activeTxs).toHaveLength(1);
    expect(activeTxs[0]?.amountCents).toBe(-250);
    expect(activeTxs[0]?.categoryId).toBe('coffee_snacks'); // preserved!
    expect(activeTxs[0]?.userNote).toBe('Con amigos'); // preserved!

    // Also verify reversible audit link
    const undone = undoReconciliationLink({
      auditLinkId: reconciled.auditLinks[0]!.id,
      transactions: reconciled.transactions,
      auditLinks: reconciled.auditLinks,
    });
    expect(undone.transactions.filter((t) => t.status !== 'superseded')).toHaveLength(2);
  });

  // 5. Two real same-merchant 2.50 payments on one date
  it('Test 5: Two real same-merchant 2.50 payments on one date -> both retained unless evidence proves duplication', () => {
    const src1: SourceRecord = {
      id: 'src_1',
      userId: USER_JARED,
      accountId: 'acc_bank',
      sourceType: 'provider',
      providerCode: 'enable_banking',
      sourceExternalId: 'caixabank_tx_001',
      importBatchId: null,
      originalDescription: 'PANADERIA MADRID',
      bookingDate: '2026-10-12',
      valueDate: '2026-10-12',
      occurredAtUtc: null,
      receivedAtServerUtc: '2026-10-12T18:00:00Z',
      status: 'booked',
      currency: 'EUR',
      amountCents: -250,
      counterpartyName: 'PANADERIA MADRID',
      counterpartyIbanNormalized: null,
      remittanceInfo: null,
      normalizationVersion: 1,
      provenance: 'enable_banking',
    };

    const src2: SourceRecord = {
      ...src1,
      id: 'src_2',
      sourceExternalId: 'caixabank_tx_002', // Distinct transaction ID on same day & merchant & amount
    };

    const step1 = ingestAndReconcileSourceRecord({
      incomingSource: src1,
      existingSources: [],
      existingTransactions: [],
      existingAuditLinks: [],
    });

    const step2 = ingestAndReconcileSourceRecord({
      incomingSource: src2,
      existingSources: step1.sourceRecords,
      existingTransactions: step1.transactions,
      existingAuditLinks: step1.auditLinks,
    });

    const activeTxs = step2.transactions.filter((t) => t.status !== 'superseded');
    expect(activeTxs).toHaveLength(2);
    expect(activeTxs[0]!.amountCents + activeTxs[1]!.amountCents).toBe(-500);
  });

  // 6. Pending 20 becoming booked 22
  it('Test 6: Pending 20 becoming booked 22 -> one final expense of 22, no leftover 20 commitment', () => {
    const pendingTx = makeBaseTx({
      id: 'tx_pending_20',
      accountId: 'acc_bank',
      status: 'pending',
      amountCents: -2000, // -20.00 EUR
      bookingDate: '2026-10-14',
      description: 'REPSOL ESTACION SERVICIO',
      categoryId: 'transport',
      sourceRecordIds: ['src_pend_1'],
    });

    const bookedSource: SourceRecord = {
      id: 'src_booked_22',
      userId: USER_JARED,
      accountId: 'acc_bank',
      sourceType: 'provider',
      providerCode: 'enable_banking',
      sourceExternalId: 'repsol_settled_ref',
      importBatchId: null,
      originalDescription: 'REPSOL ESTACION SERVICIO MADRID',
      bookingDate: '2026-10-16',
      valueDate: '2026-10-14',
      occurredAtUtc: null,
      receivedAtServerUtc: '2026-10-16T09:00:00Z',
      status: 'booked',
      currency: 'EUR',
      amountCents: -2200, // -22.00 EUR settled
      counterpartyName: 'REPSOL',
      counterpartyIbanNormalized: null,
      remittanceInfo: null,
      normalizationVersion: 1,
      provenance: 'enable_banking',
    };

    const res = ingestAndReconcileSourceRecord({
      incomingSource: bookedSource,
      existingSources: [],
      existingTransactions: [pendingTx],
      existingAuditLinks: [],
    });

    expect(res.action).toBe('reconciled_pending_to_booked');
    const active = res.transactions.filter((t) => t.status !== 'superseded');
    expect(active).toHaveLength(1);
    expect(active[0]?.status).toBe('booked');
    expect(active[0]?.amountCents).toBe(-2200);
    expect(active[0]?.categoryId).toBe('transport');
  });

  // 7. Booked balance 100 excluding pending debit 10 -> 90; available balance 90 already reflecting it -> still 90
  it('Test 7: Booked balance 100 excluding pending debit 10 -> 90; available balance 90 already reflecting it -> still 90', () => {
    const bankAcc = createAccount({ id: 'acc_bank', userId: USER_JARED, name: 'CaixaBank', type: 'bank' });
    const pendingDebit10 = makeBaseTx({
      id: 'tx_pend_10',
      accountId: bankAcc.id,
      status: 'pending',
      amountCents: -1000, // -10.00 EUR
      bookingDate: '2026-10-15',
      occurredAtUtc: '2026-10-15T10:00:00Z',
    });

    // Case A: Booked balance (CLBD) of 100 EUR (includesPendingDebits = false)
    const liqFromBooked = calculateEstimatedUncommittedLiquidity({
      accounts: [bankAcc],
      snapshots: [
        {
          id: 'snap_clbd',
          userId: USER_JARED,
          accountId: bankAcc.id,
          source: 'provider',
          balanceType: 'CLBD',
          amountCents: 10000,
          currency: 'EUR',
          referenceTimeUtc: '2026-10-15T12:00:00Z',
          referenceBookingDate: '2026-10-15',
          includesPendingDebits: false,
        },
      ],
      transactions: [pendingDebit10],
      obligations: [],
      savingsReservations: [],
      periodKey: '2026-10',
    });
    expect(liqFromBooked.uncommittedLiquidityCents).toBe(9000); // 90.00 EUR

    // Case B: Available balance (ITAV) of 90 EUR (includesPendingDebits = true)
    const liqFromAvailable = calculateEstimatedUncommittedLiquidity({
      accounts: [bankAcc],
      snapshots: [
        {
          id: 'snap_itav',
          userId: USER_JARED,
          accountId: bankAcc.id,
          source: 'provider',
          balanceType: 'ITAV',
          amountCents: 9000,
          currency: 'EUR',
          referenceTimeUtc: '2026-10-15T12:00:00Z',
          referenceBookingDate: '2026-10-15',
          includesPendingDebits: true,
        },
      ],
      transactions: [pendingDebit10],
      obligations: [],
      savingsReservations: [],
      periodKey: '2026-10',
    });
    expect(liqFromAvailable.uncommittedLiquidityCents).toBe(9000); // Still 90.00 EUR, not 80!
  });

  // 8. Funds 1,000 and reserved unpaid rent 800 -> 200 uncommitted; after paying 800 and clearing reservation -> still 200
  it('Test 8: Funds 1,000 and reserved unpaid rent 800 -> 200 uncommitted; after paying 800 and clearing reservation -> still 200', () => {
    const bankAcc = createAccount({ id: 'acc_bank', userId: USER_JARED, name: 'CaixaBank', type: 'bank' });
    const snap1000 = {
      id: 'snap_1000',
      userId: USER_JARED,
      accountId: bankAcc.id,
      source: 'provider' as const,
      balanceType: 'CLBD' as const,
      amountCents: 100000, // 1,000 EUR
      currency: 'EUR' as const,
      referenceTimeUtc: '2026-10-01T08:00:00Z',
      referenceBookingDate: '2026-10-01' as const,
      includesPendingDebits: false,
    };

    const rentObligation: ObligationReservation = {
      id: 'ob_rent',
      userId: USER_JARED,
      name: 'Alquiler Octubre',
      periodKey: '2026-10',
      expectedAmountCents: 80000, // 800 EUR
      paidAmountCents: 0,
      status: 'reserved',
      dueDate: '2026-10-05',
      settledTransactionIds: [],
    };

    const beforePay = calculateEstimatedUncommittedLiquidity({
      accounts: [bankAcc],
      snapshots: [snap1000],
      transactions: [],
      obligations: [rentObligation],
      savingsReservations: [],
      periodKey: '2026-10',
    });
    expect(beforePay.uncommittedLiquidityCents).toBe(20000); // 200 EUR

    // Now pay the 800 EUR rent after the snapshot and settle the obligation atomically
    const rentPaymentTx = makeBaseTx({
      id: 'tx_rent_paid',
      accountId: bankAcc.id,
      amountCents: -80000,
      bookingDate: '2026-10-05',
      occurredAtUtc: '2026-10-05T10:00:00Z',
      scope: 'non_personal',
    });

    const settled = settleObligationWithPayment({
      obligation: rentObligation,
      paymentTransaction: rentPaymentTx,
    });

    const afterPay = calculateEstimatedUncommittedLiquidity({
      accounts: [bankAcc],
      snapshots: [snap1000],
      transactions: [settled.updatedTransaction],
      obligations: [settled.updatedObligation],
      savingsReservations: [],
      periodKey: '2026-10',
    });
    expect(afterPay.totalIncludedOwnedFundsCents).toBe(20000); // 1,000 - 800 = 200 EUR in bank
    expect(afterPay.unpaidObligationsReservedCents).toBe(0); // Reservation released!
    expect(afterPay.uncommittedLiquidityCents).toBe(20000); // Still 200 EUR!
  });

  // 9. Funds 500 and savings reservation 100 -> 400; transfer 100 to excluded savings and consume reservation -> 400, not 300. Also test savings included in account scope.
  it('Test 9: Savings reservation 100 with 500 funds -> 400; transfer 100 to excluded savings -> 400 (not 300); included savings scope -> 400', () => {
    const bankAcc = createAccount({
      id: 'acc_bank',
      userId: USER_JARED,
      name: 'CaixaBank Corriente',
      type: 'bank',
      includeInLiquidity: true,
    });
    const excludedSavingsAcc = createAccount({
      id: 'acc_savings_excl',
      userId: USER_JARED,
      name: 'Cuenta Ahorro Excluida',
      type: 'savings',
      includeInLiquidity: false,
    });

    const snap500 = {
      id: 'snap_500',
      userId: USER_JARED,
      accountId: bankAcc.id,
      source: 'provider' as const,
      balanceType: 'CLBD' as const,
      amountCents: 50000, // 500 EUR
      currency: 'EUR' as const,
      referenceTimeUtc: '2026-10-01T08:00:00Z',
      referenceBookingDate: '2026-10-01' as const,
      includesPendingDebits: false,
    };

    const savingsRes: SavingsReservation = {
      id: 'sr_100',
      userId: USER_JARED,
      name: 'Ahorro mensual',
      periodKey: '2026-10',
      protectedAmountCents: 10000, // 100 EUR
      transferredToExcludedAccountCents: 0,
      status: 'earmarked_in_included_account',
    };

    const beforeTransfer = calculateEstimatedUncommittedLiquidity({
      accounts: [bankAcc, excludedSavingsAcc],
      snapshots: [snap500],
      transactions: [],
      obligations: [],
      savingsReservations: [savingsRes],
      periodKey: '2026-10',
    });
    expect(beforeTransfer.uncommittedLiquidityCents).toBe(40000); // 400 EUR

    // Transfer 100 EUR to excluded savings account
    const transferOp = transferReservedSavings({
      idPrefix: 'sav_tr_1',
      userId: USER_JARED,
      fromIncludedAccount: bankAcc,
      toSavingsAccount: excludedSavingsAcc,
      reservation: savingsRes,
      transferAmountCents: 10000,
      bookingDate: '2026-10-03',
    });

    const afterExcludedTransfer = calculateEstimatedUncommittedLiquidity({
      accounts: [bankAcc, excludedSavingsAcc],
      snapshots: [snap500],
      transactions: transferOp.transferLegs,
      obligations: [],
      savingsReservations: [transferOp.updatedReservation],
      periodKey: '2026-10',
    });
    expect(afterExcludedTransfer.totalIncludedOwnedFundsCents).toBe(40000); // 400 EUR in bank
    expect(afterExcludedTransfer.retainedSavingsReservationsCents).toBe(0); // Consumed!
    expect(afterExcludedTransfer.uncommittedLiquidityCents).toBe(40000); // 400 EUR, NOT 300 EUR!

    // Now test when the savings account IS included in the liquidity account scope
    const includedSavingsAcc = { ...excludedSavingsAcc, includeInLiquidity: true };
    const snapSavings0 = {
      ...snap500,
      id: 'snap_sav_0',
      accountId: includedSavingsAcc.id,
      amountCents: 0,
    };
    const afterIncludedTransfer = calculateEstimatedUncommittedLiquidity({
      accounts: [bankAcc, includedSavingsAcc],
      snapshots: [snap500, snapSavings0],
      transactions: transferOp.transferLegs,
      obligations: [],
      savingsReservations: [transferOp.updatedReservation],
      periodKey: '2026-10',
    });
    expect(afterIncludedTransfer.totalIncludedOwnedFundsCents).toBe(50000); // 400 bank + 100 savings = 500
    expect(afterIncludedTransfer.retainedSavingsReservationsCents).toBe(10000); // Retained once!
    expect(afterIncludedTransfer.uncommittedLiquidityCents).toBe(40000); // 500 - 100 = 400 EUR!
  });

  // 10 & 16. Personal template (174 allocated, 80 protected, 94 spendable; 2.50 small purchase -> 37.50 small & 91.50 spendable; counted once)
  it('Test 10 & Test 16: Personal template (174 total, 80 protected, 94 spendable) + 2.50 small purchase -> 37.50 small & 91.50 spendable (counted once)', () => {
    const allocation = createBudgetAllocation({
      id: 'bud_oct',
      userId: USER_JARED,
      periodKey: '2026-10',
      confirmedByUser: true,
      protectedSavingsAllocatedCents: PERSONAL_ENVELOPE_TEMPLATE_EUR.protectedSavingsAllocationCents,
      smallPurchasesAllocatedCents: PERSONAL_ENVELOPE_TEMPLATE_EUR.smallPurchasesAllocationCents,
      flexibleSpendingAllocatedCents: PERSONAL_ENVELOPE_TEMPLATE_EUR.flexibleSpendingAllocationCents,
    });

    expect(allocation.totalPersonalAllocatedCents).toBe(17400); // 174.00 EUR
    expect(allocation.protectedSavingsAllocatedCents).toBe(8000); // 80.00 EUR

    const smallPurchaseTx = makeBaseTx({
      id: 'tx_small_250',
      accountId: 'acc_bank',
      amountCents: -250, // 2.50 EUR
      bookingDate: '2026-10-10',
      scope: 'personal',
      smallSpendingTagged: true,
      categoryId: 'coffee_snacks',
    });

    const env = calculatePersonalEnvelopes({
      allocation,
      transactions: [smallPurchaseTx],
      accounts: [],
      nowInstantUtc: '2026-10-10T12:00:00Z',
    });

    expect(env.spendableAllocatedCents).toBe(9400); // 94.00 EUR
    expect(env.totalPersonalNetSpentCents).toBe(250); // One economic expense of 2.50 EUR, NOT 5.00 EUR!
    expect(env.smallPurchasesRemainingCents).toBe(3750); // 37.50 EUR
    expect(env.spendableRemainingCents).toBe(9150); // 91.50 EUR
  });

  // 11. Budget 40, spending 29 -> add 2 -> 31 spent, 9 remaining, one 75% alert. Retry concurrently -> one logical event.
  it('Test 11: Budget 40, spending 29 -> add 2 -> 31 spent, 9 remaining, one 75% alert; concurrent retry -> one logical event', () => {
    const firstEval = evaluateBudgetThresholdCrossing({
      userId: USER_JARED,
      budgetId: 'small_purchases',
      budgetName: 'Compras pequeñas',
      periodKey: '2026-10',
      budgetAllocatedCents: 4000, // 40 EUR
      spentBeforeCents: 0,
      spentAfterCents: 2900, // 29 EUR (72.5% -> crosses 50%)
      existingHandledRecords: [],
      existingOutboxEvents: [],
    });
    expect(firstEval.emittedEvent?.thresholdPercent).toBe(50);

    // Now add 2 EUR (29 -> 31 EUR = 77.5% -> crosses 75%)
    const secondEval = evaluateBudgetThresholdCrossing({
      userId: USER_JARED,
      budgetId: 'small_purchases',
      budgetName: 'Compras pequeñas',
      periodKey: '2026-10',
      budgetAllocatedCents: 4000,
      spentBeforeCents: 2900,
      spentAfterCents: 3100,
      existingHandledRecords: firstEval.updatedHandledRecords,
      existingOutboxEvents: firstEval.updatedOutboxEvents,
    });

    expect(secondEval.spentAfterCents).toBe(3100);
    expect(secondEval.remainingAfterCents).toBe(900); // 9.00 EUR
    expect(secondEval.emittedEvent?.thresholdPercent).toBe(75);
    expect(secondEval.updatedOutboxEvents).toHaveLength(2); // 50% and 75%

    // Retry the exact same transition (concurrent worker / duplicate request)
    const retryEval = evaluateBudgetThresholdCrossing({
      userId: USER_JARED,
      budgetId: 'small_purchases',
      budgetName: 'Compras pequeñas',
      periodKey: '2026-10',
      budgetAllocatedCents: 4000,
      spentBeforeCents: 2900,
      spentAfterCents: 3100,
      existingHandledRecords: secondEval.updatedHandledRecords,
      existingOutboxEvents: secondEval.updatedOutboxEvents,
    });

    expect(retryEval.emittedEvent).toBeNull();
    expect(retryEval.updatedOutboxEvents).toHaveLength(2); // Still only one 75% logical event!
  });

  // 12. Budget 40, spending 19 -> add 25 -> 44, remaining -4, one highest-severity notification rather than four.
  it('Test 12: Budget 40, spending 19 -> add 25 -> 44, remaining -4, one highest-severity notification (100%) rather than four', () => {
    const jumpEval = evaluateBudgetThresholdCrossing({
      userId: USER_JARED,
      budgetId: 'small_purchases',
      budgetName: 'Compras pequeñas',
      periodKey: '2026-10',
      budgetAllocatedCents: 4000, // 40 EUR
      spentBeforeCents: 1900, // 19 EUR (47.5%)
      spentAfterCents: 4400, // 44 EUR (110% -> jumps across 50%, 75%, 90%, 100%)
      existingHandledRecords: [],
      existingOutboxEvents: [],
    });

    expect(jumpEval.spentAfterCents).toBe(4400);
    expect(jumpEval.remainingAfterCents).toBe(-400); // -4.00 EUR (never clamped to 0!)
    expect(jumpEval.updatedOutboxEvents).toHaveLength(1);
    expect(jumpEval.emittedEvent?.thresholdPercent).toBe(100);
    expect(jumpEval.emittedEvent?.lowerThresholdsCrossedAndMarkedHandled).toEqual([50, 75, 90]);
    expect(jumpEval.updatedHandledRecords).toHaveLength(4);
  });

  // 13. New budget period can emit thresholds again; app restart does not reset the old period's event history.
  it('Test 13: New budget period can emit thresholds again; app restart preserves old period history', () => {
    const octEval = evaluateBudgetThresholdCrossing({
      userId: USER_JARED,
      budgetId: 'small_purchases',
      budgetName: 'Compras pequeñas',
      periodKey: '2026-10',
      budgetAllocatedCents: 4000,
      spentBeforeCents: 0,
      spentAfterCents: 3100, // 77.5% -> 75% emitted, 50% suppressed
      existingHandledRecords: [],
      existingOutboxEvents: [],
    });

    // Simulate app restart on 2026-10: re-evaluating with persisted state emits nothing
    const octAfterRestart = evaluateBudgetThresholdCrossing({
      userId: USER_JARED,
      budgetId: 'small_purchases',
      budgetName: 'Compras pequeñas',
      periodKey: '2026-10',
      budgetAllocatedCents: 4000,
      spentBeforeCents: 3000,
      spentAfterCents: 3100,
      existingHandledRecords: octEval.updatedHandledRecords,
      existingOutboxEvents: octEval.updatedOutboxEvents,
    });
    expect(octAfterRestart.emittedEvent).toBeNull();

    // New period 2026-11 can emit 50% / 75% again!
    const novEval = evaluateBudgetThresholdCrossing({
      userId: USER_JARED,
      budgetId: 'small_purchases',
      budgetName: 'Compras pequeñas',
      periodKey: '2026-11',
      budgetAllocatedCents: 4000,
      spentBeforeCents: 0,
      spentAfterCents: 2100, // 52.5%
      existingHandledRecords: octEval.updatedHandledRecords,
      existingOutboxEvents: octEval.updatedOutboxEvents,
    });
    expect(novEval.emittedEvent?.thresholdPercent).toBe(50);
    expect(novEval.emittedEvent?.periodKey).toBe('2026-11');
  });

  // 14. Refund 5 against expense 20 -> net expense 15; income unchanged. Test cross-period policy explicitly.
  it('Test 14: Refund 5 against expense 20 -> net expense 15, income unchanged; explicit cross-period policy tested', () => {
    const salary1000 = makeBaseTx({
      id: 'tx_sal',
      accountId: 'acc_bank',
      type: 'income',
      amountCents: 100000,
      bookingDate: '2026-10-01',
    });
    const expense20 = makeBaseTx({
      id: 'tx_exp_20',
      accountId: 'acc_bank',
      type: 'expense',
      amountCents: -2000, // -20 EUR
      bookingDate: '2026-10-20',
    });
    const refund5SameMonth = makeBaseTx({
      id: 'tx_ref_5',
      accountId: 'acc_bank',
      type: 'refund',
      amountCents: 500, // +5 EUR
      bookingDate: '2026-10-25',
      linkedExpenseId: 'tx_exp_20',
    });

    const sameMonthFlow = calculateMonthlyCashFlow({
      periodKey: '2026-10',
      accounts: [],
      transactions: [salary1000, expense20, refund5SameMonth],
    });
    expect(sameMonthFlow.recognizedExternalIncomeCents).toBe(100000); // Unchanged!
    expect(sameMonthFlow.netRealExpensesCents).toBe(1500); // 20 - 5 = 15 EUR

    // Now test cross-period refund arriving in 2026-11 for the 2026-10 purchase
    const refund5NextMonth = {
      ...refund5SameMonth,
      id: 'tx_ref_nov',
      bookingDate: '2026-11-03' as const,
    };

    const novCreditCurrentPolicy = calculateMonthlyCashFlow({
      periodKey: '2026-11',
      accounts: [],
      transactions: [expense20, refund5NextMonth],
      refundPolicy: 'CREDIT_CURRENT_PERIOD',
    });
    expect(novCreditCurrentPolicy.refundsAppliedCents).toBe(500);
    expect(novCreditCurrentPolicy.crossPeriodRefundsReceivedCents).toBe(500);

    const octAdjustOriginalPolicy = calculateMonthlyCashFlow({
      periodKey: '2026-10',
      accounts: [],
      transactions: [expense20, refund5NextMonth],
      refundPolicy: 'ADJUST_ORIGINAL_PERIOD',
    });
    expect(octAdjustOriginalPolicy.netRealExpensesCents).toBe(1500);
  });

  // 15. Salary forecast does not increase current liquidity; opening balance does not increase monthly income.
  it('Test 15: Salary forecast does not increase current liquidity; opening balance does not increase monthly income', () => {
    const bankAcc = createAccount({ id: 'acc_bank', userId: USER_JARED, name: 'CaixaBank', type: 'bank' });
    const openingTx = makeBaseTx({
      id: 'tx_open',
      accountId: bankAcc.id,
      type: 'opening_balance',
      amountCents: 30000, // 300 EUR opening balance
      bookingDate: '2026-10-01',
    });

    const flow = calculateMonthlyCashFlow({
      periodKey: '2026-10',
      accounts: [bankAcc],
      transactions: [openingTx],
      plannedIncomeCents: 150000, // 1,500 EUR planned salary not yet received
    });

    expect(flow.recognizedExternalIncomeCents).toBe(0); // Opening balance & planned income excluded!
    expect(flow.plannedUnreceivedIncomeCents).toBe(150000);

    const liq = calculateEstimatedUncommittedLiquidity({
      accounts: [bankAcc],
      snapshots: [],
      transactions: [openingTx],
      obligations: [],
      savingsReservations: [],
      periodKey: '2026-10',
    });
    expect(liq.uncommittedLiquidityCents).toBe(30000); // Only the 300 EUR opening funds, NOT +1,500 forecast!
  });

  // 17. Offline operation uploaded twice -> one transaction; logout/login as another user cannot upload the first user's queue.
  it('Test 17: Offline operation uploaded twice -> one transaction; User B cannot upload User A queue; logout warns on unsynced', () => {
    let queue = enqueueOfflineExpense({
      queue: [],
      entry: {
        clientIdempotencyKey: 'idem_offline_001',
        userId: USER_JARED,
        accountId: 'acc_cash',
        amountCents: -450,
        description: 'Bocadillo offline',
        categoryId: 'coffee_snacks',
        scope: 'personal',
        smallSpendingTagged: true,
        bookingDate: '2026-10-18',
        occurredAtUtc: '2026-10-18T11:00:00Z',
        userNote: null,
      },
    });

    const logoutCheck = evaluateLogoutSafety({ activeUserId: USER_JARED, queue });
    expect(logoutCheck.canProceedWithLogout).toBe(false);
    expect(logoutCheck.unsyncedCountForUser).toBe(1);

    // User B logs in and attempts to flush the queue -> User A's item is rejected!
    const flushByOtherUser = flushOfflineQueueForUser({
      activeUserId: USER_OTHER,
      queue,
      existingTransactions: [],
    });
    expect(flushByOtherUser.uploadedCount).toBe(0);
    expect(flushByOtherUser.rejectedCrossUserCount).toBe(1);
    expect(flushByOtherUser.transactions).toHaveLength(0);

    // User A flushes twice -> only ONE transaction created!
    const flush1 = flushOfflineQueueForUser({
      activeUserId: USER_JARED,
      queue,
      existingTransactions: [],
    });
    expect(flush1.uploadedCount).toBe(1);
    expect(flush1.transactions).toHaveLength(1);

    const flush2 = flushOfflineQueueForUser({
      activeUserId: USER_JARED,
      queue: flush1.updatedQueue,
      existingTransactions: flush1.transactions,
    });
    expect(flush2.uploadedCount).toBe(0);
    expect(flush2.deduplicatedNoopCount).toBe(1);
    expect(flush2.transactions).toHaveLength(1);
  });

  // 18. Reimporting identical CSV -> no duplicate economic effect; overlapping files and partial failures handled safely + formula injection defense.
  it('Test 18: Reimporting identical CSV -> idempotent; overlapping files flagged; invalid row blocks partial silent commit; formula injection sanitized', () => {
    const csvContent = [
      'Fecha;Concepto;Importe;Moneda',
      '10/10/2026;MERCADONA COMPRA;-45,20;EUR',
      '12/10/2026;CAFETERIA SOL;-2,50;EUR',
    ].join('\n');

    const mapping = {
      dateColumnIndex: 0,
      descriptionColumnIndex: 1,
      amountColumnIndex: 2,
      currencyColumnIndex: 3,
      dateFormat: 'DD/MM/YYYY' as const,
      delimiter: ';' as const,
      hasHeaderRow: true,
    };

    const preview1 = previewCsvStatement(csvContent, mapping);
    expect(preview1.canCommit).toBe(true);

    const commit1 = commitCsvImportBatch({
      batchId: 'batch_1',
      userId: USER_JARED,
      accountId: 'acc_bank',
      preview: preview1,
      existingSources: [],
      existingTransactions: [],
    });
    expect(commit1.importedCount).toBe(2);
    expect(commit1.transactions).toHaveLength(2);

    // Reimport identical CSV -> 0 new economic transactions!
    const commitIdentical = commitCsvImportBatch({
      batchId: 'batch_2',
      userId: USER_JARED,
      accountId: 'acc_bank',
      preview: preview1,
      existingSources: commit1.sourceRecords,
      existingTransactions: commit1.transactions,
    });
    expect(commitIdentical.importedCount).toBe(0);
    expect(commitIdentical.idempotentSkippedCount).toBe(2);
    expect(commitIdentical.transactions).toHaveLength(2);

    // Overlapping CSV file (different file content/hash, containing one overlapping row and one new row)
    const overlappingCsv = [
      'Fecha;Concepto;Importe;Moneda',
      '12/10/2026;CAFETERIA SOL;-2,50;EUR',
      '14/10/2026;LIBRERIA CENTRAL;-15,00;EUR',
    ].join('\n');
    const previewOverlap = previewCsvStatement(overlappingCsv, mapping);
    const commitOverlap = commitCsvImportBatch({
      batchId: 'batch_3',
      userId: USER_JARED,
      accountId: 'acc_bank',
      preview: previewOverlap,
      existingSources: commit1.sourceRecords,
      existingTransactions: commit1.transactions,
    });
    expect(commitOverlap.duplicateReviewCount).toBe(1);

    // Rollback batch_3 restores exact state of batch_1
    const rolledBack = rollbackCsvImportBatch({
      batchId: 'batch_3',
      transactions: commitOverlap.transactions,
      sourceRecords: commitOverlap.sourceRecords,
    });
    expect(rolledBack.transactions).toHaveLength(2);

    // Partial failure in CSV must NOT silently commit valid rows
    const brokenCsv = [
      'Fecha;Concepto;Importe;Moneda',
      '10/10/2026;MERCADONA;-45,20;EUR',
      'FECHA_INVALIDA;ROTO;ABC;EUR',
    ].join('\n');
    const brokenPreview = previewCsvStatement(brokenCsv, mapping);
    expect(brokenPreview.canCommit).toBe(false);
    expect(() =>
      commitCsvImportBatch({
        batchId: 'batch_broken',
        userId: USER_JARED,
        accountId: 'acc_bank',
        preview: brokenPreview,
        existingSources: [],
        existingTransactions: [],
      })
    ).toThrow();

    // Formula injection defense on CSV export
    const maliciousTx = makeBaseTx({
      id: 'tx_formula',
      accountId: 'acc_bank',
      amountCents: -100,
      description: '=HYPERLINK("http://evil.example/leak", "Click")',
      userNote: '+SUM(A1:A10)',
    });
    const exported = exportTransactionsToSpanishCsv([maliciousTx]);
    expect(exported).toContain(`"'=HYPERLINK`);
    expect(exported).toContain(`"'+SUM(A1:A10)"`);
  });

  // 19. Reconnection maps to the same underlying account; sync pagination failure does not lose data or advance the final cursor incorrectly.
  it('Test 19: Reconnection maps to same underlying account; sync pagination failure preserves data and cursor', async () => {
    const firstConn = upsertProviderAccount([], {
      userId: USER_JARED,
      providerCode: 'enable_banking',
      providerSessionAccountId: 'session1_uid_abc',
      ibanNormalized: 'ES9121000418450200051332',
      ibanMasked: 'ES91 **** **** 1332',
      name: 'Cuenta CaixaBank',
      currency: 'EUR',
    });
    expect(firstConn.matchedExisting).toBe(false);

    // Reconnect with a new session that assigns a different `providerSessionAccountId` for the same IBAN
    const secondConn = upsertProviderAccount(firstConn.accounts, {
      userId: USER_JARED,
      providerCode: 'enable_banking',
      providerSessionAccountId: 'session2_uid_xyz',
      ibanNormalized: 'ES91 2100 0418 4502 0005 1332',
      ibanMasked: 'ES91 **** **** 1332',
      name: 'Cuenta CaixaBank',
      currency: 'EUR',
    });
    expect(secondConn.matchedExisting).toBe(true);
    expect(secondConn.accounts).toHaveLength(1);
    expect(secondConn.account.id).toBe(firstConn.account.id);
    expect(secondConn.account.providerSessionAccountId).toBe('session2_uid_xyz');

    // Now test pagination failure mid-sync
    const existingTx = makeBaseTx({
      id: 'tx_existing_safe',
      accountId: secondConn.account.id,
      amountCents: -1000,
      bookingDate: '2026-10-01',
    });

    const initialCursor = {
      connectionId: 'conn_1',
      lastSuccessfulBookingDate: '2026-10-01' as const,
      lastSuccessfulSyncUtc: '2026-10-01T12:00:00Z',
      isLocked: false,
      lastErrorSpanish: null,
    };

    const failedSync = await syncAccountPagesAtomically({
      userId: USER_JARED,
      account: secondConn.account,
      cursor: initialCursor,
      targetDateFrom: '2026-10-01',
      targetDateTo: '2026-10-20',
      isUserInitiated: false,
      existingSources: [],
      existingTransactions: [existingTx],
      fetchPage: async (continuationKey) => {
        if (continuationKey === null) {
          return {
            transactions: [
              {
                sourceExternalId: 'page1_tx',
                bookingDate: '2026-10-10',
                valueDate: '2026-10-10',
                status: 'booked',
                amountCents: -500,
                currency: 'EUR',
                originalDescription: 'Compra Pagina 1',
                counterpartyName: null,
                counterpartyIbanNormalized: null,
                remittanceInfo: null,
              },
            ],
            continuationKey: 'page_2_token',
          };
        }
        throw new Error('HTTP 502 Bad Gateway from ASPSP on Page 2');
      },
    });

    expect(failedSync.success).toBe(false);
    // Existing data preserved, partial run not committed, cursor NOT advanced to 2026-10-20!
    expect(failedSync.transactions).toEqual([existingTx]);
    expect(failedSync.updatedCursor.lastSuccessfulBookingDate).toBe('2026-10-01');
    expect(failedSync.updatedCursor.lastErrorSpanish).toContain('502');
  });

  // 20. User B cannot read, modify, export, subscribe to or reference user A's records; unauthenticated access denied.
  it('Test 20: Multi-user isolation & composite ownership enforcement; unauthenticated access denied; SSRF push endpoint check', () => {
    const jaredAccount = createAccount({ id: 'acc_jared', userId: USER_JARED, name: 'CaixaBank', type: 'bank' });

    // Unauthenticated access denied
    expect(() => enforceRowOwnership(null, jaredAccount, 'cuenta')).toThrow(UnauthenticatedAccessError);

    // User B cannot read or modify User A's row
    expect(() => enforceRowOwnership(USER_OTHER, jaredAccount, 'cuenta')).toThrow(SecurityAccessDeniedError);

    // User B cannot reference User A's account when creating a transaction (composite FK check)
    expect(() =>
      enforceCompositeReferenceOwnership({
        authenticatedUserId: USER_OTHER,
        referencedEntities: [{ id: jaredAccount.id, userId: jaredAccount.userId, kind: 'account' }],
      })
    ).toThrow(SecurityAccessDeniedError);

    // RLS filter returns 0 rows of User A to User B
    expect(filterRowsByRls(USER_OTHER, [jaredAccount])).toHaveLength(0);

    // SSRF protection on push subscription endpoints
    expect(validateSafeWebPushEndpoint('https://web.push.apple.com/QH123').valid).toBe(true);
    expect(validateSafeWebPushEndpoint('http://169.254.169.254/latest/meta-data').valid).toBe(false);
    expect(validateSafeWebPushEndpoint('https://localhost:8080/push').valid).toBe(false);
  });

  // 21. Expired/replayed/wrong-user authorization state rejected; exact institution selection (no silent imagin substitution).
  it('Test 21: Expired, replayed, and wrong-user authorization states are rejected; CaixaBank never silently substituted by imagin', async () => {
    const created = await createBoundAuthState({
      id: 'state_1',
      initiatingUserId: USER_JARED,
      aspspName: 'CaixaBank',
      aspspCountry: 'ES',
      redirectUri: 'https://stopspend.example.com/auth/bank/callback',
      allowedOrigins: ['https://stopspend.example.com'],
      nowUtc: '2026-10-30T10:00:00Z',
      ttlSeconds: 600, // expires at 10:10:00Z
    });

    // Wrong user rejected
    await expect(
      validateAndConsumeAuthStateCallback({
        rawStateFromQuery: created.rawState,
        codeFromQuery: 'auth_code_123',
        storedRecords: [created.record],
        authenticatedCallbackUserId: USER_OTHER,
        nowUtc: '2026-10-30T10:02:00Z',
      })
    ).rejects.toThrow(/otro usuario/i);

    // Expired state rejected
    await expect(
      validateAndConsumeAuthStateCallback({
        rawStateFromQuery: created.rawState,
        codeFromQuery: 'auth_code_123',
        storedRecords: [created.record],
        authenticatedCallbackUserId: USER_JARED,
        nowUtc: '2026-10-30T10:15:00Z',
      })
    ).rejects.toThrow(/caducado/i);

    // Valid consumption succeeds and strips sensitive query params
    const valid = await validateAndConsumeAuthStateCallback({
      rawStateFromQuery: created.rawState,
      codeFromQuery: 'auth_code_123',
      storedRecords: [created.record],
      authenticatedCallbackUserId: USER_JARED,
      nowUtc: '2026-10-30T10:05:00Z',
      currentCallbackUrl: 'https://stopspend.example.com/auth/bank/callback?code=auth_code_123&state=secret',
    });
    expect(valid.sanitizedBrowserPath).toBe('/auth/bank/callback');

    // Replay of already consumed state rejected!
    await expect(
      validateAndConsumeAuthStateCallback({
        rawStateFromQuery: created.rawState,
        codeFromQuery: 'auth_code_123',
        storedRecords: valid.updatedRecords,
        authenticatedCallbackUserId: USER_JARED,
        nowUtc: '2026-10-30T10:06:00Z',
      })
    ).rejects.toThrow(/ya fue utilizado/i);

    // Institution check: if only imagin is returned, never silently substitute for CaixaBank
    expect(() =>
      selectExactInstitution([{ name: 'imagin', country: 'ES' }], 'CaixaBank', 'ES')
    ).toThrow(/Nunca se sustituye silenciosamente/i);
  });

  // 22. No provider configuration -> manual/CSV paths work and no fake bank status appears.
  it('Test 22: No provider configuration -> status is "Sin configurar", never fake connected', () => {
    const badge = resolveBankConnectionStatusBadge({
      mode: 'unconfigured',
      hasValidSession: false,
      hasSuccessfulRealRead: false,
    });
    expect(badge.state).toBe('unconfigured');
    expect(badge.badgeTextSpanish).toBe('Sin configurar');

    // Even in production mode, if no real read has succeeded yet, never show connected!
    const prodPending = resolveBankConnectionStatusBadge({
      mode: 'production',
      hasValidSession: true,
      hasSuccessfulRealRead: false,
    });
    expect(prodPending.state).toBe('production_awaiting_auth');
  });

  // 23. Missing opening funds -> liquidity unknown, not zero or an invented balance; budgets still work.
  it('Test 23: Missing opening funds -> liquidity is null ("Desconocido"), not 0; budgets and simulator still work with disclosure', () => {
    const bankAcc = createAccount({ id: 'acc_bank', userId: USER_JARED, name: 'CaixaBank', type: 'bank' });
    const expense10 = makeBaseTx({
      id: 'tx_10',
      accountId: bankAcc.id,
      amountCents: -1000,
      bookingDate: '2026-10-10',
    });

    const liq = calculateEstimatedUncommittedLiquidity({
      accounts: [bankAcc],
      snapshots: [], // No snapshot and no opening_balance!
      transactions: [expense10],
      obligations: [],
      savingsReservations: [],
      periodKey: '2026-10',
    });

    expect(liq.uncommittedLiquidityCents).toBeNull();
    expect(formatEur(liq.uncommittedLiquidityCents)).toBe('Desconocido');

    const allocation = createBudgetAllocation({
      id: 'bud_oct',
      userId: USER_JARED,
      periodKey: '2026-10',
      confirmedByUser: true,
      protectedSavingsAllocatedCents: 8000,
      smallPurchasesAllocatedCents: 4000,
      flexibleSpendingAllocatedCents: 5400,
    });

    const env = calculatePersonalEnvelopes({
      allocation,
      transactions: [expense10],
      accounts: [bankAcc],
      nowInstantUtc: '2026-10-10T12:00:00Z',
    });
    expect(env.spendableRemainingCents).toBe(8400); // Budgets work!

    const sim = simulatePurchase({
      amountCents: 500,
      envelopeTarget: 'small_purchases',
      envelopes: env,
      liquidity: liq,
    });
    expect(sim.verdict).toBe('WITHIN_BUDGET_STALE_OR_UNKNOWN_LIQUIDITY');
    expect(sim.liquidityAfterCents).toBeNull();
  });

  // 24. Madrid month boundaries, daylight-saving changes, zero budgets, negative remaining balances, split transactions and period rollover policy.
  it('Test 24: Madrid month boundary & DST change (2026-10-25), zero budget, negative balance, split transactions & rollover', () => {
    // 2026-10-31T23:30:00Z is already 2026-11-01 00:30:00 in Europe/Madrid (CET UTC+1)!
    const boundaryParts = getMadridDateParts('2026-10-31T23:30:00Z');
    expect(boundaryParts.calendarDate).toBe('2026-11-01');
    expect(boundaryParts.periodKey).toBe('2026-11');

    // Autumn DST switch day in Madrid: 2026-10-25 (switches from CEST UTC+2 to CET UTC+1)
    expect(isWithinMadridQuietHours('2026-10-25T00:30:00Z', 22, 8)).toBe(true); // 02:30 local
    expect(isWithinMadridQuietHours('2026-10-25T10:00:00Z', 22, 8)).toBe(false); // 11:00 local

    // Remaining days in October on 2026-10-30 in Madrid -> 2 days (Oct 30 and Oct 31)
    const remDays = getRemainingCalendarDaysInPeriod('2026-10', '2026-10-30T12:00:00Z');
    expect(remDays.totalDaysInMonth).toBe(31);
    expect(remDays.remainingDaysIncludingToday).toBe(2);

    // Split transaction where 10 EUR supermarket receipt has 3 EUR personal small purchase + 7 EUR household non-personal
    const splitTx = makeBaseTx({
      id: 'tx_split_supermarket',
      accountId: 'acc_bank',
      amountCents: -1000, // -10.00 EUR total receipt
      bookingDate: '2026-10-15',
      scope: 'mixed',
      splits: validateSplitsForTransaction(-1000, [
        {
          id: 'sp_1',
          label: 'Refresco personal',
          amountCents: 300, // 3.00 EUR personal small purchase
          categoryId: 'coffee_snacks',
          scope: 'personal',
          smallSpendingTagged: true,
        },
        {
          id: 'sp_2',
          label: 'Compra hogar compartida',
          amountCents: 700, // 7.00 EUR non-personal
          categoryId: 'groceries',
          scope: 'non_personal',
          smallSpendingTagged: false,
        },
      ]),
    });

    // Zero budget & rollover policy test
    const zeroAllocWithRollover = createBudgetAllocation({
      id: 'bud_zero',
      userId: USER_JARED,
      periodKey: '2026-10',
      confirmedByUser: true,
      protectedSavingsAllocatedCents: 0,
      smallPurchasesAllocatedCents: 0,
      flexibleSpendingAllocatedCents: 0,
      rolloverFromPreviousCents: 200, // +2.00 EUR rollover
    });

    const env = calculatePersonalEnvelopes({
      allocation: zeroAllocWithRollover,
      transactions: [splitTx],
      accounts: [],
      nowInstantUtc: '2026-10-15T12:00:00Z',
    });

    // Only the 3.00 EUR personal split is charged to personal budget (never the 7.00 EUR household split, and never 10 + 3 = 13!)
    expect(env.totalPersonalNetSpentCents).toBe(300);
    expect(env.smallPurchasesNetSpentCents).toBe(300);
    // Rollover 2.00 EUR minus 3.00 EUR personal spend = -1.00 EUR (-100 cents, negative balance preserved!)
    expect(env.spendableRemainingCents).toBe(-100);
    expect(env.smallPurchasesUsedPercent).toBeNull(); // Zero base allocation -> null percent, no division by zero!
  });
});
