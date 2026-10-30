import { Cents, SupportedCurrency } from '../money';
import { CalendarDateISO } from '../dates/madrid';

export type AccountType = 'cash' | 'bank' | 'savings' | 'credit_card';

export interface Account {
  id: string;
  userId: string;
  name: string;
  type: AccountType;
  currency: SupportedCurrency;
  /**
   * Credit liabilities (`credit_card`) MUST NEVER be included in spendable cash liquidity.
   * Savings accounts can be included or excluded from uncommitted liquidity depending on
   * explicit account scope.
   */
  includeInLiquidity: boolean;
  isOwned: boolean;
  /**
   * Stable identity across provider reconnections (e.g., `caixabank:ES12...` or IBAN SHA-256).
   * Prevents duplicating an account when `providerSessionAccountId` changes on re-auth.
   */
  stableIdentityKey: string | null;
  providerCode: string | null;
  providerSessionAccountId: string | null;
  ibanMasked: string | null;
  createdAtUtc: string;
}

export type BalanceSnapshotType =
  | 'CLBD' // Closing Booked (asentado al cierre)
  | 'ITBD' // Interim Booked (asentado intradía)
  | 'ITAV' // Interim Available (disponible intradía)
  | 'CLAV' // Closing Available (disponible al cierre)
  | 'XPCD' // Expected
  | 'MANUAL'
  | 'OPENING';

export interface BalanceSnapshot {
  id: string;
  userId: string;
  accountId: string;
  source: 'provider' | 'manual' | 'opening';
  balanceType: BalanceSnapshotType;
  amountCents: Cents;
  currency: SupportedCurrency;
  referenceTimeUtc: string;
  referenceBookingDate: CalendarDateISO;
  /**
   * Whether pending card authorizations / debits are ALREADY subtracted in `amountCents`.
   * E.g., `CLBD` / `ITBD` does NOT include pending debits (`false`), while `ITAV` may
   * already reflect them (`true`).
   */
  includesPendingDebits: boolean;
}

export type SourceType = 'manual' | 'csv' | 'provider';

export interface SourceRecord {
  id: string;
  userId: string;
  accountId: string;
  sourceType: SourceType;
  providerCode: string | null;
  sourceExternalId: string | null;
  importBatchId: string | null;
  originalDescription: string;
  bookingDate: CalendarDateISO;
  valueDate: CalendarDateISO | null;
  /**
   * Exact purchase/event UTC timestamp ONLY when genuinely known (e.g. manual entry).
   * When bank/CSV only supplies a booking date, this MUST remain `null` (never fabricate `00:00:00Z`).
   */
  occurredAtUtc: string | null;
  receivedAtServerUtc: string;
  status: 'booked' | 'pending';
  currency: SupportedCurrency;
  /** Signed cents: negative for debits/outflows, positive for credits/inflows */
  amountCents: Cents;
  counterpartyName: string | null;
  counterpartyIbanNormalized: string | null;
  remittanceInfo: string | null;
  normalizationVersion: number;
  provenance: string;
}

export type TransactionType =
  | 'income'
  | 'expense'
  | 'refund'
  | 'internal_transfer'
  | 'opening_balance'
  | 'adjustment'
  | 'unknown';

export type TransactionStatus =
  | 'booked'
  | 'pending'
  | 'provisional' // Manual entry on a bank account awaiting bank reconciliation
  | 'superseded'; // Replaced/merged into another canonical transaction (audit trail preserved)

export type SpendingScope = 'personal' | 'non_personal' | 'mixed';

export type CategoryAttributionSource =
  | 'user_locked'
  | 'user_rule'
  | 'merchant_rule'
  | 'provider_hint'
  | 'unknown';

export type TransactionReviewStatus =
  | 'none'
  | 'requires_deposit_origin_review'
  | 'requires_duplicate_review'
  | 'requires_transfer_scope_review'
  | 'requires_category_review';

export interface TransactionSplit {
  id: string;
  label: string;
  /** Positive cents magnitude allocated to this split */
  amountCents: Cents;
  categoryId: string;
  scope: 'personal' | 'non_personal';
  smallSpendingTagged: boolean;
}

export interface CanonicalTransaction {
  id: string;
  userId: string;
  accountId: string;
  type: TransactionType;
  status: TransactionStatus;
  /** Signed cents: positive for inflow (`income`, `refund`), negative for outflow (`expense`) */
  amountCents: Cents;
  currency: SupportedCurrency;
  bookingDate: CalendarDateISO;
  valueDate: CalendarDateISO | null;
  /** Null if bank only supplied `bookingDate` */
  occurredAtUtc: string | null;
  createdAtUtc: string;
  description: string;
  merchantNormalized: string;
  userNote: string | null;
  categoryId: string | null;
  categorySource: CategoryAttributionSource;
  categoryConfidence: number; // 0..100 heuristic score
  categoryExplanation: string | null;
  scope: SpendingScope;
  /** Editable tag/rule for small discretionary purchases ("gasto hormiga / compras pequeñas") */
  smallSpendingTagged: boolean;
  splits: TransactionSplit[];
  /** For `type === 'refund'`, links to original expense transaction ID */
  linkedExpenseId: string | null;
  /** For `type === 'internal_transfer'`, links both legs of the transfer */
  transferPairId: string | null;
  /** Target/counterpart account ID for internal transfers or untracked owned account transfers */
  counterpartAccountId: string | null;
  untrackedOwnedDestinationLabel: string | null;
  /** For `type === 'expense'` that settles a reserved obligation */
  settledObligationId: string | null;
  /** For savings transfer that consumes a savings reservation */
  consumedSavingsReservationId: string | null;
  supersededByTransactionId: string | null;
  reviewStatus: TransactionReviewStatus;
  sourceRecordIds: string[];
}

export interface ReconciliationAuditLink {
  id: string;
  userId: string;
  linkType: 'provisional_to_bank' | 'pending_to_booked' | 'duplicate_candidate' | 'transfer_pair';
  fromTransactionId: string;
  toTransactionId: string;
  previousAmountCents: Cents;
  newAmountCents: Cents;
  preservedCategoryId: string | null;
  preservedUserNote: string | null;
  reversible: boolean;
  createdAtUtc: string;
  reason: string;
}

export interface ObligationReservation {
  id: string;
  userId: string;
  name: string;
  periodKey: string; // YYYY-MM
  expectedAmountCents: Cents;
  paidAmountCents: Cents;
  status: 'reserved' | 'partially_paid' | 'settled' | 'cancelled';
  dueDate: CalendarDateISO | null;
  settledTransactionIds: string[];
}

export interface SavingsReservation {
  id: string;
  userId: string;
  name: string;
  periodKey: string; // YYYY-MM
  protectedAmountCents: Cents;
  transferredToExcludedAccountCents: Cents;
  status: 'earmarked_in_included_account' | 'partially_transferred' | 'transferred_to_savings';
}
