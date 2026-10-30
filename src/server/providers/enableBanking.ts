import { parseMoneyToCents } from '../../domain/money';
import { assertValidCalendarDate, CalendarDateISO } from '../../domain/dates/madrid';
import {
  Account,
  BalanceSnapshot,
  CanonicalTransaction,
  SourceRecord,
  upsertProviderAccount,
} from '../../domain/ledger';
import { ingestAndReconcileSourceRecord } from '../../domain/reconciliation';
import {
  generateOneTimeAuthState,
  sha256Hex,
  signEnableBankingJwt,
} from '../crypto/runtimeSpike';
import {
  AspspInstitutionInfo,
  AuthorizationStateRecord,
  BankConnectionUiState,
  ProviderAccountDto,
  ProviderBalanceDto,
  ProviderCapabilities,
  ProviderEnvironmentMode,
  ProviderTransactionDto,
  ProviderTransactionsPageDto,
  UnsupportedProviderOperationResult,
} from './types';

export * from './types';

export class BankingProviderError extends Error {
  public readonly code: string;
  public readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'BankingProviderError';
    this.code = code;
    this.status = status;
  }
}

export interface EnableBankingConfig {
  mode: ProviderEnvironmentMode;
  baseUrl: string; // https://api.enablebanking.com
  appId: string;
  privateKeyPem: string;
  redirectUri: string;
  allowedOrigins: readonly string[];
}

export const ENABLE_BANKING_CAPABILITIES: ProviderCapabilities = {
  providerCode: 'enable_banking',
  displayName: 'Enable Banking (PSD2 AIS)',
  supportsInstitutionDiscovery: true,
  supportsBalances: true,
  supportsTransactions: true,
  supportsPaginationContinuationKey: true,
  supportsPendingTransactions: true,
  supportsSessionDeletion: true,
  promisesImmediateBankSideRevocation: false,
};

/**
 * Determines the honest UI status badge for the banking integration (Section 1, 3, 13 & Test 22).
 * Never shows "Connected" in production unless `hasValidSession` AND `hasSuccessfulRealRead` are true.
 */
export function resolveBankConnectionStatusBadge(params: {
  mode: ProviderEnvironmentMode;
  localSyncPaused?: boolean;
  sessionRevoked?: boolean;
  hasValidSession: boolean;
  hasSuccessfulRealRead: boolean;
  lastSyncError?: string | null;
}): {
  state: BankConnectionUiState;
  badgeTextSpanish: string;
  descriptionSpanish: string;
} {
  if (params.mode === 'unconfigured') {
    return {
      state: 'unconfigured',
      badgeTextSpanish: 'Sin configurar',
      descriptionSpanish:
        'Integración bancaria desactivada por falta de credenciales de servidor. Entrada manual e importación CSV totalmente operativas.',
    };
  }

  if (params.sessionRevoked) {
    return {
      state: 'session_revoked',
      badgeTextSpanish: 'Sesión eliminada',
      descriptionSpanish:
        'La sesión se ha eliminado en Enable Banking. Si deseas revocar también el permiso en el banco de inmediato, revísalo en CaixaBankNow.',
    };
  }

  if (params.localSyncPaused) {
    return {
      state: 'sync_paused_locally',
      badgeTextSpanish: 'Sincronización en pausa',
      descriptionSpanish:
        'La sincronización automática local está detenida. La sesión en el proveedor no se consulta hasta que la reanudes.',
    };
  }

  if (params.lastSyncError) {
    return {
      state: 'error',
      badgeTextSpanish: 'Error de sincronización',
      descriptionSpanish: params.lastSyncError,
    };
  }

  if (params.mode === 'sandbox') {
    if (params.hasValidSession) {
      return {
        state: 'sandbox_connected',
        badgeTextSpanish: 'Entorno de pruebas (Conectado)',
        descriptionSpanish: 'Conectado al entorno de pruebas (Sandbox) de Enable Banking.',
      };
    }
    return {
      state: 'sandbox_ready',
      badgeTextSpanish: 'Entorno de pruebas',
      descriptionSpanish: 'Credenciales de Sandbox configuradas. Listo para probar autorización.',
    };
  }

  // Production mode: ONLY label connected after valid authorization AND a successful real read!
  if (params.hasValidSession && params.hasSuccessfulRealRead) {
    return {
      state: 'production_connected',
      badgeTextSpanish: 'Conectado a CaixaBank (Lectura verificada)',
      descriptionSpanish:
        'Conexión de solo lectura verificada con tu cuenta de CaixaBank a través de Enable Banking.',
    };
  }

  return {
    state: 'production_awaiting_auth',
    badgeTextSpanish: 'Pendiente de autorización en CaixaBank',
    descriptionSpanish:
      'Completa la vinculación en el panel de Enable Banking (Linked Accounts) y autoriza el acceso en CaixaBankNow.',
  };
}

