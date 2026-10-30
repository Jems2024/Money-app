import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CalendarDateISO, getMadridDateParts, PeriodMonthKey } from '../domain/dates/madrid';
import {
  Account,
  BalanceSnapshot,
  CanonicalTransaction,
  createAccount,
  ObligationReservation,
  ReconciliationAuditLink,
  SavingsReservation,
  SourceRecord,
} from '../domain/ledger';
import {
  BudgetPeriodAllocation,
  createBudgetAllocation,
  CrossPeriodRefundPolicy,
  PERSONAL_ENVELOPE_TEMPLATE_EUR,
} from '../domain/budgets';
import { AlertOutboxEvent, HandledThresholdRecord } from '../domain/alerts';
import { CategorizationRule } from '../domain/categorization';
import { OfflineQueuedExpense } from '../domain/offline';
import { ProviderEnvironmentMode } from '../server/providers/types';

export interface UserSession {
  userId: string;
  email: string;
  displayName: string;
}

export interface CsvImportBatchMeta {
  id: string;
  fileHashKey: string;
  filename: string;
  rowCount: number;
  createdAtUtc: string;
}

export interface AppUserState {
  userId: string;
  displayName: string;
  currentPeriodKey: PeriodMonthKey;
  onboardingConfirmed: boolean;
  plannedMonthlyIncomeCents: number;
  refundPolicy: CrossPeriodRefundPolicy;
  rememberedAccountId: string;
  rememberedCategoryId: string;
  accounts: Account[];
  snapshots: BalanceSnapshot[];
  sourceRecords: SourceRecord[];
  transactions: CanonicalTransaction[];
  auditLinks: ReconciliationAuditLink[];
  budgetAllocations: Record<PeriodMonthKey, BudgetPeriodAllocation>;
  obligations: ObligationReservation[];
  savingsReservations: SavingsReservation[];
  categorizationRules: CategorizationRule[];
  handledThresholds: HandledThresholdRecord[];
  alertOutbox: AlertOutboxEvent[];
  csvBatches: CsvImportBatchMeta[];
  bankConfig: {
    mode: ProviderEnvironmentMode;
    hasValidSession: boolean;
    hasSuccessfulRealRead: boolean;
    localSyncPaused: boolean;
    sessionRevoked: boolean;
    lastSyncUtc: string | null;
    lastSyncError: string | null;
  };
  pushConfig: {
    permissionState: 'default' | 'granted' | 'denied' | 'unsupported';
    subscribedEndpoint: string | null;
    includeSensitiveAmountsInPush: boolean;
    quietHoursEnabled: boolean;
    quietHoursStart: number;
    quietHoursEnd: number;
  };
  offlineModeEnabled: boolean;
  simulateNetworkOffline: boolean;
  simulateNextApiError: boolean;
}

export const KNOWN_SUPABASE_PROJECT_REF = 'zsnvclyoypabmgqqaizj';
export const KNOWN_SUPABASE_PROJECT_URL = `https://${KNOWN_SUPABASE_PROJECT_REF}.supabase.co`;

const SUPABASE_URL =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) || KNOWN_SUPABASE_PROJECT_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as
  | string
  | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

const effectivePublicKey =
  SUPABASE_PUBLISHABLE_KEY && !SUPABASE_PUBLISHABLE_KEY.includes('placeholder')
    ? SUPABASE_PUBLISHABLE_KEY
    : SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.includes('placeholder')
      ? SUPABASE_ANON_KEY
      : undefined;

export const supabaseClient: SupabaseClient | null =
  SUPABASE_URL && !SUPABASE_URL.includes('your-project-ref') && effectivePublicKey
    ? createClient(SUPABASE_URL, effectivePublicKey)
    : null;

const SESSION_STORAGE_KEY = 'stopspend_active_session_v1';
const OFFLINE_QUEUE_STORAGE_KEY = 'stopspend_device_offline_queue_v1';

export function getUserStateStorageKey(userId: string): string {
  return `stopspend_user_state_v1_${userId}`;
}

