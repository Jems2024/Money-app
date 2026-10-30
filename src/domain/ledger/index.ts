import { assertValidCents, assertValidCurrency, Cents, sumCents, subtractCents, addCents } from '../money';
import { assertValidCalendarDate, CalendarDateISO } from '../dates/madrid';
import {
  Account,
  AccountType,
  CanonicalTransaction,
  TransactionSplit,
} from './types';

export * from './types';

export class LedgerInvariantError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LedgerInvariantError';
    this.code = code;
  }
}

/**
 * Creates a validated Account. Credit card liabilities (`credit_card`) can NEVER have
 * `includeInLiquidity: true`.
 */
export function createAccount(params: {
  id: string;
  userId: string;
  name: string;
  type: AccountType;
  currency?: string;
  includeInLiquidity?: boolean;
  isOwned?: boolean;
  stableIdentityKey?: string | null;
  providerCode?: string | null;
  providerSessionAccountId?: string | null;
  ibanMasked?: string | null;
  createdAtUtc?: string;
}): Account {
  const currency = params.currency ?? 'EUR';
  assertValidCurrency(currency);

  const includeInLiquidity =
    params.type === 'credit_card'
      ? false // Invariant: credit liabilities must never be treated as cash available to spend
      : params.includeInLiquidity ?? (params.type === 'cash' || params.type === 'bank');

  if (params.type === 'credit_card' && params.includeInLiquidity === true) {
    throw new LedgerInvariantError(
      'CREDIT_LIABILITY_LIQUIDITY_FORBIDDEN',
      'El límite o saldo de una tarjeta de crédito no puede tratarse como liquidez disponible para gastar.'
    );
  }

  return {
    id: params.id,
    userId: params.userId,
    name: params.name.trim(),
    type: params.type,
    currency,
    includeInLiquidity,
    isOwned: params.isOwned ?? true,
    stableIdentityKey: params.stableIdentityKey ?? null,
    providerCode: params.providerCode ?? null,
    providerSessionAccountId: params.providerSessionAccountId ?? null,
    ibanMasked: params.ibanMasked ?? null,
    createdAtUtc: params.createdAtUtc ?? new Date().toISOString(),
  };
}

/**
 * Reconciles a provider-returned account on connection or reconnection.
 * Uses `stableIdentityKey` (e.g., `enable_banking:ES9121000418450200051332`) so that
 * when a new session assigns a new `providerSessionAccountId`, it updates the existing
 * app `Account` instead of duplicating it.
 */
export function upsertProviderAccount(
  existingAccounts: readonly Account[],
  incoming: {
    userId: string;
    providerCode: string;
    providerSessionAccountId: string;
    ibanNormalized: string;
    ibanMasked: string;
    name: string;
    type?: AccountType;
    currency: string;
    nowUtc?: string;
  }
): { accounts: Account[]; matchedExisting: boolean; account: Account } {
  assertValidCurrency(incoming.currency);
  const stableKey = `${incoming.providerCode.toLowerCase()}:${incoming.ibanNormalized.replace(/\s+/g, '').toUpperCase()}`;

  const existingIndex = existingAccounts.findIndex(
    (a) =>
      a.userId === incoming.userId &&
      ((a.stableIdentityKey !== null && a.stableIdentityKey === stableKey) ||
        (a.providerCode === incoming.providerCode &&
          a.providerSessionAccountId === incoming.providerSessionAccountId))
  );

  if (existingIndex !== -1) {
    const current = existingAccounts[existingIndex]!;
    const updated: Account = {
      ...current,
      providerSessionAccountId: incoming.providerSessionAccountId,
      stableIdentityKey: stableKey,
      ibanMasked: incoming.ibanMasked,
    };
    const next = [...existingAccounts];
    next[existingIndex] = updated;
    return { accounts: next, matchedExisting: true, account: updated };
  }

  const created = createAccount({
    id: `acc_${incoming.providerCode}_${existingAccounts.length + 1}`,
    userId: incoming.userId,
    name: incoming.name,
    type: incoming.type ?? 'bank',
    currency: incoming.currency,
    stableIdentityKey: stableKey,
    providerCode: incoming.providerCode,
    providerSessionAccountId: incoming.providerSessionAccountId,
    ibanMasked: incoming.ibanMasked,
    createdAtUtc: incoming.nowUtc,
  });

  return {
    accounts: [...existingAccounts, created],
    matchedExisting: false,
    account: created,
  };
}