/**
 * Masks an IBAN for safe logging and UI display (`ES91 **** **** **** **** 1332`).
 * Never logs or exposes full raw IBANs in client logs.
 */
export function maskIban(iban: string): string {
  const clean = iban.replace(/\s+/g, '').toUpperCase();
  if (clean.length < 8) {
    return '****';
  }
  return `${clean.slice(0, 4)} **** **** ${clean.slice(-4)}`;
}

/**
 * Selects the exact institution from the Enable Banking `/aspsps` response without
 * ever silently substituting `imagin` or another bank for `CaixaBank` (Section 3).
 */
export function selectExactInstitution(
  institutions: readonly AspspInstitutionInfo[],
  requestedName: string = 'CaixaBank',
  requestedCountry: string = 'ES'
): AspspInstitutionInfo {
  const exact = institutions.find(
    (inst) =>
      inst.country.toUpperCase() === requestedCountry.toUpperCase() &&
      inst.name.trim().toLowerCase() === requestedName.trim().toLowerCase()
  );

  if (!exact) {
    throw new BankingProviderError(
      'ASPSP_NOT_FOUND',
      `No se encontró la entidad exacta "${requestedName}" (${requestedCountry}) en el catálogo vivo de Enable Banking. Nunca se sustituye silenciosamente por imagin u otra entidad.`
    );
  }

  return exact;
}

/**
 * Creates a short-lived, cryptographically random, one-use authorization state bound to
 * the authenticated `initiatingUserId`, validating the redirect URI against `allowedOrigins`.
 */
export async function createBoundAuthState(params: {
  id: string;
  initiatingUserId: string;
  aspspName: string;
  aspspCountry: string;
  redirectUri: string;
  allowedOrigins: readonly string[];
  nowUtc?: string;
  ttlSeconds?: number;
}): Promise<{
  rawState: string;
  record: AuthorizationStateRecord;
}> {
  if (!params.initiatingUserId.trim()) {
    throw new BankingProviderError('UNAUTHENTICATED_USER', 'Se requiere un usuario autenticado.');
  }

  let parsedRedirect: URL;
  try {
    parsedRedirect = new URL(params.redirectUri);
  } catch {
    throw new BankingProviderError('INVALID_REDIRECT_URI', 'Redirect URI mal formada.');
  }

  const originAllowed = params.allowedOrigins.some(
    (o) => o.replace(/\/$/, '').toLowerCase() === parsedRedirect.origin.toLowerCase()
  );
  if (!originAllowed) {
    throw new BankingProviderError(
      'DISALLOWED_REDIRECT_ORIGIN',
      `El origen de redirección "${parsedRedirect.origin}" no está en la lista permitida.`
    );
  }

  const { rawState, stateHashHex } = await generateOneTimeAuthState();
  const nowMs = new Date(params.nowUtc ?? new Date().toISOString()).getTime();
  const ttlMs = (params.ttlSeconds ?? 600) * 1000; // 10 minutes default

  return {
    rawState,
    record: {
      id: params.id,
      stateHashHex,
      initiatingUserId: params.initiatingUserId,
      aspspName: params.aspspName,
      aspspCountry: params.aspspCountry,
      redirectUri: params.redirectUri,
      createdAtUtc: new Date(nowMs).toISOString(),
      expiresAtUtc: new Date(nowMs + ttlMs).toISOString(),
      consumedAtUtc: null,
    },
  };
}

/**
 * Validates and consumes an OAuth/PSD2 callback `state` parameter on the server.
 *
 * Enforces Section 3 & Acceptance Test 21:
 * - Rejects unknown, expired, or already-used (replayed) states.
 * - If `requestingUserId` is present in the callback session, verifies it matches `initiatingUserId`
 *   (preventing cross-user binding).
 * - If the callback opens in an external browser context on iOS (where the standalone PWA session
 *   cookie isn't shared), binds strictly to the server-side `record.initiatingUserId` that initiated
 *   the state and returns a neutral completion payload, while stripping `code` and `state` from URL.
 */