export function createInitialUserState(
  userId: string,
  displayName: string = 'Jared',
  nowInstantUtc: string = new Date().toISOString()
): AppUserState {
  const madridNow = getMadridDateParts(nowInstantUtc);
  const periodKey = madridNow.periodKey;

  const cashAccount = createAccount({
    id: 'acc_cash_main',
    userId,
    name: 'Efectivo en mano',
    type: 'cash',
    includeInLiquidity: true,
    createdAtUtc: nowInstantUtc,
  });

  const bankAccount = createAccount({
    id: 'acc_bank_caixabank',
    userId,
    name: 'Cuenta CaixaBank',
    type: 'bank',
    includeInLiquidity: true,
    providerCode: 'enable_banking',
    createdAtUtc: nowInstantUtc,
  });

  const savingsAccount = createAccount({
    id: 'acc_savings_excluded',
    userId,
    name: 'Cuenta Ahorro Separada',
    type: 'savings',
    includeInLiquidity: false,
    createdAtUtc: nowInstantUtc,
  });

  const defaultAllocation = createBudgetAllocation({
    id: `bud_${periodKey}`,
    userId,
    periodKey,
    confirmedByUser: false, // Requires explicit user confirmation in onboarding!
    protectedSavingsAllocatedCents: PERSONAL_ENVELOPE_TEMPLATE_EUR.protectedSavingsAllocationCents,
    smallPurchasesAllocatedCents: PERSONAL_ENVELOPE_TEMPLATE_EUR.smallPurchasesAllocationCents,
    flexibleSpendingAllocatedCents: PERSONAL_ENVELOPE_TEMPLATE_EUR.flexibleSpendingAllocationCents,
  });

  const envModeRaw = (import.meta.env.VITE_BANK_PROVIDER_MODE as string | undefined) ?? 'unconfigured';
  const bankMode: ProviderEnvironmentMode =
    envModeRaw === 'sandbox' || envModeRaw === 'production' ? envModeRaw : 'unconfigured';

  return {
    userId,
    displayName,
    currentPeriodKey: periodKey,
    onboardingConfirmed: false,
    plannedMonthlyIncomeCents: 0,
    refundPolicy: 'CREDIT_CURRENT_PERIOD',
    rememberedAccountId: bankAccount.id,
    rememberedCategoryId: 'coffee_snacks',
    accounts: [cashAccount, bankAccount, savingsAccount],
    // Invariant (Acceptance Test 22 & 23): Never seed fake balances or transactions!
    // Liquidity starts as `null` ("Desconocido") until user enters opening funds or connects bank.
    snapshots: [],
    sourceRecords: [],
    transactions: [],
    auditLinks: [],
    budgetAllocations: {
      [periodKey]: defaultAllocation,
    },
    obligations: [],
    savingsReservations: [],
    categorizationRules: [],
    handledThresholds: [],
    alertOutbox: [],
    csvBatches: [],
    bankConfig: {
      mode: bankMode,
      hasValidSession: false,
      hasSuccessfulRealRead: false,
      localSyncPaused: false,
      sessionRevoked: false,
      lastSyncUtc: null,
      lastSyncError: null,
    },
    pushConfig: {
      permissionState: 'default',
      subscribedEndpoint: null,
      includeSensitiveAmountsInPush: false,
      quietHoursEnabled: true,
      quietHoursStart: 22,
      quietHoursEnd: 8,
    },
    offlineModeEnabled: true,
    simulateNetworkOffline: false,
    simulateNextApiError: false,
  };
}

export function loadActiveSession(): UserSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as UserSession;
  } catch {
    return null;
  }
}

export function saveActiveSession(session: UserSession | null): void {
  if (!session) {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function loadUserState(userId: string, displayName: string = 'Jared'): AppUserState {
  try {
    const raw = localStorage.getItem(getUserStateStorageKey(userId));
    if (!raw) {
      return createInitialUserState(userId, displayName);
    }
    return JSON.parse(raw) as AppUserState;
  } catch {
    return createInitialUserState(userId, displayName);
  }
}

export function saveUserState(state: AppUserState): void {
  localStorage.setItem(getUserStateStorageKey(state.userId), JSON.stringify(state));
}

export function clearUserFinancialCacheOnDevice(userId: string): void {
  localStorage.removeItem(getUserStateStorageKey(userId));
}

export function loadDeviceOfflineQueue(): OfflineQueuedExpense[] {
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as OfflineQueuedExpense[];
  } catch {
    return [];
  }
}

export function saveDeviceOfflineQueue(queue: readonly OfflineQueuedExpense[]): void {
  localStorage.setItem(OFFLINE_QUEUE_STORAGE_KEY, JSON.stringify(queue));
}

export function getTodayMadridCalendarDate(): CalendarDateISO {
  return getMadridDateParts(new Date().toISOString()).calendarDate;
}
