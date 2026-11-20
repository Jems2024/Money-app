"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Award,
  Bell,
  Building2,
  CheckCircle2,
  Clock,
  Coffee,
  Edit3,
  Home,
  Loader2,
  LogOut,
  Phone,
  PieChart,
  Plus,
  Receipt,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Tag,
  Trash2,
} from "lucide-react";
import {
  BankAccount,
  EnvelopeCategory,
  FamilyRole,
  FixedBill,
  MonthlyEnvelopes,
  Transaction,
} from "@/types/finance";
import { createClient } from "@/lib/supabase/client";
import { computeFintonicInsights } from "@/lib/fintonic-insights";
import BankSyncModal from "./BankSyncModal";
import FintonicInsightsPanel from "./FintonicInsightsPanel";
import ManualTransactionModal from "./ManualTransactionModal";
import PhoneAlertsModal from "./PhoneAlertsModal";
import PrivateAuthScreen from "./PrivateAuthScreen";

function formatEUR(amount: number): string {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
  }).format(amount);
}

interface AuthenticatedUserProfile {
  id: string;
  email: string;
  display_name: string;
  role: FamilyRole;
  phone: string;
  whatsappApiKey?: string;
}

type FintonicTab = "inicio" | "movimientos" | "presupuesto" | "alertas" | "finscore";