export async function validateAndConsumeAuthStateCallback(params: {
  rawStateFromQuery: string;
  codeFromQuery: string;
  storedRecords: readonly AuthorizationStateRecord[];
  authenticatedCallbackUserId?: string | null;
  nowUtc?: string;
  currentCallbackUrl?: string;
}): Promise<{
  consumedRecord: AuthorizationStateRecord;
  updatedRecords: AuthorizationStateRecord[];
  sanitizedBrowserPath: string;
  neutralCompletionMessageSpanish: string;
}> {
  if (!params.rawStateFromQuery || !params.codeFromQuery) {
    throw new BankingProviderError(
      'MISSING_CALLBACK_PARAMS',
      'Faltan parámetros de autorización (state o code) en el retorno bancario.'
    );
  }

  const incomingHash = await sha256Hex(params.rawStateFromQuery);
  const record = params.storedRecords.find((r) => r.stateHashHex === incomingHash);

  if (!record) {
    throw new BankingProviderError(
      'INVALID_AUTH_STATE',
      'Estado de autorización inválido o desconocido.'
    );
  }

  if (record.consumedAtUtc !== null) {
    throw new BankingProviderError(
      'REPLAYED_AUTH_STATE',
      'Este estado de autorización ya fue utilizado (protección contra repetición / replay).'
    );
  }

  const nowIso = params.nowUtc ?? new Date().toISOString();
  if (new Date(nowIso).getTime() > new Date(record.expiresAtUtc).getTime()) {
    throw new BankingProviderError(
      'EXPIRED_AUTH_STATE',
      'El estado de autorización ha caducado. Inicia la conexión de nuevo desde STOP SPEND.'
    );
  }

  if (
    params.authenticatedCallbackUserId &&
    params.authenticatedCallbackUserId !== record.initiatingUserId
  ) {
    throw new BankingProviderError(
      'CROSS_USER_STATE_MISMATCH',
      'El estado de autorización pertenece a otro usuario (vinculación cruzada rechazada).'
    );
  }

  const consumedRecord: AuthorizationStateRecord = {
    ...record,
    consumedAtUtc: nowIso,
  };

  const updatedRecords = params.storedRecords.map((r) =>
    r.id === record.id ? consumedRecord : r
  );

  // Strip sensitive `code` and `state` parameters from the browser URL
  let sanitizedBrowserPath = '/banco/completado';
  if (params.currentCallbackUrl) {
    try {
      const u = new URL(params.currentCallbackUrl);
      u.searchParams.delete('code');
      u.searchParams.delete('state');
      u.searchParams.delete('error');
      sanitizedBrowserPath = u.pathname + (u.search ? u.search : '');
    } catch {
      sanitizedBrowserPath = '/banco/completado';
    }
  }

  return {
    consumedRecord,
    updatedRecords,
    sanitizedBrowserPath,
    neutralCompletionMessageSpanish:
      'Autorización procesada. Puedes volver a la aplicación instalada STOP SPEND para consultar el estado de tu cuenta.',
  };
}

// ============================================================================
// ENABLE BANKING PAYLOAD PARSERS (Exact decimal strings, no floating point!)
// ============================================================================

export interface EnableBankingRawBalanceItem {
  balance_type: string;
  balance_amount: {
    amount: string;
    currency: string;
  };
  reference_date?: string;
  last_change_date_time?: string;
}

export interface EnableBankingRawTransactionItem {
  entry_reference?: string | null;
  transaction_id?: string | null;
  booking_date?: string | null;
  value_date?: string | null;
  transaction_date?: string | null;
  status?: 'BOOK' | 'PDNG' | 'INFO' | string;
  credit_debit_indicator: 'CRDT' | 'DBIT';
  transaction_amount: {
    amount: string;
    currency: string;
  };
  remittance_information?: string[] | string | null;
  creditor?: { name?: string | null };
  debtor?: { name?: string | null };
  creditor_account?: { iban?: string | null };
  debtor_account?: { iban?: string | null };
}

/**
 * Parses an Enable Banking balance item (`GET /accounts/{account_id}/balances`)
 * into a strongly typed `ProviderBalanceDto` using exact integer cents.
 */
