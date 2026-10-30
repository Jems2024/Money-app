import React, { useState, useEffect, useMemo } from 'react';
import {
  Home,
  ListOrdered,
  Wallet,
  BarChart3,
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
  Coffee,
} from 'lucide-react';
import {
  addCents,
  centsToSpanishDecimal,
  formatEur,
  parseMoneyToCents,
} from './domain/money';
import { CalendarDateISO } from './domain/dates/madrid';
import {
  CanonicalTransaction,
  ObligationReservation,
  SavingsReservation,
  SpendingScope,
} from './domain/ledger';
import {
  calculateEstimatedUncommittedLiquidity,
  calculateMonthlyCashFlow,
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
import {
  computeLikeForLikeAnalytics,
  DEFAULT_SPANISH_CATEGORIES,
  detectRecurringPaymentCandidates,
} from './domain/categorization';
import {
  commitCsvImportBatch,
  exportTransactionsToSpanishCsv,
  previewCsvStatement,
  rollbackCsvImportBatch,
} from './domain/csv';
import {
  enqueueOfflineExpense,
  evaluateLogoutSafety,
  flushOfflineQueueForUser,
  OfflineQueuedExpense,
} from './domain/offline';
import { resolveBankConnectionStatusBadge } from './server/providers/enableBanking';
import {
  AppUserState,
  clearUserFinancialCacheOnDevice,
  createInitialUserState,
  getTodayMadridCalendarDate,
  KNOWN_SUPABASE_PROJECT_REF,
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
  deleteTransactionFromSupabase,
  fetchUserStateFromSupabase,
  persistBudgetAllocationToSupabase,
  persistTransactionToSupabase,
  updateTransactionInSupabase,
} from './state/supabaseRepository';
import {
  HowItIsCalculatedModal,
  PurchaseSimulatorModal,
  QuickExpenseModal,
} from './components/Modals';

type ActiveTab = 'inicio' | 'movimientos' | 'presupuestos' | 'analisis' | 'ajustes';

export const App: React.FC = () => {
  // 1. Private Auth Session State
  const [session, setSession] = useState<UserSession | null>(() => loadActiveSession());
  const [authEmail, setAuthEmail] = useState('jared@stopspend.es');
  const [authPasscode, setAuthPasscode] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);

  // 2. Per-User App State & Device Offline Queue
  const [appState, setAppState] = useState<AppUserState>(() =>
    session ? loadUserState(session.userId, session.displayName) : createInitialUserState('user_jared')
  );
  const [offlineQueue, setOfflineQueue] = useState<OfflineQueuedExpense[]>(() =>
    loadDeviceOfflineQueue()
  );

  // 3. Navigation & UI Modal States
  const [activeTab, setActiveTab] = useState<ActiveTab>('inicio');
  const [isQuickExpenseOpen, setIsQuickExpenseOpen] = useState(false);
  const [quickExpenseInitialAmount, setQuickExpenseInitialAmount] = useState('');
  const [quickExpenseInitialSmall, setQuickExpenseInitialSmall] = useState(true);
  const [isSimulatorOpen, setIsSimulatorOpen] = useState(false);
  const [activeBreakdown, setActiveBreakdown] = useState<HowItIsCalculatedBreakdown | null>(null);

  // Undo Toast & Status Feedback
  const [undoTransactionId, setUndoTransactionId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<{
    text: string;
    type: 'success' | 'warning' | 'error';
  } | null>(null);

  // Onboarding customization fields
  const [onboardSmallEur, setOnboardSmallEur] = useState('40,00');
  const [onboardFlexibleEur, setOnboardFlexibleEur] = useState('54,00');
  const [onboardProtectedEur, setOnboardProtectedEur] = useState('80,00');

  // Movements Filter & Edit States
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategoryId, setFilterCategoryId] = useState<string>('all');
  const [filterScope, setFilterScope] = useState<'all' | 'personal' | 'non_personal'>('all');
  const [filterOnlySmall, setFilterOnlySmall] = useState(false);
  const [editingTxId, setEditingTxId] = useState<string | null>(null);
  const [editAmountInput, setEditAmountInput] = useState('');
  const [editDescriptionInput, setEditDescriptionInput] = useState('');
  const [editCategoryId, setEditCategoryId] = useState('coffee_snacks');

  // CSV Import States
  const [csvRawText, setCsvRawText] = useState('');
  const [csvDelimiter, setCsvDelimiter] = useState<';' | ','>(';');
  const [csvDateFormat, setCsvDateFormat] = useState<'DD/MM/YYYY' | 'YYYY-MM-DD'>('DD/MM/YYYY');
  const [csvTargetAccountId, setCsvTargetAccountId] = useState('acc_bank_caixabank');

  // Opening Balance / Cash Income / Obligation Creation Inputs
  const [openingBankAmountInput, setOpeningBankAmountInput] = useState('');
  const [cashIncomeAmountInput, setCashIncomeAmountInput] = useState('');
  const [newObligationName, setNewObligationName] = useState('');
  const [newObligationAmount, setNewObligationAmount] = useState('');
  const [deleteConfirmInput, setDeleteConfirmInput] = useState('');
  const [logoutWarningModal, setLogoutWarningModal] = useState<string | null>(null);

  // Sync user state whenever session changes (Real Supabase Postgres when configured)
  useEffect(() => {
    if (!session) return;
    const loadedLocal = loadUserState(session.userId, session.displayName);
    setAppState(loadedLocal);

    if (supabaseClient) {
      fetchUserStateFromSupabase(supabaseClient, session.userId, session.displayName)
        .then((remoteState) => {
          setAppState(remoteState);
          saveUserState(remoteState);
        })
        .catch(() => {
          // Preserve loaded state if offline
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

  // Current Budget Period Allocation
  const currentAllocation = useMemo(() => {
    const existing = appState.budgetAllocations[appState.currentPeriodKey];
    if (existing) return existing;
    return createBudgetAllocation({
      id: `bud_${appState.currentPeriodKey}`,
      userId: appState.userId,
      periodKey: appState.currentPeriodKey,
      confirmedByUser: appState.onboardingConfirmed,
      protectedSavingsAllocatedCents: 8000,
      smallPurchasesAllocatedCents: 4000,
      flexibleSpendingAllocatedCents: 5400,
    });
  }, [appState.budgetAllocations, appState.currentPeriodKey, appState.userId, appState.onboardingConfirmed]);

  // Calculate the Three Financial Views (Section 6)
  const envelopesView = useMemo(
    () =>
      calculatePersonalEnvelopes({
        allocation: currentAllocation,
        transactions: appState.transactions,
        accounts: appState.accounts,
        refundPolicy: appState.refundPolicy,
        lastSyncUtc: appState.bankConfig.lastSyncUtc,
      }),
    [currentAllocation, appState.transactions, appState.accounts, appState.refundPolicy, appState.bankConfig.lastSyncUtc]
  );

  const liquidityView = useMemo(
    () =>
      calculateEstimatedUncommittedLiquidity({
        accounts: appState.accounts,
        snapshots: appState.snapshots,
        transactions: appState.transactions,
        obligations: appState.obligations,
        savingsReservations: appState.savingsReservations,
        periodKey: appState.currentPeriodKey,
        lastSyncUtc: appState.bankConfig.lastSyncUtc,
      }),
    [
      appState.accounts,
      appState.snapshots,
      appState.transactions,
      appState.obligations,
      appState.savingsReservations,
      appState.currentPeriodKey,
      appState.bankConfig.lastSyncUtc,
    ]
  );

  const cashFlowView = useMemo(
    () =>
      calculateMonthlyCashFlow({
        periodKey: appState.currentPeriodKey,
        accounts: appState.accounts,
        transactions: appState.transactions,
        plannedIncomeCents: appState.plannedMonthlyIncomeCents,
        refundPolicy: appState.refundPolicy,
        lastSyncUtc: appState.bankConfig.lastSyncUtc,
      }),
    [
      appState.currentPeriodKey,
      appState.accounts,
      appState.transactions,
      appState.plannedMonthlyIncomeCents,
      appState.refundPolicy,
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
    const displayName = trimmedEmail.startsWith('jared') ? 'Jared' : trimmedEmail.split('@')[0]!;
    const newSession: UserSession = {
      userId: derivedUserId,
      email: trimmedEmail,
      displayName,
    };
    saveActiveSession(newSession);
    setSession(newSession);
  };

  const handleConfirmOnboarding = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const smallCents = parseMoneyToCents(onboardSmallEur, { allowNegative: false });
      const flexCents = parseMoneyToCents(onboardFlexibleEur, { allowNegative: false });
      const protCents = parseMoneyToCents(onboardProtectedEur, { allowNegative: false });

      const confirmedAlloc = createBudgetAllocation({
        id: `bud_${appState.currentPeriodKey}`,
        userId: appState.userId,
        periodKey: appState.currentPeriodKey,
        confirmedByUser: true,
        protectedSavingsAllocatedCents: protCents,
        smallPurchasesAllocatedCents: smallCents,
        flexibleSpendingAllocatedCents: flexCents,
      });

      const savingsRes: SavingsReservation = {
        id: `sr_${appState.currentPeriodKey}`,
        userId: appState.userId,
        name: 'Ahorro personal protegido del mes',
        periodKey: appState.currentPeriodKey,
        protectedAmountCents: protCents,
        transferredToExcludedAccountCents: 0,
        status: 'earmarked_in_included_account',
      };

      setAppState((prev) => ({
        ...prev,
        onboardingConfirmed: true,
        budgetAllocations: {
          ...prev.budgetAllocations,
          [prev.currentPeriodKey]: confirmedAlloc,
        },
        savingsReservations:
          protCents > 0
            ? [
                ...prev.savingsReservations.filter(
                  (s) => s.periodKey !== prev.currentPeriodKey
                ),
                savingsRes,
              ]
            : prev.savingsReservations,
      }));

      if (supabaseClient) {
        void persistBudgetAllocationToSupabase({
          client: supabaseClient,
          authenticatedUserId: appState.userId,
          allocation: confirmedAlloc,
          savingsReservation: protCents > 0 ? savingsRes : undefined,
        }).catch((err) => {
          setToastMessage({
            text: err instanceof Error ? err.message : 'Error al sincronizar presupuesto con Supabase.',
            type: 'error',
          });
        });
      }

      setToastMessage({
        text: `Presupuesto de ${appState.currentPeriodKey} confirmado: ${formatEur(
          addCents(smallCents, flexCents)
        )} gastables y ${formatEur(protCents)} de ahorro protegido.`,
        type: 'success',
      });
    } catch (err) {
      setToastMessage({
        text: err instanceof Error ? err.message : 'Importes de presupuesto inválidos.',
        type: 'error',
      });
    }
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
    const alloc =
      prevState.budgetAllocations[prevState.currentPeriodKey] ?? currentAllocation;

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

    // 1. Evaluate Small Purchases envelope
    const smallEval = evaluateBudgetThresholdCrossing({
      userId: prevState.userId,
      budgetId: 'small_purchases',
      budgetName: 'Compras pequeñas',
      periodKey: prevState.currentPeriodKey,
      budgetAllocatedCents: alloc.smallPurchasesAllocatedCents,
      spentBeforeCents: beforeEnv.smallPurchasesNetSpentCents,
      spentAfterCents: afterEnv.smallPurchasesNetSpentCents,
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

    // 2. Evaluate Total Personal Spendable envelope
    const totalEval = evaluateBudgetThresholdCrossing({
      userId: prevState.userId,
      budgetId: 'personal_spendable_total',
      budgetName: 'Presupuesto personal gastable',
      periodKey: prevState.currentPeriodKey,
      budgetAllocatedCents: afterEnv.spendableAllocatedCents,
      spentBeforeCents: beforeEnv.totalPersonalNetSpentCents,
      spentAfterCents: afterEnv.totalPersonalNetSpentCents,
      existingHandledRecords: smallEval.updatedHandledRecords,
      existingOutboxEvents: smallEval.updatedOutboxEvents,
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
      latestEmitted: smallEval.emittedEvent ?? totalEval.emittedEvent,
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
    // Check simulated API error
    if (appState.simulateNextApiError) {
      setAppState((prev) => ({ ...prev, simulateNextApiError: false }));
      setToastMessage({
        text: 'Error de servidor simulado al guardar. Puedes reintentar o activar la cola sin conexión.',
        type: 'error',
      });
      return;
    }

    // Check offline mode queue
    if (appState.simulateNetworkOffline) {
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
      // Bank purchase entered manually starts as 'provisional' until bank import reconciles it
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
            text: err instanceof Error ? err.message : 'Error al persistir en Supabase.',
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
        simulateNetworkOffline: false,
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
      if (filterOnlySmall && !tx.smallSpendingTagged) {
        return false;
      }
      return true;
    });
  }, [appState.transactions, searchQuery, filterCategoryId, filterScope, filterOnlySmall]);

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

  // Analytics & Recurring Candidates
  const currentMonthAnalytics = useMemo(() => {
    const start: CalendarDateISO = `${appState.currentPeriodKey}-01` as CalendarDateISO;
    const end: CalendarDateISO = `${appState.currentPeriodKey}-31` as CalendarDateISO;
    return computeLikeForLikeAnalytics({
      transactions: appState.transactions,
      currentWindowStart: start,
      currentWindowEnd: end,
      previousWindowStart: '2026-09-01',
      previousWindowEnd: '2026-09-30',
      hasCompletePreviousHistory: appState.transactions.some((t) =>
        t.bookingDate.startsWith('2026-09')
      ),
    });
  }, [appState.transactions, appState.currentPeriodKey]);

  const recurringCandidates = useMemo(
    () =>
      detectRecurringPaymentCandidates({
        transactions: appState.transactions,
        existingObligationNames: appState.obligations.map((o) => o.name),
      }),
    [appState.transactions, appState.obligations]
  );

  // ============================================================================
  // RENDER: PRIVATE AUTHENTICATION SCREEN IF NOT SIGNED IN
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
                Acceso privado · España (EUR · Europe/Madrid)
              </p>
            </div>
          </div>

          <div className="rounded-xl bg-slate-950/90 border border-slate-800 p-3 text-xs text-slate-300 space-y-1">
            <div className="flex items-center gap-1.5 text-emerald-400 font-semibold">
              <Lock className="w-3.5 h-3.5" />
              <span>Aplicación personal de inscripción cerrada</span>
            </div>
            <p className="text-slate-400">
              Sin registro público, sin publicidad y sin pedir nunca contraseñas bancarias.
            </p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label htmlFor="auth-email" className="block text-xs font-semibold text-slate-300 mb-1">
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
              <label htmlFor="auth-pass" className="block text-xs font-semibold text-slate-300 mb-1">
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
              Entrar a mi presupuesto
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ============================================================================
  // RENDER: MAIN AUTHENTICATED PWA SHELL
  // ============================================================================
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
              <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-slate-800 text-slate-300">
                {appState.currentPeriodKey}
              </span>
            </div>
            <p className="text-[11px] text-slate-400">
              {appState.displayName} · Europa/Madrid
            </p>
          </div>
        </div>

        {/* Status Badges: Offline Queue + Bank Status */}
        <div className="flex items-center gap-1.5">
          {appState.simulateNetworkOffline && (
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
        {/* Onboarding Budget Confirmation Banner if not confirmed yet */}
        {!appState.onboardingConfirmed && (
          <section
            data-testid="onboarding-card"
            className="rounded-2xl bg-slate-900 border border-emerald-600/50 p-4 space-y-3 shadow-lg"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-400">
                  Configuración inicial · Periodo {appState.currentPeriodKey}
                </span>
                <h2 className="text-base font-bold text-slate-100 mt-0.5">
                  Confirma tus sobres personales mensuales
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Plantilla sugerida: 174,00 € asignados (94,00 € gastables divididos en 40,00 € compras pequeñas + 54,00 € flexible, y 80,00 € de ahorro personal protegido que no suma como dinero para gastar).
                </p>
              </div>
            </div>

            <form onSubmit={handleConfirmOnboarding} className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Compras pequeñas
                  </label>
                  <input
                    data-testid="onboard-small-input"
                    type="text"
                    value={onboardSmallEur}
                    onChange={(e) => setOnboardSmallEur(e.target.value)}
                    className="w-full min-h-[42px] rounded-xl bg-slate-950 border border-slate-700 px-2.5 text-sm font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Gasto flexible
                  </label>
                  <input
                    data-testid="onboard-flex-input"
                    type="text"
                    value={onboardFlexibleEur}
                    onChange={(e) => setOnboardFlexibleEur(e.target.value)}
                    className="w-full min-h-[42px] rounded-xl bg-slate-950 border border-slate-700 px-2.5 text-sm font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Ahorro protegido
                  </label>
                  <input
                    data-testid="onboard-protected-input"
                    type="text"
                    value={onboardProtectedEur}
                    onChange={(e) => setOnboardProtectedEur(e.target.value)}
                    className="w-full min-h-[42px] rounded-xl bg-slate-950 border border-slate-700 px-2.5 text-sm font-mono text-slate-100"
                  />
                </div>
              </div>
              <button
                type="submit"
                data-testid="confirm-onboarding-button"
                className="w-full min-h-[46px] rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs"
              >
                Confirmar presupuesto personal ({appState.currentPeriodKey})
              </button>
            </form>
          </section>
        )}

        {/* ====================================================================
            TAB 1: INICIO (Home — Prevention of Overspending)
           ==================================================================== */}
        {activeTab === 'inicio' && (
          <div className="space-y-4">
            {/* Primary Card: Personal Spendable Budget Remaining */}
            <section
              data-testid="home-personal-budget-card"
              className="rounded-2xl bg-gradient-to-b from-slate-900 to-slate-900/90 border border-slate-800 p-5 shadow-xl space-y-4"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                    ¿Cuánto me queda en mi presupuesto personal?
                  </span>
                  <div
                    data-testid="spendable-remaining-value"
                    className={`text-4xl font-mono font-extrabold tracking-tight mt-1 ${
                      envelopesView.spendableRemainingCents < 0
                        ? 'text-rose-400'
                        : 'text-slate-50'
                    }`}
                  >
                    {formatEur(envelopesView.spendableRemainingCents)}
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    de {formatEur(envelopesView.spendableAllocatedCents)} gastables (excluye{' '}
                    {formatEur(envelopesView.protectedSavingsAllocatedCents)} de ahorro protegido)
                  </p>
                </div>

                <button
                  type="button"
                  data-testid="how-calc-envelopes-btn"
                  onClick={() => setActiveBreakdown(envelopesView.howItIsCalculated)}
                  className="min-h-[40px] px-2.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 flex items-center gap-1 shrink-0"
                >
                  <Info className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Cómo se calcula</span>
                </button>
              </div>

              {/* Prominent Small Purchases Sub-Envelope on Home (Section 7) */}
              <div
                data-testid="home-small-purchases-card"
                className="rounded-xl bg-slate-950/90 border border-slate-800 p-3.5 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Coffee className="w-4 h-4 text-amber-400" />
                    <span className="text-xs font-bold text-slate-200">
                      Sobre de Compras pequeñas
                    </span>
                  </div>
                  <span
                    data-testid="small-purchases-remaining-value"
                    className={`font-mono font-bold text-base ${
                      envelopesView.smallPurchasesRemainingCents < 0
                        ? 'text-rose-400'
                        : 'text-amber-300'
                    }`}
                  >
                    {formatEur(envelopesView.smallPurchasesRemainingCents)} libres
                  </span>
                </div>

                <div className="w-full h-2.5 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full transition-all ${
                      envelopesView.smallPurchasesRemainingCents < 0
                        ? 'bg-rose-500'
                        : (envelopesView.smallPurchasesUsedPercent ?? 0) >= 75
                          ? 'bg-amber-500'
                          : 'bg-emerald-500'
                    }`}
                    style={{
                      width: `${Math.min(
                        100,
                        Math.max(0, envelopesView.smallPurchasesUsedPercent ?? 0)
                      )}%`,
                    }}
                  />
                </div>

                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>
                    Gastado: {formatEur(envelopesView.smallPurchasesNetSpentCents)} de{' '}
                    {formatEur(envelopesView.smallPurchasesAllocatedCents)}
                  </span>
                  <span>
                    {envelopesView.smallPurchasesRemainingCents < 0
                      ? 'Superado'
                      : `${envelopesView.smallPurchasesUsedPercent ?? 0}% usado`}
                  </span>
                </div>
              </div>

              {/* Daily Pacing Planning Guide */}
              <div className="flex items-center justify-between rounded-xl bg-slate-950/60 border border-slate-800/70 px-3.5 py-2.5 text-xs">
                <span className="text-slate-400">
                  Guía orientativa ({envelopesView.remainingCalendarDaysIncludingToday} días restantes este mes):
                </span>
                <span className="font-mono font-semibold text-slate-200">
                  {formatEur(envelopesView.dailyPacingGuideCents, { unknownLabel: '0,00 €' })} / día
                </span>
              </div>

              {/* Two Primary Actions: "Añadir gasto" & "¿Puedo comprar esto?" */}
              <div className="grid grid-cols-2 gap-3 pt-1">
                <button
                  type="button"
                  data-testid="primary-add-expense-btn"
                  onClick={() => {
                    setQuickExpenseInitialAmount('');
                    setQuickExpenseInitialSmall(true);
                    setIsQuickExpenseOpen(true);
                  }}
                  className="min-h-[52px] rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-950/50"
                >
                  <PlusCircle className="w-5 h-5" />
                  <span>Añadir gasto</span>
                </button>

                <button
                  type="button"
                  data-testid="primary-simulate-purchase-btn"
                  onClick={() => setIsSimulatorOpen(true)}
                  className="min-h-[52px] rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-indigo-950/50"
                >
                  <Calculator className="w-5 h-5" />
                  <span>¿Puedo comprar esto?</span>
                </button>
              </div>
            </section>

            {/* Active Threshold Alerts Banner */}
            {appState.alertOutbox.length > 0 && (
              <section
                data-testid="home-threshold-alerts"
                className="rounded-2xl bg-amber-950/40 border border-amber-700/60 p-4 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-amber-300 font-bold text-xs">
                    <Bell className="w-4 h-4" />
                    <span>Avisos de umbral de presupuesto ({appState.alertOutbox.length})</span>
                  </div>
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
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400 shrink-0">
                        {alert.deliveryState === 'queued_quiet_hours'
                          ? 'Silencio nocturno'
                          : 'Generada'}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Secondary View: Estimated Uncommitted Liquidity & Monthly Cash Flow */}
            <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* View C: Estimated Uncommitted Liquidity */}
              <div
                data-testid="home-liquidity-card"
                className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-400">
                    Liquidez libre estimada
                  </span>
                  <button
                    type="button"
                    data-testid="how-calc-liquidity-btn"
                    onClick={() => setActiveBreakdown(liquidityView.howItIsCalculated)}
                    className="text-xs text-emerald-400 hover:underline flex items-center gap-1"
                  >
                    <Info className="w-3.5 h-3.5" />
                    <span>Cómo se calcula</span>
                  </button>
                </div>

                <div
                  data-testid="liquidity-value"
                  className={`text-xl font-mono font-bold ${
                    liquidityView.uncommittedLiquidityCents === null
                      ? 'text-amber-300'
                      : liquidityView.uncommittedLiquidityCents < 0
                        ? 'text-rose-400'
                        : 'text-slate-100'
                  }`}
                >
                  {formatEur(liquidityView.uncommittedLiquidityCents)}
                </div>

                <p className="text-[11px] text-slate-400">
                  {liquidityView.uncommittedLiquidityCents === null
                    ? 'Falta saldo inicial o lectura bancaria verificada. Nunca inventamos un saldo 0,00 €.'
                    : `Fondos propios: ${formatEur(
                        liquidityView.totalIncludedOwnedFundsCents
                      )} · Comprometido: ${formatEur(
                        addCents(
                          liquidityView.unpaidObligationsReservedCents,
                          liquidityView.retainedSavingsReservationsCents
                        )
                      )}`}
                </p>
              </div>

              {/* View A: Monthly Cash Flow */}
              <div
                data-testid="home-cashflow-card"
                className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-400">
                    Flujo de caja mensual
                  </span>
                  <button
                    type="button"
                    data-testid="how-calc-cashflow-btn"
                    onClick={() => setActiveBreakdown(cashFlowView.howItIsCalculated)}
                    className="text-xs text-emerald-400 hover:underline flex items-center gap-1"
                  >
                    <Info className="w-3.5 h-3.5" />
                    <span>Cómo se calcula</span>
                  </button>
                </div>

                <div
                  data-testid="cashflow-net-value"
                  className={`text-xl font-mono font-bold ${
                    cashFlowView.netCashFlowCents < 0 ? 'text-rose-400' : 'text-emerald-400'
                  }`}
                >
                  {formatEur(cashFlowView.netCashFlowCents, { showSign: true })}
                </div>

                <p className="text-[11px] text-slate-400">
                  Ingresos cobrados: {formatEur(cashFlowView.recognizedExternalIncomeCents)} · Gastos
                  netos: {formatEur(cashFlowView.netRealExpensesCents)}
                </p>
              </div>
            </section>
          </div>
        )}

        {/* ====================================================================
            TAB 2: MOVIMIENTOS (Transactions, Filters, Splits, CSV Import/Export)
           ==================================================================== */}
        {activeTab === 'movimientos' && (
          <div className="space-y-4">
            {/* Search & Filters */}
            <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3">
              <h2 className="text-base font-bold text-slate-100">Movimientos y conciliación</h2>

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

              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  data-testid="filter-only-small-btn"
                  onClick={() => setFilterOnlySmall((v) => !v)}
                  className={`min-h-[40px] px-3 rounded-xl text-xs font-medium border ${
                    filterOnlySmall
                      ? 'bg-amber-950 border-amber-500 text-amber-200'
                      : 'bg-slate-950 border-slate-800 text-slate-400'
                  }`}
                >
                  Solo compras pequeñas ({filterOnlySmall ? 'Activo' : 'Todos'})
                </button>

                <button
                  type="button"
                  data-testid="export-csv-button"
                  onClick={() => {
                    const csv = exportTransactionsToSpanishCsv(appState.transactions);
                    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `stop-spend-${appState.currentPeriodKey}.csv`;
                    a.click();
                    URL.revokeObjectURL(url);
                    setToastMessage({
                      text: 'CSV exportado con protección contra inyección de fórmulas.',
                      type: 'success',
                    });
                  }}
                  className="min-h-[40px] px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Exportar CSV</span>
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
                  const catObj = DEFAULT_SPANISH_CATEGORIES.find((c) => c.id === tx.categoryId);
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
                            {tx.smallSpendingTagged && (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-950 border border-amber-700 text-amber-300 font-semibold">
                                Compra pequeña
                              </span>
                            )}
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300">
                              {tx.status === 'provisional'
                                ? 'Provisional (Manual)'
                                : tx.status === 'pending'
                                  ? 'Pendiente banco'
                                  : 'Asentado'}
                            </span>
                            {tx.reviewStatus !== 'none' && (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-rose-950 border border-rose-700 text-rose-200">
                                Revisión requerida
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-400 mt-0.5">
                            Fecha contable: {tx.bookingDate} ·{' '}
                            {catObj?.nameSpanish ?? 'Sin categoría'} · Ámbito:{' '}
                            {tx.scope === 'personal' ? 'Personal' : 'No personal'}
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
                                Categoría (fija corrección)
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
                                    description: editDescriptionInput.trim() || tx.description,
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
                                    text: 'Movimiento y categoría actualizados (bloqueada frente a reglas automáticas).',
                                    type: 'success',
                                  });
                                } catch (e) {
                                  setToastMessage({
                                    text: e instanceof Error ? e.message : 'Error al editar',
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

            {/* CSV Statement Import & Batch Rollback (Section 9) */}
            <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                  <Upload className="w-4 h-4 text-emerald-400" />
                  <span>Importar extracto CSV (Fallback bancario)</span>
                </h3>
              </div>

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
                  'Fecha;Concepto;Importe;Moneda\n15/10/2026;MERCADONA COMPRA;-24,50;EUR\n16/10/2026;STARBUCKS;-3,20;EUR'
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
                      <strong className={csvPreview.errors.length > 0 ? 'text-rose-400' : ''}>
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
                        // Suppress historical notification flood on batch CSV import
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
                          text: `CSV importado: ${res.importedCount} nuevos, ${res.idempotentSkippedCount} idempotentes omitidos.`,
                          type: 'success',
                        });
                      }}
                      className="min-h-[40px] px-4 rounded-xl bg-emerald-600 disabled:bg-slate-800 disabled:text-slate-500 text-white font-bold"
                    >
                      Confirmar importación CSV
                    </button>
                  </div>
                  {csvPreview.errors.map((err, i) => (
                    <p key={i} className="text-rose-400">
                      Fila {err.rowNumber}: {err.messageSpanish}
                    </p>
                  ))}
                </div>
              )}

              {appState.csvBatches.length > 0 && (
                <div className="space-y-1.5 pt-2">
                  <span className="text-xs font-semibold text-slate-400">
                    Lotes CSV importados (reversibles):
                  </span>
                  {appState.csvBatches.map((b) => (
                    <div
                      key={b.id}
                      className="flex items-center justify-between rounded-xl bg-slate-950 px-3 py-2 text-xs"
                    >
                      <span>
                        {b.filename} ({b.rowCount} movs)
                      </span>
                      <button
                        type="button"
                        data-testid={`rollback-batch-${b.id}`}
                        onClick={() => {
                          const rb = rollbackCsvImportBatch({
                            batchId: b.id,
                            transactions: appState.transactions,
                            sourceRecords: appState.sourceRecords,
                          });
                          setAppState((prev) => ({
                            ...prev,
                            transactions: rb.transactions,
                            sourceRecords: rb.sourceRecords,
                            csvBatches: prev.csvBatches.filter((x) => x.id !== b.id),
                          }));
                          setToastMessage({
                            text: `Lote CSV ${b.filename} revertido correctamente.`,
                            type: 'success',
                          });
                        }}
                        className="text-rose-400 hover:underline font-semibold"
                      >
                        Revertir lote
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {/* ====================================================================
            TAB 3: PRESUPUESTOS (Envelopes, Obligations, Savings, Cash & Opening Funds)
           ==================================================================== */}
        {activeTab === 'presupuestos' && (
          <div className="space-y-4">
            {/* Personal Envelopes Editor */}
            <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3">
              <h2 className="text-base font-bold text-slate-100">
                Sobres del periodo {appState.currentPeriodKey}
              </h2>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="rounded-xl bg-slate-950 p-3 border border-slate-800">
                  <span className="text-slate-400 block">Compras pequeñas</span>
                  <strong className="font-mono text-sm text-amber-300">
                    {formatEur(envelopesView.smallPurchasesRemainingCents)}
                  </strong>
                  <span className="text-[10px] text-slate-500 block">
                    de {formatEur(envelopesView.smallPurchasesAllocatedCents)}
                  </span>
                </div>
                <div className="rounded-xl bg-slate-950 p-3 border border-slate-800">
                  <span className="text-slate-400 block">Gasto flexible</span>
                  <strong className="font-mono text-sm text-emerald-300">
                    {formatEur(envelopesView.flexibleSpendingRemainingCents)}
                  </strong>
                  <span className="text-[10px] text-slate-500 block">
                    de {formatEur(envelopesView.flexibleSpendingAllocatedCents)}
                  </span>
                </div>
                <div className="rounded-xl bg-slate-950 p-3 border border-slate-800">
                  <span className="text-slate-400 block">Ahorro protegido</span>
                  <strong className="font-mono text-sm text-indigo-300">
                    {formatEur(envelopesView.protectedSavingsAllocatedCents)}
                  </strong>
                  <span className="text-[10px] text-slate-500 block">No gastable</span>
                </div>
              </div>
            </section>

            {/* Obligations & Reserved Bills (Section 6) */}
            <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3">
              <h3 className="text-sm font-bold text-slate-100">
                Obligaciones y recibos reservados (Compromisos en liquidez)
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input
                  data-testid="new-obligation-name"
                  type="text"
                  placeholder="Ej. Alquiler piso"
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
                        periodKey: appState.currentPeriodKey,
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
                      setNewObligationName('');
                      setNewObligationAmount('');
                    } catch (e) {
                      setToastMessage({
                        text: e instanceof Error ? e.message : 'Importe inválido',
                        type: 'error',
                      });
                    }
                  }}
                  className="min-h-[42px] rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold"
                >
                  Reservar obligación
                </button>
              </div>

              {appState.obligations.length > 0 && (
                <div className="space-y-2 pt-2">
                  {appState.obligations.map((ob) => {
                    const remaining = Math.max(0, ob.expectedAmountCents - ob.paidAmountCents);
                    return (
                      <div
                        key={ob.id}
                        className="rounded-xl bg-slate-950 border border-slate-800 p-3 flex items-center justify-between text-xs"
                      >
                        <div>
                          <span className="font-bold text-slate-200">{ob.name}</span>
                          <span className="block text-slate-400">
                            Reservado pendiente: {formatEur(remaining)} de{' '}
                            {formatEur(ob.expectedAmountCents)} ({ob.status})
                          </span>
                        </div>
                        {remaining > 0 && (
                          <button
                            type="button"
                            data-testid={`pay-obligation-${ob.id}`}
                            onClick={() => {
                              const payTx: CanonicalTransaction = {
                                id: `tx_ob_pay_${Date.now()}`,
                                userId: appState.userId,
                                accountId: 'acc_bank_caixabank',
                                type: 'expense',
                                status: 'booked',
                                amountCents: -remaining,
                                currency: 'EUR',
                                bookingDate: getTodayMadridCalendarDate(),
                                valueDate: getTodayMadridCalendarDate(),
                                occurredAtUtc: new Date().toISOString(),
                                createdAtUtc: new Date().toISOString(),
                                description: `Pago obligación: ${ob.name}`,
                                merchantNormalized: ob.name.toUpperCase(),
                                userNote: null,
                                categoryId: 'housing_bills',
                                categorySource: 'user_locked',
                                categoryConfidence: 100,
                                categoryExplanation: 'Pago de obligación reservada',
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
                              setToastMessage({
                                text: `Obligación "${ob.name}" pagada y reserva liberada atómicamente.`,
                                type: 'success',
                              });
                            }}
                            className="min-h-[38px] px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
                          >
                            Pagar y liberar reserva
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Opening Bank Balance Snapshot & Cash Salary Entry */}
            <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3">
              <h3 className="text-sm font-bold text-slate-100">
                Saldos verificados y nómina en efectivo
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="rounded-xl bg-slate-950 border border-slate-800 p-3 space-y-2">
                  <span className="font-semibold text-slate-300 block">
                    Fijar saldo bancario conocido (CaixaBank)
                  </span>
                  <div className="flex gap-2">
                    <input
                      data-testid="bank-snapshot-input"
                      type="text"
                      placeholder="Ej. 1.000,00"
                      value={openingBankAmountInput}
                      onChange={(e) => setOpeningBankAmountInput(e.target.value)}
                      className="flex-1 min-h-[40px] rounded-lg bg-slate-900 border border-slate-700 px-2.5 font-mono text-slate-100"
                    />
                    <button
                      type="button"
                      data-testid="save-bank-snapshot-btn"
                      onClick={() => {
                        try {
                          const cents = parseMoneyToCents(openingBankAmountInput);
                          setAppState((prev) => ({
                            ...prev,
                            snapshots: [
                              {
                                id: `snap_${Date.now()}`,
                                userId: prev.userId,
                                accountId: 'acc_bank_caixabank',
                                source: 'manual',
                                balanceType: 'MANUAL',
                                amountCents: cents,
                                currency: 'EUR',
                                referenceTimeUtc: new Date().toISOString(),
                                referenceBookingDate: getTodayMadridCalendarDate(),
                                includesPendingDebits: false,
                              },
                              ...prev.snapshots,
                            ],
                          }));
                          setOpeningBankAmountInput('');
                          setToastMessage({
                            text: 'Saldo bancario registrado para cálculo de liquidez.',
                            type: 'success',
                          });
                        } catch (e) {
                          setToastMessage({
                            text: e instanceof Error ? e.message : 'Importe inválido',
                            type: 'error',
                          });
                        }
                      }}
                      className="px-3 rounded-lg bg-emerald-600 text-white font-bold"
                    >
                      Guardar
                    </button>
                  </div>
                </div>

                <div className="rounded-xl bg-slate-950 border border-slate-800 p-3 space-y-2">
                  <span className="font-semibold text-slate-300 block">
                    Registrar nómina / ingreso en efectivo
                  </span>
                  <div className="flex gap-2">
                    <input
                      data-testid="cash-salary-input"
                      type="text"
                      placeholder="Ej. 1.250,00"
                      value={cashIncomeAmountInput}
                      onChange={(e) => setCashIncomeAmountInput(e.target.value)}
                      className="flex-1 min-h-[40px] rounded-lg bg-slate-900 border border-slate-700 px-2.5 font-mono text-slate-100"
                    />
                    <button
                      type="button"
                      data-testid="save-cash-salary-btn"
                      onClick={() => {
                        try {
                          const cents = parseMoneyToCents(cashIncomeAmountInput, {
                            allowNegative: false,
                          });
                          const salaryTx: CanonicalTransaction = {
                            id: `tx_cash_sal_${Date.now()}`,
                            userId: appState.userId,
                            accountId: 'acc_cash_main',
                            type: 'income',
                            status: 'booked',
                            amountCents: cents,
                            currency: 'EUR',
                            bookingDate: getTodayMadridCalendarDate(),
                            valueDate: getTodayMadridCalendarDate(),
                            occurredAtUtc: new Date().toISOString(),
                            createdAtUtc: new Date().toISOString(),
                            description: 'Nómina cobrada en efectivo',
                            merchantNormalized: 'NOMINA EFECTIVO',
                            userNote: null,
                            categoryId: 'income',
                            categorySource: 'user_locked',
                            categoryConfidence: 100,
                            categoryExplanation: 'Ingreso externo en cuenta de efectivo',
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
                            transactions: [salaryTx, ...prev.transactions],
                          }));
                          setCashIncomeAmountInput('');
                          setToastMessage({
                            text: `Nómina en efectivo de ${formatEur(cents)} registrada.`,
                            type: 'success',
                          });
                        } catch (e) {
                          setToastMessage({
                            text: e instanceof Error ? e.message : 'Importe inválido',
                            type: 'error',
                          });
                        }
                      }}
                      className="px-3 rounded-lg bg-emerald-600 text-white font-bold"
                    >
                      Cobrar
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </div>
        )}

        {/* ====================================================================
            TAB 4: ANÁLISIS (Category/Merchant Breakdowns & Recurring Candidates)
           ==================================================================== */}
        {activeTab === 'analisis' && (
          <div className="space-y-4">
            <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3">
              <h2 className="text-base font-bold text-slate-100">
                Análisis determinista ({appState.currentPeriodKey})
              </h2>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-xl bg-slate-950 border border-slate-800 p-3">
                  <span className="text-slate-400 block">Gasto personal neto</span>
                  <strong className="font-mono text-lg text-slate-100">
                    {formatEur(currentMonthAnalytics.currentWindowNetSpendCents)}
                  </strong>
                  <span className="text-[11px] text-slate-400 block mt-0.5">
                    {currentMonthAnalytics.deltaPercent !== null
                      ? `${currentMonthAnalytics.deltaPercent}% vs mes anterior`
                      : 'Sin historial previo completo para comparar'}
                  </span>
                </div>

                <div className="rounded-xl bg-slate-950 border border-slate-800 p-3">
                  <span className="text-slate-400 block">Compras pequeñas (nº y total)</span>
                  <strong className="font-mono text-lg text-amber-300">
                    {currentMonthAnalytics.smallPurchaseCount} compras ·{' '}
                    {formatEur(currentMonthAnalytics.smallPurchaseNetCents)}
                  </strong>
                  <span className="text-[11px] text-slate-400 block mt-0.5">
                    Etiquetadas por regla o manualmente
                  </span>
                </div>
              </div>

              <div className="space-y-2 pt-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Desglose por categoría
                </h3>
                {Object.entries(currentMonthAnalytics.byCategoryNetCents).length === 0 ? (
                  <p className="text-xs text-slate-500">Sin gastos personales en este periodo.</p>
                ) : (
                  Object.entries(currentMonthAnalytics.byCategoryNetCents).map(([catId, cents]) => {
                    const cat = DEFAULT_SPANISH_CATEGORIES.find((c) => c.id === catId);
                    return (
                      <div
                        key={catId}
                        className="flex items-center justify-between rounded-xl bg-slate-950 px-3 py-2 text-xs"
                      >
                        <span>{cat?.nameSpanish ?? catId}</span>
                        <span className="font-mono font-bold text-slate-200">
                          {formatEur(cents)}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            {/* Recurring Payment Candidates */}
            <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-2">
              <h3 className="text-sm font-bold text-slate-100">
                Candidatos de pagos recurrentes detectados
              </h3>
              <p className="text-xs text-slate-400">
                Detectar un patrón no reserva dinero automáticamente: confírmalo si deseas crear una obligación reservada.
              </p>
              {recurringCandidates.length === 0 ? (
                <p className="text-xs text-slate-500 pt-1">
                  No hay candidatos recurrentes pendientes de confirmar.
                </p>
              ) : (
                recurringCandidates.map((cand) => (
                  <div
                    key={cand.merchantNormalized}
                    className="rounded-xl bg-slate-950 border border-slate-800 p-3 flex items-center justify-between gap-2 text-xs"
                  >
                    <div>
                      <span className="font-bold text-slate-100">{cand.displayDescription}</span>
                      <p className="text-slate-400">{cand.evidenceSpanish}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const ob: ObligationReservation = {
                          id: `ob_rec_${Date.now()}`,
                          userId: appState.userId,
                          name: cand.displayDescription,
                          periodKey: appState.currentPeriodKey,
                          expectedAmountCents: cand.estimatedAmountCents,
                          paidAmountCents: 0,
                          status: 'reserved',
                          dueDate: `${appState.currentPeriodKey}-${String(
                            cand.approximateDayOfMonth
                          ).padStart(2, '0')}` as CalendarDateISO,
                          settledTransactionIds: [],
                        };
                        setAppState((prev) => ({
                          ...prev,
                          obligations: [...prev.obligations, ob],
                        }));
                        setToastMessage({
                          text: `Obligación recurrente "${cand.displayDescription}" confirmada y reservada.`,
                          type: 'success',
                        });
                      }}
                      className="min-h-[38px] px-3 rounded-lg bg-emerald-600 text-white font-semibold shrink-0"
                    >
                      Confirmar ({formatEur(cand.estimatedAmountCents)})
                    </button>
                  </div>
                ))
              )}
            </section>
          </div>
        )}

        {/* ====================================================================
            TAB 5: AJUSTES (CaixaBank / Enable Banking, Offline Queue, Push, Security)
           ==================================================================== */}
        {activeTab === 'ajustes' && (
          <div className="space-y-4">
            {/* 0. Supabase Project Status */}
            <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-400">
                    Persistencia y Base de Datos
                  </span>
                  <h2 className="text-base font-bold text-slate-100">
                    Proyecto Supabase: STOP SPEND ({KNOWN_SUPABASE_PROJECT_REF})
                  </h2>
                </div>
                <span className="text-xs font-mono px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-slate-300">
                  {supabaseClient ? 'Supabase Conectado' : 'Pendiente de clave pública'}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                URL: <code className="text-slate-200">https://{KNOWN_SUPABASE_PROJECT_REF}.supabase.co</code> ·
                La conexión a Supabase gestiona tu autenticación y base de datos PostgreSQL con RLS; Enable Banking permanece <strong>Sin configurar</strong> de forma independiente hasta que vincules tu cuenta de CaixaBank.
              </p>
            </section>

            {/* 1. Banking Connection: CaixaBank via Enable Banking */}
            <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-400">
                    Integración PSD2 de solo lectura
                  </span>
                  <h2 className="text-base font-bold text-slate-100">
                    Conexión CaixaBank (Enable Banking)
                  </h2>
                </div>
                <span className="text-xs font-mono px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-slate-300">
                  {bankStatusBadge.badgeTextSpanish}
                </span>
              </div>

              <p className="text-xs text-slate-300">{bankStatusBadge.descriptionSpanish}</p>

              <div className="rounded-xl bg-slate-950 border border-slate-800 p-3 text-xs text-slate-400 space-y-1">
                <p className="font-semibold text-slate-200">
                  Proceso en 2 pasos para uso personal restringido:
                </p>
                <p>
                  1. Vincula primero tu cuenta propia de CaixaBank en el panel de Enable Banking (<em>Linked Accounts</em>).
                </p>
                <p>
                  2. Inicia la autorización PSD2 desde STOP SPEND y completa la autenticación SCA en CaixaBankNow.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setAppState((prev) => ({
                      ...prev,
                      bankConfig: {
                        ...prev.bankConfig,
                        localSyncPaused: !prev.bankConfig.localSyncPaused,
                      },
                    }))
                  }
                  className="min-h-[40px] px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-slate-200"
                >
                  {appState.bankConfig.localSyncPaused
                    ? 'Reanudar sincronización local'
                    : 'Pausar sincronización local'}
                </button>

                <button
                  type="button"
                  onClick={() =>
                    setAppState((prev) => ({
                      ...prev,
                      bankConfig: {
                        ...prev.bankConfig,
                        hasValidSession: false,
                        sessionRevoked: true,
                      },
                    }))
                  }
                  className="min-h-[40px] px-3 rounded-xl bg-rose-950/70 hover:bg-rose-900 border border-rose-700/60 text-xs text-rose-200"
                >
                  Eliminar sesión en proveedor (DELETE /sessions)
                </button>
              </div>
            </section>

            {/* 2. Offline Queue & API Error Recovery Controls */}
            <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Wifi className="w-4 h-4 text-emerald-400" />
                <span>Cola sin conexión (Offline) y resiliencia</span>
              </h3>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                <button
                  type="button"
                  data-testid="toggle-simulate-offline-btn"
                  onClick={() =>
                    setAppState((prev) => ({
                      ...prev,
                      simulateNetworkOffline: !prev.simulateNetworkOffline,
                    }))
                  }
                  className={`min-h-[44px] px-3 rounded-xl border font-semibold flex items-center justify-between ${
                    appState.simulateNetworkOffline
                      ? 'bg-amber-950/70 border-amber-600 text-amber-200'
                      : 'bg-slate-950 border-slate-800 text-slate-300'
                  }`}
                >
                  <span>Modo sin conexión</span>
                  <span>{appState.simulateNetworkOffline ? 'ACTIVO (Encolando)' : 'Conectado'}</span>
                </button>

                <button
                  type="button"
                  data-testid="toggle-simulate-api-error-btn"
                  onClick={() =>
                    setAppState((prev) => ({
                      ...prev,
                      simulateNextApiError: !prev.simulateNextApiError,
                    }))
                  }
                  className={`min-h-[44px] px-3 rounded-xl border font-semibold flex items-center justify-between ${
                    appState.simulateNextApiError
                      ? 'bg-rose-950/70 border-rose-600 text-rose-200'
                      : 'bg-slate-950 border-slate-800 text-slate-300'
                  }`}
                >
                  <span>Simular fallo de API en próximo guardado</span>
                  <span>{appState.simulateNextApiError ? 'Armado' : 'Inactivo'}</span>
                </button>
              </div>

              {userPendingOfflineQueue.length > 0 && (
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
              )}
            </section>

            {/* 3. Web Push & Quiet Hours (Europe/Madrid) */}
            <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Bell className="w-4 h-4 text-emerald-400" />
                <span>Notificaciones Web Push y Horas de Silencio (Europe/Madrid)</span>
              </h3>
              <p className="text-xs text-slate-400">
                Por defecto, los avisos push ocultan importes y comercios por privacidad. En iPhone (iOS Safari) requiere instalar primero la web en pantalla de inicio.
              </p>
              <div className="flex flex-wrap gap-2 text-xs">
                <button
                  type="button"
                  data-testid="request-push-permission-btn"
                  onClick={async () => {
                    if (typeof Notification === 'undefined') {
                      setAppState((prev) => ({
                        ...prev,
                        pushConfig: { ...prev.pushConfig, permissionState: 'unsupported' },
                      }));
                      return;
                    }
                    const perm = await Notification.requestPermission();
                    setAppState((prev) => ({
                      ...prev,
                      pushConfig: {
                        ...prev.pushConfig,
                        permissionState: perm,
                      },
                    }));
                    setToastMessage({
                      text:
                        perm === 'granted'
                          ? 'Permiso de notificaciones concedido.'
                          : 'Notificaciones denegadas; las alertas dentro de la app siguen activas.',
                      type: perm === 'granted' ? 'success' : 'warning',
                    });
                  }}
                  className="min-h-[40px] px-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold"
                >
                  Solicitar permiso Push ({appState.pushConfig.permissionState})
                </button>

                <button
                  type="button"
                  onClick={() =>
                    setAppState((prev) => ({
                      ...prev,
                      pushConfig: {
                        ...prev.pushConfig,
                        includeSensitiveAmountsInPush:
                          !prev.pushConfig.includeSensitiveAmountsInPush,
                      },
                    }))
                  }
                  className="min-h-[40px] px-3 rounded-xl bg-slate-800 text-slate-200"
                >
                  Mostrar importes en Push:{' '}
                  {appState.pushConfig.includeSensitiveAmountsInPush ? 'Sí (Opt-in)' : 'No (Ocultos)'}
                </button>
              </div>
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

      {/* Bottom Navigation Bar (5 Tabs: Inicio, Movimientos, Presupuestos, Análisis, Ajustes) */}
      <nav
        aria-label="Navegación principal"
        className="safe-bottom fixed bottom-0 left-0 right-0 z-30 bg-slate-950/95 backdrop-blur-md border-t border-slate-800"
      >
        <div className="max-w-xl mx-auto grid grid-cols-5 px-2 py-1">
          {[
            { id: 'inicio', label: 'Inicio', Icon: Home },
            { id: 'movimientos', label: 'Movimientos', Icon: ListOrdered },
            { id: 'presupuestos', label: 'Presupuestos', Icon: Wallet },
            { id: 'analisis', label: 'Análisis', Icon: BarChart3 },
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
                  active ? 'text-emerald-400 font-bold' : 'text-slate-400 hover:text-slate-200'
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
