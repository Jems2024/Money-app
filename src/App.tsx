import React, { useState, useEffect, useMemo } from 'react';
import {
  Home,
  ListOrdered,
  Wallet,
  FileSpreadsheet,
  Settings,
  PlusCircle,
  Calculator,
  Info,
  RotateCcw,
  Upload,
  Download,
  Lock,
  WifiOff,
  Wifi,
  Bell,
  Building2,
  LogOut,
  Trash2,
  Edit3,
  RefreshCw,
  FileText,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
} from 'lucide-react';
import {
  addCents,
  centsToSpanishDecimal,
  formatEur,
  parseMoneyToCents,
  subtractCents,
} from './domain/money';
import { CalendarDateISO, getMadridDateParts, PeriodMonthKey } from './domain/dates/madrid';
import {
  CanonicalTransaction,
  ObligationReservation,
  SpendingScope,
} from './domain/ledger';
import {
  calculateEstimatedUncommittedLiquidity,
  calculatePersonalEnvelopes,
  createBudgetAllocation,
  HowItIsCalculatedBreakdown,
  settleObligationWithPayment,
} from './domain/budgets';
import {
  AlertOutboxEvent,
  evaluateBudgetThresholdCrossing,
  HandledThresholdRecord,
} from './domain/alerts';
import { DEFAULT_SPANISH_CATEGORIES } from './domain/categorization';
import {
  commitCsvImportBatch,
  exportTransactionsToSpanishCsv,
  previewCsvStatement,
} from './domain/csv';
import {
  enqueueOfflineExpense,
  evaluateLogoutSafety,
  flushOfflineQueueForUser,
  OfflineQueuedExpense,
} from './domain/offline';
import {
  calculateBankBalanceCardSummary,
  exportMonthlyReportToCsv,
  formatPeriodMonthLabelSpanish,
  generateMonthlyFinancialReport,
  ReportAccountScope,
} from './domain/reports';
import { generateMonthlyReportPdf } from './domain/reports/pdfGenerator';
import { resolveBankConnectionStatusBadge } from './server/providers/enableBanking';
import {
  AppUserState,
  clearUserFinancialCacheOnDevice,
  createInitialUserState,
  getTodayMadridCalendarDate,
  isLegacyDefaultTemplateAllocation,
  loadActiveSession,
  loadDeviceOfflineQueue,
  loadUserState,
  saveActiveSession,
  saveDeviceOfflineQueue,
  saveUserState,
  supabaseClient,
  UserSession,
} from './state/appStore';
import {
  deleteObligationFromSupabase,
  deleteTransactionFromSupabase,
  fetchUserStateFromSupabase,
  persistBudgetAllocationToSupabase,
  persistObligationToSupabase,
  persistTransactionToSupabase,
  updateTransactionInSupabase,
} from './state/supabaseRepository';
import {
  BudgetSetupModal,
  HowItIsCalculatedModal,
  PurchaseSimulatorModal,
  QuickExpenseModal,
} from './components/Modals';

type ActiveTab = 'inicio' | 'movimientos' | 'presupuesto' | 'informes' | 'ajustes';

function triggerBrowserFileDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export const App: React.FC = () => {
  // 1. Private Auth Session State
  const [session, setSession] = useState<UserSession | null>(() => loadActiveSession());
  const [authEmail, setAuthEmail] = useState('jared@stopspend.es');
  const [authPasscode, setAuthPasscode] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);

  // 2. Per-User App State & Device Offline Queue
  const [appState, setAppState] = useState<AppUserState>(() =>
    session
      ? loadUserState(session.userId, session.displayName)
      : createInitialUserState('user_jared')
  );
  const [offlineQueue, setOfflineQueue] = useState<OfflineQueuedExpense[]>(() =>
    loadDeviceOfflineQueue()
  );
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
    };
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // 3. Navigation & Selected Month (defaults dynamically to current Europe/Madrid month!)
  const [activeTab, setActiveTab] = useState<ActiveTab>('inicio');
  const [selectedPeriodKey, setSelectedPeriodKey] = useState<PeriodMonthKey>(() =>
    getMadridDateParts(new Date().toISOString()).periodKey
  );
  const [reportAccountScope, setReportAccountScope] =
    useState<ReportAccountScope>('all_owned');

  // 4. UI Modal & Onboarding States
  const [isBudgetModalOpen, setIsBudgetModalOpen] = useState(false);
  const [isQuickExpenseOpen, setIsQuickExpenseOpen] = useState(false);
  const [quickExpenseInitialAmount, setQuickExpenseInitialAmount] = useState('');
  const [quickExpenseInitialSmall, setQuickExpenseInitialSmall] = useState(true);
  const [isSimulatorOpen, setIsSimulatorOpen] = useState(false);
  const [activeBreakdown, setActiveBreakdown] =
    useState<HowItIsCalculatedBreakdown | null>(null);
  const [showUnconfiguredBankMessage, setShowUnconfiguredBankMessage] = useState(false);
  const [isRefreshingBank, setIsRefreshingBank] = useState(false);
  const [lastGeneratedPdfMeta, setLastGeneratedPdfMeta] = useState<{
    filename: string;
    pageCount: number;
    byteLength: number;
    previewText: string;
  } | null>(null);

  // Undo Toast & Status Feedback
  const [undoTransactionId, setUndoTransactionId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<{
    text: string;
    type: 'success' | 'warning' | 'error';
  } | null>(null);

  // Movements Filter & Edit States
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategoryId, setFilterCategoryId] = useState<string>('all');
  const [filterScope, setFilterScope] = useState<'all' | 'personal' | 'non_personal'>('all');
  const [editingTxId, setEditingTxId] = useState<string | null>(null);
  const [editAmountInput, setEditAmountInput] = useState('');
  const [editDescriptionInput, setEditDescriptionInput] = useState('');
  const [editCategoryId, setEditCategoryId] = useState('coffee_snacks');

  // CSV Import States
  const [csvRawText, setCsvRawText] = useState('');
  const [csvDelimiter, setCsvDelimiter] = useState<';' | ','>(';');
  const [csvDateFormat, setCsvDateFormat] = useState<'DD/MM/YYYY' | 'YYYY-MM-DD'>(
    'DD/MM/YYYY'
  );
  const [csvTargetAccountId, setCsvTargetAccountId] = useState('');

  // Advanced / Optional Cash & Obligations Inputs
  const [cashIncomeAmountInput, setCashIncomeAmountInput] = useState('');
  const [newObligationName, setNewObligationName] = useState('');
  const [newObligationAmount, setNewObligationAmount] = useState('');
  const [deleteConfirmInput, setDeleteConfirmInput] = useState('');
  const [logoutWarningModal, setLogoutWarningModal] = useState<string | null>(null);

  // Handle PSD2 / OAuth callback query parameters safely (`?code=...&state=...`)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hasCallbackParams = params.has('code') && params.has('state');
    if (hasCallbackParams) {
      // Remove sensitive query parameters immediately from browser address bar
      const cleanUrl = `${window.location.origin}${window.location.pathname}`;
      window.history.replaceState({}, document.title, cleanUrl);
      setToastMessage({
        text: 'Retorno de autorización bancaria procesado de forma segura.',
        type: 'success',
      });
    }
  }, []);

  // Sync user state whenever session changes
  useEffect(() => {
    if (!session) return;
    const loadedLocal = loadUserState(session.userId, session.displayName);
    setAppState(loadedLocal);
    setSelectedPeriodKey(loadedLocal.currentPeriodKey);

    if (supabaseClient) {
      fetchUserStateFromSupabase(supabaseClient, session.userId, session.displayName)
        .then((remoteState) => {
          setAppState(remoteState);
          setSelectedPeriodKey(remoteState.currentPeriodKey);
          saveUserState(remoteState);
        })
        .catch(() => {
          // Preserve local state if offline
        });
    }
  }, [session]);

  useEffect(() => {
    if (session) {
      saveUserState(appState);
    }
  }, [appState, session]);

  useEffect(() => {
    saveDeviceOfflineQueue(offlineQueue);
  }, [offlineQueue]);

  // Available Period Month Keys for selectors (always includes current Europe/Madrid month + recent months + any month with data)
  const availablePeriodKeys = useMemo(() => {
    const currentMadrid = getMadridDateParts(new Date().toISOString());
    const set = new Set<PeriodMonthKey>([
      currentMadrid.periodKey,
      appState.currentPeriodKey,
      selectedPeriodKey,
    ]);
    // Add previous 5 months from current Europe/Madrid date
    let y = currentMadrid.year;
    let m = currentMadrid.month;
    for (let i = 0; i < 6; i++) {
      const pk = `${y}-${String(m).padStart(2, '0')}` as PeriodMonthKey;
      set.add(pk);
      m -= 1;
      if (m < 1) {
        m = 12;
        y -= 1;
      }
    }
    for (const tx of appState.transactions) {
      if (tx.bookingDate && tx.bookingDate.length >= 7) {
        set.add(tx.bookingDate.slice(0, 7) as PeriodMonthKey);
      }
    }
    for (const pk of Object.keys(appState.budgetAllocations)) {
      set.add(pk as PeriodMonthKey);
    }
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [appState.currentPeriodKey, appState.transactions, appState.budgetAllocations, selectedPeriodKey]);

  // User-configured budget for the selected month (or null if user hasn't set one!)
  const configuredBudgetForSelectedMonth = useMemo(() => {
    const existing = appState.budgetAllocations[selectedPeriodKey];
    if (existing && existing.confirmedByUser) {
      return existing;
    }
    return null;
  }, [appState.budgetAllocations, selectedPeriodKey]);

  // Fallback internal allocation for simulator/envelopes calculations when needed
  const internalAllocationForCalculations = useMemo(() => {
    if (configuredBudgetForSelectedMonth) {
      return configuredBudgetForSelectedMonth;
    }
    return createBudgetAllocation({
      id: `bud_unconfigured_${selectedPeriodKey}`,
      userId: appState.userId,
      periodKey: selectedPeriodKey,
      confirmedByUser: false,
      protectedSavingsAllocatedCents: 0,
      smallPurchasesAllocatedCents: 0,
      flexibleSpendingAllocatedCents: 0,
    });
  }, [configuredBudgetForSelectedMonth, selectedPeriodKey, appState.userId]);

  // Bank Balance Card Summary (Requirement 2A)
  const bankBalanceSummary = useMemo(
    () =>
      calculateBankBalanceCardSummary({
        accounts: appState.accounts,
        snapshots: appState.snapshots,
        transactions: appState.transactions,
        selectedBankScope: appState.selectedHomeBankScope,
        bankConfig: appState.bankConfig,
      }),
    [
      appState.accounts,
      appState.snapshots,
      appState.transactions,
      appState.selectedHomeBankScope,
      appState.bankConfig,
    ]
  );

  // Monthly Financial Report for `selectedPeriodKey` and `reportAccountScope` (Requirement 3 & 4)
  const monthlyReport = useMemo(
    () =>
      generateMonthlyFinancialReport({
        periodKey: selectedPeriodKey,
        accountScope: reportAccountScope,
        accounts: appState.accounts,
        transactions: appState.transactions,
        sourceRecords: appState.sourceRecords,
        budgetAllocation: configuredBudgetForSelectedMonth,
        budgetScopeMode: appState.budgetScopeMode,
        budgetSelectedAccountIds: appState.budgetSelectedAccountIds,
        refundPolicy: appState.refundPolicy,
        lastSyncUtc: appState.bankConfig.lastSyncUtc,
      }),
    [
      selectedPeriodKey,
      reportAccountScope,
      appState.accounts,
      appState.transactions,
      appState.sourceRecords,
      configuredBudgetForSelectedMonth,
      appState.budgetScopeMode,
      appState.budgetSelectedAccountIds,
      appState.refundPolicy,
      appState.bankConfig.lastSyncUtc,
    ]
  );

  // Home Monthly Summary (always scoped to all owned accounts for the selected month)
  const homeMonthReport = useMemo(
    () =>
      generateMonthlyFinancialReport({
        periodKey: selectedPeriodKey,
        accountScope: 'all_owned',
        accounts: appState.accounts,
        transactions: appState.transactions,
        sourceRecords: appState.sourceRecords,
        budgetAllocation: configuredBudgetForSelectedMonth,
        budgetScopeMode: appState.budgetScopeMode,
        budgetSelectedAccountIds: appState.budgetSelectedAccountIds,
        refundPolicy: appState.refundPolicy,
        lastSyncUtc: appState.bankConfig.lastSyncUtc,
      }),
    [
      selectedPeriodKey,
      appState.accounts,
      appState.transactions,
      appState.sourceRecords,
      configuredBudgetForSelectedMonth,
      appState.budgetScopeMode,
      appState.budgetSelectedAccountIds,
      appState.refundPolicy,
      appState.bankConfig.lastSyncUtc,
    ]
  );

  // Preserve internal domain calculations for Simulator & optional details
  const envelopesView = useMemo(
    () =>
      calculatePersonalEnvelopes({
        allocation: internalAllocationForCalculations,
        transactions: appState.transactions,
        accounts: appState.accounts,
        refundPolicy: appState.refundPolicy,
        lastSyncUtc: appState.bankConfig.lastSyncUtc,
      }),
    [
      internalAllocationForCalculations,
      appState.transactions,
      appState.accounts,
      appState.refundPolicy,
      appState.bankConfig.lastSyncUtc,
    ]
  );

  const liquidityView = useMemo(
    () =>
      calculateEstimatedUncommittedLiquidity({
        accounts: appState.accounts,
        snapshots: appState.snapshots,
        transactions: appState.transactions,
        obligations: appState.obligations,
        savingsReservations: appState.savingsReservations,
        periodKey: selectedPeriodKey,
        lastSyncUtc: appState.bankConfig.lastSyncUtc,
      }),
    [
      appState.accounts,
      appState.snapshots,
      appState.transactions,
      appState.obligations,
      appState.savingsReservations,
      selectedPeriodKey,
      appState.bankConfig.lastSyncUtc,
    ]
  );

  const bankStatusBadge = useMemo(
    () =>
      resolveBankConnectionStatusBadge({
        mode: appState.bankConfig.mode,
        hasValidSession: appState.bankConfig.hasValidSession,
        hasSuccessfulRealRead: appState.bankConfig.hasSuccessfulRealRead,
        localSyncPaused: appState.bankConfig.localSyncPaused,
        sessionRevoked: appState.bankConfig.sessionRevoked,
        lastSyncError: appState.bankConfig.lastSyncError,
      }),
    [appState.bankConfig]
  );

  const userPendingOfflineQueue = useMemo(
    () =>
      offlineQueue.filter(
        (q) => q.userId === appState.userId && q.syncStatus === 'pending_sync'
      ),
    [offlineQueue, appState.userId]
  );

  const ownedBankAccounts = useMemo(
    () => appState.accounts.filter((a) => a.isOwned && a.type === 'bank'),
    [appState.accounts]
  );

  const primaryBankAccount = useMemo(
    () => ownedBankAccounts[0] ?? appState.accounts.find((a) => a.type === 'bank') ?? appState.accounts[0],
    [ownedBankAccounts, appState.accounts]
  );

  const primaryCashAccount = useMemo(
    () => appState.accounts.find((a) => a.isOwned && a.type === 'cash') ?? appState.accounts[0],
    [appState.accounts]
  );

  useEffect(() => {
    if (!csvTargetAccountId && primaryBankAccount) {
      setCsvTargetAccountId(primaryBankAccount.id);
    }
  }, [primaryBankAccount, csvTargetAccountId]);

  // Recent 5 transactions for Home
  const recentFiveTransactions = useMemo(() => {
    return [...appState.transactions]
      .filter((tx) => tx.status !== 'superseded')
      .sort((a, b) => b.bookingDate.localeCompare(a.bookingDate))
      .slice(0, 5);
  }, [appState.transactions]);

  // Filtered Canonical Transactions for Movimientos tab
  const filteredTransactions = useMemo(() => {
    return appState.transactions.filter((tx) => {
      if (tx.status === 'superseded') return false;
      if (
        searchQuery.trim() &&
        !tx.description.toLowerCase().includes(searchQuery.trim().toLowerCase())
      ) {
        return false;
      }
      if (filterCategoryId !== 'all' && tx.categoryId !== filterCategoryId) {
        return false;
      }
      if (filterScope !== 'all' && tx.scope !== filterScope) {
        return false;
      }
      return true;
    });
  }, [appState.transactions, searchQuery, filterCategoryId, filterScope]);

  // CSV Preview
  const csvPreview = useMemo(() => {
    if (!csvRawText.trim()) return null;
    return previewCsvStatement(csvRawText, {
      dateColumnIndex: 0,
      descriptionColumnIndex: 1,
      amountColumnIndex: 2,
      currencyColumnIndex: 3,
      dateFormat: csvDateFormat,
      delimiter: csvDelimiter,
      hasHeaderRow: true,
    });
  }, [csvRawText, csvDateFormat, csvDelimiter]);

  // ============================================================================
  // HANDLERS
  // ============================================================================

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    const trimmedEmail = authEmail.trim().toLowerCase();
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      setAuthError('Introduce un correo electrónico válido.');
      return;
    }
    if (authPasscode.trim().length < 4) {
      setAuthError('Introduce tu clave privada (mínimo 4 caracteres).');
      return;
    }

    if (supabaseClient) {
      const { data, error } = await supabaseClient.auth.signInWithPassword({
        email: trimmedEmail,
        password: authPasscode,
      });
      if (error || !data.user) {
        setAuthError(
          error?.message ||
            'Error de autenticación en Supabase. Verifica tu usuario y contraseña.'
        );
        return;
      }
      const displayName =
        (data.user.user_metadata?.display_name as string | undefined) ||
        (trimmedEmail.startsWith('jared') ? 'Jared' : trimmedEmail.split('@')[0]!);
      const newSession: UserSession = {
        userId: data.user.id,
        email: trimmedEmail,
        displayName,
      };
      saveActiveSession(newSession);
      setSession(newSession);
      return;
    }

    const derivedUserId =
      trimmedEmail === 'jared@stopspend.es'
        ? 'user_jared'
        : `user_${trimmedEmail.replace(/[^a-z0-9]/g, '_')}`;
    const displayName = trimmedEmail.startsWith('jared')
      ? 'Jared'
      : trimmedEmail.split('@')[0]!;
    const newSession: UserSession = {
      userId: derivedUserId,
      email: trimmedEmail,
      displayName,
    };
    saveActiveSession(newSession);
    setSession(newSession);
  };

  // Requirement 1: Bank-First Onboarding Actions (Real Enable Banking Integration)
  const handleConnectMyBankClick = async () => {
    if (appState.bankConfig.mode === 'unconfigured' && (!supabaseClient || !session)) {
      setShowUnconfiguredBankMessage(true);
      return;
    }

    setIsRefreshingBank(true);
    try {
      if (!supabaseClient || !session) {
        setToastMessage({
          text: 'Inicia sesión para conectar tu cuenta de CaixaBank.',
          type: 'error',
        });
        return;
      }

      const { data, error } = await supabaseClient.functions.invoke('bank-auth', {
        body: {},
      });

      if (error || !data) {
        setShowUnconfiguredBankMessage(true);
        setToastMessage({
          text: 'La conexión bancaria todavía no está disponible.',
          type: 'warning',
        });
        return;
      }

      if (data.authorizationUrl) {
        // Official bank PSD2 authorization redirection
        window.location.href = data.authorizationUrl;
        return;
      }

      if (data.error === 'PROVIDER_UNCONFIGURED') {
        setShowUnconfiguredBankMessage(true);
        return;
      }

      setShowUnconfiguredBankMessage(true);
    } catch {
      setShowUnconfiguredBankMessage(true);
    } finally {
      setIsRefreshingBank(false);
    }
  };

  const handleContinueWithoutBank = () => {
    setShowUnconfiguredBankMessage(false);
    setAppState((prev) => ({
      ...prev,
      bankOnboardingCompleted: true,
      bankConnectedChoice: 'skipped',
    }));
  };

  const handleRefreshBankBalance = async () => {
    setIsRefreshingBank(true);
    try {
      if (!supabaseClient || !session) {
        setToastMessage({
          text: 'No pudimos actualizar tu saldo. Inténtalo de nuevo.',
          type: 'error',
        });
        return;
      }

      const { data, error } = await supabaseClient.functions.invoke('bank-sync', {
        body: {},
      });

      if (error || !data?.success) {
        const errorMsg = data?.messageSpanish || 'No pudimos actualizar tu saldo. Inténtalo de nuevo.';
        setAppState((prev) => ({
          ...prev,
          bankConfig: {
            ...prev.bankConfig,
            lastSyncError: errorMsg,
          },
        }));
        setToastMessage({
          text: errorMsg,
          type: 'error',
        });
        return;
      }

      const freshState = await fetchUserStateFromSupabase(
        supabaseClient,
        session.userId,
        session.displayName
      );
      setAppState(freshState);
      saveUserState(freshState);

      setToastMessage({
        text: 'Saldo y movimientos actualizados.',
        type: 'success',
      });
    } catch {
      setAppState((prev) => ({
        ...prev,
        bankConfig: {
          ...prev.bankConfig,
          lastSyncError: 'No pudimos contactar con el banco.',
        },
      }));
      setToastMessage({
        text: 'No pudimos actualizar tu saldo. Inténtalo de nuevo.',
        type: 'error',
      });
    } finally {
      setIsRefreshingBank(false);
    }
  };

  const handleDisconnectBank = async () => {
    try {
      if (supabaseClient && session) {
        await supabaseClient.functions.invoke('bank-auth', {
          body: { action: 'disconnect' },
        });
      }
    } catch {
      // Proceed with local update
    }
    setAppState((prev) => ({
      ...prev,
      bankConfig: {
        ...prev.bankConfig,
        hasValidSession: false,
        sessionRevoked: true,
      },
    }));
    setToastMessage({
      text: 'Sesión bancaria eliminada en el proveedor.',
      type: 'warning',
    });
  };

  // Requirement 2B: Save Monthly Budget (Does NOT alter bank balance!)
  const handleSaveMonthlyBudget = (params: {
    monthlyLimitCents: number;
    categoryLimitsCents: Record<string, number>;
    scopeMode: 'personal_only' | 'all_spending';
    selectedAccountIds: string[];
  }) => {
    const newAlloc = createBudgetAllocation({
      id: `bud_${selectedPeriodKey}`,
      userId: appState.userId,
      periodKey: selectedPeriodKey,
      confirmedByUser: true,
      protectedSavingsAllocatedCents: 0,
      smallPurchasesAllocatedCents: 0,
      flexibleSpendingAllocatedCents: params.monthlyLimitCents,
      categoryAllocationsCents: params.categoryLimitsCents,
    });

    setAppState((prev) => ({
      ...prev,
      onboardingConfirmed: true,
      hasLegacyTemplateBudget: isLegacyDefaultTemplateAllocation(newAlloc),
      budgetScopeMode: params.scopeMode,
      budgetSelectedAccountIds: params.selectedAccountIds,
      budgetAllocations: {
        ...prev.budgetAllocations,
        [selectedPeriodKey]: newAlloc,
      },
    }));

    if (supabaseClient) {
      void persistBudgetAllocationToSupabase({
        client: supabaseClient,
        authenticatedUserId: appState.userId,
        allocation: newAlloc,
      }).catch((err) => {
        setToastMessage({
          text:
            err instanceof Error
              ? err.message
              : 'Error al sincronizar presupuesto con Supabase.',
          type: 'error',
        });
      });
    }

    setIsBudgetModalOpen(false);
    setToastMessage({
      text: `Presupuesto mensual de ${formatEur(params.monthlyLimitCents)} guardado para ${formatPeriodMonthLabelSpanish(selectedPeriodKey)}. El saldo de tu banco no cambia.`,
      type: 'success',
    });
  };

  // Requirement 5: Explicit reset of old 174/94/80/40 EUR template while preserving transactions
  const handleResetLegacyTemplateBudget = () => {
    setAppState((prev) => {
      const nextBudgets: Record<PeriodMonthKey, typeof internalAllocationForCalculations> = {};
      for (const [pk, alloc] of Object.entries(prev.budgetAllocations)) {
        if (!isLegacyDefaultTemplateAllocation(alloc)) {
          nextBudgets[pk as PeriodMonthKey] = alloc;
        }
      }
      return {
        ...prev,
        onboardingConfirmed: Boolean(nextBudgets[prev.currentPeriodKey]?.confirmedByUser),
        hasLegacyTemplateBudget: false,
        budgetAllocations: nextBudgets,
        savingsReservations: prev.savingsReservations.filter(
          (s) => s.protectedAmountCents !== 8000
        ),
      };
    });
    setToastMessage({
      text: 'Plantilla antigua (174 € / 94 € / 80 €) restablecida. Tus movimientos se han conservado intactos.',
      type: 'success',
    });
  };

  const evaluateThresholdsAfterSpendChange = (
    prevState: AppUserState,
    nextTransactions: CanonicalTransaction[],
    suppressAlerts: boolean = false
  ): {
    handledThresholds: HandledThresholdRecord[];
    alertOutbox: AlertOutboxEvent[];
    latestEmitted: AlertOutboxEvent | null;
  } => {
    const alloc = prevState.budgetAllocations[prevState.currentPeriodKey];
    if (!alloc || !alloc.confirmedByUser) {
      return {
        handledThresholds: prevState.handledThresholds,
        alertOutbox: prevState.alertOutbox,
        latestEmitted: null,
      };
    }

    const beforeEnv = calculatePersonalEnvelopes({
      allocation: alloc,
      transactions: prevState.transactions,
      accounts: prevState.accounts,
    });
    const afterEnv = calculatePersonalEnvelopes({
      allocation: alloc,
      transactions: nextTransactions,
      accounts: prevState.accounts,
    });

    const totalEval = evaluateBudgetThresholdCrossing({
      userId: prevState.userId,
      budgetId: 'personal_spendable_total',
      budgetName: 'Presupuesto del mes',
      periodKey: prevState.currentPeriodKey,
      budgetAllocatedCents: afterEnv.spendableAllocatedCents,
      spentBeforeCents: beforeEnv.totalPersonalNetSpentCents,
      spentAfterCents: afterEnv.totalPersonalNetSpentCents,
      existingHandledRecords: prevState.handledThresholds,
      existingOutboxEvents: prevState.alertOutbox,
      suppressAlertEmission: suppressAlerts,
      includeSensitiveAmountsInPush: prevState.pushConfig.includeSensitiveAmountsInPush,
      quietHoursConfig: {
        enabled: prevState.pushConfig.quietHoursEnabled,
        startHour: prevState.pushConfig.quietHoursStart,
        endHour: prevState.pushConfig.quietHoursEnd,
      },
    });

    return {
      handledThresholds: totalEval.updatedHandledRecords,
      alertOutbox: totalEval.updatedOutboxEvents,
      latestEmitted: totalEval.emittedEvent,
    };
  };

  const handleSaveQuickExpense = (params: {
    amountCents: number;
    description: string;
    categoryId: string;
    accountId: string;
    bookingDate: CalendarDateISO;
    scope: SpendingScope;
    smallSpendingTagged: boolean;
    userNote: string | null;
  }) => {
    if (!isOnline) {
      const clientIdempotencyKey = `idem_${Date.now()}`;
      const nextQueue = enqueueOfflineExpense({
        queue: offlineQueue,
        entry: {
          clientIdempotencyKey,
          userId: appState.userId,
          accountId: params.accountId,
          amountCents: -Math.abs(params.amountCents),
          description: params.description,
          categoryId: params.categoryId,
          scope: params.scope,
          smallSpendingTagged: params.smallSpendingTagged,
          bookingDate: params.bookingDate,
          occurredAtUtc: new Date().toISOString(),
          userNote: params.userNote,
        },
      });
      setOfflineQueue(nextQueue);
      setIsQuickExpenseOpen(false);
      setToastMessage({
        text: 'Sin conexión: gasto guardado en la cola local ("Pendiente de sincronizar").',
        type: 'warning',
      });
      return;
    }

    const targetAccount = appState.accounts.find((a) => a.id === params.accountId);
    const txId = `tx_manual_${Date.now()}`;
    const newTx: CanonicalTransaction = {
      id: txId,
      userId: appState.userId,
      accountId: params.accountId,
      type: 'expense',
      status: targetAccount?.type === 'bank' ? 'provisional' : 'booked',
      amountCents: -Math.abs(params.amountCents),
      currency: 'EUR',
      bookingDate: params.bookingDate,
      valueDate: params.bookingDate,
      occurredAtUtc: new Date().toISOString(),
      createdAtUtc: new Date().toISOString(),
      description: params.description,
      merchantNormalized: params.description.toUpperCase().trim(),
      userNote: params.userNote,
      categoryId: params.categoryId,
      categorySource: 'user_locked',
      categoryConfidence: 100,
      categoryExplanation: 'Introducido manualmente por el usuario',
      scope: params.scope,
      smallSpendingTagged: params.smallSpendingTagged,
      splits: [],
      linkedExpenseId: null,
      transferPairId: null,
      counterpartAccountId: null,
      untrackedOwnedDestinationLabel: null,
      settledObligationId: null,
      consumedSavingsReservationId: null,
      supersededByTransactionId: null,
      reviewStatus: 'none',
      sourceRecordIds: [`src_${txId}`],
    };

    setAppState((prev) => {
      const nextTxs = [newTx, ...prev.transactions];
      const alertEval = evaluateThresholdsAfterSpendChange(prev, nextTxs, false);
      if (alertEval.latestEmitted) {
        setToastMessage({
          text: alertEval.latestEmitted.inAppTitleSpanish,
          type: 'warning',
        });
      } else {
        setToastMessage({
          text: `Gasto de ${formatEur(params.amountCents)} guardado.`,
          type: 'success',
        });
      }
      if (supabaseClient && targetAccount) {
        void persistTransactionToSupabase({
          client: supabaseClient,
          authenticatedUserId: prev.userId,
          transaction: newTx,
          targetAccount,
          newHandledThresholds: alertEval.handledThresholds,
          newAlertEvents: alertEval.alertOutbox,
        }).catch((err) => {
          setToastMessage({
            text:
              err instanceof Error ? err.message : 'Error al persistir en Supabase.',
            type: 'error',
          });
        });
      }

      return {
        ...prev,
        rememberedAccountId: params.accountId,
        rememberedCategoryId: params.categoryId,
        transactions: nextTxs,
        handledThresholds: alertEval.handledThresholds,
        alertOutbox: alertEval.alertOutbox,
      };
    });

    setUndoTransactionId(txId);
    setIsQuickExpenseOpen(false);
  };

  const handleUndoLastExpense = () => {
    if (!undoTransactionId) return;
    const txToUndo = appState.transactions.find((t) => t.id === undoTransactionId);
    if (supabaseClient && txToUndo) {
      void deleteTransactionFromSupabase({
        client: supabaseClient,
        authenticatedUserId: appState.userId,
        transaction: txToUndo,
      });
    }
    setAppState((prev) => ({
      ...prev,
      transactions: prev.transactions.filter((t) => t.id !== undoTransactionId),
    }));
    setUndoTransactionId(null);
    setToastMessage({
      text: 'Último gasto deshecho correctamente.',
      type: 'success',
    });
  };

  const handleReconnectAndFlushOfflineQueue = () => {
    const res = flushOfflineQueueForUser({
      activeUserId: appState.userId,
      queue: offlineQueue,
      existingTransactions: appState.transactions,
    });
    setOfflineQueue(res.updatedQueue);
    setAppState((prev) => {
      const alertEval = evaluateThresholdsAfterSpendChange(prev, res.transactions, false);
      return {
        ...prev,
        transactions: res.transactions,
        handledThresholds: alertEval.handledThresholds,
        alertOutbox: alertEval.alertOutbox,
      };
    });
    setToastMessage({
      text: `Cola sincronizada: ${res.uploadedCount} movimiento(s) subidos (${res.deduplicatedNoopCount} duplicados omitidos).`,
      type: 'success',
    });
  };

  // Requirement 4: Download PDF & CSV Report Handlers
  const handleDownloadReportPdf = () => {
    const generated = generateMonthlyReportPdf(monthlyReport);
    const blob = new Blob([new Uint8Array(generated.bytes)], { type: 'application/pdf' });
    triggerBrowserFileDownload(blob, generated.filename);
    setLastGeneratedPdfMeta({
      filename: generated.filename,
      pageCount: generated.pageCount,
      byteLength: generated.bytes.byteLength,
      previewText: generated.plainTextPages.join('\n--- PAGE BREAK ---\n'),
    });
    setToastMessage({
      text: `Informe PDF descargado (${generated.filename} · ${generated.pageCount} página(s)).`,
      type: 'success',
    });
  };

  const handleDownloadReportCsv = () => {
    const csvContent = exportMonthlyReportToCsv(monthlyReport);
    const filename = `informe-stop-spend-${monthlyReport.periodKey}.csv`;
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    triggerBrowserFileDownload(blob, filename);
    setToastMessage({
      text: `Informe CSV descargado (${filename}) con protección contra inyección de fórmulas.`,
      type: 'success',
    });
  };

  // ============================================================================
  // RENDER 1: PRIVATE AUTHENTICATION SCREEN IF NOT SIGNED IN
  // ============================================================================
  if (!session) {
    return (
      <div className="min-h-dvh bg-slate-950 text-slate-100 flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-800 p-6 shadow-2xl space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-emerald-500/10 border border-emerald-500/40 flex items-center justify-center text-emerald-400 font-bold text-xl">
              €
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-slate-100">STOP SPEND</h1>
              <p className="text-xs text-slate-400">
                Tu banco, tus gastos y tus informes · España (EUR)
              </p>
            </div>
          </div>

          <div className="rounded-xl bg-slate-950/90 border border-slate-800 p-3 text-xs text-slate-300 space-y-1">
            <div className="flex items-center gap-1.5 text-emerald-400 font-semibold">
              <Lock className="w-3.5 h-3.5" />
              <span>Aplicación personal de acceso privado</span>
            </div>
            <p className="text-slate-400">
              Sin registro público, sin publicidad y sin pedir nunca tus claves bancarias.
            </p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label
                htmlFor="auth-email"
                className="block text-xs font-semibold text-slate-300 mb-1"
              >
                Correo del titular
              </label>
              <input
                id="auth-email"
                data-testid="auth-email-input"
                type="email"
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                className="w-full min-h-[48px] rounded-xl bg-slate-950 border border-slate-700 px-3.5 text-sm text-slate-100"
              />
            </div>

            <div>
              <label
                htmlFor="auth-pass"
                className="block text-xs font-semibold text-slate-300 mb-1"
              >
                Clave de acceso privado
              </label>
              <input
                id="auth-pass"
                data-testid="auth-password-input"
                type="password"
                placeholder="Introduce tu clave..."
                value={authPasscode}
                onChange={(e) => setAuthPasscode(e.target.value)}
                className="w-full min-h-[48px] rounded-xl bg-slate-950 border border-slate-700 px-3.5 text-sm text-slate-100"
              />
            </div>

            {authError && (
              <div
                role="alert"
                className="rounded-xl bg-rose-950/60 border border-rose-700 p-3 text-xs text-rose-200"
              >
                {authError}
              </div>
            )}

            <button
              type="submit"
              data-testid="auth-submit-button"
              className="w-full min-h-[48px] rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm shadow-lg shadow-emerald-950/50"
            >
              Entrar
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ============================================================================
  // RENDER 2: BANK-FIRST ONBOARDING WELCOME SCREEN (Requirement 1)
  // ============================================================================
  if (!appState.bankOnboardingCompleted) {
    return (
      <div className="min-h-dvh bg-slate-950 text-slate-100 flex items-center justify-center p-4">
        <div
          data-testid="bank-onboarding-screen"
          className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-800 p-6 shadow-2xl space-y-5"
        >
          <div className="w-12 h-12 rounded-2xl bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
            <Building2 className="w-6 h-6" />
          </div>

          <div className="space-y-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
              Bienvenido a STOP SPEND
            </span>
            <h1
              data-testid="bank-onboarding-title"
              className="text-2xl font-extrabold tracking-tight text-slate-50"
            >
              Conecta tu banco para ver tu saldo y tus movimientos.
            </h1>
            <p className="text-xs text-slate-400 leading-relaxed">
              Integración oficial de solo lectura para <strong>CaixaBank</strong> (España). STOP SPEND nunca solicita tu contraseña ni tu PIN bancario: la autorización se realiza directamente en CaixaBank.
            </p>
          </div>

          <div className="rounded-xl bg-slate-950 border border-slate-800 p-3.5 text-xs space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Entidad soportada en v1:</span>
              <span className="font-bold text-slate-100">CaixaBank (ES)</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Estado del proveedor:</span>
              <span className="font-mono text-slate-300">
                {bankStatusBadge.badgeTextSpanish}
              </span>
            </div>
          </div>

          {showUnconfiguredBankMessage && (
            <div
              role="alert"
              data-testid="bank-unconfigured-notice"
              className="rounded-xl bg-amber-950/60 border border-amber-600/80 p-4 text-xs text-amber-100 space-y-2.5"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-bold text-sm text-amber-200">
                    La conexión bancaria todavía no está disponible.
                  </p>
                  <p className="text-amber-100/90">
                    Falta configurar las credenciales de servidor de Enable Banking (App ID y clave privada RSA) para CaixaBank. No inventamos saldos ni simulamos una conexión falsa.
                  </p>
                </div>
              </div>
              <button
                type="button"
                data-testid="onboard-go-to-settings-btn"
                onClick={() => {
                  setShowUnconfiguredBankMessage(false);
                  setAppState((prev) => ({
                    ...prev,
                    bankOnboardingCompleted: true,
                    bankConnectedChoice: 'skipped',
                  }));
                  setActiveTab('ajustes');
                }}
                className="w-full min-h-[42px] px-3 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs"
              >
                Ver pasos de configuración en Ajustes
              </button>
            </div>
          )}

          <div className="space-y-2.5 pt-1">
            <button
              type="button"
              data-testid="onboard-connect-bank-btn"
              onClick={handleConnectMyBankClick}
              className="w-full min-h-[52px] rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm shadow-lg shadow-emerald-950/50 flex items-center justify-center gap-2"
            >
              <Building2 className="w-4 h-4" />
              <span>Conectar mi banco</span>
            </button>

            <button
              type="button"
              data-testid="onboard-continue-without-bank-btn"
              onClick={handleContinueWithoutBank}
              className="w-full min-h-[48px] rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs"
            >
              Continuar sin conectar
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ============================================================================
  // RENDER 3: MAIN AUTHENTICATED APPLICATION
  // ============================================================================
  const budgetComparison = homeMonthReport.budgetComparison;

  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100 flex flex-col max-w-xl mx-auto border-x border-slate-900/80">
      {/* Top Header */}
      <header className="safe-top sticky top-0 z-30 bg-slate-950/90 backdrop-blur-md border-b border-slate-800/80 px-4 py-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center text-emerald-400 font-bold text-sm">
            €
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-sm tracking-tight">STOP SPEND</span>
              <span
                data-testid="header-period-pill"
                className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-slate-800 text-slate-300"
              >
                {selectedPeriodKey}
              </span>
            </div>
            <p className="text-[11px] text-slate-400">
              {appState.displayName} · Europa/Madrid
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {!isOnline && (
            <span
              data-testid="offline-badge"
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-950 border border-amber-700 text-[11px] font-semibold text-amber-200"
            >
              <WifiOff className="w-3.5 h-3.5" />
              <span>Sin conexión ({userPendingOfflineQueue.length})</span>
            </span>
          )}
          <span
            data-testid="bank-status-pill"
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium border ${
              bankStatusBadge.state === 'production_connected'
                ? 'bg-emerald-950/70 border-emerald-700 text-emerald-200'
                : bankStatusBadge.state === 'sandbox_ready' ||
                    bankStatusBadge.state === 'sandbox_connected'
                  ? 'bg-indigo-950/70 border-indigo-700 text-indigo-200'
                  : 'bg-slate-900 border-slate-800 text-slate-400'
            }`}
          >
            <Building2 className="w-3.5 h-3.5" />
            <span>{bankStatusBadge.badgeTextSpanish}</span>
          </span>
        </div>
      </header>

      {/* Toast & Undo Bar */}
      {toastMessage && (
        <div
          role="status"
          data-testid="toast-banner"
          className={`mx-4 mt-3 rounded-xl border px-3.5 py-2.5 text-xs flex items-center justify-between gap-2 ${
            toastMessage.type === 'error'
              ? 'bg-rose-950/80 border-rose-700 text-rose-100'
              : toastMessage.type === 'warning'
                ? 'bg-amber-950/80 border-amber-700 text-amber-100'
                : 'bg-emerald-950/80 border-emerald-700 text-emerald-100'
          }`}
        >
          <span className="font-medium">{toastMessage.text}</span>
          <div className="flex items-center gap-2 shrink-0">
            {undoTransactionId && (
              <button
                type="button"
                data-testid="undo-expense-button"
                onClick={handleUndoLastExpense}
                className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-emerald-300 font-bold flex items-center gap-1 border border-emerald-600/50"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Deshacer</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setToastMessage(null)}
              className="text-slate-400 hover:text-white px-1"
              aria-label="Cerrar aviso"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 px-4 py-4 space-y-5 pb-28">
        {/* ====================================================================
            TAB 1: INICIO (Simple Home Screen — Requirement 2)
           ==================================================================== */}
        {activeTab === 'inicio' && (
          <div className="space-y-4">
            {/* A. MAIN CARD: "Saldo en tu banco" */}
            <section
              data-testid="home-bank-balance-card"
              className="rounded-2xl bg-gradient-to-b from-slate-900 to-slate-900/95 border border-slate-800 p-5 shadow-xl space-y-3.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                    Saldo en tu banco
                  </span>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-slate-300 font-medium">
                      {bankBalanceSummary.bankName} · {bankBalanceSummary.selectedAccountName}
                      {bankBalanceSummary.ibanMasked
                        ? ` (${bankBalanceSummary.ibanMasked})`
                        : ''}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  data-testid="refresh-bank-balance-btn"
                  disabled={isRefreshingBank}
                  onClick={handleRefreshBankBalance}
                  className="min-h-[38px] px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-xs font-semibold text-slate-200 flex items-center gap-1.5 shrink-0"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${isRefreshingBank ? 'animate-spin' : ''}`}
                  />
                  <span>{isRefreshingBank ? 'Actualizando...' : 'Actualizar'}</span>
                </button>
              </div>

              {/* Account Selector when multiple owned bank accounts exist */}
              {ownedBankAccounts.length > 1 && (
                <div>
                  <label
                    htmlFor="home-bank-account-select"
                    className="block text-[11px] text-slate-400 mb-1"
                  >
                    Cuenta bancaria mostrada:
                  </label>
                  <select
                    id="home-bank-account-select"
                    data-testid="home-bank-account-select"
                    value={appState.selectedHomeBankScope}
                    onChange={(e) =>
                      setAppState((prev) => ({
                        ...prev,
                        selectedHomeBankScope: e.target.value,
                      }))
                    }
                    className="w-full min-h-[40px] rounded-xl bg-slate-950 border border-slate-800 px-3 text-xs text-slate-200"
                  >
                    {ownedBankAccounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name} {acc.ibanMasked ? `(${acc.ibanMasked})` : ''}
                      </option>
                    ))}
                    <option value="all_bank">
                      Todas las cuentas bancarias propias ({ownedBankAccounts.length})
                    </option>
                  </select>
                </div>
              )}

              {/* Prominent Reported Bank Balance OR "Banco sin conectar" */}
              {bankBalanceSummary.reportedBalanceCents !== null ? (
                <div className="space-y-1.5">
                  <div
                    data-testid="home-bank-balance-value"
                    className="text-4xl font-mono font-extrabold tracking-tight text-slate-50"
                  >
                    {formatEur(bankBalanceSummary.reportedBalanceCents)}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                    <span data-testid="home-bank-balance-type-label">
                      {bankBalanceSummary.balanceTypeLabelSpanish}
                    </span>
                    {bankBalanceSummary.secondaryBookedBalanceCents !== null && (
                      <span className="text-slate-400">
                        · Saldo contable:{' '}
                        <strong className="font-mono text-slate-200">
                          {formatEur(bankBalanceSummary.secondaryBookedBalanceCents)}
                        </strong>
                      </span>
                    )}
                  </div>
                  {bankBalanceSummary.lastUpdatedMadridFormatted && (
                    <p
                      data-testid="home-bank-last-updated"
                      className="text-[11px] text-slate-400"
                    >
                      Última actualización: {bankBalanceSummary.lastUpdatedMadridFormatted}
                    </p>
                  )}
                </div>
              ) : (
                <div className="rounded-xl bg-slate-950/90 border border-slate-800 p-4 space-y-2.5">
                  <div
                    data-testid="home-bank-balance-value"
                    className="text-2xl font-bold text-slate-200"
                  >
                    Banco sin conectar
                  </div>
                  <p className="text-xs text-slate-400">
                    Conecta tu cuenta de CaixaBank para ver tu saldo real reportado por el banco, o importa tus movimientos por CSV.
                  </p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button
                      type="button"
                      data-testid="home-connect-bank-btn"
                      onClick={() => {
                        if (appState.bankConfig.mode === 'unconfigured') {
                          setToastMessage({
                            text: 'La conexión bancaria todavía no está disponible. Revisa la configuración en Ajustes.',
                            type: 'warning',
                          });
                          setActiveTab('ajustes');
                        } else {
                          handleConnectMyBankClick();
                        }
                      }}
                      className="min-h-[40px] px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center gap-1.5"
                    >
                      <Building2 className="w-3.5 h-3.5" />
                      <span>Conectar mi banco</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Stale Balance Warning if sync failed */}
              {bankBalanceSummary.isStale && (
                <div
                  data-testid="stale-balance-badge"
                  className="rounded-xl bg-amber-950/60 border border-amber-600/80 p-3 text-xs text-amber-100 flex items-start gap-2"
                >
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold text-amber-200 block">
                      Saldo desactualizado
                    </span>
                    <span>{bankBalanceSummary.staleReasonSpanish}</span>
                  </div>
                </div>
              )}

              {/* Separate Manual Cash Balance (if tracked) */}
              {bankBalanceSummary.manualCashBalanceCents !== null && (
                <div
                  data-testid="home-manual-cash-row"
                  className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs"
                >
                  <span className="text-slate-400">
                    Efectivo manual (registrado por separado):
                  </span>
                  <span className="font-mono font-bold text-slate-200">
                    {formatEur(bankBalanceSummary.manualCashBalanceCents)}
                  </span>
                </div>
              )}
            </section>

            {/* B. PRIMARY ACTION: "Crear presupuesto" / "Editar presupuesto" */}
            <section
              data-testid="home-budget-card"
              className="rounded-2xl bg-slate-900 border border-slate-800 p-5 shadow-lg space-y-3.5"
            >
              {budgetComparison ? (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                        Presupuesto del mes ({formatPeriodMonthLabelSpanish(selectedPeriodKey)})
                      </span>
                      <div
                        data-testid="home-budget-limit-value"
                        className="text-lg font-bold text-slate-200 mt-0.5"
                      >
                        Límite: {formatEur(budgetComparison.monthlyLimitCents)}
                      </div>
                    </div>

                    <button
                      type="button"
                      data-testid="open-budget-modal-btn"
                      onClick={() => setIsBudgetModalOpen(true)}
                      className="min-h-[38px] px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-emerald-300 flex items-center gap-1"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      <span>Editar presupuesto</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl bg-slate-950 border border-slate-800 p-3">
                      <span className="text-xs text-slate-400 block">Gastado</span>
                      <strong
                        data-testid="home-budget-spent"
                        className="text-xl font-mono font-bold text-slate-100"
                      >
                        Gastado: {formatEur(budgetComparison.spentInBudgetScopeCents)}
                      </strong>
                    </div>

                    <div className="rounded-xl bg-slate-950 border border-slate-800 p-3">
                      <span className="text-xs text-slate-400 block">Disponible del límite</span>
                      <strong
                        data-testid="home-budget-remaining"
                        className={`text-xl font-mono font-bold ${
                          budgetComparison.remainingCents < 0
                            ? 'text-rose-400'
                            : 'text-emerald-400'
                        }`}
                      >
                        Te quedan: {formatEur(budgetComparison.remainingCents)}
                      </strong>
                    </div>
                  </div>

                  {/* Simple Progress Bar */}
                  <div className="space-y-1.5">
                    <div
                      data-testid="home-budget-progress-bar"
                      className="w-full h-3 rounded-full bg-slate-800 overflow-hidden"
                    >
                      <div
                        className={`h-full transition-all ${
                          budgetComparison.remainingCents < 0
                            ? 'bg-rose-500'
                            : budgetComparison.usedPercent >= 80
                              ? 'bg-amber-500'
                              : 'bg-emerald-500'
                        }`}
                        style={{
                          width: `${Math.min(
                            100,
                            Math.max(0, budgetComparison.usedPercent)
                          )}%`,
                        }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-slate-400">
                      <span>
                        Cuentas: {budgetComparison.selectedAccountNames.join(', ')}
                      </span>
                      <span>{budgetComparison.usedPercent}% utilizado</span>
                    </div>
                    {budgetComparison.scopeMode === 'personal_only' &&
                      budgetComparison.excludedNonPersonalCount > 0 && (
                        <p className="text-[11px] text-amber-300">
                          Excluye {budgetComparison.excludedNonPersonalCount} gasto(s) marcados como no personales ({formatEur(budgetComparison.excludedNonPersonalCents)}).
                        </p>
                      )}
                  </div>
                </>
              ) : (
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="space-y-1">
                    <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                      Control de gasto mensual
                    </span>
                    <h2 className="text-base font-bold text-slate-100">
                      Aún no has fijado un presupuesto para {formatPeriodMonthLabelSpanish(selectedPeriodKey)}
                    </h2>
                    <p className="text-xs text-slate-400">
                      Define cuánto quieres gastar este mes. No mueve dinero ni altera el saldo de tu banco.
                    </p>
                  </div>
                  <button
                    type="button"
                    data-testid="open-budget-modal-btn"
                    onClick={() => setIsBudgetModalOpen(true)}
                    className="min-h-[48px] px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shrink-0 shadow-lg shadow-emerald-950/50"
                  >
                    Crear presupuesto
                  </button>
                </div>
              )}
            </section>

            {/* C. MONTHLY SUMMARY ("Ingresos del mes", "Gastos del mes", "Ver informe mensual") */}
            <section
              data-testid="home-monthly-summary-card"
              className="rounded-2xl bg-slate-900 border border-slate-800 p-5 space-y-3.5"
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-bold text-slate-100">Resumen mensual</h2>
                <select
                  aria-label="Seleccionar mes"
                  data-testid="home-month-selector"
                  value={selectedPeriodKey}
                  onChange={(e) => setSelectedPeriodKey(e.target.value as PeriodMonthKey)}
                  className="min-h-[38px] rounded-xl bg-slate-950 border border-slate-800 px-3 text-xs font-medium text-slate-200"
                >
                  {availablePeriodKeys.map((pk) => (
                    <option key={pk} value={pk}>
                      {formatPeriodMonthLabelSpanish(pk)} ({pk})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-slate-950 border border-slate-800 p-3">
                  <span className="text-xs text-slate-400 block">Ingresos del mes</span>
                  <strong
                    data-testid="home-month-income"
                    className="text-lg font-mono font-bold text-emerald-400"
                  >
                    {formatEur(homeMonthReport.totalExternalIncomeCents)}
                  </strong>
                </div>

                <div className="rounded-xl bg-slate-950 border border-slate-800 p-3">
                  <span className="text-xs text-slate-400 block">Gastos del mes</span>
                  <strong
                    data-testid="home-month-expenses"
                    className="text-lg font-mono font-bold text-rose-300"
                  >
                    {formatEur(homeMonthReport.totalNetExpensesCents)}
                  </strong>
                </div>
              </div>

              <button
                type="button"
                data-testid="home-view-report-btn"
                onClick={() => setActiveTab('informes')}
                className="w-full min-h-[44px] rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-100 flex items-center justify-center gap-1.5"
              >
                <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
                <span>Ver informe mensual</span>
                <ChevronRight className="w-4 h-4 text-slate-400" />
              </button>
            </section>

            {/* D. RECENT TRANSACTIONS (Last 5 relevant movements + "Ver todos" + secondary "Añadir gasto") */}
            <section
              data-testid="home-recent-transactions-card"
              className="rounded-2xl bg-slate-900 border border-slate-800 p-5 space-y-3.5"
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-bold text-slate-100">Últimos movimientos</h2>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="primary-add-expense-btn"
                    onClick={() => {
                      setQuickExpenseInitialAmount('');
                      setQuickExpenseInitialSmall(true);
                      setIsQuickExpenseOpen(true);
                    }}
                    className="min-h-[38px] px-3 rounded-xl bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 text-xs font-bold flex items-center gap-1.5"
                  >
                    <PlusCircle className="w-3.5 h-3.5" />
                    <span>Añadir gasto</span>
                  </button>
                  <button
                    type="button"
                    data-testid="home-view-all-movements-btn"
                    onClick={() => setActiveTab('movimientos')}
                    className="min-h-[38px] px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200"
                  >
                    Ver todos
                  </button>
                </div>
              </div>

              {recentFiveTransactions.length === 0 ? (
                <div className="rounded-xl bg-slate-950 border border-slate-800 p-4 text-center text-xs text-slate-400">
                  Aún no hay movimientos registrados. Conecta tu banco, importa un CSV o pulsa «Añadir gasto».
                </div>
              ) : (
                <div className="divide-y divide-slate-800 rounded-xl bg-slate-950 border border-slate-800">
                  {recentFiveTransactions.map((tx) => {
                    const catObj = DEFAULT_SPANISH_CATEGORIES.find(
                      (c) => c.id === tx.categoryId
                    );
                    return (
                      <div
                        key={tx.id}
                        data-testid={`home-recent-tx-${tx.id}`}
                        className="p-3 flex items-center justify-between gap-2 text-xs"
                      >
                        <div>
                          <span className="font-bold text-slate-100 block">
                            {tx.description}
                          </span>
                          <span className="text-slate-400">
                            {tx.bookingDate} ·{' '}
                            {tx.type === 'internal_transfer'
                              ? 'Traspaso interno'
                              : (catObj?.nameSpanish ?? 'Sin categoría')}
                          </span>
                        </div>
                        <span
                          className={`font-mono font-bold ${
                            tx.amountCents < 0 ? 'text-rose-300' : 'text-emerald-300'
                          }`}
                        >
                          {formatEur(tx.amountCents, { showSign: true })}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Threshold Alerts if any were triggered */}
            {appState.alertOutbox.length > 0 && (
              <section
                data-testid="home-threshold-alerts"
                className="rounded-2xl bg-amber-950/40 border border-amber-700/60 p-4 space-y-2"
              >
                <div className="flex items-center gap-2 text-amber-300 font-bold text-xs">
                  <Bell className="w-4 h-4" />
                  <span>Avisos de presupuesto ({appState.alertOutbox.length})</span>
                </div>
                <div className="space-y-1.5">
                  {appState.alertOutbox.slice(-3).map((alert) => (
                    <div
                      key={alert.id}
                      data-testid={`alert-item-${alert.thresholdPercent}`}
                      className="rounded-xl bg-slate-950/80 border border-amber-800/50 p-2.5 text-xs flex items-start justify-between gap-2"
                    >
                      <div>
                        <p className="font-bold text-amber-200">{alert.inAppTitleSpanish}</p>
                        <p className="text-slate-300 mt-0.5">{alert.inAppBodySpanish}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {/* ====================================================================
            TAB 2: MOVIMIENTOS (Transactions, Filters, Inline Edit, CSV Import)
           ==================================================================== */}
        {activeTab === 'movimientos' && (
          <div className="space-y-4">
            <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-base font-bold text-slate-100">Movimientos</h2>
                <button
                  type="button"
                  onClick={() => {
                    setQuickExpenseInitialAmount('');
                    setQuickExpenseInitialSmall(true);
                    setIsQuickExpenseOpen(true);
                  }}
                  className="min-h-[40px] px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1.5"
                >
                  <PlusCircle className="w-4 h-4" />
                  <span>Añadir gasto</span>
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input
                  data-testid="movements-search-input"
                  type="text"
                  placeholder="Buscar comercio o concepto..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="min-h-[44px] rounded-xl bg-slate-950 border border-slate-800 px-3 text-xs text-slate-100"
                />

                <select
                  data-testid="movements-category-filter"
                  value={filterCategoryId}
                  onChange={(e) => setFilterCategoryId(e.target.value)}
                  className="min-h-[44px] rounded-xl bg-slate-950 border border-slate-800 px-3 text-xs text-slate-200"
                >
                  <option value="all">Todas las categorías</option>
                  {DEFAULT_SPANISH_CATEGORIES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nameSpanish}
                    </option>
                  ))}
                </select>

                <select
                  data-testid="movements-scope-filter"
                  value={filterScope}
                  onChange={(e) =>
                    setFilterScope(e.target.value as 'all' | 'personal' | 'non_personal')
                  }
                  className="min-h-[44px] rounded-xl bg-slate-950 border border-slate-800 px-3 text-xs text-slate-200"
                >
                  <option value="all">Todos los ámbitos</option>
                  <option value="personal">Solo ámbito personal</option>
                  <option value="non_personal">Solo no personal / hogar</option>
                </select>
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  data-testid="export-csv-button"
                  onClick={() => {
                    const csv = exportTransactionsToSpanishCsv(appState.transactions);
                    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                    triggerBrowserFileDownload(
                      blob,
                      `stop-spend-${selectedPeriodKey}.csv`
                    );
                    setToastMessage({
                      text: 'CSV exportado con protección contra inyección de fórmulas.',
                      type: 'success',
                    });
                  }}
                  className="min-h-[40px] px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Exportar movimientos CSV</span>
                </button>
              </div>
            </section>

            {/* Transactions List */}
            <section className="rounded-2xl bg-slate-900 border border-slate-800 divide-y divide-slate-800">
              {filteredTransactions.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-400">
                  No hay movimientos que coincidan con el filtro actual.
                </div>
              ) : (
                filteredTransactions.map((tx) => {
                  const catObj = DEFAULT_SPANISH_CATEGORIES.find(
                    (c) => c.id === tx.categoryId
                  );
                  const isEditing = editingTxId === tx.id;

                  return (
                    <div
                      key={tx.id}
                      data-testid={`transaction-row-${tx.id}`}
                      className="p-4 space-y-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-bold text-sm text-slate-100">
                              {tx.description}
                            </span>
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300">
                              {tx.status === 'provisional'
                                ? 'Provisional (Manual)'
                                : tx.status === 'pending'
                                  ? 'Pendiente banco'
                                  : 'Asentado'}
                            </span>
                          </div>
                          <p className="text-xs text-slate-400 mt-0.5">
                            Fecha contable: {tx.bookingDate} ·{' '}
                            {tx.type === 'internal_transfer'
                              ? 'Traspaso interno'
                              : (catObj?.nameSpanish ?? 'Sin categoría')}{' '}
                            · Ámbito: {tx.scope === 'personal' ? 'Personal' : 'No personal'}
                          </p>
                        </div>

                        <div className="text-right">
                          <div
                            className={`font-mono font-bold text-sm ${
                              tx.amountCents < 0 ? 'text-rose-300' : 'text-emerald-300'
                            }`}
                          >
                            {formatEur(tx.amountCents, { showSign: true })}
                          </div>
                          <button
                            type="button"
                            data-testid={`edit-tx-btn-${tx.id}`}
                            onClick={() => {
                              setEditingTxId(isEditing ? null : tx.id);
                              setEditAmountInput(
                                centsToSpanishDecimal(Math.abs(tx.amountCents))
                              );
                              setEditDescriptionInput(tx.description);
                              setEditCategoryId(tx.categoryId ?? 'coffee_snacks');
                            }}
                            className="text-[11px] text-emerald-400 hover:underline inline-flex items-center gap-1 mt-1"
                          >
                            <Edit3 className="w-3 h-3" />
                            <span>{isEditing ? 'Cerrar' : 'Editar / Categoría'}</span>
                          </button>
                        </div>
                      </div>

                      {isEditing && (
                        <div className="rounded-xl bg-slate-950 border border-slate-800 p-3 space-y-2.5 mt-2">
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            <div>
                              <label className="block text-[10px] text-slate-400 mb-1">
                                Importe (EUR)
                              </label>
                              <input
                                data-testid="edit-tx-amount-input"
                                type="text"
                                value={editAmountInput}
                                onChange={(e) => setEditAmountInput(e.target.value)}
                                className="w-full min-h-[40px] rounded-lg bg-slate-900 border border-slate-700 px-2.5 text-xs font-mono text-slate-100"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] text-slate-400 mb-1">
                                Concepto
                              </label>
                              <input
                                data-testid="edit-tx-desc-input"
                                type="text"
                                value={editDescriptionInput}
                                onChange={(e) => setEditDescriptionInput(e.target.value)}
                                className="w-full min-h-[40px] rounded-lg bg-slate-900 border border-slate-700 px-2.5 text-xs text-slate-100"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] text-slate-400 mb-1">
                                Categoría
                              </label>
                              <select
                                data-testid="edit-tx-category-select"
                                value={editCategoryId}
                                onChange={(e) => setEditCategoryId(e.target.value)}
                                className="w-full min-h-[40px] rounded-lg bg-slate-900 border border-slate-700 px-2.5 text-xs text-slate-100"
                              >
                                {DEFAULT_SPANISH_CATEGORIES.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.nameSpanish}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>

                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              data-testid="save-edit-tx-btn"
                              onClick={() => {
                                try {
                                  const newAbs = parseMoneyToCents(editAmountInput, {
                                    allowNegative: false,
                                  });
                                  const signed = tx.amountCents < 0 ? -newAbs : newAbs;
                                  const updatedTx: CanonicalTransaction = {
                                    ...tx,
                                    amountCents: signed,
                                    description:
                                      editDescriptionInput.trim() || tx.description,
                                    categoryId: editCategoryId,
                                    categorySource: 'user_locked',
                                    reviewStatus: 'none',
                                  };
                                  if (supabaseClient) {
                                    void updateTransactionInSupabase({
                                      client: supabaseClient,
                                      authenticatedUserId: appState.userId,
                                      transaction: updatedTx,
                                    });
                                  }
                                  setAppState((prev) => ({
                                    ...prev,
                                    transactions: prev.transactions.map((item) =>
                                      item.id === tx.id ? updatedTx : item
                                    ),
                                  }));
                                  setEditingTxId(null);
                                  setToastMessage({
                                    text: 'Movimiento y categoría actualizados.',
                                    type: 'success',
                                  });
                                } catch (e) {
                                  setToastMessage({
                                    text:
                                      e instanceof Error ? e.message : 'Error al editar',
                                    type: 'error',
                                  });
                                }
                              }}
                              className="min-h-[40px] px-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold"
                            >
                              Guardar cambios
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </section>

            {/* CSV Statement Import */}
            <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Upload className="w-4 h-4 text-emerald-400" />
                <span>Importar extracto CSV del banco</span>
              </h3>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                <select
                  value={csvTargetAccountId}
                  onChange={(e) => setCsvTargetAccountId(e.target.value)}
                  className="min-h-[42px] rounded-xl bg-slate-950 border border-slate-800 px-3 text-slate-200"
                >
                  {appState.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      Cuenta destino: {a.name}
                    </option>
                  ))}
                </select>

                <select
                  value={csvDelimiter}
                  onChange={(e) => setCsvDelimiter(e.target.value as ';' | ',')}
                  className="min-h-[42px] rounded-xl bg-slate-950 border border-slate-800 px-3 text-slate-200"
                >
                  <option value=";">Separador: Punto y coma (;)</option>
                  <option value=",">Separador: Coma (,)</option>
                </select>

                <select
                  value={csvDateFormat}
                  onChange={(e) =>
                    setCsvDateFormat(e.target.value as 'DD/MM/YYYY' | 'YYYY-MM-DD')
                  }
                  className="min-h-[42px] rounded-xl bg-slate-950 border border-slate-800 px-3 text-slate-200"
                >
                  <option value="DD/MM/YYYY">Fecha: DD/MM/YYYY (España)</option>
                  <option value="YYYY-MM-DD">Fecha: YYYY-MM-DD (ISO)</option>
                </select>
              </div>

              <textarea
                data-testid="csv-import-textarea"
                rows={4}
                placeholder={
                  'Fecha;Concepto;Importe;Moneda\n02/11/2026;MERCADONA COMPRA;-24,50;EUR\n03/11/2026;CAFETERIA;-3,20;EUR'
                }
                value={csvRawText}
                onChange={(e) => setCsvRawText(e.target.value)}
                className="w-full rounded-xl bg-slate-950 border border-slate-800 p-3 text-xs font-mono text-slate-200"
              />

              {csvPreview && (
                <div className="rounded-xl bg-slate-950 border border-slate-800 p-3 text-xs space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-300">
                      Filas válidas: <strong>{csvPreview.validRows.length}</strong> · Errores:{' '}
                      <strong
                        className={csvPreview.errors.length > 0 ? 'text-rose-400' : ''}
                      >
                        {csvPreview.errors.length}
                      </strong>
                    </span>
                    <button
                      type="button"
                      data-testid="csv-commit-button"
                      disabled={!csvPreview.canCommit}
                      onClick={() => {
                        const batchId = `batch_${Date.now()}`;
                        const res = commitCsvImportBatch({
                          batchId,
                          userId: appState.userId,
                          accountId: csvTargetAccountId,
                          preview: csvPreview,
                          existingSources: appState.sourceRecords,
                          existingTransactions: appState.transactions,
                        });
                        const alertEval = evaluateThresholdsAfterSpendChange(
                          appState,
                          res.transactions,
                          true
                        );
                        setAppState((prev) => ({
                          ...prev,
                          transactions: res.transactions,
                          sourceRecords: res.sourceRecords,
                          handledThresholds: alertEval.handledThresholds,
                          csvBatches: [
                            ...prev.csvBatches,
                            {
                              id: batchId,
                              fileHashKey: csvPreview.fileHashKey,
                              filename: `Extracto_${batchId}.csv`,
                              rowCount: res.importedCount,
                              createdAtUtc: new Date().toISOString(),
                            },
                          ],
                        }));
                        setCsvRawText('');
                        setToastMessage({
                          text: `CSV importado: ${res.importedCount} nuevos, ${res.idempotentSkippedCount} duplicados omitidos.`,
                          type: 'success',
                        });
                      }}
                      className="min-h-[40px] px-4 rounded-xl bg-emerald-600 disabled:bg-slate-800 disabled:text-slate-500 text-white font-bold"
                    >
                      Confirmar importación CSV
                    </button>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {/* ====================================================================
            TAB 3: PRESUPUESTO (Budget Configuration, Category Limits & Simulator)
           ==================================================================== */}
        {activeTab === 'presupuesto' && (
          <div className="space-y-4">
            {/* Legacy Template Reset Banner (Requirement 5) */}
            {appState.hasLegacyTemplateBudget && (
              <section
                data-testid="legacy-template-reset-banner"
                className="rounded-2xl bg-amber-950/50 border border-amber-600/80 p-4 space-y-2 text-xs"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="font-bold text-amber-200 block">
                      Plantilla antigua detectada (174,00 € / 94,00 € / 80,00 €)
                    </span>
                    <p className="text-amber-100/90 mt-0.5">
                      Se ha conservado el presupuesto de plantilla de la versión anterior para no borrar datos sin permiso. Puedes restablecerlo y definir tu propio límite mensual cuando quieras.
                    </p>
                  </div>
                  <button
                    type="button"
                    data-testid="reset-legacy-template-btn"
                    onClick={handleResetLegacyTemplateBudget}
                    className="min-h-[38px] px-3 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold shrink-0"
                  >
                    Restablecer plantilla antigua
                  </button>
                </div>
              </section>
            )}

            <section className="rounded-2xl bg-slate-900 border border-slate-800 p-5 space-y-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                    Presupuesto mensual · {formatPeriodMonthLabelSpanish(selectedPeriodKey)}
                  </span>
                  <h2 className="text-lg font-bold text-slate-100 mt-0.5">
                    {budgetComparison
                      ? `Presupuesto del mes: ${formatEur(budgetComparison.monthlyLimitCents)}`
                      : '¿Cuánto quieres gastar este mes?'}
                  </h2>
                </div>

                <button
                  type="button"
                  data-testid="budget-tab-open-modal-btn"
                  onClick={() => setIsBudgetModalOpen(true)}
                  className="min-h-[42px] px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold"
                >
                  {budgetComparison ? 'Editar presupuesto' : 'Crear presupuesto'}
                </button>
              </div>

              <p className="text-xs text-slate-400">
                El presupuesto es una referencia personal para controlar tus compras del mes. No mueve dinero entre cuentas ni modifica el saldo reportado por tu banco.
              </p>

              {budgetComparison && (
                <div className="space-y-3 pt-1">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl bg-slate-950 border border-slate-800 p-3.5">
                      <span className="text-xs text-slate-400 block">Gastado este mes</span>
                      <strong className="text-xl font-mono font-bold text-slate-100">
                        {formatEur(budgetComparison.spentInBudgetScopeCents)}
                      </strong>
                    </div>
                    <div className="rounded-xl bg-slate-950 border border-slate-800 p-3.5">
                      <span className="text-xs text-slate-400 block">Disponible</span>
                      <strong
                        className={`text-xl font-mono font-bold ${
                          budgetComparison.remainingCents < 0
                            ? 'text-rose-400'
                            : 'text-emerald-400'
                        }`}
                      >
                        {formatEur(budgetComparison.remainingCents)}
                      </strong>
                    </div>
                  </div>

                  {/* Secondary Action in Budget Screen: "¿Puedo comprar esto?" */}
                  <div className="flex flex-wrap gap-2 pt-2">
                    <button
                      type="button"
                      data-testid="primary-simulate-purchase-btn"
                      onClick={() => setIsSimulatorOpen(true)}
                      className="min-h-[46px] px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs flex items-center gap-2"
                    >
                      <Calculator className="w-4 h-4" />
                      <span>¿Puedo comprar esto? (Simulador)</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setActiveBreakdown(envelopesView.howItIsCalculated)}
                      className="min-h-[46px] px-3.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5"
                    >
                      <Info className="w-4 h-4 text-emerald-400" />
                      <span>Ver desglose del cálculo</span>
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* Optional Category Limits Progress if any category limits are set */}
            {configuredBudgetForSelectedMonth &&
              Object.keys(configuredBudgetForSelectedMonth.categoryAllocationsCents).length >
                0 && (
                <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3">
                  <h3 className="text-sm font-bold text-slate-100">
                    Límites opcionales por categoría
                  </h3>
                  <div className="space-y-2">
                    {Object.entries(
                      configuredBudgetForSelectedMonth.categoryAllocationsCents
                    ).map(([catId, limitCents]) => {
                      const catSummary = homeMonthReport.categoryBreakdown.find(
                        (c) => c.categoryId === catId
                      );
                      const spentCents = catSummary?.netExpenseCents ?? 0;
                      const remCents = subtractCents(limitCents, spentCents);
                      const catObj = DEFAULT_SPANISH_CATEGORIES.find(
                        (c) => c.id === catId
                      );
                      return (
                        <div
                          key={catId}
                          className="rounded-xl bg-slate-950 border border-slate-800 p-3 flex items-center justify-between text-xs"
                        >
                          <div>
                            <span className="font-bold text-slate-200 block">
                              {catObj?.nameSpanish ?? catId}
                            </span>
                            <span className="text-slate-400">
                              Gastado: {formatEur(spentCents)} de {formatEur(limitCents)}
                            </span>
                          </div>
                          <span
                            className={`font-mono font-bold ${
                              remCents < 0 ? 'text-rose-400' : 'text-emerald-400'
                            }`}
                          >
                            Te quedan: {formatEur(remCents)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

            {/* Optional Details: Reserved Obligations & Manual Cash Income */}
            <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3">
              <h3 className="text-sm font-bold text-slate-100">
                Recibos previstos y efectivo manual (Opcional)
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input
                  data-testid="new-obligation-name"
                  type="text"
                  placeholder="Ej. Alquiler o recibo"
                  value={newObligationName}
                  onChange={(e) => setNewObligationName(e.target.value)}
                  className="min-h-[42px] rounded-xl bg-slate-950 border border-slate-800 px-3 text-xs text-slate-100"
                />
                <input
                  data-testid="new-obligation-amount"
                  type="text"
                  placeholder="Importe EUR (ej. 800,00)"
                  value={newObligationAmount}
                  onChange={(e) => setNewObligationAmount(e.target.value)}
                  className="min-h-[42px] rounded-xl bg-slate-950 border border-slate-800 px-3 text-xs font-mono text-slate-100"
                />
                <button
                  type="button"
                  data-testid="add-obligation-btn"
                  onClick={() => {
                    try {
                      const cents = parseMoneyToCents(newObligationAmount, {
                        allowNegative: false,
                      });
                      if (!newObligationName.trim() || cents <= 0) return;
                      const ob: ObligationReservation = {
                        id: `ob_${Date.now()}`,
                        userId: appState.userId,
                        name: newObligationName.trim(),
                        periodKey: selectedPeriodKey,
                        expectedAmountCents: cents,
                        paidAmountCents: 0,
                        status: 'reserved',
                        dueDate: getTodayMadridCalendarDate(),
                        settledTransactionIds: [],
                      };
                      setAppState((prev) => ({
                        ...prev,
                        obligations: [...prev.obligations, ob],
                      }));
                      if (supabaseClient && session) {
                        persistObligationToSupabase({
                          client: supabaseClient,
                          authenticatedUserId: session.userId,
                          obligation: ob,
                        }).catch(() => {});
                      }
                      setNewObligationName('');
                      setNewObligationAmount('');
                    } catch (e) {
                      setToastMessage({
                        text: e instanceof Error ? e.message : 'Importe inválido',
                        type: 'error',
                      });
                    }
                  }}
                  className="min-h-[42px] rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold"
                >
                  Anotar recibo previsto
                </button>
              </div>

              {appState.obligations.length > 0 && (
                <div className="space-y-2 pt-2">
                  {appState.obligations.map((ob) => {
                    const remaining = Math.max(
                      0,
                      ob.expectedAmountCents - ob.paidAmountCents
                    );
                    return (
                      <div
                        key={ob.id}
                        className="rounded-xl bg-slate-950 border border-slate-800 p-3 flex items-center justify-between text-xs"
                      >
                        <div>
                          <span className="font-bold text-slate-200">{ob.name}</span>
                          <span className="block text-slate-400">
                            Pendiente: {formatEur(remaining)} de{' '}
                            {formatEur(ob.expectedAmountCents)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          {remaining > 0 && (
                            <button
                              type="button"
                              data-testid={`pay-obligation-${ob.id}`}
                              onClick={() => {
                                const payTx: CanonicalTransaction = {
                                  id: `tx_ob_pay_${Date.now()}`,
                                  userId: appState.userId,
                                  accountId: primaryBankAccount?.id ?? 'acc_bank_caixabank',
                                  type: 'expense',
                                  status: 'booked',
                                  amountCents: -remaining,
                                  currency: 'EUR',
                                  bookingDate: getTodayMadridCalendarDate(),
                                  valueDate: getTodayMadridCalendarDate(),
                                  occurredAtUtc: new Date().toISOString(),
                                  createdAtUtc: new Date().toISOString(),
                                  description: `Pago recibo: ${ob.name}`,
                                  merchantNormalized: ob.name.toUpperCase(),
                                  userNote: null,
                                  categoryId: 'housing_bills',
                                  categorySource: 'user_locked',
                                  categoryConfidence: 100,
                                  categoryExplanation: 'Pago de recibo previsto',
                                  scope: 'non_personal',
                                  smallSpendingTagged: false,
                                  splits: [],
                                  linkedExpenseId: null,
                                  transferPairId: null,
                                  counterpartAccountId: null,
                                  untrackedOwnedDestinationLabel: null,
                                  settledObligationId: ob.id,
                                  consumedSavingsReservationId: null,
                                  supersededByTransactionId: null,
                                  reviewStatus: 'none',
                                  sourceRecordIds: [],
                                };
                                const settled = settleObligationWithPayment({
                                  obligation: ob,
                                  paymentTransaction: payTx,
                                });
                                setAppState((prev) => ({
                                  ...prev,
                                  transactions: [
                                    settled.updatedTransaction,
                                    ...prev.transactions,
                                  ],
                                  obligations: prev.obligations.map((x) =>
                                    x.id === ob.id ? settled.updatedObligation : x
                                  ),
                                }));
                              }}
                              className="min-h-[36px] px-3 rounded-lg bg-emerald-600 text-white font-semibold"
                            >
                              Marcar pagado
                            </button>
                          )}
                          <button
                            type="button"
                            data-testid={`delete-obligation-${ob.id}`}
                            onClick={() => {
                              setAppState((prev) => ({
                                ...prev,
                                obligations: prev.obligations.filter((x) => x.id !== ob.id),
                              }));
                              if (supabaseClient && session) {
                                deleteObligationFromSupabase({
                                  client: supabaseClient,
                                  authenticatedUserId: session.userId,
                                  obligationId: ob.id,
                                }).catch(() => {});
                              }
                            }}
                            className="min-h-[36px] px-2.5 rounded-lg bg-slate-800 hover:bg-rose-950 text-slate-400 hover:text-rose-300"
                            title="Eliminar recibo previsto"
                          >
                            Eliminar
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="pt-2 border-t border-slate-800 flex items-center gap-2 text-xs">
                <input
                  data-testid="cash-salary-input"
                  type="text"
                  placeholder="Añadir ingreso en efectivo (EUR, ej. 200,00)"
                  value={cashIncomeAmountInput}
                  onChange={(e) => setCashIncomeAmountInput(e.target.value)}
                  className="flex-1 min-h-[40px] rounded-xl bg-slate-950 border border-slate-800 px-3 font-mono text-slate-100"
                />
                <button
                  type="button"
                  data-testid="save-cash-salary-btn"
                  onClick={() => {
                    try {
                      const cents = parseMoneyToCents(cashIncomeAmountInput, {
                        allowNegative: false,
                      });
                      const cashTx: CanonicalTransaction = {
                        id: `tx_cash_inc_${Date.now()}`,
                        userId: appState.userId,
                        accountId: primaryCashAccount?.id ?? 'acc_cash_main',
                        type: 'income',
                        status: 'booked',
                        amountCents: cents,
                        currency: 'EUR',
                        bookingDate: getTodayMadridCalendarDate(),
                        valueDate: getTodayMadridCalendarDate(),
                        occurredAtUtc: new Date().toISOString(),
                        createdAtUtc: new Date().toISOString(),
                        description: 'Ingreso en efectivo',
                        merchantNormalized: 'INGRESO EFECTIVO',
                        userNote: null,
                        categoryId: 'income',
                        categorySource: 'user_locked',
                        categoryConfidence: 100,
                        categoryExplanation: 'Ingreso externo en efectivo',
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
                      setAppState((prev) => ({
                        ...prev,
                        transactions: [cashTx, ...prev.transactions],
                      }));
                      setCashIncomeAmountInput('');
                    } catch (e) {
                      setToastMessage({
                        text: e instanceof Error ? e.message : 'Importe inválido',
                        type: 'error',
                      });
                    }
                  }}
                  className="min-h-[40px] px-3.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold"
                >
                  Registrar efectivo
                </button>
              </div>
            </section>
          </div>
        )}

        {/* ====================================================================
            TAB 4: INFORMES (Monthly Reports & Downloadable PDF / CSV — Req 3 & 4)
           ==================================================================== */}
        {activeTab === 'informes' && (
          <div className="space-y-4" data-testid="monthly-reports-screen">
            {/* Header & Selectors + Prominent "Descargar informe" Buttons */}
            <section className="rounded-2xl bg-slate-900 border border-slate-800 p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                    Informes financieros mensuales
                  </span>
                  <h2 className="text-lg font-bold text-slate-100 mt-0.5">
                    Informe de {monthlyReport.periodLabelSpanish}
                  </h2>
                </div>

                {/* Prominent Download Actions: PDF & CSV */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="download-report-pdf-btn"
                    onClick={handleDownloadReportPdf}
                    className="min-h-[44px] px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center gap-1.5 shadow-lg shadow-emerald-950/50"
                  >
                    <FileText className="w-4 h-4" />
                    <span>Descargar informe (PDF)</span>
                  </button>
                  <button
                    type="button"
                    data-testid="download-report-csv-btn"
                    onClick={handleDownloadReportCsv}
                    className="min-h-[44px] px-3.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 font-bold text-xs flex items-center gap-1.5 border border-slate-700"
                  >
                    <Download className="w-4 h-4 text-emerald-400" />
                    <span>Descargar CSV</span>
                  </button>
                </div>
              </div>

              {/* Month and Account Scope Selectors */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div>
                  <label
                    htmlFor="report-month-select"
                    className="block text-slate-400 mb-1"
                  >
                    Mes y año del informe:
                  </label>
                  <select
                    id="report-month-select"
                    data-testid="report-month-select"
                    value={selectedPeriodKey}
                    onChange={(e) =>
                      setSelectedPeriodKey(e.target.value as PeriodMonthKey)
                    }
                    className="w-full min-h-[42px] rounded-xl bg-slate-950 border border-slate-800 px-3 text-slate-100 font-medium"
                  >
                    {availablePeriodKeys.map((pk) => (
                      <option key={pk} value={pk}>
                        {formatPeriodMonthLabelSpanish(pk)} ({pk})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="report-scope-select"
                    className="block text-slate-400 mb-1"
                  >
                    Ámbito de cuentas:
                  </label>
                  <select
                    id="report-scope-select"
                    data-testid="report-scope-select"
                    value={reportAccountScope}
                    onChange={(e) => setReportAccountScope(e.target.value)}
                    className="w-full min-h-[42px] rounded-xl bg-slate-950 border border-slate-800 px-3 text-slate-100 font-medium"
                  >
                    <option value="all_owned">Todas las cuentas propias</option>
                    <option value="bank_only">Solo cuentas bancarias</option>
                    {appState.accounts
                      .filter((a) => a.isOwned && a.type !== 'credit_card')
                      .map((acc) => (
                        <option key={acc.id} value={acc.id}>
                          Solo {acc.name}
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              {/* Data Coverage & Incomplete History Disclosure */}
              <div
                data-testid="report-coverage-banner"
                className={`rounded-xl border p-3 text-xs flex items-start gap-2.5 ${
                  monthlyReport.dataCoverage.isIncompleteHistory
                    ? 'bg-amber-950/40 border-amber-700/70 text-amber-100'
                    : 'bg-slate-950 border-slate-800 text-slate-300'
                }`}
              >
                {monthlyReport.dataCoverage.isIncompleteHistory ? (
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                )}
                <div className="space-y-0.5">
                  <span className="font-semibold block">
                    Cobertura de datos ({monthlyReport.accountScopeLabelSpanish})
                  </span>
                  <p>{monthlyReport.dataCoverage.coverageNoticeSpanish}</p>
                </div>
              </div>

              {lastGeneratedPdfMeta && (
                <div
                  data-testid="generated-pdf-verification-box"
                  className="rounded-xl bg-emerald-950/30 border border-emerald-700/50 p-3 text-xs text-emerald-100 space-y-1"
                >
                  <p className="font-bold">
                    Documento PDF generado: {lastGeneratedPdfMeta.filename} (
                    {lastGeneratedPdfMeta.pageCount} página(s),{' '}
                    {lastGeneratedPdfMeta.byteLength} bytes)
                  </p>
                </div>
              )}
            </section>

            {/* Income, Net Expenses & Monthly Result (Distinct from Bank Balance) */}
            <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-1">
                <span className="text-xs text-slate-400 block">
                  Ingresos externos totales
                </span>
                <strong
                  data-testid="report-income-value"
                  className="text-xl font-mono font-bold text-emerald-400"
                >
                  {formatEur(monthlyReport.totalExternalIncomeCents)}
                </strong>
                <span className="text-[11px] text-slate-500 block">
                  Abonos asentados en el mes
                </span>
              </div>

              <div className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-1">
                <span className="text-xs text-slate-400 block">Gastos netos totales</span>
                <strong
                  data-testid="report-expenses-value"
                  className="text-xl font-mono font-bold text-rose-300"
                >
                  {formatEur(monthlyReport.totalNetExpensesCents)}
                </strong>
                <span className="text-[11px] text-slate-500 block">
                  Bruto: {formatEur(monthlyReport.grossExpensesCents)} · Devoluciones:{' '}
                  {formatEur(monthlyReport.refundsAppliedCents)}
                </span>
              </div>

              <div className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400">
                    Resultado (Ingresos - Gastos)
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                    No es saldo bancario
                  </span>
                </div>
                <strong
                  data-testid="report-result-value"
                  className={`text-xl font-mono font-bold block ${
                    monthlyReport.monthlyResultCents < 0
                      ? 'text-rose-400'
                      : 'text-emerald-400'
                  }`}
                >
                  {formatEur(monthlyReport.monthlyResultCents, { showSign: true })}
                </strong>
                <span className="text-[11px] text-slate-500 block">
                  Diferencia neta del periodo seleccionado
                </span>
              </div>
            </section>

            {/* Budget vs Actual Spending (ONLY when configured) */}
            {monthlyReport.budgetComparison && (
              <section
                data-testid="report-budget-comparison-card"
                className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-2"
              >
                <h3 className="text-sm font-bold text-slate-100">
                  Presupuesto vs. Gasto real ({monthlyReport.periodLabelSpanish})
                </h3>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div className="rounded-xl bg-slate-950 p-3 border border-slate-800">
                    <span className="text-slate-400 block">Presupuesto fijado</span>
                    <strong className="font-mono text-sm text-slate-100">
                      {formatEur(monthlyReport.budgetComparison.monthlyLimitCents)}
                    </strong>
                  </div>
                  <div className="rounded-xl bg-slate-950 p-3 border border-slate-800">
                    <span className="text-slate-400 block">Gasto computable</span>
                    <strong className="font-mono text-sm text-rose-300">
                      {formatEur(monthlyReport.budgetComparison.spentInBudgetScopeCents)}
                    </strong>
                  </div>
                  <div className="rounded-xl bg-slate-950 p-3 border border-slate-800">
                    <span className="text-slate-400 block">Margen restante</span>
                    <strong
                      className={`font-mono text-sm ${
                        monthlyReport.budgetComparison.remainingCents < 0
                          ? 'text-rose-400'
                          : 'text-emerald-400'
                      }`}
                    >
                      {formatEur(monthlyReport.budgetComparison.remainingCents)}
                    </strong>
                  </div>
                </div>
              </section>
            )}

            {/* Category Breakdown & Largest Expenses */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-2.5">
                <h3 className="text-sm font-bold text-slate-100">Gasto por categoría</h3>
                {monthlyReport.categoryBreakdown.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    Sin gastos en las cuentas seleccionadas.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {monthlyReport.categoryBreakdown.map((cat) => (
                      <div
                        key={cat.categoryId}
                        data-testid={`report-cat-${cat.categoryId}`}
                        className="rounded-xl bg-slate-950 border border-slate-800 p-2.5 flex items-center justify-between text-xs"
                      >
                        <div>
                          <span className="font-semibold text-slate-200 block">
                            {cat.categoryNameSpanish}
                          </span>
                          <span className="text-[11px] text-slate-400">
                            {cat.transactionCount} mov. · {cat.percentageOfTotal}% del total
                          </span>
                        </div>
                        <span className="font-mono font-bold text-slate-100">
                          {formatEur(cat.netExpenseCents)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-2.5">
                <h3 className="text-sm font-bold text-slate-100">
                  Mayores gastos del mes
                </h3>
                {monthlyReport.largestExpenses.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    Sin gastos registrados en este mes.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {monthlyReport.largestExpenses.map((item) => (
                      <div
                        key={item.transaction.id}
                        className="rounded-xl bg-slate-950 border border-slate-800 p-2.5 flex items-center justify-between text-xs"
                      >
                        <div>
                          <span className="font-semibold text-slate-200 block">
                            {item.transaction.description}
                          </span>
                          <span className="text-[11px] text-slate-400">
                            {item.transaction.bookingDate} · {item.categoryNameSpanish}
                          </span>
                        </div>
                        <span className="font-mono font-bold text-rose-300">
                          {formatEur(Math.abs(item.transaction.amountCents))}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            {/* Internal Transfers Displayed Separately (Excluded from Income/Expense totals) */}
            <section
              data-testid="report-internal-transfers-card"
              className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-2"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-100">
                  Traspasos internos entre cuentas propias (Excluidos de ingresos y gastos)
                </h3>
                <span className="text-xs font-mono text-slate-300">
                  {monthlyReport.internalTransfersCount} mov. ·{' '}
                  {formatEur(monthlyReport.internalTransfersTotalCents)}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Mover dinero entre tus propias cuentas no es ni un ingreso externo ni un gasto real.
              </p>
            </section>

            {/* Full Transaction Table for Selected Month & Scope */}
            <section
              data-testid="report-transactions-table"
              className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-100">
                  Tabla completa de movimientos ({monthlyReport.allScopedTransactions.length})
                </h3>
                {monthlyReport.pendingTransactionsCount > 0 && (
                  <span className="text-[11px] text-amber-300">
                    Incluye {monthlyReport.pendingTransactionsCount} pendiente(s)/provisional(es) ({formatEur(monthlyReport.pendingTransactionsExpenseCents)})
                  </span>
                )}
              </div>

              {monthlyReport.allScopedTransactions.length === 0 ? (
                <p className="text-xs text-slate-500 py-4 text-center">
                  No hay movimientos registrados para el mes y ámbito seleccionados.
                </p>
              ) : (
                <div className="divide-y divide-slate-800 rounded-xl bg-slate-950 border border-slate-800">
                  {monthlyReport.allScopedTransactions.map((item) => (
                    <div
                      key={item.transaction.id}
                      className="p-3 flex items-center justify-between gap-2 text-xs"
                    >
                      <div>
                        <span className="font-bold text-slate-100 block">
                          {item.transaction.description}
                        </span>
                        <span className="text-slate-400">
                          {item.transaction.bookingDate} · {item.accountName} ·{' '}
                          {item.categoryNameSpanish} · {item.sourceLabelSpanish} (
                          {item.statusLabelSpanish})
                        </span>
                      </div>
                      <span
                        className={`font-mono font-bold shrink-0 ${
                          item.transaction.type === 'internal_transfer'
                            ? 'text-slate-400'
                            : item.transaction.amountCents < 0
                              ? 'text-rose-300'
                              : 'text-emerald-300'
                        }`}
                      >
                        {formatEur(item.transaction.amountCents, { showSign: true })}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {/* ====================================================================
            TAB 5: AJUSTES (Bank Setup, Offline Queue, Push, Security)
           ==================================================================== */}
        {activeTab === 'ajustes' && (
          <div className="space-y-4">
            {/* 1. Banking Connection: CaixaBank */}
            <section
              data-testid="settings-bank-connection-card"
              className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-400">
                    Integración PSD2 de solo lectura
                  </span>
                  <h2 className="text-base font-bold text-slate-100">
                    Conexión CaixaBank
                  </h2>
                </div>
                <span className="text-xs font-mono px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-slate-300">
                  {bankStatusBadge.badgeTextSpanish}
                </span>
              </div>

              <p className="text-xs text-slate-300">{bankStatusBadge.descriptionSpanish}</p>

              {appState.bankConfig.lastSyncUtc && (
                <p className="text-xs text-slate-400">
                  Última sincronización:{' '}
                  {new Date(appState.bankConfig.lastSyncUtc).toLocaleString('es-ES', {
                    timeZone: 'Europe/Madrid',
                  })}
                </p>
              )}

              {appState.bankConfig.mode === 'unconfigured' && (
                <div className="rounded-xl bg-amber-950/40 border border-amber-700/60 p-3 text-xs text-amber-100 space-y-1">
                  <p className="font-bold text-amber-200">
                    La conexión bancaria todavía no está disponible.
                  </p>
                  <p className="text-amber-100/90">
                    Puedes continuar registrando tus gastos manualmente en efectivo o importando un extracto bancario en CSV.
                  </p>
                </div>
              )}

              <div className="flex flex-wrap gap-2 pt-1">
                {appState.bankConfig.hasValidSession ? (
                  <>
                    <button
                      type="button"
                      disabled={isRefreshingBank}
                      onClick={handleRefreshBankBalance}
                      className="min-h-[40px] px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-xs font-bold text-white flex items-center gap-1.5"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${isRefreshingBank ? 'animate-spin' : ''}`}
                      />
                      <span>{isRefreshingBank ? 'Actualizando...' : 'Actualizar saldo ahora'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleDisconnectBank}
                      className="min-h-[40px] px-3 rounded-xl bg-rose-950/70 hover:bg-rose-900 border border-rose-700/60 text-xs text-rose-200"
                    >
                      Desconectar mi banco
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={isRefreshingBank}
                    onClick={handleConnectMyBankClick}
                    className="min-h-[40px] px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-xs font-bold text-white flex items-center gap-1.5"
                  >
                    <Building2 className="w-3.5 h-3.5" />
                    <span>Conectar mi banco</span>
                  </button>
                )}
              </div>
            </section>

            {/* 2. Offline Queue & Resiliency */}
            <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Wifi className="w-4 h-4 text-emerald-400" />
                <span>Cola sin conexión y sincronización</span>
              </h3>

              <div className="rounded-xl bg-slate-950 border border-slate-800 p-3 text-xs space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Estado de red del dispositivo:</span>
                  <span className={`font-bold ${isOnline ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {isOnline ? 'Conectado a Internet' : 'Sin conexión a Internet'}
                  </span>
                </div>
              </div>

              {userPendingOfflineQueue.length > 0 ? (
                <div
                  data-testid="offline-queue-panel"
                  className="rounded-xl bg-amber-950/40 border border-amber-700/70 p-3 space-y-2 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-amber-200">
                      {userPendingOfflineQueue.length} gasto(s) Pendiente de sincronizar
                    </span>
                    <button
                      type="button"
                      data-testid="flush-offline-queue-btn"
                      onClick={handleReconnectAndFlushOfflineQueue}
                      className="min-h-[38px] px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold flex items-center gap-1"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Reconectar y sincronizar cola</span>
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-400">
                  No hay gastos pendientes de sincronización. Todos los movimientos están al día.
                </p>
              )}
            </section>

            {/* 4. Data Deletion & Safe Logout */}
            <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3">
              <h3 className="text-sm font-bold text-slate-100">
                Privacidad, borrado de datos y sesión
              </h3>

              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder='Escribe "ELIMINAR MIS DATOS" para borrar todo'
                  value={deleteConfirmInput}
                  onChange={(e) => setDeleteConfirmInput(e.target.value)}
                  className="flex-1 min-h-[40px] rounded-xl bg-slate-950 border border-slate-800 px-3 text-xs text-slate-200"
                />
                <button
                  type="button"
                  disabled={deleteConfirmInput !== 'ELIMINAR MIS DATOS'}
                  onClick={() => {
                    clearUserFinancialCacheOnDevice(appState.userId);
                    setAppState(createInitialUserState(appState.userId, appState.displayName));
                    setDeleteConfirmInput('');
                    setToastMessage({
                      text: 'Todos los datos financieros del usuario han sido eliminados.',
                      type: 'warning',
                    });
                  }}
                  className="min-h-[40px] px-3 rounded-xl bg-rose-700 disabled:bg-slate-800 disabled:text-slate-500 text-white text-xs font-bold flex items-center gap-1"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Borrar datos</span>
                </button>
              </div>

              <div className="pt-2 border-t border-slate-800 flex justify-between items-center">
                <span className="text-xs text-slate-400">Sesión activa: {session.email}</span>
                <button
                  type="button"
                  data-testid="logout-button"
                  onClick={() => {
                    const check = evaluateLogoutSafety({
                      activeUserId: appState.userId,
                      queue: offlineQueue,
                    });
                    if (!check.canProceedWithLogout) {
                      setLogoutWarningModal(check.warningSpanish);
                      return;
                    }
                    saveActiveSession(null);
                    setSession(null);
                  }}
                  className="min-h-[42px] px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 flex items-center gap-1.5"
                >
                  <LogOut className="w-4 h-4" />
                  <span>Cerrar sesión</span>
                </button>
              </div>

              {logoutWarningModal && (
                <div className="rounded-xl bg-rose-950/80 border border-rose-600 p-3 text-xs text-rose-100 space-y-2">
                  <p>{logoutWarningModal}</p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setLogoutWarningModal(null)}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setLogoutWarningModal(null);
                        saveActiveSession(null);
                        setSession(null);
                      }}
                      className="px-3 py-1.5 rounded-lg bg-rose-600 text-white font-bold"
                    >
                      Cerrar sesión de todos modos
                    </button>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </main>

      {/* Bottom Navigation Bar: Inicio | Movimientos | Presupuesto | Informes | Ajustes */}
      <nav
        aria-label="Navegación principal"
        className="safe-bottom fixed bottom-0 left-0 right-0 z-30 bg-slate-950/95 backdrop-blur-md border-t border-slate-800"
      >
        <div className="max-w-xl mx-auto grid grid-cols-5 px-2 py-1">
          {[
            { id: 'inicio', label: 'Inicio', Icon: Home },
            { id: 'movimientos', label: 'Movimientos', Icon: ListOrdered },
            { id: 'presupuesto', label: 'Presupuesto', Icon: Wallet },
            { id: 'informes', label: 'Informes', Icon: FileSpreadsheet },
            { id: 'ajustes', label: 'Ajustes', Icon: Settings },
          ].map(({ id, label, Icon }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                data-testid={`nav-tab-${id}`}
                onClick={() => setActiveTab(id as ActiveTab)}
                className={`min-h-[52px] flex flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-medium transition ${
                  active
                    ? 'text-emerald-400 font-bold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Modals */}
      <BudgetSetupModal
        isOpen={isBudgetModalOpen}
        periodKey={selectedPeriodKey}
        periodLabelSpanish={formatPeriodMonthLabelSpanish(selectedPeriodKey)}
        isEditingExisting={Boolean(configuredBudgetForSelectedMonth)}
        initialMonthlyLimitCents={
          configuredBudgetForSelectedMonth
            ? addCents(
                configuredBudgetForSelectedMonth.smallPurchasesAllocatedCents,
                configuredBudgetForSelectedMonth.flexibleSpendingAllocatedCents
              )
            : null
        }
        initialCategoryLimitsCents={
          configuredBudgetForSelectedMonth?.categoryAllocationsCents ?? {}
        }
        initialScopeMode={appState.budgetScopeMode}
        initialSelectedAccountIds={appState.budgetSelectedAccountIds}
        ownedAccounts={appState.accounts.filter((a) => a.isOwned)}
        excludedNonPersonalCount={homeMonthReport.nonPersonalTransactionsCount}
        excludedNonPersonalCents={homeMonthReport.nonPersonalExpensesCents}
        onSave={handleSaveMonthlyBudget}
        onClose={() => setIsBudgetModalOpen(false)}
      />

      <QuickExpenseModal
        isOpen={isQuickExpenseOpen}
        accounts={appState.accounts}
        defaultAccountId={appState.rememberedAccountId}
        defaultCategoryId={appState.rememberedCategoryId}
        defaultDate={getTodayMadridCalendarDate()}
        initialAmountDecimal={quickExpenseInitialAmount}
        initialSmallSpending={quickExpenseInitialSmall}
        onSave={handleSaveQuickExpense}
        onClose={() => setIsQuickExpenseOpen(false)}
      />

      <PurchaseSimulatorModal
        isOpen={isSimulatorOpen}
        envelopes={envelopesView}
        liquidity={liquidityView}
        onRegisterPurchaseFromSimulation={(amountDec, isSmall) => {
          setQuickExpenseInitialAmount(amountDec);
          setQuickExpenseInitialSmall(isSmall);
          setIsQuickExpenseOpen(true);
        }}
        onClose={() => setIsSimulatorOpen(false)}
      />

      <HowItIsCalculatedModal
        breakdown={activeBreakdown}
        onClose={() => setActiveBreakdown(null)}
      />
    </div>
  );
};