export function parseEnableBankingBalance(
  raw: EnableBankingRawBalanceItem,
  fallbackDate: CalendarDateISO
): ProviderBalanceDto {
  const amountCents = parseMoneyToCents(raw.balance_amount.amount, {
    currency: raw.balance_amount.currency,
  });

  const normalizedType = (raw.balance_type || 'CLBD').toUpperCase();
  const validTypes = ['CLBD', 'ITBD', 'ITAV', 'CLAV', 'XPCD'] as const;
  const balanceType: ProviderBalanceDto['balanceType'] = (
    validTypes.includes(normalizedType as (typeof validTypes)[number])
      ? normalizedType
      : 'CLBD'
  ) as ProviderBalanceDto['balanceType'];

  // ITAV, CLAV, XPCD typically reflect pending card authorizations; CLBD and ITBD are booked only
  const includesPendingDebits =
    balanceType === 'ITAV' || balanceType === 'CLAV' || balanceType === 'XPCD';

  const refDate =
    raw.reference_date && /^\d{4}-\d{2}-\d{2}$/.test(raw.reference_date)
      ? assertValidCalendarDate(raw.reference_date)
      : fallbackDate;

  return {
    balanceType,
    amountCents,
    currency: 'EUR',
    referenceBookingDate: refDate,
    referenceTimeUtc: raw.last_change_date_time ?? new Date().toISOString(),
    includesPendingDebits,
  };
}

/**
 * Parses an Enable Banking transaction item (`GET /accounts/{account_id}/transactions`)
 * into a `ProviderTransactionDto`.
 * - Preserves `booking_date` as a pure calendar date (`YYYY-MM-DD`).
 * - Applies `credit_debit_indicator` (`DBIT` -> negative cents, `CRDT` -> positive cents).
 */
export function parseEnableBankingTransaction(
  raw: EnableBankingRawTransactionItem,
  fallbackBookingDate: CalendarDateISO
): ProviderTransactionDto {
  const absCents = Math.abs(
    parseMoneyToCents(raw.transaction_amount.amount, {
      currency: raw.transaction_amount.currency,
    })
  );

  const signedCents = raw.credit_debit_indicator === 'DBIT' ? -absCents : absCents;
  const rawBooking = raw.booking_date || raw.transaction_date || raw.value_date || fallbackBookingDate;
  const bookingDate = assertValidCalendarDate(rawBooking.slice(0, 10));
  const valueDate = raw.value_date ? assertValidCalendarDate(raw.value_date.slice(0, 10)) : null;

  const status: 'booked' | 'pending' = raw.status === 'PDNG' ? 'pending' : 'booked';
  const remittanceText = Array.isArray(raw.remittance_information)
    ? raw.remittance_information.join(' ').trim()
    : (raw.remittance_information ?? '').trim();

  const counterpartyName =
    raw.credit_debit_indicator === 'DBIT'
      ? (raw.creditor?.name ?? null)
      : (raw.debtor?.name ?? null);

  const counterpartyIban =
    raw.credit_debit_indicator === 'DBIT'
      ? (raw.creditor_account?.iban ?? null)
      : (raw.debtor_account?.iban ?? null);

  const descriptionParts = [counterpartyName, remittanceText].filter(Boolean);
  const originalDescription =
    descriptionParts.length > 0 ? descriptionParts.join(' — ') : 'Movimiento bancario';

  const sourceExternalId =
    (raw.entry_reference && raw.entry_reference.trim()) ||
    (raw.transaction_id && raw.transaction_id.trim()) ||
    null;

  return {
    sourceExternalId,
    bookingDate,
    valueDate,
    status,
    amountCents: signedCents,
    currency: 'EUR',
    originalDescription,
    counterpartyName,
    counterpartyIbanNormalized: counterpartyIban
      ? counterpartyIban.replace(/\s+/g, '').toUpperCase()
      : null,
    remittanceInfo: remittanceText || null,
  };
}

// ============================================================================
// ENABLE BANKING ADAPTER CLIENT (Server-side only)
// ============================================================================

