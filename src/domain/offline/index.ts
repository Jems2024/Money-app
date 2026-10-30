import { Cents } from '../money';
import { CalendarDateISO } from '../dates/madrid';
import { CanonicalTransaction, SpendingScope } from '../ledger';

/**
 * STOP SPEND — Offline Queue & Multi-User Isolation (`src/domain/offline`)
 *
 * Section 11 & Acceptance Test 17 invariants:
 * 1. Offline quick entry uses an explicit opt-in device-local queue with client idempotency IDs
 *    and visible `"Pendiente de sincronizar"` state.
 * 2. Every queued entry is strictly namespaced to `userId`.
 * 3. Uploading the same offline operation twice produces ONE canonical transaction.
 * 4. Logging out and logging in as another user (`userB`) CANNOT upload `userA`'s queue!
 * 5. Warns the user before discarding unsynced entries on logout.
 */

export interface OfflineQueuedExpense {
  clientIdempotencyKey: string;
  userId: string;
  accountId: string;
  amountCents: Cents; // negative cents for expense
  description: string;
  categoryId: string;
  scope: SpendingScope;
  smallSpendingTagged: boolean;
  bookingDate: CalendarDateISO;
  occurredAtUtc: string;
  userNote: string | null;
  syncStatus: 'pending_sync' | 'synced' | 'failed';
}

export class OfflineQueueSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineQueueSecurityError';
  }
}

export function enqueueOfflineExpense(params: {
  queue: readonly OfflineQueuedExpense[];
  entry: Omit<OfflineQueuedExpense, 'syncStatus'>;
}): OfflineQueuedExpense[] {
  const exists = params.queue.some(
    (q) =>
      q.userId === params.entry.userId &&
      q.clientIdempotencyKey === params.entry.clientIdempotencyKey
  );
  if (exists) {
    return [...params.queue];
  }
  return [
    ...params.queue,
    {
      ...params.entry,
      syncStatus: 'pending_sync',
    },
  ];
}

/**
 * Flushes pending offline queue items for the authenticated `activeUserId`.
 * - Rejects or isolates items belonging to any other `userId` (Acceptance Test 17).
 * - Deduplicates by `clientIdempotencyKey` on the server/ledger so uploading twice
 *   never creates duplicate transactions.
 */
export function flushOfflineQueueForUser(params: {
  activeUserId: string;
  queue: readonly OfflineQueuedExpense[];
  existingTransactions: readonly CanonicalTransaction[];
  attemptUploadItemIds?: readonly string[];
}): {
  transactions: CanonicalTransaction[];
  updatedQueue: OfflineQueuedExpense[];
  uploadedCount: number;
  deduplicatedNoopCount: number;
  rejectedCrossUserCount: number;
} {
  let transactions = [...params.existingTransactions];
  let uploadedCount = 0;
  let deduplicatedNoopCount = 0;
  let rejectedCrossUserCount = 0;

  const updatedQueue = params.queue.map((item) => {
    if (
      params.attemptUploadItemIds &&
      !params.attemptUploadItemIds.includes(item.clientIdempotencyKey)
    ) {
      return item;
    }

    // Security invariant (Acceptance Test 17): User B cannot upload User A's offline queue!
    if (item.userId !== params.activeUserId) {
      rejectedCrossUserCount++;
      return item;
    }

    const expectedTxId = `tx_offline_${item.userId}_${item.clientIdempotencyKey}`;
    const alreadyInLedger = transactions.some((tx) => tx.id === expectedTxId);

    if (alreadyInLedger) {
      deduplicatedNoopCount++;
      return { ...item, syncStatus: 'synced' as const };
    }

    const newTx: CanonicalTransaction = {
      id: expectedTxId,
      userId: item.userId,
      accountId: item.accountId,
      type: 'expense',
      status: 'provisional',
      amountCents: -Math.abs(item.amountCents),
      currency: 'EUR',
      bookingDate: item.bookingDate,
      valueDate: item.bookingDate,
      occurredAtUtc: item.occurredAtUtc,
      createdAtUtc: new Date().toISOString(),
      description: item.description,
      merchantNormalized: item.description.toUpperCase().trim(),
      userNote: item.userNote,
      categoryId: item.categoryId,
      categorySource: 'user_locked',
      categoryConfidence: 100,
      categoryExplanation: 'Gasto registrado en cola offline y sincronizado con clave idempotente',
      scope: item.scope,
      smallSpendingTagged: item.smallSpendingTagged,
      splits: [],
      linkedExpenseId: null,
      transferPairId: null,
      counterpartAccountId: null,
      untrackedOwnedDestinationLabel: null,
      settledObligationId: null,
      consumedSavingsReservationId: null,
      supersededByTransactionId: null,
      reviewStatus: 'none',
      sourceRecordIds: [`src_offline_${item.clientIdempotencyKey}`],
    };

    transactions.push(newTx);
    uploadedCount++;
    return { ...item, syncStatus: 'synced' as const };
  });

  return {
    transactions,
    updatedQueue,
    uploadedCount,
    deduplicatedNoopCount,
    rejectedCrossUserCount,
  };
}

/**
 * Checks whether the current user has unsynced entries before logging out,
 * requiring explicit confirmation before clearing local financial caches.
 */
export function evaluateLogoutSafety(params: {
  activeUserId: string;
  queue: readonly OfflineQueuedExpense[];
  forceDiscardUnsynced?: boolean;
}): {
  canProceedWithLogout: boolean;
  unsyncedCountForUser: number;
  warningSpanish: string | null;
} {
  const unsyncedCountForUser = params.queue.filter(
    (q) => q.userId === params.activeUserId && q.syncStatus === 'pending_sync'
  ).length;

  if (unsyncedCountForUser > 0 && !params.forceDiscardUnsynced) {
    return {
      canProceedWithLogout: false,
      unsyncedCountForUser,
      warningSpanish: `Tienes ${unsyncedCountForUser} gasto(s) pendiente(s) de sincronizar en este dispositivo. Si cierras sesión ahora sin conexión, se descartarán.`,
    };
  }

  return {
    canProceedWithLogout: true,
    unsyncedCountForUser,
    warningSpanish: null,
  };
}