/**
 * Validates that splits sum to the exact absolute magnitude of the parent transaction.
 * Prevents counting parent + children together and rejects mismatched split sums.
 */
export function validateSplitsForTransaction(
  parentSignedAmountCents: Cents,
  splits: readonly TransactionSplit[]
): TransactionSplit[] {
  assertValidCents(parentSignedAmountCents);
  if (splits.length === 0) {
    return [];
  }

  const parentMagnitude = Math.abs(parentSignedAmountCents);
  for (const s of splits) {
    assertValidCents(s.amountCents);
    if (s.amountCents <= 0) {
      throw new LedgerInvariantError(
        'INVALID_SPLIT_AMOUNT',
        `Cada línea de desglose (split) debe tener un importe positivo > 0 céntimos.`
      );
    }
  }

  const totalSplitMagnitude = sumCents(splits.map((s) => s.amountCents));
  if (totalSplitMagnitude !== parentMagnitude) {
    throw new LedgerInvariantError(
      'SPLIT_SUM_MISMATCH',
      `La suma del desglose (${totalSplitMagnitude} céntimos) no cuadra con el importe de la transacción (${parentMagnitude} céntimos).`
    );
  }

  return [...splits];
}

/**
 * Returns the personal-scope gross spending (positive cents) or refund credit (negative cents)
 * contributed by a canonical transaction.
 * - Superseded transactions contribute 0 (never double-counted).
 * - Internal transfers, opening balances, and non-personal transactions contribute 0 to personal spending.
 * - If splits exist, ONLY the splits are summed (parent is never added on top of splits).
 */
export function getPersonalNetSpendImpactCents(tx: CanonicalTransaction): {
  personalGrossExpenseCents: Cents;
  personalRefundCreditCents: Cents;
  smallPurchaseGrossCents: Cents;
  byCategoryNetCents: Record<string, Cents>;
} {
  if (tx.status === 'superseded') {
    return {
      personalGrossExpenseCents: 0,
      personalRefundCreditCents: 0,
      smallPurchaseGrossCents: 0,
      byCategoryNetCents: {},
    };
  }

  if (tx.type === 'expense') {
    const magnitude = Math.abs(tx.amountCents);
    if (tx.splits.length > 0) {
      validateSplitsForTransaction(tx.amountCents, tx.splits);
      let personalGross = 0;
      let smallGross = 0;
      const byCat: Record<string, Cents> = {};
      for (const split of tx.splits) {
        if (split.scope === 'personal') {
          personalGross = addCents(personalGross, split.amountCents);
          if (split.smallSpendingTagged) {
            smallGross = addCents(smallGross, split.amountCents);
          }
          byCat[split.categoryId] = addCents(byCat[split.categoryId] ?? 0, split.amountCents);
        }
      }
      return {
        personalGrossExpenseCents: personalGross,
        personalRefundCreditCents: 0,
        smallPurchaseGrossCents: smallGross,
        byCategoryNetCents: byCat,
      };
    }

    if (tx.scope !== 'personal') {
      return {
        personalGrossExpenseCents: 0,
        personalRefundCreditCents: 0,
        smallPurchaseGrossCents: 0,
        byCategoryNetCents: {},
      };
    }

    const catKey = tx.categoryId ?? 'uncategorized';
    return {
      personalGrossExpenseCents: magnitude,
      personalRefundCreditCents: 0,
      smallPurchaseGrossCents: tx.smallSpendingTagged ? magnitude : 0,
      byCategoryNetCents: { [catKey]: magnitude },
    };
  }

  if (tx.type === 'refund') {
    const magnitude = Math.abs(tx.amountCents);
    if (tx.scope !== 'personal' && tx.splits.length === 0) {
      return {
        personalGrossExpenseCents: 0,
        personalRefundCreditCents: 0,
        smallPurchaseGrossCents: 0,
        byCategoryNetCents: {},
      };
    }
    const catKey = tx.categoryId ?? 'uncategorized';
    return {
      personalGrossExpenseCents: 0,
      personalRefundCreditCents: magnitude,
      smallPurchaseGrossCents: tx.smallSpendingTagged ? -magnitude : 0,
      byCategoryNetCents: { [catKey]: -magnitude },
    };
  }

  return {
    personalGrossExpenseCents: 0,
    personalRefundCreditCents: 0,
    smallPurchaseGrossCents: 0,
    byCategoryNetCents: {},
  };
}