export class EnableBankingAdapter {
  public readonly capabilities = ENABLE_BANKING_CAPABILITIES;
  private readonly config: EnableBankingConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: EnableBankingConfig, fetchImpl: typeof fetch = globalThis.fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  private async buildAuthHeaders(isUserInitiated: boolean, psuIpAddress?: string): Promise<Record<string, string>> {
    if (this.config.mode === 'unconfigured' || !this.config.privateKeyPem || !this.config.appId) {
      throw new BankingProviderError(
        'PROVIDER_UNCONFIGURED',
        'Enable Banking no está configurado en el servidor.'
      );
    }

    const jwt = await signEnableBankingJwt({
      appId: this.config.appId,
      privateKeyPem: this.config.privateKeyPem,
      ttlSeconds: 300,
    });

    const headers: Record<string, string> = {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    // Invariant (Section 10): Separate user-triggered refresh from unattended cron refresh accurately!
    // Never attach PSU-IP-Address on unattended background cron jobs to evade ASPSP rate limits.
    if (isUserInitiated && psuIpAddress) {
      headers['PSU-IP-Address'] = psuIpAddress;
    }

    return headers;
  }

  /**
   * 1. Institution discovery (`GET /aspsps?country=ES`)
   */
  public async discoverCaixaBankInstitution(
    country: string = 'ES',
    institutionName: string = 'CaixaBank'
  ): Promise<AspspInstitutionInfo> {
    const headers = await this.buildAuthHeaders(true);
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/aspsps?country=${encodeURIComponent(country)}`;
    const res = await this.fetchImpl(url, { method: 'GET', headers });
    if (!res.ok) {
      throw new BankingProviderError(
        'ASPSP_DISCOVERY_FAILED',
        `Error HTTP ${res.status} al consultar el catálogo de entidades en Enable Banking.`,
        res.status
      );
    }
    const data = (await res.json()) as { aspsps?: AspspInstitutionInfo[] };
    return selectExactInstitution(data.aspsps ?? [], institutionName, country);
  }

  /**
   * 2. Start authorization (`POST /auth`)
   */
  public async startAuthorization(params: {
    aspspName: string;
    aspspCountry: string;
    state: string;
    validUntilIso: string;
  }): Promise<{ authorizationUrl: string }> {
    const headers = await this.buildAuthHeaders(true);
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/auth`;
    const body = {
      access: {
        valid_until: params.validUntilIso,
        balances: true,
        transactions: true,
      },
      aspsp: {
        name: params.aspspName,
        country: params.aspspCountry,
      },
      state: params.state,
      redirect_url: this.config.redirectUri,
      psu_type: 'personal',
    };

    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new BankingProviderError(
        'AUTH_INIT_FAILED',
        `Error HTTP ${res.status} al iniciar autorización POST /auth en Enable Banking.`,
        res.status
      );
    }

    const payload = (await res.json()) as { url?: string };
    if (!payload.url) {
      throw new BankingProviderError('INVALID_AUTH_RESPONSE', 'Enable Banking no devolvió URL de redirección.');
    }

    return { authorizationUrl: payload.url };
  }

  /**
   * 3. Callback code exchange (`POST /sessions`)
   */
  public async exchangeCodeForSession(code: string): Promise<{
    sessionId: string;
    accounts: ProviderAccountDto[];
    validUntilIso: string | null;
  }> {
    const headers = await this.buildAuthHeaders(true);
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/sessions`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ code }),
    });

    if (!res.ok) {
      throw new BankingProviderError(
        'SESSION_EXCHANGE_FAILED',
        `Error HTTP ${res.status} al canjear sesión en POST /sessions.`,
        res.status
      );
    }

    const data = (await res.json()) as {
      session_id: string;
      accounts?: Array<{
        uid: string;
        account_id?: { iban?: string };
        name?: string;
        currency?: string;
        cash_account_type?: string;
      }>;
      access?: { valid_until?: string };
    };

    const accounts: ProviderAccountDto[] = (data.accounts ?? []).map((acc) => {
      const rawIban = acc.account_id?.iban ?? acc.uid;
      const ibanNormalized = rawIban.replace(/\s+/g, '').toUpperCase();
      return {
        providerSessionAccountId: acc.uid,
        ibanNormalized,
        ibanMasked: maskIban(ibanNormalized),
        name: acc.name || 'Cuenta CaixaBank',
        currency: 'EUR',
        productType: acc.cash_account_type === 'SVGS' ? 'savings' : 'bank',
      };
    });

    return {
      sessionId: data.session_id,
      accounts,
      validUntilIso: data.access?.valid_until ?? null,
    };
  }

  /**
   * 4. Fetch balances (`GET /accounts/{account_id}/balances`)
   */
  public async fetchAccountBalances(params: {
    providerSessionAccountId: string;
    isUserInitiated: boolean;
    fallbackDate: CalendarDateISO;
  }): Promise<ProviderBalanceDto[]> {
    const headers = await this.buildAuthHeaders(params.isUserInitiated);
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/accounts/${encodeURIComponent(
      params.providerSessionAccountId
    )}/balances`;
    const res = await this.fetchImpl(url, { method: 'GET', headers });
    if (!res.ok) {
      throw new BankingProviderError(
        'BALANCES_FETCH_FAILED',
        `Error HTTP ${res.status} al consultar saldos de la cuenta.`,
        res.status
      );
    }
    const data = (await res.json()) as { balances?: EnableBankingRawBalanceItem[] };
    return (data.balances ?? []).map((b) => parseEnableBankingBalance(b, params.fallbackDate));
  }

