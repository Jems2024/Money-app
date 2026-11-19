"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BellRing,
  Building2,
  CheckCircle2,
  Clock,
  Coffee,
  Edit3,
  Loader2,
  LogOut,
  Phone,
  Plus,
  Receipt,
  Save,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  Tag,
  Wallet,
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
import BankSyncModal from "./BankSyncModal";
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
}

export default function FamilyFinanceDashboard() {
  const [loadingSession, setLoadingSession] = useState(true);
  const [currentUser, setCurrentUser] =
    useState<AuthenticatedUserProfile | null>(null);

  // Datos 100% reales y privados del usuario en Supabase (empiezan vacíos en 0,00 €)
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

  // Pestaña activa del panel individual
  const [activeTab, setActiveTab] = useState<"resumen" | "cuentas" | "sobres">(
    "resumen"
  );

  // Modales
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  const [isPhoneModalOpen, setIsPhoneModalOpen] = useState(false);
  const [isEditingEnvelopes, setIsEditingEnvelopes] = useState(false);
  const [isAddingBill, setIsAddingBill] = useState(false);
  const [editingBalanceId, setEditingBalanceId] = useState<string | null>(null);
  const [tempBalanceValue, setTempBalanceValue] = useState<string>("");

  // Formulario de nuevo recibo fijo con custom_code
  const [newBillCode, setNewBillCode] = useState("REC-LUZ");
  const [newBillName, setNewBillName] = useState("");
  const [newBillAmount, setNewBillAmount] = useState("");
  const [newBillAccountId, setNewBillAccountId] = useState("");

  // Alertas Push disparadas en la sesión del usuario
  const [pushAlertsFeed, setPushAlertsFeed] = useState<
    { id: string; title: string; body: string; threshold: 80 | 100 }[]
  >([]);
  const [psd2Banner, setPsd2Banner] = useState<{
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
        setPsd2Banner({
          type: "success",
          text: `¡Cuenta de ${params.get("bank") || "imagin"} conectada con éxito! Ya puedes pulsar "Mi Banco / CSV -> Sincronizar" para descargar tus movimientos.`,
        });
        window.history.replaceState({}, "", "/");
      } else if (params.get("psd2_error")) {
        setPsd2Banner({
          type: "error",
          text: `No se pudo completar la conexión bancaria (${params.get("psd2_error")}). Asegúrate de elegir "imagin" en la pestaña 3. PSD2 Online.`,
        });
        window.history.replaceState({}, "", "/");
      }
    }
  }, []);

  // Cargar únicamente los datos reales de Supabase del usuario autenticado
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
        if (data.envelopes) {
          setEnvelopes(data.envelopes);
        }
        if (data.accounts?.length > 0 && !newBillAccountId) {
          setNewBillAccountId(data.accounts[0].id);
        }
      } else {
        setCurrentUser(null);
      }
    } catch {
      setCurrentUser(null);
    } finally {
      setLoadingSession(false);
    }
  }, [newBillAccountId]);

  useEffect(() => {
    loadPrivateUserData();
  }, [loadPrivateUserData]);

  // Cálculos matemáticos privados del usuario (empiezan en 0,00 € si no hay cuentas/movimientos)
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

    const liquidityAfterBills = totalBalance - pendingBillsTotal;
    const hasOverdraftRisk = accounts.length > 0 && liquidityAfterBills < 0;

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
      subtitle: string,
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
      return { key, label, subtitle, spent, limit, percentage, status };
    };

    const freeLimit =
      currentUser?.role === "esposa"
        ? Number(envelopes.wife_free_limit)
        : Number(envelopes.husband_free_limit);

    const envelopeList = [
      buildEnvelope(
        "hormiga",
        "Mis Gastos Hormiga",
        "Cafeterías, bares, panaderías y pequeños compras rápidas",
        sumEnv(["hormiga"]),
        Number(envelopes.ant_expenses_limit)
      ),
      buildEnvelope(
        "necesario",
        "Supermercado y Necesarios",
        "Alimentación, farmacia y básicos del mes",
        sumEnv(["necesario"]),
        Number(envelopes.groceries_limit)
      ),
      buildEnvelope(
        currentUser?.role === "esposa" ? "libre_esposa" : "libre_esposo",
        "Mi Gasto Libre Personal",
        "Caprichos, ropa, deporte y ocio personal",
        sumEnv(["libre_esposo", "libre_esposa", "libre_comun"]),
        freeLimit
      ),
      buildEnvelope(
        "ahorro",
        "Mi Meta de Ahorro Mensual",
        "Importe reservado este mes",
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
      liquidityAfterBills,
      hasOverdraftRisk,
      envelopeList,
    };
  }, [accounts, fixedBills, envelopes, transactions, currentUser]);

  const pendingReviewTransactions = useMemo(
    () => transactions.filter((t) => t.needs_review),
    [transactions]
  );

  // Evaluar umbrales 80% y 100% tras un gasto
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

  // Recargar datos y verificar alertas
  const handleDataChanged = async () => {
    await loadPrivateUserData();
    const res = await fetch("/api/user-data", { cache: "no-store" });
    const data = await res.json();
    if (data.ok) {
      checkThresholdsAndNotify(data.transactions || [], data.envelopes);
    }
  };

  // Confirmar compra de supermercado en 1 toque
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

  // Guardar saldo editado de una cuenta
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

  // Guardar límites de sobres mensuales en Supabase
  const handleSaveEnvelopes = async () => {
    await fetch("/api/user-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "save_envelopes",
        envelopes,
      }),
    });
    setIsEditingEnvelopes(false);
    await loadPrivateUserData();
  };

  // Crear nuevo recibo fijo en Supabase
  const handleCreateFixedBill = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetAccId = newBillAccountId || accounts[0]?.id;
    if (!targetAccId) return;

    const numericAmount = parseFloat(newBillAmount.replace(",", "."));
    if (!newBillName.trim() || isNaN(numericAmount) || numericAmount <= 0)
      return;

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

  // Alternar Pagado / Pendiente en un recibo fijo
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

  // Cerrar sesión
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
      <div className="min-h-screen bg-[#070b14] text-slate-100 flex items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-slate-300">
          <Loader2 className="w-5 h-5 animate-spin text-emerald-400" />
          <span>Cargando tu espacio privado...</span>
        </div>
      </div>
    );
  }

  // Si no ha iniciado sesión, mostrar obligatoriamente la pantalla de Crear Usuario / Login
  if (!currentUser) {
    return <PrivateAuthScreen onAuthenticated={loadPrivateUserData} />;
  }

  return (
    <div className="min-h-screen bg-[#070b14] text-slate-100 pb-24">
      {/* =====================================================================
          CABECERA INDIVIDUAL PRIVADA DEL USUARIO AUTENTICADO
         ===================================================================== */}
      <header className="sticky top-0 z-30 backdrop-blur-xl bg-[#070b14]/90 border-b border-slate-800/80">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-900/30">
              <Wallet className="w-5 h-5 text-slate-950" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-sm sm:text-base font-bold text-white">
                  Hola, {currentUser.display_name}
                </h1>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  100% Privado
                </span>
              </div>
              <p className="text-[11px] text-slate-400 truncate">
                {currentUser.email}
              </p>
            </div>
          </div>

          {/* Botones de Teléfono Móvil + Configurar Banco + Cerrar Sesión */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsPhoneModalOpen(true)}
              className={`py-2 px-3 rounded-xl border text-xs font-semibold flex items-center gap-1.5 transition ${
                currentUser.phone
                  ? "bg-emerald-950/70 border-emerald-600/60 text-emerald-300"
                  : "bg-amber-500/20 border-amber-500/50 text-amber-200 animate-pulse"
              }`}
            >
              <Phone className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">
                {currentUser.phone
                  ? `Móvil: ${currentUser.phone}`
                  : "Poner Mi Teléfono"}
              </span>
              <span className="sm:hidden">
                {currentUser.phone ? "Móvil OK" : "Teléfono"}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setIsSyncModalOpen(true)}
              className="py-2 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white flex items-center gap-1.5 transition"
            >
              <Building2 className="w-3.5 h-3.5" />
              <span>
                {accounts.length === 0 ? "Configurar Mi Banco" : "Mi Banco / CSV"}
              </span>
            </button>

            <button
              type="button"
              onClick={handleLogout}
              title="Cerrar sesión"
              className="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 hover:text-white transition"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Selector de Pestañas Privadas */}
        <div className="max-w-5xl mx-auto px-4 pb-3">
          <div className="grid grid-cols-3 gap-1.5 p-1 rounded-2xl bg-slate-900/95 border border-slate-800">
            <button
              type="button"
              onClick={() => setActiveTab("resumen")}
              className={`py-2 px-2 rounded-xl text-xs font-semibold transition ${
                activeTab === "resumen"
                  ? "bg-emerald-600 text-white shadow"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              Mi Resumen General
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("cuentas")}
              className={`py-2 px-2 rounded-xl text-xs font-semibold transition flex items-center justify-center gap-1.5 ${
                activeTab === "cuentas"
                  ? "bg-emerald-600 text-white shadow"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <span>Mi Banco y Recibos ({accounts.length})</span>
              {metrics.hasOverdraftRisk && (
                <AlertTriangle className="w-3.5 h-3.5 text-amber-300" />
              )}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("sobres")}
              className={`py-2 px-2 rounded-xl text-xs font-semibold transition ${
                activeTab === "sobres"
                  ? "bg-emerald-600 text-white shadow"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              Mis Sobres del Mes
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 pt-5 space-y-6">
        {psd2Banner && (
          <div
            className={`p-4 rounded-2xl border text-xs flex items-center justify-between gap-3 ${
              psd2Banner.type === "success"
                ? "bg-emerald-950/80 border-emerald-500/60 text-emerald-200"
                : "bg-rose-950/80 border-rose-500/60 text-rose-200"
            }`}
          >
            <span>{psd2Banner.text}</span>
            <button
              type="button"
              onClick={() => setPsd2Banner(null)}
              className="text-xs underline shrink-0"
            >
              Cerrar
            </button>
          </div>
        )}
        {/* ===================================================================
            PASO A PASO INICIAL SI AÚN NO HA VINCULADO SU CUENTA BANCARIA
           =================================================================== */}
        {accounts.length === 0 && (
          <section className="rounded-3xl bg-gradient-to-br from-emerald-950/60 via-slate-900 to-slate-900 border-2 border-emerald-500/50 p-6 shadow-xl">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="space-y-1.5">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-300">
                  👋 ¡Bienvenido/a a tu panel privado, {currentUser.display_name}!
                </span>
                <h2 className="text-lg sm:text-xl font-bold text-white">
                  Tu cuenta está en 0,00 € lista para empezar
                </h2>
                <p className="text-xs text-slate-300 leading-relaxed max-w-2xl">
                  Aquí no hay datos de prueba ni nadie más puede ver lo que
                  hagas. Pulsa el botón para añadir tu cuenta bancaria (ej.
                  CaixaBank, BBVA, Santander) e indicar tu saldo inicial o subir
                  tu extracto.
                </p>
              </div>

              <div className="flex flex-wrap gap-2.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setIsSyncModalOpen(true)}
                  className="py-3 px-5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-2 shadow-lg shadow-emerald-950/60 transition"
                >
                  <Building2 className="w-4 h-4" />
                  1. Configurar Mi Cuenta Bancaria
                </button>

                <button
                  type="button"
                  onClick={() => setIsPhoneModalOpen(true)}
                  className="py-3 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-2 transition"
                >
                  <Phone className="w-4 h-4 text-emerald-400" />
                  2. Verificar Mi Teléfono
                </button>
              </div>
            </div>
          </section>
        )}

        {/* ===================================================================
            TARJETA PRINCIPAL: MI DINERO REAL LIBRE PRIVADO
           =================================================================== */}
        <section className="rounded-3xl bg-gradient-to-br from-slate-900 via-slate-900 to-emerald-950/30 border border-slate-800 p-5 sm:p-6 shadow-xl">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-emerald-400">
                <Sparkles className="w-3.5 h-3.5" />
                Mi Dinero Real Libre Disponible
              </span>
              <div className="text-3xl sm:text-4xl font-extrabold text-white mt-1 tracking-tight">
                {formatEUR(metrics.realFreeMoney)}
              </div>
              <p className="text-xs text-slate-400 mt-1">
                Calculado sobre tus cuentas privadas:{" "}
                <code className="text-slate-300">
                  Mi Saldo Banco − Mis Recibos Pendientes − Mi Meta de Ahorro
                </code>
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  accounts.length === 0
                    ? setIsSyncModalOpen(true)
                    : setIsManualModalOpen(true)
                }
                className="py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow-lg shadow-emerald-950/50 transition"
              >
                <Plus className="w-4 h-4" />
                Registrar Mi Gasto / Ingreso
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-5">
            <div className="rounded-2xl bg-slate-950/75 border border-slate-800 p-4">
              <div className="flex items-center justify-between text-xs text-emerald-400 font-medium">
                <span>Mi Saldo Actual en Banco</span>
                <Building2 className="w-3.5 h-3.5" />
              </div>
              <div className="text-xl font-bold text-white mt-1">
                {formatEUR(metrics.totalBalance)}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                {accounts.length === 0
                  ? "Sin cuenta configurada aún"
                  : `${accounts.length} cuenta(s) activa(s)`}
              </div>
            </div>

            <div className="rounded-2xl bg-slate-950/75 border border-slate-800 p-4">
              <div className="flex items-center justify-between text-xs text-amber-400 font-medium">
                <span>− Mis Recibos Fijos Pendientes</span>
                <Receipt className="w-3.5 h-3.5" />
              </div>
              <div className="text-xl font-bold text-amber-300 mt-1">
                −{formatEUR(metrics.pendingBillsTotal)}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                Pagados este mes: {formatEUR(metrics.paidBillsTotal)}
              </div>
            </div>

            <div className="rounded-2xl bg-slate-950/75 border border-slate-800 p-4">
              <div className="flex items-center justify-between text-xs text-teal-400 font-medium">
                <span>− Mi Meta de Ahorro Mensual</span>
                <Wallet className="w-3.5 h-3.5" />
              </div>
              <div className="text-xl font-bold text-teal-300 mt-1">
                −{formatEUR(metrics.savingsGoal)}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                Configurable en Mis Sobres
              </div>
            </div>
          </div>

          {metrics.hasOverdraftRisk && (
            <div className="mt-4 p-4 rounded-2xl bg-rose-950/90 border border-rose-500 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
              <div className="text-xs text-rose-200">
                <strong>🚨 Alerta de Liquidez en tu Cuenta:</strong> Tu saldo
                actual ({formatEUR(metrics.totalBalance)}) no alcanza para cubrir
                tus recibos fijos pendientes (
                {formatEUR(metrics.pendingBillsTotal)}). Faltan{" "}
                <strong>{formatEUR(Math.abs(metrics.liquidityAfterBills))}</strong>.
              </div>
            </div>
          )}
        </section>

        {/* ===================================================================
            MIS CUENTAS BANCARIAS CONFIGURADAS (CON EDITOR DE SALDO)
           =================================================================== */}
        {(activeTab === "resumen" || activeTab === "cuentas") &&
          accounts.length > 0 && (
            <section className="rounded-3xl bg-slate-900/90 border border-slate-800 p-5 shadow-lg space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <Building2 className="w-5 h-5 text-emerald-400" />
                  Mis Cuentas Bancarias Privadas
                </h2>
                <button
                  type="button"
                  onClick={() => setIsSyncModalOpen(true)}
                  className="text-xs text-emerald-400 hover:underline font-semibold"
                >
                  + Añadir otra cuenta o subir CSV
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {accounts.map((acc) => (
                  <div
                    key={acc.id}
                    className="rounded-2xl bg-slate-950 border border-slate-800 p-4 flex items-center justify-between gap-3"
                  >
                    <div>
                      <span className="text-[11px] font-semibold text-emerald-400">
                        {acc.bank_name}
                      </span>
                      <div className="text-sm font-bold text-white">
                        {acc.account_alias}
                      </div>
                      <div className="text-xs font-mono text-slate-400 mt-0.5">
                        {acc.iban_masked}
                      </div>
                    </div>

                    <div className="text-right">
                      {editingBalanceId === acc.id ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            step="0.01"
                            value={tempBalanceValue}
                            onChange={(e) => setTempBalanceValue(e.target.value)}
                            className="w-24 rounded-lg bg-slate-900 border border-slate-700 px-2 py-1 text-sm text-white"
                          />
                          <button
                            type="button"
                            onClick={() => handleSaveAccountBalance(acc.id)}
                            className="px-2.5 py-1 rounded-lg bg-emerald-600 text-xs font-bold text-white"
                          >
                            OK
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="text-lg font-extrabold text-white">
                            {formatEUR(Number(acc.current_balance))}
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingBalanceId(acc.id);
                              setTempBalanceValue(String(acc.current_balance));
                            }}
                            className="text-[11px] text-emerald-400 hover:underline inline-flex items-center gap-1"
                          >
                            <Edit3 className="w-3 h-3" />
                            Actualizar saldo
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

        {/* ===================================================================
            BANDEJA DE CONFIRMACIÓN DE SUPERMERCADO (1 TOQUE)
           =================================================================== */}
        {pendingReviewTransactions.length > 0 && (
          <section className="rounded-3xl bg-slate-900/90 border border-amber-500/40 p-5 shadow-lg">
            <div className="flex items-center gap-2.5 mb-4">
              <div className="w-9 h-9 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center">
                <ShoppingCart className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h2 className="text-base font-bold text-white">
                  Confirmación de Supermercado ({pendingReviewTransactions.length})
                </h2>
                <p className="text-xs text-slate-400">
                  Elige con 1 toque a qué sobre va cada compra de supermercado:
                </p>
              </div>
            </div>

            <div className="space-y-3">
              {pendingReviewTransactions.map((tx) => (
                <div
                  key={tx.id}
                  className="rounded-2xl bg-slate-950/90 border border-slate-800 p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono px-2 py-0.5 rounded bg-slate-900 text-emerald-300 border border-slate-800">
                        {tx.custom_code || "SUP-01"}
                      </span>
                      <span className="text-xs text-slate-400">{tx.date}</span>
                    </div>
                    <div className="flex items-baseline gap-3 mt-1">
                      <h3 className="text-sm font-bold text-white">
                        {tx.concept}
                      </h3>
                      <span className="text-base font-extrabold text-amber-300">
                        {formatEUR(tx.amount)}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleConfirmSupermarketTx(tx, "necesario")}
                      className="py-2 px-3 rounded-xl bg-emerald-600/20 hover:bg-emerald-600 border border-emerald-500/50 text-emerald-200 hover:text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition"
                    >
                      <ShoppingCart className="w-3.5 h-3.5" />
                      <span>Necesaria</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleConfirmSupermarketTx(tx, "hormiga")}
                      className="py-2 px-3 rounded-xl bg-amber-600/20 hover:bg-amber-600 border border-amber-500/50 text-amber-200 hover:text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition"
                    >
                      <Coffee className="w-3.5 h-3.5" />
                      <span>Hormiga</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleConfirmSupermarketTx(tx, "mi_libre")}
                      className="py-2 px-3 rounded-xl bg-indigo-600/20 hover:bg-indigo-600 border border-indigo-500/50 text-indigo-200 hover:text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition"
                    >
                      <ShoppingBag className="w-3.5 h-3.5" />
                      <span>Mi Libre</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ===================================================================
            MIS SOBRES MENSUALES PRIVADOS (EDITABLES)
           =================================================================== */}
        {(activeTab === "resumen" || activeTab === "sobres") && (
          <section className="rounded-3xl bg-slate-900/90 border border-slate-800 p-5 shadow-lg">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-base font-bold text-white">
                  Mis Sobres Mensuales
                </h2>
                <p className="text-xs text-slate-400">
                  Recibirás un aviso en tu móvil ({currentUser.phone || "sin configurar"}) al llegar al 80% y al 100%.
                </p>
              </div>

              <button
                type="button"
                onClick={() =>
                  isEditingEnvelopes
                    ? handleSaveEnvelopes()
                    : setIsEditingEnvelopes(true)
                }
                className="self-start sm:self-auto py-2 px-3.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-emerald-300 flex items-center gap-1.5 transition"
              >
                {isEditingEnvelopes ? (
                  <>
                    <Save className="w-3.5 h-3.5" />
                    Guardar Mis Límites
                  </>
                ) : (
                  <>
                    <Edit3 className="w-3.5 h-3.5" />
                    Editar Límites de Mis Sobres
                  </>
                )}
              </button>
            </div>

            {isEditingEnvelopes && (
              <div className="mb-5 p-4 rounded-2xl bg-slate-950 border border-emerald-500/40 grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    🐜 Gastos Hormiga (€)
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
                    className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-1.5 text-sm text-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    🛒 Supermercado / Necesarios (€)
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
                    className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-1.5 text-sm text-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    🎯 Mi Gasto Libre (€)
                  </label>
                  <input
                    type="number"
                    value={
                      currentUser.role === "esposa"
                        ? envelopes.wife_free_limit
                        : envelopes.husband_free_limit
                    }
                    onChange={(e) =>
                      setEnvelopes({
                        ...envelopes,
                        husband_free_limit: Number(e.target.value),
                        wife_free_limit: Number(e.target.value),
                      })
                    }
                    className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-1.5 text-sm text-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    🐷 Mi Meta de Ahorro (€)
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
                    className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-1.5 text-sm text-white"
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {metrics.envelopeList.map((env) => {
                const barColor =
                  env.key === "ahorro"
                    ? "bg-teal-500"
                    : env.status === "exceeded100"
                    ? "bg-rose-500"
                    : env.status === "warning80"
                    ? "bg-amber-500"
                    : "bg-emerald-500";

                return (
                  <div
                    key={env.key}
                    className="rounded-2xl bg-slate-950/80 border border-slate-800/90 p-4 space-y-2.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-bold text-white">
                          {env.label}
                        </h3>
                        <p className="text-[11px] text-slate-400">
                          {env.subtitle}
                        </p>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-extrabold text-white">
                          {formatEUR(env.spent)}{" "}
                          <span className="text-xs font-normal text-slate-400">
                            / {formatEUR(env.limit)}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-400">
                          {env.percentage}% usado
                        </div>
                      </div>
                    </div>

                    <div className="relative h-3 w-full rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${barColor}`}
                        style={{ width: `${Math.min(env.percentage, 100)}%` }}
                      />
                      <div
                        className="absolute top-0 bottom-0 w-0.5 bg-white/40"
                        style={{ left: "80%" }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ===================================================================
            CHECKLIST DE MIS RECIBOS FIJOS PRIVADOS CON CÓDIGO
           =================================================================== */}
        {(activeTab === "resumen" || activeTab === "cuentas") && (
          <section className="rounded-3xl bg-slate-900/90 border border-slate-800 p-5 shadow-lg">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <Receipt className="w-5 h-5 text-emerald-400" />
                  Mis Recibos Fijos Mensuales
                </h2>
                <p className="text-xs text-slate-400">
                  Añade tus recibos domiciliados (luz, alquiler, internet, etc.)
                  para descontarlos automáticamente de tu saldo libre.
                </p>
              </div>

              <button
                type="button"
                onClick={() =>
                  accounts.length === 0
                    ? setIsSyncModalOpen(true)
                    : setIsAddingBill(!isAddingBill)
                }
                className="self-start sm:self-auto py-2 px-3.5 rounded-xl bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-xs font-semibold text-emerald-300 flex items-center gap-1.5 transition"
              >
                <Plus className="w-4 h-4" />
                Añadir Mi Recibo Fijo
              </button>
            </div>

            {isAddingBill && accounts.length > 0 && (
              <form
                onSubmit={handleCreateFixedBill}
                className="mb-5 p-4 rounded-2xl bg-slate-950 border border-slate-800 grid grid-cols-1 sm:grid-cols-4 gap-3"
              >
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Código (`custom_code`)
                  </label>
                  <input
                    type="text"
                    required
                    value={newBillCode}
                    onChange={(e) =>
                      setNewBillCode(e.target.value.toUpperCase())
                    }
                    placeholder="REC-LUZ"
                    className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-2 text-xs font-mono text-emerald-300 uppercase"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Nombre del Recibo
                  </label>
                  <input
                    type="text"
                    required
                    value={newBillName}
                    onChange={(e) => setNewBillName(e.target.value)}
                    placeholder="Ej. Endesa Luz / Alquiler / Gimnasio"
                    className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-2 text-xs text-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Importe (€)
                  </label>
                  <div className="flex gap-1.5">
                    <input
                      type="number"
                      step="0.01"
                      required
                      value={newBillAmount}
                      onChange={(e) => setNewBillAmount(e.target.value)}
                      placeholder="75.00"
                      className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-2 text-xs text-white"
                    />
                    <button
                      type="submit"
                      className="px-3.5 py-2 rounded-xl bg-emerald-600 text-xs font-bold text-white"
                    >
                      Guardar
                    </button>
                  </div>
                </div>
              </form>
            )}

            {fixedBills.length === 0 ? (
              <div className="rounded-2xl bg-slate-950/60 border border-slate-800 p-5 text-center text-xs text-slate-400">
                No tienes ningún recibo fijo registrado todavía. Pulsa{" "}
                <strong>+ Añadir Mi Recibo Fijo</strong> para crear los tuyos.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {fixedBills.map((bill) => (
                  <div
                    key={bill.id}
                    className="rounded-2xl p-4 bg-slate-950 border border-slate-800 flex items-center justify-between gap-3"
                  >
                    <div className="space-y-1">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono font-bold bg-slate-800 text-emerald-300">
                        <Tag className="w-3 h-3" />
                        {bill.custom_code}
                      </span>
                      <div className="text-sm font-bold text-white">
                        {bill.name}
                      </div>
                    </div>

                    <div className="text-right space-y-1.5">
                      <div className="text-base font-extrabold text-white">
                        {formatEUR(bill.expected_amount)}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleToggleFixedBill(bill)}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition ${
                          bill.is_paid_this_month
                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                            : "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                        }`}
                      >
                        {bill.is_paid_this_month ? (
                          <>
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Pagado
                          </>
                        ) : (
                          <>
                            <Clock className="w-3.5 h-3.5" />
                            Pendiente
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* ===================================================================
            HISTORIAL PRIVADO DE MOVIMIENTOS Y ALERTAS MÓVILES
           =================================================================== */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <section className="rounded-3xl bg-slate-900/90 border border-slate-800 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <BellRing className="w-4 h-4 text-amber-400" />
                Mis Alertas al Móvil (80% / 100%)
              </h2>
              <button
                type="button"
                onClick={() => setIsPhoneModalOpen(true)}
                className="text-[11px] text-emerald-400 hover:underline"
              >
                Configurar
              </button>
            </div>

            {pushAlertsFeed.length === 0 ? (
              <p className="text-xs text-slate-400 leading-relaxed">
                Tus sobres están por debajo del 80%. Cuando un sobre llegue al
                80% o al 100%, verás aquí el aviso y te saltará en tu móvil{" "}
                {currentUser.phone ? `(${currentUser.phone})` : ""}.
              </p>
            ) : (
              <div className="space-y-2.5">
                {pushAlertsFeed.map((alert) => (
                  <div
                    key={alert.id}
                    className="p-3 rounded-2xl border bg-amber-950/50 border-amber-600/40 text-amber-200 text-xs space-y-1"
                  >
                    <div className="font-bold">{alert.title}</div>
                    <p className="text-[11px] opacity-90">{alert.body}</p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="lg:col-span-2 rounded-3xl bg-slate-900/90 border border-slate-800 p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-white">
                Mis Movimientos Privados ({transactions.length})
              </h2>
              <button
                type="button"
                onClick={() =>
                  accounts.length === 0
                    ? setIsSyncModalOpen(true)
                    : setIsManualModalOpen(true)
                }
                className="text-xs text-emerald-400 hover:underline font-semibold"
              >
                + Añadir movimiento
              </button>
            </div>

            {transactions.length === 0 ? (
              <div className="rounded-2xl bg-slate-950/60 border border-slate-800 p-6 text-center text-xs text-slate-400">
                Aún no has registrado ningún movimiento. Todo lo que añadas o
                importes será 100% privado para tu usuario.
              </div>
            ) : (
              <div className="space-y-2">
                {transactions.slice(0, 12).map((tx) => (
                  <div
                    key={tx.id}
                    className="flex items-center justify-between p-3 rounded-2xl bg-slate-950/75 border border-slate-800/80"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                          tx.type === "income"
                            ? "bg-emerald-500/20 text-emerald-400"
                            : "bg-blue-500/20 text-blue-300"
                        }`}
                      >
                        {tx.type === "income" ? (
                          <ArrowUpRight className="w-4 h-4" />
                        ) : (
                          <ArrowDownRight className="w-4 h-4" />
                        )}
                      </div>

                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-white truncate">
                            {tx.concept}
                          </span>
                          {tx.custom_code && (
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-emerald-300">
                              {tx.custom_code}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-slate-400">
                          <span className="uppercase text-slate-300 font-medium">
                            {tx.envelope.replace("_", " ")}
                          </span>
                          <span>·</span>
                          <span>{tx.date}</span>
                        </div>
                      </div>
                    </div>

                    <div
                      className={`text-sm font-bold shrink-0 ${
                        tx.type === "income"
                          ? "text-emerald-400"
                          : "text-slate-100"
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
        </div>
      </main>

      {/* Modales Interactivos Conectados a Supabase */}
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
        onPhoneSaved={(newPhone) => {
          setCurrentUser((prev) =>
            prev ? { ...prev, phone: newPhone } : null
          );
        }}
      />
    </div>
  );
}
