import { diffCalendarDays } from '../dates/madrid';
import {
  Account,
  CanonicalTransaction,
  ReconciliationAuditLink,
  SourceRecord,
} from '../ledger';

export function normalizeMerchantText(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function merchantsAreCompatible(a: string, b: string): boolean {
  const na = normalizeMerchantText(a);
  const nb = normalizeMerchantText(b);
  if (!na || !nb) {
    return true;
  }
  if (na === nb || na.includes(nb) || nb.includes(na)) {
    return true;
  }
  const tokensA = na.split(' ').filter((t) => t.length >= 3);
  const tokensB = new Set(nb.split(' ').filter((t) => t.length >= 3));
  return tokensA.some((t) => tokensB.has(t));
}

export interface IngestSourceRecordResult {
  transactions: CanonicalTransaction[];
  sourceRecords: SourceRecord[];
  auditLinks: ReconciliationAuditLink[];
  action:
    | 'idempotent_noop'
    | 'reconciled_provisional_manual'
    | 'reconciled_pending_to_booked'
    | 'created_new_canonical'
    | 'flagged_duplicate_review';
  canonicalTransaction: CanonicalTransaction;
}

/**
 * Ingests an incoming bank/CSV `SourceRecord` and reconciles it against existing
 * source records and canonical transactions for the same account.
 *
 * Guarantees:
 * 1. Exact `(accountId, providerCode, sourceExternalId, status)` match -> idempotent no-op.
 * 2. Manual provisional bank expense (`2,50 €`) followed by matching bank record -> merges into
 *    ONE canonical expense (`2,50 €`), preserving user category, notes, scope & tags, and creates
 *    a reversible `ReconciliationAuditLink` (Acceptance Test 4).
 * 3. Two distinct bank records on the same date for the same merchant and amount (`2,50 €` + `2,50 €`
 *    with distinct `sourceExternalId` or from the same batch) -> BOTH retained as valid expenses
 *    (Acceptance Test 5).
 * 4. Pending authorization (`20,00 €`) becoming booked (`22,00 €`) -> supersedes the `20,00 €`
 *    pending transaction and leaves ONE final booked expense of `22,00 €` (Acceptance Test 6).
 */
export function ingestAndReconcileSourceRecord(params: {
  incomingSource: SourceRecord;
  existingSources: readonly SourceRecord[];
  existingTransactions: readonly CanonicalTransaction[];
  existingAuditLinks: readonly ReconciliationAuditLink[];
  ownedAccounts?: readonly Account[];
  defaultScope?: CanonicalTransaction['scope'];
  defaultCategoryId?: string | null;
}): IngestSourceRecordResult {
  const { incomingSource } = params;

  // 1. Check strict provider/batch idempotency key first
  if (incomingSource.sourceExternalId !== null) {
    const existingSameSource = params.existingSources.find(
      (s) =>
        s.accountId === incomingSource.accountId &&
        s.sourceType === incomingSource.sourceType &&
        s.providerCode === incomingSource.providerCode &&
        s.sourceExternalId === incomingSource.sourceExternalId
    );

    if (existingSameSource) {
      const linkedTx = params.existingTransactions.find((tx) =>
        tx.sourceRecordIds.includes(existingSameSource.id) && tx.status !== 'superseded'
      );

      // If existing source was 'pending' and incoming with same external ID is now 'booked',
      // transition it via pending-to-booked below!
      if (existingSameSource.status === incomingSource.status && linkedTx) {
        return {
          transactions: [...params.existingTransactions],
          sourceRecords: [...params.existingSources],
          auditLinks: [...params.existingAuditLinks],
          action: 'idempotent_noop',
          canonicalTransaction: linkedTx,
        };
      }
    }
  }

  // 2. Check Pending-to-Booked reconciliation (Acceptance Test 6)
  // Matches either by same `sourceExternalId` transitioning from pending -> booked,
  // or by candidate matching (same account, pending status, compatible merchant, 0..7 days window,
  // and exact amount or pre-authorization settlement within 25% tolerance).
  if (incomingSource.status === 'booked' && incomingSource.amountCents < 0) {
    const pendingCandidates = params.existingTransactions.filter((tx) => {
      if (
        tx.accountId !== incomingSource.accountId ||
        tx.status !== 'pending' ||
        tx.amountCents >= 0
      ) {
        return false;
      }

      // Check if they share the same external provider ID
      const sharesExternalId =
        incomingSource.sourceExternalId !== null &&
        tx.sourceRecordIds.some((sid) => {
          const src = params.existingSources.find((s) => s.id === sid);
          return src && src.sourceExternalId === incomingSource.sourceExternalId;
        });
      if (sharesExternalId) {
        return true;
      }

      const dayDiff = diffCalendarDays(incomingSource.bookingDate, tx.bookingDate);
      if (dayDiff < -1 || dayDiff > 7) {
        return false;
      }
      if (!merchantsAreCompatible(incomingSource.originalDescription, tx.description)) {
        return false;
      }

      const pendingAbs = Math.abs(tx.amountCents);
      const bookedAbs = Math.abs(incomingSource.amountCents);
      const maxDelta = Math.max(500, Math.round(pendingAbs * 0.25)); // Up to 25% or 5 EUR pre-auth delta
      return Math.abs(bookedAbs - pendingAbs) <= maxDelta;
    });

    if (pendingCandidates.length === 1) {
      const pendingTx = pendingCandidates[0]!;
      const supersededPending: CanonicalTransaction = {
        ...pendingTx,
        status: 'superseded',
        supersededByTransactionId: `tx_${incomingSource.id}`,
      };

      const bookedCanonical: CanonicalTransaction = {
        ...pendingTx,
        id: `tx_${incomingSource.id}`,
        status: 'booked',
        amountCents: incomingSource.amountCents,
        bookingDate: incomingSource.bookingDate,
        valueDate: incomingSource.valueDate,
        // Preserve user's category, note, scope, and small-spending tag!
        categoryId: pendingTx.categoryId ?? params.defaultCategoryId ?? null,
        userNote: pendingTx.userNote,
        scope: pendingTx.scope,
        smallSpendingTagged: pendingTx.smallSpendingTagged,
        sourceRecordIds: [...pendingTx.sourceRecordIds, incomingSource.id],
        supersededByTransactionId: null,
      };

      const auditLink: ReconciliationAuditLink = {
        id: `audit_p2b_${incomingSource.id}`,
        userId: incomingSource.userId,
        linkType: 'pending_to_booked',
        fromTransactionId: pendingTx.id,
        toTransactionId: bookedCanonical.id,
        previousAmountCents: pendingTx.amountCents,
        newAmountCents: bookedCanonical.amountCents,
        preservedCategoryId: pendingTx.categoryId,
        preservedUserNote: pendingTx.userNote,
        reversible: true,
        createdAtUtc: new Date().toISOString(),
        reason: 'Autorización pendiente asentada por el banco (actualización atómica de importe y estado).',
      };

      const updatedTransactions = params.existingTransactions.map((t) =>
        t.id === pendingTx.id ? supersededPending : t
      );
      updatedTransactions.push(bookedCanonical);

      return {
        transactions: updatedTransactions,
        sourceRecords: [...params.existingSources, incomingSource],
        auditLinks: [...params.existingAuditLinks, auditLink],
        action: 'reconciled_pending_to_booked',
        canonicalTransaction: bookedCanonical,
      };
    }
  }

  // 3. Check Provisional Manual Entry -> Imported Bank/CSV Record reconciliation (Acceptance Test 4)
  const provisionalManualCandidates = params.existingTransactions.filter((tx) => {
    if (
      tx.accountId !== incomingSource.accountId ||
      tx.status !== 'provisional' ||
      tx.amountCents !== incomingSource.amountCents
    ) {
      return false;
    }
    const dayDiff = Math.abs(diffCalendarDays(incomingSource.bookingDate, tx.bookingDate));
    return dayDiff <= 4;
  });

  if (provisionalManualCandidates.length === 1) {
    const manualTx = provisionalManualCandidates[0]!;
    const supersededManual: CanonicalTransaction = {
      ...manualTx,
      status: 'superseded',
      supersededByTransactionId: `tx_${incomingSource.id}`,
    };

    const reconciledTx: CanonicalTransaction = {
      ...manualTx,
      id: `tx_${incomingSource.id}`,
      status: incomingSource.status,
      bookingDate: incomingSource.bookingDate,
      valueDate: incomingSource.valueDate,
      // Keep original manual occurredAtUtc if user entered it, or null if bank only
      occurredAtUtc: manualTx.occurredAtUtc,
      // Preserve user's confirmed category, note, splits, scope, and small-spending tag!
      categoryId: manualTx.categoryId ?? params.defaultCategoryId ?? null,
      categorySource: manualTx.categoryId ? 'user_locked' : manualTx.categorySource,
      userNote: manualTx.userNote,
      scope: manualTx.scope,
      smallSpendingTagged: manualTx.smallSpendingTagged,
      splits: manualTx.splits,
      sourceRecordIds: [...manualTx.sourceRecordIds, incomingSource.id],
      supersededByTransactionId: null,
      reviewStatus: 'none',
    };

    const auditLink: ReconciliationAuditLink = {
      id: `audit_m2b_${incomingSource.id}`,
      userId: incomingSource.userId,
      linkType: 'provisional_to_bank',
      fromTransactionId: manualTx.id,
      toTransactionId: reconciledTx.id,
      previousAmountCents: manualTx.amountCents,
      newAmountCents: reconciledTx.amountCents,
      preservedCategoryId: manualTx.categoryId,
      preservedUserNote: manualTx.userNote,
      reversible: true,
      createdAtUtc: new Date().toISOString(),
      reason: 'Gasto manual provisional conciliado con registro bancario importado.',
    };

    const updatedTransactions = params.existingTransactions.map((t) =>
      t.id === manualTx.id ? supersededManual : t
    );
    updatedTransactions.push(reconciledTx);

    return {
      transactions: updatedTransactions,
      sourceRecords: [...params.existingSources, incomingSource],
      auditLinks: [...params.existingAuditLinks, auditLink],
      action: 'reconciled_provisional_manual',
      canonicalTransaction: reconciledTx,
    };
  }

  // 4. If multiple provisional candidates match ambiguously, or if an overlapping CSV import
  // without stable bank external IDs matches an existing transaction from a DIFFERENT import batch,
  // check whether it's a valid second same-day purchase (Acceptance Test 5) vs ambiguous overlap.
  let reviewStatus: CanonicalTransaction['reviewStatus'] = 'none';
  if (provisionalManualCandidates.length > 1) {
    reviewStatus = 'requires_duplicate_review';
  } else if (incomingSource.sourceType === 'csv') {
    // If another CSV batch (different importBatchId) already imported the exact same date, amount, and description,
    // flag as candidate duplicate for user review (do NOT silently drop and do NOT silently show green certainty).
    // However, two rows within the SAME import batch or with distinct provider external IDs are distinct real purchases!
    const crossBatchMatch = params.existingSources.some(
      (s) =>
        s.accountId === incomingSource.accountId &&
        s.sourceType === 'csv' &&
        s.importBatchId !== null &&
        incomingSource.importBatchId !== null &&
        s.importBatchId !== incomingSource.importBatchId &&
        s.bookingDate === incomingSource.bookingDate &&
        s.amountCents === incomingSource.amountCents &&
        s.originalDescription.trim() === incomingSource.originalDescription.trim()
    );
    if (crossBatchMatch) {
      reviewStatus = 'requires_duplicate_review';
    }
  }

  // 5. Determine canonical transaction type (avoiding automatic internal transfer classification
  // unless counterpart IBAN belongs to a verified owned account)
  let txType: CanonicalTransaction['type'] =
    incomingSource.amountCents < 0 ? 'expense' : 'income';

  if (incomingSource.counterpartyIbanNormalized && params.ownedAccounts) {
    const cleanCounterparty = incomingSource.counterpartyIbanNormalized
      .replace(/\s+/g, '')
      .toUpperCase();
    const matchesOwnedAccount = params.ownedAccounts.some(
      (acc) =>
        acc.isOwned &&
        acc.stableIdentityKey !== null &&
        acc.stableIdentityKey.toUpperCase().endsWith(cleanCounterparty)
    );
    if (matchesOwnedAccount) {
      txType = 'internal_transfer';
    }
  }

  const newCanonical: CanonicalTransaction = {
    id: `tx_${incomingSource.id}`,
    userId: incomingSource.userId,
    accountId: incomingSource.accountId,
    type: txType,
    status: incomingSource.status,
    amountCents: incomingSource.amountCents,
    currency: incomingSource.currency,
    bookingDate: incomingSource.bookingDate,
    valueDate: incomingSource.valueDate,
    occurredAtUtc: incomingSource.occurredAtUtc, // Never fabricate purchase time if null!
    createdAtUtc: incomingSource.receivedAtServerUtc,
    description: incomingSource.originalDescription,
    merchantNormalized: normalizeMerchantText(incomingSource.originalDescription),
    userNote: null,
    categoryId: params.defaultCategoryId ?? null,
    categorySource: params.defaultCategoryId ? 'merchant_rule' : 'unknown',
    categoryConfidence: params.defaultCategoryId ? 85 : 0,
    categoryExplanation: null,
    scope: txType === 'internal_transfer' ? 'non_personal' : (params.defaultScope ?? 'personal'),
    smallSpendingTagged: false,
    splits: [],
    linkedExpenseId: null,
    transferPairId: null,
    counterpartAccountId: null,
    untrackedOwnedDestinationLabel: null,
    settledObligationId: null,
    consumedSavingsReservationId: null,
    supersededByTransactionId: null,
    reviewStatus,
    sourceRecordIds: [incomingSource.id],
  };

  return {
    transactions: [...params.existingTransactions, newCanonical],
    sourceRecords: [...params.existingSources, incomingSource],
    auditLinks: [...params.existingAuditLinks],
    action:
      reviewStatus === 'requires_duplicate_review'
        ? 'flagged_duplicate_review'
        : 'created_new_canonical',
    canonicalTransaction: newCanonical,
  };
}

/**
 * Reverses a reconciliation link (e.g., if the user unlinks a manual provisional purchase
 * from a bank movement because they were actually two separate expenses).
 */
export function undoReconciliationLink(params: {
  auditLinkId: string;
  transactions: readonly CanonicalTransaction[];
  auditLinks: readonly ReconciliationAuditLink[];
}): {
  transactions: CanonicalTransaction[];
  auditLinks: ReconciliationAuditLink[];
} {
  const link = params.auditLinks.find((l) => l.id === params.auditLinkId);
  if (!link || !link.reversible) {
    throw new Error(`El enlace de conciliación "${params.auditLinkId}" no existe o no es reversible.`);
  }

  const restoredTransactions = params.transactions.map((tx) => {
    if (tx.id === link.fromTransactionId) {
      return {
        ...tx,
        status: (link.linkType === 'provisional_to_bank' ? 'provisional' : 'pending') as CanonicalTransaction['status'],
        supersededByTransactionId: null,
      };
    }
    if (tx.id === link.toTransactionId) {
      return {
        ...tx,
        sourceRecordIds: tx.sourceRecordIds.filter((id) => !id.includes(link.fromTransactionId)),
      };
    }
    return tx;
  });

  return {
    transactions: restoredTransactions,
    auditLinks: params.auditLinks.filter((l) => l.id !== params.auditLinkId),
  };
}

/**
 * Evaluates pending authorizations for staleness without treating absence from a single API
 * response as cancellation. Only marks items older than `expiryCalendarDays` (default 10 days)
 * for review.
 */
export function evaluateStalePendingAuthorizations(params: {
  transactions: readonly CanonicalTransaction[];
  currentMadridDate: string;
  expiryCalendarDays?: number;
}): {
  activePendingIds: string[];
  expiredForReviewIds: string[];
} {
  const maxAge = params.expiryCalendarDays ?? 10;
  const activePendingIds: string[] = [];
  const expiredForReviewIds: string[] = [];

  for (const tx of params.transactions) {
    if (tx.status !== 'pending') {
      continue;
    }
    const ageDays = diffCalendarDays(params.currentMadridDate, tx.bookingDate);
    if (ageDays > maxAge) {
      expiredForReviewIds.push(tx.id);
    } else {
      activePendingIds.push(tx.id);
    }
  }

  return { activePendingIds, expiredForReviewIds };
}