  /**
   * 5. Fetch paginated transactions (`GET /accounts/{account_id}/transactions`)
   */
  public async fetchAccountTransactionsPage(params: {
    providerSessionAccountId: string;
    dateFrom: CalendarDateISO;
    dateTo?: CalendarDateISO;
    continuationKey?: string | null;
    isUserInitiated: boolean;
  }): Promise<ProviderTransactionsPageDto> {
    const headers = await this.buildAuthHeaders(params.isUserInitiated);
    const query = new URLSearchParams({ date_from: params.dateFrom });
    if (params.dateTo) {
      query.set('date_to', params.dateTo);
    }
    if (params.continuationKey) {
      query.set('continuation_key', params.continuationKey);
    }

    const url = `${this.config.baseUrl.replace(/\/$/, '')}/accounts/${encodeURIComponent(
      params.providerSessionAccountId
    )}/transactions?${query.toString()}`;

    const res = await this.fetchImpl(url, { method: 'GET', headers });
    if (!res.ok) {
      throw new BankingProviderError(
        'TRANSACTIONS_FETCH_FAILED',
        `Error HTTP ${res.status} al consultar movimientos paginados.`,
        res.status
      );
    }

    const data = (await res.json()) as {
      transactions?: EnableBankingRawTransactionItem[];
      continuation_key?: string | null;
    };

    const parsed = (data.transactions ?? []).map((t) =>
      parseEnableBankingTransaction(t, params.dateFrom)
    );

    return {
      transactions: parsed,
      continuationKey: data.continuation_key ?? null,
    };
  }