export default function FamilyFinanceDashboard() {
  const [loadingSession, setLoadingSession] = useState(true);
  const [currentUser, setCurrentUser] =
    useState<AuthenticatedUserProfile | null>(null);

  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [envelopes, setEnvelopes] = useState<MonthlyEnvelopes>({
    id: "",
    month_year: new Date().toISOString().slice(0, 7),
    ant_expenses_limit: 150,
    husband_free_limit: 200,
    wife_free_limit: 200,
    shared_free_limit: 150,
    savings_goal: 300,
    groceries_limit: 400,
    notified_thresholds: {},
  });
  const [fixedBills, setFixedBills] = useState<FixedBill[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  // Navegación inferior estilo Fintonic (5 pestañas)
  const [activeTab, setActiveTab] = useState<FintonicTab>("inicio");

  // Filtros en Movimientos
  const [txSearch, setTxSearch] = useState("");
  const [txFilter, setTxFilter] = useState<"all" | "expense" | "income">("all");

  // Modales y edición
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  const [isPhoneModalOpen, setIsPhoneModalOpen] = useState(false);
  const [isEditingEnvelopes, setIsEditingEnvelopes] = useState(false);
  const [isAddingBill, setIsAddingBill] = useState(false);
  const [editingBalanceId, setEditingBalanceId] = useState<string | null>(null);
  const [tempBalanceValue, setTempBalanceValue] = useState<string>("");
  const [syncingAccountId, setSyncingAccountId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [didAutoSync, setDidAutoSync] = useState(false);

  // Nuevo recibo fijo
  const [newBillCode, setNewBillCode] = useState("REC-LUZ");
  const [newBillName, setNewBillName] = useState("");
  const [newBillAmount, setNewBillAmount] = useState("");
  const [newBillAccountId, setNewBillAccountId] = useState("");

  // Alertas y banner PSD2
  const [pushAlertsFeed, setPushAlertsFeed] = useState<
    { id: string; title: string; body: string; threshold: 80 | 100 }[]
  >([]);
  const [statusBanner, setStatusBanner] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
      }
      const params = new URLSearchParams(window.location.search);
      if (params.get("psd2_connected") === "true") {
        setStatusBanner({
          type: "success",
          text: `¡Cuenta de ${params.get("bank") || "imagin"} conectada! Pulsa el icono de sincronizar 🔄 en tu cuenta para descargar tus movimientos.`,
        });
        window.history.replaceState({}, "", "/");
      } else if (params.get("psd2_error")) {
        setStatusBanner({
          type: "error",
          text: `Error al conectar el banco (${params.get("psd2_error")}). Verifica tus credenciales de Enable Banking en Vercel.`,
        });
        window.history.replaceState({}, "", "/");
      }
    }
  }, []);

  const loadPrivateUserData = useCallback(async () => {
    try {
      const res = await fetch("/api/user-data", { cache: "no-store" });
      if (res.status === 401) {
        setCurrentUser(null);
        setLoadingSession(false);
        return;
      }
      const data = await res.json();
      if (data.ok && data.user) {
        setCurrentUser(data.user);
        setAccounts(data.accounts || []);
        setFixedBills(data.fixedBills || []);
        setTransactions(data.transactions || []);
        if (data.envelopes) setEnvelopes(data.envelopes);
        if (data.accounts?.length > 0) {
          setNewBillAccountId((prev) => prev || data.accounts[0].id);
        }
      } else {
        setCurrentUser(null);
      }
    } catch {
      setCurrentUser(null);
    } finally {
      setLoadingSession(false);
    }
  }, []);

  useEffect(() => {
    loadPrivateUserData();
  }, [loadPrivateUserData]);

  // Auto-sincronización silenciosa al abrir la app si pasaron > 5 min desde el último sync PSD2
  useEffect(() => {
    if (didAutoSync || accounts.length === 0) return;
    const psd2Acc = accounts.find((a) => a.enable_banking_account_id);
    if (!psd2Acc) return;

    const lastSyncMs = psd2Acc.last_synced_at
      ? new Date(psd2Acc.last_synced_at).getTime()
      : 0;
    const fiveMinutes = 5 * 60 * 1000;
    if (Date.now() - lastSyncMs > fiveMinutes) {
      setDidAutoSync(true);
      fetch("/api/enable-banking/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bankAccountId: psd2Acc.id }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.ok) {
            loadPrivateUserData();
          }
        })
        .catch(() => {});
    } else {
      setDidAutoSync(true);
    }
  }, [accounts, didAutoSync, loadPrivateUserData]);

  // Cálculos principales
  const metrics = useMemo(() => {
    const totalBalance = accounts.reduce(
      (acc, a) => acc + Number(a.current_balance || 0),
      0
    );
    const pendingBillsTotal = fixedBills
      .filter((b) => !b.is_paid_this_month)
      .reduce((acc, b) => acc + Number(b.expected_amount || 0), 0);
    const paidBillsTotal = fixedBills
      .filter((b) => b.is_paid_this_month)
      .reduce((acc, b) => acc + Number(b.expected_amount || 0), 0);

    const savingsGoal = Number(envelopes.savings_goal || 0);
    const realFreeMoney =
      accounts.length === 0
        ? 0
        : totalBalance - pendingBillsTotal - savingsGoal;

    const currentMonthPrefix = new Date().toISOString().slice(0, 7);
    const monthTxs = transactions.filter((t) =>
      String(t.date || "").startsWith(currentMonthPrefix)
    );
    const monthIncome = monthTxs
      .filter((t) => t.type === "income")
      .reduce((acc, t) => acc + Number(t.amount || 0), 0);
    const monthExpenses = monthTxs
      .filter((t) => t.type === "expense")
      .reduce((acc, t) => acc + Number(t.amount || 0), 0);

    const confirmedExpenses = transactions.filter(
      (t) => t.type === "expense" && !t.needs_review
    );
    const sumEnv = (keys: EnvelopeCategory[]) =>
      confirmedExpenses
        .filter((t) => keys.includes(t.envelope))
        .reduce((acc, t) => acc + Number(t.amount || 0), 0);

    const buildEnvelope = (
      key: EnvelopeCategory,
      label: string,
      spent: number,
      limit: number
    ) => {
      const safeLimit = limit > 0 ? limit : 1;
      const percentage = Math.round((spent / safeLimit) * 100);
      const status: "safe" | "warning80" | "exceeded100" =
        percentage >= 100
          ? "exceeded100"
          : percentage >= 80
          ? "warning80"
          : "safe";
      return { key, label, spent, limit, percentage, status };
    };

    const freeLimit =
      currentUser?.role === "esposa"
        ? Number(envelopes.wife_free_limit)
        : Number(envelopes.husband_free_limit);

    const envelopeList = [
      buildEnvelope(
        "hormiga",
        "Gastos Hormiga",
        sumEnv(["hormiga"]),
        Number(envelopes.ant_expenses_limit)
      ),
      buildEnvelope(
        "necesario",
        "Supermercado y Necesarios",
        sumEnv(["necesario"]),
        Number(envelopes.groceries_limit)
      ),
      buildEnvelope(
        currentUser?.role === "esposa" ? "libre_esposa" : "libre_esposo",
        "Gasto Libre Personal",
        sumEnv(["libre_esposo", "libre_esposa", "libre_comun"]),
        freeLimit
      ),
      buildEnvelope(
        "ahorro",
        "Meta de Ahorro Mensual",
        sumEnv(["ahorro"]),
        savingsGoal
      ),
    ];

    return {
      totalBalance,
      pendingBillsTotal,
      paidBillsTotal,
      savingsGoal,
      realFreeMoney,
      monthIncome,
      monthExpenses,
      envelopeList,
    };
  }, [accounts, fixedBills, envelopes, transactions, currentUser]);

  const fintonicInsights = useMemo(
    () => computeFintonicInsights(accounts, fixedBills, transactions, envelopes),
    [accounts, fixedBills, transactions, envelopes]
  );

  const pendingReviewTransactions = useMemo(
    () => transactions.filter((t) => t.needs_review),
    [transactions]
  );

  const filteredTransactions = useMemo(() => {
    return transactions.filter((tx) => {
      if (txFilter !== "all" && tx.type !== txFilter) return false;
      if (txSearch.trim()) {
        const q = txSearch.toLowerCase();
        const matchConcept = tx.concept.toLowerCase().includes(q);
        const matchCode = (tx.custom_code || "").toLowerCase().includes(q);
        const matchEnv = tx.envelope.toLowerCase().includes(q);
        return matchConcept || matchCode || matchEnv;
      }
      return true;
    });
  }, [transactions, txFilter, txSearch]);

  const checkThresholdsAndNotify = async (
    updatedTxs: Transaction[],
    currentEnv: MonthlyEnvelopes
  ) => {
    try {
      const res = await fetch("/api/push/check-thresholds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          envelopes: currentEnv,
          transactions: updatedTxs,
        }),
      });
      const data = await res.json();
      if (data.ok && Array.isArray(data.triggeredAlerts) && data.triggeredAlerts.length > 0) {
        const newAlerts = data.triggeredAlerts.map(
          (a: { title: string; body: string; threshold: 80 | 100 }) => ({
            id: `alert-${Date.now()}-${Math.random()}`,
            title: a.title,
            body: a.body,
            threshold: a.threshold,
          })
        );
        setPushAlertsFeed((prev) => [...newAlerts, ...prev]);

        if (
          typeof window !== "undefined" &&
          "Notification" in window &&
          Notification.permission === "granted"
        ) {
          for (const alert of newAlerts) {
            new Notification(alert.title, {
              body: alert.body,
              icon: "/icon.svg",
            });
          }
        }
      }
    } catch {
      // Silencioso
    }
  };

  const handleDataChanged = async () => {
    await loadPrivateUserData();
    const res = await fetch("/api/user-data", { cache: "no-store" });
    const data = await res.json();
    if (data.ok) {
      checkThresholdsAndNotify(data.transactions || [], data.envelopes);
    }
  };

  // Eliminar cuenta bancaria (soluciona las cuentas de prueba antiguas)
  const handleDeleteAccount = async (account: BankAccount) => {
    if (
      !window.confirm(
        `¿Seguro que quieres eliminar "${account.account_alias}" (${account.bank_name}) y sus movimientos asociados?`
      )
    ) {
      return;
    }
    setDeletingId(account.id);
    try {
      const res = await fetch("/api/user-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete_bank_account",
          accountId: account.id,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setStatusBanner({
          type: "success",
          text: `Cuenta "${account.account_alias}" eliminada correctamente.`,
        });
        await loadPrivateUserData();
      }
    } finally {
      setDeletingId(null);
    }
  };

  // Sincronizar cuenta PSD2 directamente desde la tarjeta
  const handleSyncAccountPSD2 = async (account: BankAccount) => {
    setSyncingAccountId(account.id);
    setStatusBanner(null);
    try {
      const res = await fetch("/api/enable-banking/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bankAccountId: account.id }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStatusBanner({
          type: "error",
          text: data.error || "No se pudo sincronizar la cuenta.",
        });
      } else {
        setStatusBanner({
          type: "success",
          text: `¡Sincronizado ${account.bank_name}! Saldo actual: ${formatEUR(
            Number(data.currentBalance || 0)
          )} (${(data.newTransactions || []).length} movimientos).`,
        });
        await handleDataChanged();
      }
    } finally {
      setSyncingAccountId(null);
    }
  };

  const handleDeleteTransaction = async (txId: string) => {
    setDeletingId(txId);
    try {
      await fetch("/api/user-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete_transaction", txId }),
      });
      await loadPrivateUserData();
    } finally {
      setDeletingId(null);
    }
  };

  const handleDeleteFixedBill = async (billId: string) => {
    setDeletingId(billId);
    try {
      await fetch("/api/user-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete_fixed_bill", billId }),
      });
      await loadPrivateUserData();
    } finally {
      setDeletingId(null);
    }
  };

  const handleConfirmSupermarketTx = async (
    tx: Transaction,
    choice: "necesario" | "hormiga" | "mi_libre"
  ) => {
    const targetEnvelope: EnvelopeCategory =
      choice === "mi_libre"
        ? currentUser?.role === "esposa"
          ? "libre_esposa"
          : "libre_esposo"
        : choice;

    await fetch("/api/user-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "confirm_supermarket_tx",
        txId: tx.id,
        envelope: targetEnvelope,
      }),
    });
    await handleDataChanged();
  };

  const handleSaveAccountBalance = async (accountId: string) => {
    const val = parseFloat(tempBalanceValue.replace(",", "."));
    if (!isNaN(val)) {
      await fetch("/api/user-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_balance",
          accountId,
          currentBalance: val,
        }),
      });
      await loadPrivateUserData();
    }
    setEditingBalanceId(null);
  };

  const handleSaveEnvelopes = async () => {
    await fetch("/api/user-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save_envelopes", envelopes }),
    });
    setIsEditingEnvelopes(false);
    await loadPrivateUserData();
  };

  const handleCreateFixedBill = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetAccId = newBillAccountId || accounts[0]?.id;
    if (!targetAccId) return;
    const numericAmount = parseFloat(newBillAmount.replace(",", "."));
    if (!newBillName.trim() || isNaN(numericAmount) || numericAmount <= 0) return;

    await fetch("/api/user-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_fixed_bill",
        customCode: newBillCode.trim().toUpperCase() || "REC-FIJO",
        name: newBillName.trim(),
        expectedAmount: numericAmount,
        chargedAccountId: targetAccId,
        matchKeyword: newBillName.trim().toUpperCase(),
      }),
    });
    setNewBillName("");
    setNewBillAmount("");
    setNewBillCode("REC-FIJO");
    setIsAddingBill(false);
    await loadPrivateUserData();
  };

  const handleToggleFixedBill = async (bill: FixedBill) => {
    await fetch("/api/user-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "toggle_fixed_bill",
        billId: bill.id,
        isPaid: !bill.is_paid_this_month,
      }),
    });
    await loadPrivateUserData();
  };

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    setCurrentUser(null);
    setAccounts([]);
    setFixedBills([]);
    setTransactions([]);
  };

  if (loadingSession) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-[#00D084]" />
      </div>
    );
  }

  if (!currentUser) {
    return <PrivateAuthScreen onAuthenticated={loadPrivateUserData} />;
  }

  const criticalAlertsCount = fintonicInsights.alerts.filter(
    (a) => a.severity === "critical"
  ).length;
  const userInitial = (currentUser.display_name || "U").charAt(0).toUpperCase();

  return (
    <div className="min-h-screen bg-black text-white pb-24">
      {/* =====================================================================
          HEADER MINIMALISTA ESTILO FINTONIC (NEGRO PURO OLED)
         ===================================================================== */}
      <header className="sticky top-0 z-30 bg-black/90 backdrop-blur-xl border-b border-zinc-900">
        <div className="max-w-xl mx-auto px-4 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-[#00D084]/15 border border-[#00D084]/40 text-[#00D084] flex items-center justify-center font-bold text-sm">
              {userInitial}
            </div>
            <div>
              <h1 className="text-sm font-bold text-white leading-tight">
                Hola, {currentUser.display_name.split(" ")[0]}
              </h1>
              <span className="text-[11px] text-zinc-400">
                Espacio Privado · Solo tú
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsPhoneModalOpen(true)}
              title="Mi Teléfono Móvil"
              className="p-2 rounded-full bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 transition"
            >
              <Phone className="w-4 h-4 text-[#00D084]" />
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("alertas")}
              title="Alertas"
              className="relative p-2 rounded-full bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 transition"
            >
              <Bell className="w-4 h-4" />
              {criticalAlertsCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-rose-500 text-[10px] font-bold text-white flex items-center justify-center">
                  {criticalAlertsCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={handleLogout}
              title="Cerrar sesión"
              className="p-2 rounded-full bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-white transition"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* =====================================================================
          CONTENIDO PRINCIPAL (MOBILE-FIRST CENTRADO ESTILO FINTONIC)
         ===================================================================== */}
      <main className="max-w-xl mx-auto px-4 pt-4 space-y-5">
        {statusBanner && (
          <div
            className={`p-3.5 rounded-2xl border text-xs flex items-center justify-between gap-3 ${
              statusBanner.type === "success"
                ? "bg-emerald-950/70 border-[#00D084]/40 text-emerald-200"
                : "bg-rose-950/70 border-rose-500/40 text-rose-200"
            }`}
          >
            <span>{statusBanner.text}</span>
            <button
              type="button"
              onClick={() => setStatusBanner(null)}
              className="underline shrink-0"
            >
              OK
            </button>
          </div>
        )}

        {/* ===================================================================
            PESTAÑA 1: INICIO (CLON LAYOUT FINTONIC EN NEGRO PURO)
           =================================================================== */}
        {activeTab === "inicio" && (
          <>
            {/* Hero Saldo Total */}
            <section className="rounded-3xl bg-[#111216] border border-zinc-800/80 p-5 space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <span className="text-xs font-medium text-zinc-400">
                    Saldo total en tus cuentas
                  </span>
                  <div className="text-4xl font-extrabold text-white tracking-tight mt-0.5">
                    {formatEUR(metrics.totalBalance)}
                  </div>
                  <div className="text-xs text-zinc-400 mt-1">
                    Libre real tras recibos y ahorro:{" "}
                    <span className="text-[#00D084] font-semibold">
                      {formatEUR(metrics.realFreeMoney)}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab("finscore")}
                  className="px-2.5 py-1 rounded-full bg-zinc-900 border border-zinc-800 text-[11px] font-bold text-[#00D084] flex items-center gap-1"
                >
                  <Award className="w-3.5 h-3.5" />
                  {fintonicInsights.hasData
                    ? `${fintonicInsights.finScore} pts`
                    : "FinScore"}
                </button>
              </div>

              {/* Dos tarjetas compactas: Ingresos vs Gastos del mes */}
              <div className="grid grid-cols-2 gap-2.5">
                <div className="rounded-2xl bg-black/70 border border-zinc-800/80 p-3">
                  <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                    <ArrowDownLeft className="w-3.5 h-3.5 text-[#00D084]" />
                    <span>Ingresos mes</span>
                  </div>
                  <div className="text-base font-bold text-[#00D084] mt-1">
                    +{formatEUR(metrics.monthIncome)}
                  </div>
                </div>

                <div className="rounded-2xl bg-black/70 border border-zinc-800/80 p-3">
                  <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                    <ArrowUpRight className="w-3.5 h-3.5 text-rose-400" />
                    <span>Gastos mes</span>
                  </div>
                  <div className="text-base font-bold text-white mt-1">
                    −{formatEUR(metrics.monthExpenses)}
                  </div>
                </div>
              </div>

              {/* Acciones rápidas estilo Fintonic */}
              <div className="grid grid-cols-2 gap-2.5 pt-1">
                {accounts.some((a) => a.enable_banking_account_id) ? (
                  <button
                    type="button"
                    disabled={Boolean(syncingAccountId)}
                    onClick={() => {
                      const psd2Acc = accounts.find(
                        (a) => a.enable_banking_account_id
                      );
                      if (psd2Acc) handleSyncAccountPSD2(psd2Acc);
                    }}
                    className="py-2.5 px-3 rounded-2xl bg-[#00D084] hover:bg-[#00b874] text-black text-xs font-bold flex items-center justify-center gap-1.5 transition"
                  >
                    <RefreshCw
                      className={`w-4 h-4 ${
                        syncingAccountId ? "animate-spin" : ""
                      }`}
                    />
                    {syncingAccountId ? "Actualizando..." : "Actualizar banco"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setIsSyncModalOpen(true)}
                    className="py-2.5 px-3 rounded-2xl bg-[#00D084] hover:bg-[#00b874] text-black text-xs font-bold flex items-center justify-center gap-1.5 transition"
                  >
                    <Building2 className="w-4 h-4" />
                    Conectar / Subir CSV
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    accounts.length === 0
                      ? setIsSyncModalOpen(true)
                      : setIsManualModalOpen(true)
                  }
                  className="py-2.5 px-3 rounded-2xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition"
                >
                  <Plus className="w-4 h-4 text-[#00D084]" />
                  Añadir gasto/ingreso
                </button>
              </div>
            </section>

            {/* Sección Mis Cuentas Bancarias (CON BOTÓN ELIMINAR + SINCRONIZAR) */}
            <section className="space-y-2.5">
              <div className="flex items-center justify-between px-1">
                <h2 className="text-sm font-bold text-white">
                  Mis Cuentas ({accounts.length})
                </h2>
                <button
                  type="button"
                  onClick={() => setIsSyncModalOpen(true)}
                  className="text-xs font-semibold text-[#00D084]"
                >
                  + Añadir cuenta
                </button>
              </div>

              {accounts.length === 0 ? (
                <div className="rounded-3xl bg-[#111216] border border-zinc-800/80 p-5 text-center space-y-2">
                  <p className="text-xs text-zinc-400">
                    No tienes ninguna cuenta vinculada todavía. Todo está limpio en{" "}
                    <strong className="text-white">0,00 €</strong>.
                  </p>
                  <button
                    type="button"
                    onClick={() => setIsSyncModalOpen(true)}
                    className="py-2 px-4 rounded-xl bg-[#00D084] text-black text-xs font-bold"
                  >
                    Conectar mi cuenta de imagin
                  </button>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {accounts.map((acc) => (
                    <div
                      key={acc.id}
                      className="rounded-2xl bg-[#111216] border border-zinc-800/80 p-4 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-[#00D084]">
                            {acc.bank_name}
                          </span>
                          {acc.enable_banking_account_id && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-300 border border-zinc-800">
                              PSD2
                            </span>
                          )}
                        </div>
                        <div className="text-sm font-semibold text-white truncate">
                          {acc.account_alias}
                        </div>
                        <div className="text-[11px] font-mono text-zinc-500">
                          {acc.iban_masked}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {editingBalanceId === acc.id ? (
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              step="0.01"
                              value={tempBalanceValue}
                              onChange={(e) => setTempBalanceValue(e.target.value)}
                              className="w-20 rounded-lg bg-black border border-zinc-700 px-2 py-1 text-xs text-white"
                            />
                            <button
                              type="button"
                              onClick={() => handleSaveAccountBalance(acc.id)}
                              className="px-2 py-1 rounded-lg bg-[#00D084] text-black text-xs font-bold"
                            >
                              OK
                            </button>
                          </div>
                        ) : (
                          <div className="text-right">
                            <div className="text-base font-extrabold text-white">
                              {formatEUR(Number(acc.current_balance))}
                            </div>
                            <div className="flex items-center justify-end gap-2 mt-1">
                              {acc.enable_banking_account_id && (
                                <button
                                  type="button"
                                  disabled={syncingAccountId === acc.id}
                                  onClick={() => handleSyncAccountPSD2(acc)}
                                  title="Sincronizar con el banco"
                                  className="text-zinc-400 hover:text-[#00D084]"
                                >
                                  <RefreshCw
                                    className={`w-3.5 h-3.5 ${
                                      syncingAccountId === acc.id ? "animate-spin" : ""
                                    }`}
                                  />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingBalanceId(acc.id);
                                  setTempBalanceValue(String(acc.current_balance));
                                }}
                                title="Editar saldo"
                                className="text-zinc-400 hover:text-white"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                disabled={deletingId === acc.id}
                                onClick={() => handleDeleteAccount(acc)}
                                title="Eliminar esta cuenta"
                                className="text-zinc-500 hover:text-rose-400"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Bandeja de Supermercado en 1 toque (solo si hay pendientes) */}
            {pendingReviewTransactions.length > 0 && (
              <section className="rounded-3xl bg-[#111216] border border-amber-500/40 p-4 space-y-3">
                <div className="flex items-center gap-2 text-xs font-bold text-amber-300">
                  <ShoppingCart className="w-4 h-4" />
                  <span>
                    Confirma tus compras de supermercado ({pendingReviewTransactions.length})
                  </span>
                </div>
                {pendingReviewTransactions.map((tx) => (
                  <div
                    key={tx.id}
                    className="rounded-2xl bg-black border border-zinc-800 p-3 space-y-2.5"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-white truncate">
                        {tx.concept}
                      </span>
                      <span className="font-extrabold text-amber-300 shrink-0">
                        {formatEUR(tx.amount)}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleConfirmSupermarketTx(tx, "necesario")}
                        className="py-2 rounded-xl bg-[#00D084]/15 text-[#00D084] text-[11px] font-bold flex items-center justify-center gap-1"
                      >
                        <ShoppingCart className="w-3 h-3" />
                        Necesaria
                      </button>
                      <button
                        type="button"
                        onClick={() => handleConfirmSupermarketTx(tx, "hormiga")}
                        className="py-2 rounded-xl bg-amber-500/15 text-amber-300 text-[11px] font-bold flex items-center justify-center gap-1"
                      >
                        <Coffee className="w-3 h-3" />
                        Hormiga
                      </button>
                      <button
                        type="button"
                        onClick={() => handleConfirmSupermarketTx(tx, "mi_libre")}
                        className="py-2 rounded-xl bg-indigo-500/15 text-indigo-300 text-[11px] font-bold flex items-center justify-center gap-1"
                      >
                        <ShoppingBag className="w-3 h-3" />
                        Mi Libre
                      </button>
                    </div>
                  </div>
                ))}
              </section>
            )}

            {/* Últimos movimientos */}
            <section className="space-y-2.5">
              <div className="flex items-center justify-between px-1">
                <h2 className="text-sm font-bold text-white">
                  Últimos movimientos
                </h2>
                <button
                  type="button"
                  onClick={() => setActiveTab("movimientos")}
                  className="text-xs font-semibold text-[#00D084]"
                >
                  Ver todos
                </button>
              </div>

              {transactions.length === 0 ? (
                <div className="rounded-2xl bg-[#111216] border border-zinc-800/80 p-5 text-center text-xs text-zinc-500">
                  Sin movimientos todavía.
                </div>
              ) : (
                <div className="rounded-3xl bg-[#111216] border border-zinc-800/80 divide-y divide-zinc-800/70">
                  {transactions.slice(0, 5).map((tx) => (
                    <div
                      key={tx.id}
                      className="p-3.5 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-white truncate">
                          {tx.concept}
                        </div>
                        <div className="text-[11px] text-zinc-500 mt-0.5">
                          {tx.date} · {tx.envelope.replace("_", " ")}
                        </div>
                      </div>
                      <div
                        className={`text-sm font-bold shrink-0 ${
                          tx.type === "income" ? "text-[#00D084]" : "text-white"
                        }`}
                      >
                        {tx.type === "income" ? "+" : "-"}
                        {formatEUR(tx.amount)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {/* ===================================================================
            PESTAÑA 2: MOVIMIENTOS (BUSCADOR + FILTROS + BORRAR)
           =================================================================== */}
        {activeTab === "movimientos" && (
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-white">Movimientos</h2>
              <button
                type="button"
                onClick={() =>
                  accounts.length === 0
                    ? setIsSyncModalOpen(true)
                    : setIsManualModalOpen(true)
                }
                className="py-2 px-3 rounded-xl bg-[#00D084] text-black text-xs font-bold flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" />
                Nuevo
              </button>
            </div>

            <div className="relative">
              <Search className="w-4 h-4 text-zinc-500 absolute left-3.5 top-3" />
              <input
                type="text"
                value={txSearch}
                onChange={(e) => setTxSearch(e.target.value)}
                placeholder="Buscar comercio, código o categoría..."
                className="w-full rounded-2xl bg-[#111216] border border-zinc-800 pl-10 pr-4 py-2.5 text-xs text-white focus:border-[#00D084] focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-3 gap-2">
              {(["all", "expense", "income"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setTxFilter(f)}
                  className={`py-2 rounded-xl text-xs font-semibold border transition ${
                    txFilter === f
                      ? "bg-[#00D084]/15 border-[#00D084] text-[#00D084]"
                      : "bg-[#111216] border-zinc-800 text-zinc-400"
                  }`}
                >
                  {f === "all" ? "Todos" : f === "expense" ? "Gastos" : "Ingresos"}
                </button>
              ))}
            </div>

            {filteredTransactions.length === 0 ? (
              <div className="rounded-3xl bg-[#111216] border border-zinc-800 p-6 text-center text-xs text-zinc-500">
                No hay movimientos que coincidan.
              </div>
            ) : (
              <div className="rounded-3xl bg-[#111216] border border-zinc-800 divide-y divide-zinc-800/70">
                {filteredTransactions.map((tx) => (
                  <div
                    key={tx.id}
                    className="p-3.5 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-white truncate">
                          {tx.concept}
                        </span>
                        {tx.custom_code && (
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-900 text-[#00D084]">
                            {tx.custom_code}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-zinc-500 mt-0.5">
                        {tx.date} · {tx.envelope.replace("_", " ")}
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <span
                        className={`text-sm font-bold ${
                          tx.type === "income" ? "text-[#00D084]" : "text-white"
                        }`}
                      >
                        {tx.type === "income" ? "+" : "-"}
                        {formatEUR(tx.amount)}
                      </span>
                      <button
                        type="button"
                        disabled={deletingId === tx.id}
                        onClick={() => handleDeleteTransaction(tx.id)}
                        title="Eliminar movimiento"
                        className="text-zinc-600 hover:text-rose-400"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* ===================================================================
            PESTAÑA 3: PRESUPUESTO (SOBRES + RECIBOS FIJOS + CATEGORÍAS)
           =================================================================== */}
        {activeTab === "presupuesto" && (
          <section className="space-y-5">
            {/* Sobres Editables */}
            <div className="rounded-3xl bg-[#111216] border border-zinc-800 p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-white">
                  Presupuestos del Mes
                </h2>
                <button
                  type="button"
                  onClick={() =>
                    isEditingEnvelopes
                      ? handleSaveEnvelopes()
                      : setIsEditingEnvelopes(true)
                  }
                  className="text-xs font-bold text-[#00D084] flex items-center gap-1"
                >
                  {isEditingEnvelopes ? (
                    <>
                      <Save className="w-3.5 h-3.5" />
                      Guardar
                    </>
                  ) : (
                    <>
                      <Edit3 className="w-3.5 h-3.5" />
                      Editar límites
                    </>
                  )}
                </button>
              </div>

              {isEditingEnvelopes && (
                <div className="grid grid-cols-2 gap-2.5 p-3 rounded-2xl bg-black border border-zinc-800">
                  <div>
                    <label className="block text-[10px] text-zinc-400 mb-1">
                      Gastos Hormiga (€)
                    </label>
                    <input
                      type="number"
                      value={envelopes.ant_expenses_limit}
                      onChange={(e) =>
                        setEnvelopes({
                          ...envelopes,
                          ant_expenses_limit: Number(e.target.value),
                        })
                      }
                      className="w-full rounded-xl bg-zinc-900 border border-zinc-700 px-2.5 py-1.5 text-xs text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-zinc-400 mb-1">
                      Supermercado (€)
                    </label>
                    <input
                      type="number"
                      value={envelopes.groceries_limit}
                      onChange={(e) =>
                        setEnvelopes({
                          ...envelopes,
                          groceries_limit: Number(e.target.value),
                        })
                      }
                      className="w-full rounded-xl bg-zinc-900 border border-zinc-700 px-2.5 py-1.5 text-xs text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-zinc-400 mb-1">
                      Gasto Libre (€)
                    </label>
                    <input
                      type="number"
                      value={envelopes.husband_free_limit}
                      onChange={(e) =>
                        setEnvelopes({
                          ...envelopes,
                          husband_free_limit: Number(e.target.value),
                          wife_free_limit: Number(e.target.value),
                        })
                      }
                      className="w-full rounded-xl bg-zinc-900 border border-zinc-700 px-2.5 py-1.5 text-xs text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-zinc-400 mb-1">
                      Meta Ahorro (€)
                    </label>
                    <input
                      type="number"
                      value={envelopes.savings_goal}
                      onChange={(e) =>
                        setEnvelopes({
                          ...envelopes,
                          savings_goal: Number(e.target.value),
                        })
                      }
                      className="w-full rounded-xl bg-zinc-900 border border-zinc-700 px-2.5 py-1.5 text-xs text-white"
                    />
                  </div>
                </div>
              )}

              <div className="space-y-3.5">
                {metrics.envelopeList.map((env) => {
                  const barColor =
                    env.key === "ahorro"
                      ? "bg-[#00D084]"
                      : env.status === "exceeded100"
                      ? "bg-rose-500"
                      : env.status === "warning80"
                      ? "bg-amber-400"
                      : "bg-[#00D084]";
                  return (
                    <div key={env.key} className="space-y-1.5">
                      <div className="flex justify-between text-xs">
                        <span className="font-semibold text-white">
                          {env.label}
                        </span>
                        <span className="font-bold text-zinc-200">
                          {formatEUR(env.spent)}{" "}
                          <span className="text-zinc-500 font-normal">
                            / {formatEUR(env.limit)}
                          </span>
                        </span>
                      </div>
                      <div className="relative h-2.5 w-full rounded-full bg-zinc-900 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${barColor}`}
                          style={{ width: `${Math.min(env.percentage, 100)}%` }}
                        />
                        <div
                          className="absolute top-0 bottom-0 w-0.5 bg-white/30"
                          style={{ left: "80%" }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Recibos Fijos */}
            <div className="rounded-3xl bg-[#111216] border border-zinc-800 p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <Receipt className="w-4 h-4 text-[#00D084]" />
                  Recibos Fijos
                </h2>
                <button
                  type="button"
                  onClick={() =>
                    accounts.length === 0
                      ? setIsSyncModalOpen(true)
                      : setIsAddingBill(!isAddingBill)
                  }
                  className="text-xs font-bold text-[#00D084]"
                >
                  + Añadir recibo
                </button>
              </div>

              {isAddingBill && accounts.length > 0 && (
                <form
                  onSubmit={handleCreateFixedBill}
                  className="p-3 rounded-2xl bg-black border border-zinc-800 space-y-2.5"
                >
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="text"
                      required
                      value={newBillCode}
                      onChange={(e) => setNewBillCode(e.target.value.toUpperCase())}
                      placeholder="REC-LUZ"
                      className="rounded-xl bg-zinc-900 border border-zinc-700 px-3 py-2 text-xs font-mono text-[#00D084]"
                    />
                    <input
                      type="number"
                      step="0.01"
                      required
                      value={newBillAmount}
                      onChange={(e) => setNewBillAmount(e.target.value)}
                      placeholder="Importe €"
                      className="rounded-xl bg-zinc-900 border border-zinc-700 px-3 py-2 text-xs text-white"
                    />
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      required
                      value={newBillName}
                      onChange={(e) => setNewBillName(e.target.value)}
                      placeholder="Nombre (ej. Luz, Alquiler, Gimnasio)"
                      className="flex-1 rounded-xl bg-zinc-900 border border-zinc-700 px-3 py-2 text-xs text-white"
                    />
                    <button
                      type="submit"
                      className="px-4 py-2 rounded-xl bg-[#00D084] text-black text-xs font-bold"
                    >
                      OK
                    </button>
                  </div>
                </form>
              )}

              {fixedBills.length === 0 ? (
                <p className="text-xs text-zinc-500 text-center py-3">
                  Sin recibos fijos todavía.
                </p>
              ) : (
                <div className="space-y-2">
                  {fixedBills.map((bill) => (
                    <div
                      key={bill.id}
                      className="p-3 rounded-2xl bg-black border border-zinc-800 flex items-center justify-between gap-2"
                    >
                      <div>
                        <span className="inline-flex items-center gap-1 text-[10px] font-mono text-[#00D084]">
                          <Tag className="w-2.5 h-2.5" />
                          {bill.custom_code}
                        </span>
                        <div className="text-xs font-bold text-white">
                          {bill.name}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-white">
                          {formatEUR(bill.expected_amount)}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleToggleFixedBill(bill)}
                          className={`px-2.5 py-1 rounded-lg text-[11px] font-bold flex items-center gap-1 ${
                            bill.is_paid_this_month
                              ? "bg-[#00D084]/15 text-[#00D084]"
                              : "bg-amber-500/15 text-amber-300"
                          }`}
                        >
                          {bill.is_paid_this_month ? (
                            <>
                              <CheckCircle2 className="w-3 h-3" />
                              Pagado
                            </>
                          ) : (
                            <>
                              <Clock className="w-3 h-3" />
                              Pendiente
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteFixedBill(bill.id)}
                          className="text-zinc-600 hover:text-rose-400"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {/* ===================================================================
            PESTAÑA 4: ALERTAS (RADAR FINTONIC + PUSH MÓVIL)
           =================================================================== */}
        {activeTab === "alertas" && (
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-white">
                Centro de Alertas
              </h2>
              <button
                type="button"
                onClick={() => setIsPhoneModalOpen(true)}
                className="py-1.5 px-3 rounded-xl bg-zinc-900 border border-zinc-800 text-xs font-semibold text-[#00D084] flex items-center gap-1.5"
              >
                <Phone className="w-3.5 h-3.5" />
                {currentUser.phone || "Configurar móvil"}
              </button>
            </div>

            {fintonicInsights.alerts.length === 0 && pushAlertsFeed.length === 0 ? (
              <div className="rounded-3xl bg-[#111216] border border-zinc-800 p-6 text-center space-y-2">
                <ShieldCheck className="w-8 h-8 text-[#00D084] mx-auto" />
                <div className="text-sm font-bold text-white">
                  Todo en orden
                </div>
                <p className="text-xs text-zinc-400">
                  Sin cobros duplicados, sin comisiones bancarias y sin riesgo
                  de descubierto.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {fintonicInsights.alerts.map((alert) => (
                  <div
                    key={alert.id}
                    className={`rounded-2xl border p-4 text-xs space-y-1 ${
                      alert.severity === "critical"
                        ? "bg-rose-950/50 border-rose-500/50 text-rose-200"
                        : alert.severity === "warning"
                        ? "bg-amber-950/40 border-amber-500/40 text-amber-200"
                        : "bg-[#111216] border-zinc-800 text-zinc-200"
                    }`}
                  >
                    <div className="flex items-center justify-between font-bold">
                      <span className="flex items-center gap-1.5">
                        {alert.severity === "critical" ? (
                          <AlertOctagon className="w-4 h-4 text-rose-400" />
                        ) : (
                          <AlertTriangle className="w-4 h-4 text-amber-400" />
                        )}
                        {alert.title}
                      </span>
                      {alert.amount !== undefined && (
                        <span>{formatEUR(alert.amount)}</span>
                      )}
                    </div>
                    <p className="text-[11px] opacity-90">{alert.description}</p>
                  </div>
                ))}

                {pushAlertsFeed.map((a) => (
                  <div
                    key={a.id}
                    className="rounded-2xl border border-amber-500/40 bg-amber-950/40 p-4 text-xs text-amber-200 space-y-1"
                  >
                    <div className="font-bold">{a.title}</div>
                    <p className="text-[11px] opacity-90">{a.body}</p>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* ===================================================================
            PESTAÑA 5: FINSCORE (NOTA 300-900 + PREVISIÓN + CATEGORÍAS)
           =================================================================== */}
        {activeTab === "finscore" && (
          <FintonicInsightsPanel insights={fintonicInsights} />
        )}
      </main>

      {/* =====================================================================
          BARRA DE NAVEGACIÓN INFERIOR FIJA ESTILO APP NATIVA FINTONIC
         ===================================================================== */}
      <nav className="fixed bottom-0 inset-x-0 z-40 bg-black/95 backdrop-blur-xl border-t border-zinc-900">
        <div className="max-w-xl mx-auto grid grid-cols-5 py-2 px-1">
          {[
            { id: "inicio" as const, label: "Inicio", icon: Home },
            { id: "movimientos" as const, label: "Movimientos", icon: ArrowLeftRight },
            { id: "presupuesto" as const, label: "Presupuesto", icon: PieChart },
            { id: "alertas" as const, label: "Alertas", icon: Bell },
            { id: "finscore" as const, label: "FinScore", icon: Award },
          ].map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`flex flex-col items-center justify-center gap-1 py-1 transition ${
                  isActive ? "text-[#00D084]" : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                <div className="relative">
                  <Icon className="w-5 h-5" />
                  {item.id === "alertas" && criticalAlertsCount > 0 && (
                    <span className="absolute -top-1 -right-1.5 w-2 h-2 rounded-full bg-rose-500" />
                  )}
                </div>
                <span className="text-[10px] font-semibold">{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Modales */}
      <BankSyncModal
        isOpen={isSyncModalOpen}
        onClose={() => setIsSyncModalOpen(false)}
        userId={currentUser.id}
        userRole={currentUser.role}
        accounts={accounts}
        fixedBills={fixedBills}
        onDataChanged={handleDataChanged}
      />

      <ManualTransactionModal
        isOpen={isManualModalOpen}
        onClose={() => setIsManualModalOpen(false)}
        userRole={currentUser.role}
        accounts={accounts}
        onDataChanged={handleDataChanged}
      />

      <PhoneAlertsModal
        isOpen={isPhoneModalOpen}
        onClose={() => setIsPhoneModalOpen(false)}
        userId={currentUser.id}
        currentPhone={currentUser.phone}
        currentWhatsappApiKey={currentUser.whatsappApiKey || ""}
        onPhoneSaved={(newPhone, newApiKey) => {
          setCurrentUser((prev) =>
            prev
              ? { ...prev, phone: newPhone, whatsappApiKey: newApiKey }
              : null
          );
        }}
      />
    </div>
  );
}
