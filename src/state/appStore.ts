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
  /** Whether the user has completed the initial Bank-First Welcome screen */
  bankOnboardingCompleted: boolean;
  bankConnectedChoice: 'pending' | 'connected' | 'skipped';
  /** Selected bank account ID or 'all_bank' for the Home "Saldo en tu banco" card */
  selectedHomeBankScope: 'all_bank' | string;
  /** Whether a monthly spending budget has been explicitly configured by the user */
  onboardingConfirmed: boolean;
  /** True if an existing confirmed budget matches the legacy 174/94/80/40 EUR template */
  hasLegacyTemplateBudget: boolean;
  /** Budget scope: whether non-personal transactions are excluded from the monthly budget limit */
  budgetScopeMode: 'personal_only' | 'all_spending';
  /** Which account IDs count toward the user's monthly spending budget */
  budgetSelectedAccountIds: string[];
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

function getEnvVar(key: string): string | undefined {
  try {
    const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
    return meta?.env?.[key];
  } catch {
    return undefined;
  }
}

export const KNOWN_SUPABASE_PROJECT_REF = 'zsnvclyoypabmgqqaizj';
export const KNOWN_SUPABASE_PROJECT_URL = `https://${KNOWN_SUPABASE_PROJECT_REF}.supabase.co`;

const SUPABASE_URL =
  getEnvVar('VITE_SUPABASE_URL') || KNOWN_SUPABASE_PROJECT_URL;
const SUPABASE_PUBLISHABLE_KEY = getEnvVar('VITE_SUPABASE_PUBLISHABLE_KEY');
const SUPABASE_ANON_KEY = getEnvVar('VITE_SUPABASE_ANON_KEY');

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

/**
 * Checks whether a budget allocation matches the legacy 174 / 94 / 80 / 40 EUR onboarding template.
 */
export function isLegacyDefaultTemplateAllocation(
  alloc: BudgetPeriodAllocation | undefined | null
): boolean {
  if (!alloc) return false;
  return (
    alloc.protectedSavingsAllocatedCents ===
      PERSONAL_ENVELOPE_TEMPLATE_EUR.protectedSavingsAllocationCents &&
    alloc.smallPurchasesAllocatedCents ===
      PERSONAL_ENVELOPE_TEMPLATE_EUR.smallPurchasesAllocationCents &&
    alloc.flexibleSpendingAllocatedCents ===
      PERSONAL_ENVELOPE_TEMPLATE_EUR.flexibleSpendingAllocationCents &&
    alloc.totalPersonalAllocatedCents ===
      PERSONAL_ENVELOPE_TEMPLATE_EUR.totalPersonalAllocationCents
  );
}