  /**
   * 6. Delete provider session (`DELETE /sessions/{session_id}`)
   */
  public async deleteSession(sessionId: string): Promise<{
    deletedInProvider: boolean;
    guaranteedBankConsentRevoked: false;
    userNoticeSpanish: string;
  }> {
    const headers = await this.buildAuthHeaders(true);
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/sessions/${encodeURIComponent(sessionId)}`;
    const res = await this.fetchImpl(url, { method: 'DELETE', headers });
    if (!res.ok) {
      throw new BankingProviderError(
        'SESSION_DELETE_FAILED',
        `Error HTTP ${res.status} al eliminar la sesión en Enable Banking.`,
        res.status
      );
    }
    return {
      deletedInProvider: true,
      guaranteedBankConsentRevoked: false,
      userNoticeSpanish:
        'Sesión cerrada en Enable Banking. Para revocar también el consentimiento directamente en el banco si aún aparece activo, compruébalo en CaixaBankNow.',
    };
  }

  /**
   * Explicit unsupported operation response for any capability outside AIS read-only scope (e.g. PIS).
   */
  public initiatePaymentUnsupported(): UnsupportedProviderOperationResult {
    return {
      supported: false,
      code: 'UNSUPPORTED_PROVIDER_OPERATION',
      messageSpanish:
        'STOP SPEND es estrictamente de solo lectura: nunca inicia pagos ni mueve dinero.',
    };
  }
}

// ============================================================================
// DURABLE PAGINATED SYNC ENGINE WITH CURSOR & FAILURE ATOMICITY (Test 19)
// ============================================================================

export interface SyncCursorState {
  connectionId: string;
  lastSuccessfulBookingDate: CalendarDateISO | null;
  lastSuccessfulSyncUtc: string | null;
  isLocked: boolean;
  lastErrorSpanish: string | null;
}

/**
 * Synchronizes all pages of transactions for an account using `continuation_key`.
 *
 * Invariant (Acceptance Test 19 & Section 10):
 * - If any page fails mid-pagination (e.g. page 2 throws a network/502/429 error),
 *   existing ledger data is NEVER deleted and `lastSuccessfulBookingDate` cursor is
 *   NOT advanced to the end date!
 */
export async function syncAccountPagesAtomically(params: {
  userId: string;
  account: Account;
  cursor: SyncCursorState;
  targetDateFrom: CalendarDateISO;
  targetDateTo: CalendarDateISO;
  isUserInitiated: boolean;
  fetchPage: (continuationKey: string | null) => Promise<ProviderTransactionsPageDto>;
  existingSources: readonly SourceRecord[];
  existingTransactions: readonly CanonicalTransaction[];
  nowUtc?: string;
}): Promise<{
  success: boolean;
  updatedCursor: SyncCursorState;
  transactions: CanonicalTransaction[];
  sourceRecords: SourceRecord[];
  pagesFetched: number;
}> {
  if (params.cursor.isLocked) {
    throw new BankingProviderError(
      'SYNC_LOCKED',
      'Ya hay una sincronización en curso para esta conexión.'
    );
  }

  const nowUtc = params.nowUtc ?? new Date().toISOString();
  const stagedDtos: ProviderTransactionDto[] = [];
  let continuationKey: string | null = null;
  let pagesFetched = 0;
  const maxPagesSafety = 50;

  try {
    do {
      const page = await params.fetchPage(continuationKey);
      pagesFetched++;
      stagedDtos.push(...page.transactions);
      continuationKey = page.continuationKey;
    } while (continuationKey !== null && pagesFetched < maxPagesSafety);
  } catch (err) {
    // Pagination failed mid-run! Preserve existing transactions/sources untouched
    // and do NOT advance `lastSuccessfulBookingDate`!
    return {
      success: false,
      updatedCursor: {
        ...params.cursor,
        isLocked: false,
        lastErrorSpanish:
          err instanceof Error
            ? `Fallo en página ${pagesFetched + 1}: ${err.message}`
            : 'Fallo durante la paginación bancaria.',
      },
      transactions: [...params.existingTransactions],
      sourceRecords: [...params.existingSources],
      pagesFetched,
    };
  }

  // All pages succeeded: apply idempotent ingestion and advance the cursor!
  let transactions = [...params.existingTransactions];
  let sourceRecords = [...params.existingSources];

  for (let i = 0; i < stagedDtos.length; i++) {
    const dto = stagedDtos[i]!;
    const src: SourceRecord = {
      id: `src_eb_${params.account.id}_${dto.sourceExternalId ?? `${dto.bookingDate}_${i}`}`,
      userId: params.userId,
      accountId: params.account.id,
      sourceType: 'provider',
      providerCode: 'enable_banking',
      sourceExternalId: dto.sourceExternalId,
      importBatchId: null,
      originalDescription: dto.originalDescription,
      bookingDate: dto.bookingDate,
      valueDate: dto.valueDate,
      occurredAtUtc: null, // Never fabricate purchase time from bank booking_date!
      receivedAtServerUtc: nowUtc,
      status: dto.status,
      currency: dto.currency,
      amountCents: dto.amountCents,
      counterpartyName: dto.counterpartyName,
      counterpartyIbanNormalized: dto.counterpartyIbanNormalized,
      remittanceInfo: dto.remittanceInfo,
      normalizationVersion: 1,
      provenance: 'enable_banking:ais',
    };

    const res = ingestAndReconcileSourceRecord({
      incomingSource: src,
      existingSources: sourceRecords,
      existingTransactions: transactions,
      existingAuditLinks: [],
    });
    transactions = res.transactions;
    sourceRecords = res.sourceRecords;
  }

  return {
    success: true,
    updatedCursor: {
      connectionId: params.cursor.connectionId,
      lastSuccessfulBookingDate: params.targetDateTo,
      lastSuccessfulSyncUtc: nowUtc,
      isLocked: false,
      lastErrorSpanish: null,
    },
    transactions,
    sourceRecords,
    pagesFetched,
  };
}

export { upsertProviderAccount, type BalanceSnapshot };
