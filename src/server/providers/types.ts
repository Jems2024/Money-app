import { Cents, SupportedCurrency } from '../../domain/money';
import { CalendarDateISO } from '../../domain/dates/madrid';
import { BalanceSnapshotType } from '../../domain/ledger';

export type ProviderEnvironmentMode = 'unconfigured' | 'sandbox' | 'production';

export type BankConnectionUiState =
  | 'unconfigured' // "Sin configurar"
  | 'sandbox_ready' // "Entorno de pruebas"
  | 'sandbox_connected' // "Entorno de pruebas (Sesión activa)"
  | 'production_awaiting_auth' // "Pendiente de autorización en CaixaBank"
  | 'production_connected' // "Conectado (Verificado con lectura real)"
  | 'sync_paused_locally' // "Sincronización local en pausa"
  | 'session_revoked' // "Sesión eliminada en proveedor"
  | 'error';

export interface ProviderCapabilities {
  providerCode: 'enable_banking';
  displayName: string;
  supportsInstitutionDiscovery: boolean;
  supportsBalances: boolean;
  supportsTransactions: boolean;
  supportsPaginationContinuationKey: boolean;
  supportsPendingTransactions: boolean;
  supportsSessionDeletion: boolean;
  /**
   * False because `DELETE /sessions/{id}` closes the Enable Banking session and requests
   * ASPSP revocation where supported, but the user should verify in CaixaBankNow if they
   * require guaranteed immediate bank-side revocation.
   */
  promisesImmediateBankSideRevocation: false;
}

export interface AspspInstitutionInfo {
  name: string;
  country: string;
  bic?: string;
  maximumConsentValiditySeconds?: number;
}

export interface AuthorizationStateRecord {
  id: string;
  stateHashHex: string;
  initiatingUserId: string;
  aspspName: string;
  aspspCountry: string;
  redirectUri: string;
  createdAtUtc: string;
  expiresAtUtc: string;
  consumedAtUtc: string | null;
}

export interface ProviderAccountDto {
  providerSessionAccountId: string; // uid in session
  ibanNormalized: string;
  ibanMasked: string;
  name: string;
  currency: SupportedCurrency;
  productType: 'cash' | 'bank' | 'savings' | 'credit_card';
}

export interface ProviderBalanceDto {
  balanceType: BalanceSnapshotType;
  amountCents: Cents;
  currency: SupportedCurrency;
  referenceBookingDate: CalendarDateISO;
  referenceTimeUtc: string;
  includesPendingDebits: boolean;
}

export interface ProviderTransactionDto {
  sourceExternalId: string | null;
  bookingDate: CalendarDateISO;
  valueDate: CalendarDateISO | null;
  status: 'booked' | 'pending';
  amountCents: Cents; // signed: negative for DBIT, positive for CRDT
  currency: SupportedCurrency;
  originalDescription: string;
  counterpartyName: string | null;
  counterpartyIbanNormalized: string | null;
  remittanceInfo: string | null;
}

export interface ProviderTransactionsPageDto {
  transactions: ProviderTransactionDto[];
  continuationKey: string | null;
}

export type UnsupportedProviderOperationResult = {
  supported: false;
  code: 'UNSUPPORTED_PROVIDER_OPERATION';
  messageSpanish: string;
};