export function createInitialUserState(
  userId: string,
  displayName: string = 'Jared',
  nowInstantUtc: string = new Date().toISOString()
): AppUserState {
  const madridNow = getMadridDateParts(nowInstantUtc);
  const periodKey = madridNow.periodKey;

  const cashAccountId = userId ? `acc_cash_main_${userId}` : 'acc_cash_main';
  const bankAccountId = userId ? `acc_bank_caixabank_${userId}` : 'acc_bank_caixabank';
  const savingsAccountId = userId ? `acc_savings_excluded_${userId}` : 'acc_savings_excluded';

  const cashAccount = createAccount({
    id: cashAccountId,
    userId,
    name: 'Efectivo en mano',
    type: 'cash',
    includeInLiquidity: true,
    createdAtUtc: nowInstantUtc,
  });

  const bankAccount = createAccount({
    id: bankAccountId,
    userId,
    name: 'Cuenta CaixaBank',
    type: 'bank',
    includeInLiquidity: true,
    providerCode: 'enable_banking',
    ibanMasked: 'ES12 **** **** 3456',
    createdAtUtc: nowInstantUtc,
  });

  const savingsAccount = createAccount({
    id: savingsAccountId,
    userId,
    name: 'Cuenta Ahorro Separada',
    type: 'savings',
    includeInLiquidity: false,
    createdAtUtc: nowInstantUtc,
  });

  const envModeRaw =
    getEnvVar('VITE_BANK_PROVIDER_MODE') ?? 'unconfigured';
  const bankMode: ProviderEnvironmentMode =
    envModeRaw === 'sandbox' || envModeRaw === 'production' ? envModeRaw : 'unconfigured';

  return {
    userId,
    displayName,
    currentPeriodKey: periodKey,
    bankOnboardingCompleted: false,
    bankConnectedChoice: 'pending',
    selectedHomeBankScope: bankAccount.id,
    // Requirement 1: Remove automatic 174/94/80/40 EUR setup. Never create or confirm a budget without the user choosing it!
    onboardingConfirmed: false,
    hasLegacyTemplateBudget: false,
    budgetScopeMode: 'personal_only',
    budgetSelectedAccountIds: [bankAccount.id, cashAccount.id],
    plannedMonthlyIncomeCents: 0,
    refundPolicy: 'CREDIT_CURRENT_PERIOD',
    rememberedAccountId: bankAccount.id,
    rememberedCategoryId: 'coffee_snacks',
    accounts: [cashAccount, bankAccount, savingsAccount],
    // Invariant: Never seed fake balances or transactions!
    snapshots: [],
    sourceRecords: [],
    transactions: [],
    auditLinks: [],
    budgetAllocations: {},
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

/**
 * Normalizes and upgrades a loaded `AppUserState` so that:
 * 1. `currentPeriodKey` always rolls over to the current `Europe/Madrid` month on session load.
 * 2. Unconfirmed legacy 174/94/80/40 placeholder budgets are removed (never treated as user-created).
 * 3. Confirmed legacy 174/94/80/40 budgets are preserved (not silently deleted) and flagged with
 *    `hasLegacyTemplateBudget: true` so the user can explicitly reset them if desired.
 * 4. All genuine user-entered transactions, reconciliation links, and confirmed budgets survive intact.
 */
export function normalizeLoadedUserState(
  loaded: Partial<AppUserState> & { userId: string },
  displayNameFallback: string = 'Jared',
  nowInstantUtc: string = new Date().toISOString()
): AppUserState {
  const base = createInitialUserState(loaded.userId, displayNameFallback, nowInstantUtc);
  const currentMadridPeriod = getMadridDateParts(nowInstantUtc).periodKey;

  const cleanedAllocations: Record<PeriodMonthKey, BudgetPeriodAllocation> = {};
  let hasLegacyConfirmed = false;
  let anyConfirmedBudget = false;

  if (loaded.budgetAllocations) {
    for (const [pk, alloc] of Object.entries(loaded.budgetAllocations)) {
      if (!alloc) continue;
      if (!alloc.confirmedByUser && isLegacyDefaultTemplateAllocation(alloc)) {
        // Drop unconfirmed legacy preset template
        continue;
      }
      cleanedAllocations[pk as PeriodMonthKey] = alloc;
      if (alloc.confirmedByUser) {
        anyConfirmedBudget = true;
        if (isLegacyDefaultTemplateAllocation(alloc)) {
          hasLegacyConfirmed = true;
        }
      }
    }
  }

  const hasExistingUserActivity =
    (loaded.transactions && loaded.transactions.length > 0) ||
    (loaded.snapshots && loaded.snapshots.length > 0) ||
    anyConfirmedBudget;

  const bankOnboardingCompleted =
    typeof loaded.bankOnboardingCompleted === 'boolean'
      ? loaded.bankOnboardingCompleted
      : Boolean(hasExistingUserActivity);

  // If no budget for current month, check if previous month had repeatMonthly enabled
  let activeBudget = cleanedAllocations[currentMadridPeriod];
  if (!activeBudget) {
    const sortedKeys = (Object.keys(cleanedAllocations) as PeriodMonthKey[]).sort().reverse();
    for (const pk of sortedKeys) {
      const prev = cleanedAllocations[pk];
      if (prev?.confirmedByUser && prev?.repeatMonthly) {
        activeBudget = createBudgetAllocation({
          id: `bud_${currentMadridPeriod}`,
          userId: loaded.userId,
          periodKey: currentMadridPeriod,
          confirmedByUser: true,
          protectedSavingsAllocatedCents: prev.protectedSavingsAllocatedCents,
          smallPurchasesAllocatedCents: prev.smallPurchasesAllocatedCents,
          flexibleSpendingAllocatedCents: prev.flexibleSpendingAllocatedCents,
          rolloverFromPreviousCents: 0,
          manualAdjustmentsCents: 0,
          categoryAllocationsCents: { ...(prev.categoryAllocationsCents ?? {}) },
          scopeMode: prev.scopeMode,
          selectedAccountIds: [...(prev.selectedAccountIds ?? [])],
          repeatMonthly: true,
        });
        cleanedAllocations[currentMadridPeriod] = activeBudget;
        break;
      }
    }
  }

  const effectiveScopeMode =
    activeBudget?.scopeMode ?? loaded.budgetScopeMode ?? 'personal_only';
  const effectiveSelectedAccountIds =
    activeBudget?.selectedAccountIds && activeBudget.selectedAccountIds.length > 0
      ? activeBudget.selectedAccountIds
      : loaded.budgetSelectedAccountIds && loaded.budgetSelectedAccountIds.length > 0
        ? loaded.budgetSelectedAccountIds
        : base.budgetSelectedAccountIds;

  return {
    ...base,
    ...loaded,
    currentPeriodKey: currentMadridPeriod,
    bankOnboardingCompleted,
    bankConnectedChoice:
      loaded.bankConnectedChoice ?? (bankOnboardingCompleted ? 'skipped' : 'pending'),
    selectedHomeBankScope: loaded.selectedHomeBankScope ?? base.selectedHomeBankScope,
    onboardingConfirmed: Boolean(cleanedAllocations[currentMadridPeriod]?.confirmedByUser),
    hasLegacyTemplateBudget: hasLegacyConfirmed,
    budgetScopeMode: effectiveScopeMode,
    budgetSelectedAccountIds: effectiveSelectedAccountIds,
    budgetAllocations: cleanedAllocations,
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

export function loadUserState(
  userId: string,
  displayName: string = 'Jared',
  nowInstantUtc: string = new Date().toISOString()
): AppUserState {
  try {
    const raw = localStorage.getItem(getUserStateStorageKey(userId));
    if (!raw) {
      return createInitialUserState(userId, displayName, nowInstantUtc);
    }
    const parsed = JSON.parse(raw) as Partial<AppUserState> & { userId: string };
    return normalizeLoadedUserState(parsed, displayName, nowInstantUtc);
  } catch {
    return createInitialUserState(userId, displayName, nowInstantUtc);
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

export function getTodayMadridCalendarDate(
  nowInstantUtc: string = new Date().toISOString()
): CalendarDateISO {
  return getMadridDateParts(nowInstantUtc).calendarDate;
}