/**
 * Records a cash salary payment into the user's cash account (`type: 'income'`),
 * and optionally a linked cash-to-bank deposit (`type: 'internal_transfer'`).
 *
 * Section 5 invariant:
 * - Cash salary is external income into the cash account.
 * - Cash deposited into the bank is a linked cash-to-bank transfer (two legs sharing `transferPairId`).
 * - If a cash deposit into the bank occurs when no sufficient recorded cash exists and the user
 *   has not confirmed its origin, it is NOT invented as a second salary: it is flagged
 *   with `type: 'unknown'` and `reviewStatus: 'requires_deposit_origin_review'`.
 */
export function recordCashDepositIntoBank(params: {
  idPrefix: string;
  userId: string;
  cashAccountId: string;
  bankAccountId: string;
  amountCents: Cents;
  bookingDate: CalendarDateISO;
  currentTrackedCashBalanceCents: Cents | null;
  confirmedOrigin?: 'from_tracked_cash' | 'from_prior_untracked_cash' | 'new_external_income' | 'unconfirmed';
  description?: string;
}): {
  transactions: CanonicalTransaction[];
  requiresUserReview: boolean;
  reviewPromptSpanish: string | null;
} {
  assertValidCents(params.amountCents);
  if (params.amountCents <= 0) {
    throw new LedgerInvariantError('INVALID_DEPOSIT_AMOUNT', 'El importe del ingreso en efectivo debe ser positivo.');
  }
  assertValidCalendarDate(params.bookingDate);

  const origin = params.confirmedOrigin ?? 'unconfirmed';
  const hasEnoughTrackedCash =
    params.currentTrackedCashBalanceCents !== null &&
    params.currentTrackedCashBalanceCents >= params.amountCents;

  // Case 1: Sufficient tracked cash exists and user either confirmed 'from_tracked_cash'
  // or deposited within tracked cash balance.
  if (origin === 'from_tracked_cash' && hasEnoughTrackedCash) {
    const pairId = `${params.idPrefix}_pair`;
    const cashOutLeg: CanonicalTransaction = {
      id: `${params.idPrefix}_cash_out`,
      userId: params.userId,
      accountId: params.cashAccountId,
      type: 'internal_transfer',
      status: 'booked',
      amountCents: -params.amountCents,
      currency: 'EUR',
      bookingDate: params.bookingDate,
      valueDate: params.bookingDate,
      occurredAtUtc: null,
      createdAtUtc: new Date().toISOString(),
      description: params.description ?? 'Traspaso de efectivo a cuenta bancaria',
      merchantNormalized: 'TRASPASO EFECTIVO BANCO',
      userNote: null,
      categoryId: 'internal_transfer',
      categorySource: 'user_locked',
      categoryConfidence: 100,
      categoryExplanation: 'Ingreso en cajero vinculado a efectivo registrado',
      scope: 'non_personal',
      smallSpendingTagged: false,
      splits: [],
      linkedExpenseId: null,
      transferPairId: pairId,
      counterpartAccountId: params.bankAccountId,
      untrackedOwnedDestinationLabel: null,
      settledObligationId: null,
      consumedSavingsReservationId: null,
      supersededByTransactionId: null,
      reviewStatus: 'none',
      sourceRecordIds: [],
    };

    const bankInLeg: CanonicalTransaction = {
      ...cashOutLeg,
      id: `${params.idPrefix}_bank_in`,
      accountId: params.bankAccountId,
      amountCents: params.amountCents,
      counterpartAccountId: params.cashAccountId,
    };

    return {
      transactions: [cashOutLeg, bankInLeg],
      requiresUserReview: false,
      reviewPromptSpanish: null,
    };
  }

  // Case 2: User explicitly confirmed it was previously held cash before tracking started
  if (origin === 'from_prior_untracked_cash') {
    const adjustmentTx: CanonicalTransaction = {
      id: `${params.idPrefix}_prior_cash_opening`,
      userId: params.userId,
      accountId: params.bankAccountId,
      type: 'opening_balance',
      status: 'booked',
      amountCents: params.amountCents,
      currency: 'EUR',
      bookingDate: params.bookingDate,
      valueDate: params.bookingDate,
      occurredAtUtc: null,
      createdAtUtc: new Date().toISOString(),
      description: params.description ?? 'Ingreso de efectivo previo (ahorro en mano anterior)',
      merchantNormalized: 'EFECTIVO PREVIO',
      userNote: null,
      categoryId: 'opening_balance',
      categorySource: 'user_locked',
      categoryConfidence: 100,
      categoryExplanation: 'Confirmado por el usuario como efectivo previo; no computa como ingreso del mes',
      scope: 'non_personal',
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
    return {
      transactions: [adjustmentTx],
      requiresUserReview: false,
      reviewPromptSpanish: null,
    };
  }

  // Case 3: User explicitly confirmed it is new external income not previously recorded in cash
  if (origin === 'new_external_income') {
    const incomeTx: CanonicalTransaction = {
      id: `${params.idPrefix}_confirmed_income`,
      userId: params.userId,
      accountId: params.bankAccountId,
      type: 'income',
      status: 'booked',
      amountCents: params.amountCents,
      currency: 'EUR',
      bookingDate: params.bookingDate,
      valueDate: params.bookingDate,
      occurredAtUtc: null,
      createdAtUtc: new Date().toISOString(),
      description: params.description ?? 'Ingreso externo confirmado en cuenta',
      merchantNormalized: 'INGRESO EXTERNO CONFIRMADO',
      userNote: null,
      categoryId: 'income',
      categorySource: 'user_locked',
      categoryConfidence: 100,
      categoryExplanation: 'Confirmado por el usuario como nuevo ingreso externo',
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
    return {
      transactions: [incomeTx],
      requiresUserReview: false,
      reviewPromptSpanish: null,
    };
  }

  // Case 4: Unconfirmed deposit or insufficient tracked cash -> NEVER invent a missing salary!
  const unreviewedTx: CanonicalTransaction = {
    id: `${params.idPrefix}_unverified_deposit`,
    userId: params.userId,
    accountId: params.bankAccountId,
    type: 'unknown',
    status: 'booked',
    amountCents: params.amountCents,
    currency: 'EUR',
    bookingDate: params.bookingDate,
    valueDate: params.bookingDate,
    occurredAtUtc: null,
    createdAtUtc: new Date().toISOString(),
    description: params.description ?? 'Ingreso en efectivo pendiente de clasificar origen',
    merchantNormalized: 'INGRESO EFECTIVO PENDIENTE',
    userNote: null,
    categoryId: null,
    categorySource: 'unknown',
    categoryConfidence: 0,
    categoryExplanation: 'Requiere confirmar si procede de nómina en efectivo ya anotada, efectivo previo o nuevo ingreso.',
    scope: 'non_personal',
    smallSpendingTagged: false,
    splits: [],
    linkedExpenseId: null,
    transferPairId: null,
    counterpartAccountId: null,
    untrackedOwnedDestinationLabel: null,
    settledObligationId: null,
    consumedSavingsReservationId: null,
    supersededByTransactionId: null,
    reviewStatus: 'requires_deposit_origin_review',
    sourceRecordIds: [],
  };

  return {
    transactions: [unreviewedTx],
    requiresUserReview: true,
    reviewPromptSpanish:
      '¿De dónde procede este ingreso en efectivo? (1) Nómina/ingreso en mano ya registrado, (2) Efectivo guardado con anterioridad, o (3) Nuevo ingreso externo aún no registrado.',
  };
}

/**
 * Computes account balances purely from ledger entries when starting from an opening/snapshot balance,
 * ensuring credit card payments (`credit_card_bill_payment`) do not double-count already imported card purchases.
 */
export function computeLedgerAccountBalanceCents(
  accountId: string,
  transactions: readonly CanonicalTransaction[],
  openingOrSnapshotCents: Cents | null = 0
): Cents | null {
  if (openingOrSnapshotCents === null) {
    return null;
  }
  let balance = assertValidCents(openingOrSnapshotCents);
  for (const tx of transactions) {
    if (tx.accountId !== accountId || tx.status === 'superseded') {
      continue;
    }
    // If openingOrSnapshotCents is already passed separately, skip `opening_balance` only if caller folded it,
    // Here openingOrSnapshotCents defaults to 0 so `opening_balance` transactions add naturally.
    balance = subtractCents(addCents(balance, tx.amountCents), 0);
  }
  return balance;
}
