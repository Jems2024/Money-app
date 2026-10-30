import React, { useState, useEffect } from 'react';
import {
  X,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Calculator,
  PlusCircle,
  HelpCircle,
} from 'lucide-react';
import { formatEur, parseMoneyToCents } from '../domain/money';
import { CalendarDateISO } from '../domain/dates/madrid';
import { Account, SpendingScope } from '../domain/ledger';
import {
  EstimatedLiquidityResult,
  HowItIsCalculatedBreakdown,
  PersonalEnvelopesResult,
  simulatePurchase,
} from '../domain/budgets';
import { DEFAULT_SPANISH_CATEGORIES } from '../domain/categorization';

// ============================================================================
// 1. "CÓMO SE CALCULA" BREAKDOWN MODAL (Section 6)
// ============================================================================

export const HowItIsCalculatedModal: React.FC<{
  breakdown: HowItIsCalculatedBreakdown | null;
  onClose: () => void;
}> = ({ breakdown, onClose }) => {
  if (!breakdown) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm p-3"
      role="dialog"
      aria-modal="true"
      aria-labelledby="how-calc-title"
    >
      <div className="w-full max-w-lg rounded-2xl bg-slate-900 border border-slate-800 p-5 shadow-2xl max-h-[88dvh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
              Explicación transparente · Periodo {breakdown.periodKey}
            </span>
            <h2 id="how-calc-title" className="text-lg font-bold text-slate-100 mt-0.5">
              Cómo se calcula: {breakdown.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar explicación"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-slate-800 text-slate-300 hover:bg-slate-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mt-4 space-y-4 text-sm">
          {/* Account Scope */}
          <div className="rounded-xl bg-slate-950/80 border border-slate-800/80 p-3 space-y-1.5">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Cuentas incluidas:</span>
              <span className="font-medium text-slate-200">
                {breakdown.accountScopeIncludedNames.join(', ') || 'Ninguna'}
              </span>
            </div>
            {breakdown.accountScopeExcludedNames.length > 0 && (
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Cuentas excluidas del cálculo:</span>
                <span className="text-slate-400">
                  {breakdown.accountScopeExcludedNames.join(', ')}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Movimientos fuente evaluados:</span>
              <span className="font-mono text-slate-200">{breakdown.sourceTransactionCount}</span>
            </div>
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Última sincronización bancaria:</span>
              <span className="text-slate-300">
                {breakdown.lastSyncUtc
                  ? new Date(breakdown.lastSyncUtc).toLocaleString('es-ES', {
                      timeZone: 'Europe/Madrid',
                    })
                  : 'Sin sincronización bancaria (Modo manual / CSV)'}
              </span>
            </div>
          </div>

          {/* Formula Steps */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Desglose paso a paso
            </h3>
            <div className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-950/60">
              {breakdown.formulaSteps.map((step, idx) => (
                <div key={idx} className="p-3 flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-200 font-medium">{step.label}</span>
                    <span
                      className={`font-mono font-semibold ${
                        step.amountCents === null
                          ? 'text-amber-300'
                          : step.amountCents < 0
                            ? 'text-rose-300'
                            : 'text-emerald-300'
                      }`}
                    >
                      {formatEur(step.amountCents)}
                    </span>
                  </div>
                  {step.note && <p className="text-xs text-slate-400">{step.note}</p>}
                </div>
              ))}
            </div>
          </div>

          {/* Active Reservations */}
          {breakdown.activeReservations.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Fondos comprometidos y reservas activas
              </h3>
              <div className="space-y-1.5">
                {breakdown.activeReservations.map((res, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between rounded-lg bg-slate-800/50 px-3 py-2 text-xs"
                  >
                    <span className="text-slate-200">
                      {res.name}{' '}
                      <span className="text-slate-400">
                        ({res.type === 'savings' ? 'Ahorro protegido' : 'Recibo / Obligación'})
                      </span>
                    </span>
                    <span className="font-mono font-semibold text-amber-300">
                      {formatEur(res.remainingCents)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Missing Information & Uncertainties */}
          {(breakdown.missingInformationWarnings.length > 0 ||
            breakdown.uncertainties.length > 0) && (
            <div className="rounded-xl bg-amber-950/40 border border-amber-700/50 p-3 space-y-2">
              <div className="flex items-center gap-2 text-amber-300 font-semibold text-xs">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>Información incompleta o pendiente de revisión</span>
              </div>
              <ul className="list-disc list-inside text-xs text-amber-200/90 space-y-1">
                {breakdown.missingInformationWarnings.map((w, i) => (
                  <li key={`mw-${i}`}>{w}</li>
                ))}
                {breakdown.uncertainties.map((u, i) => (
                  <li key={`unc-${i}`}>{u}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="w-full sm:w-auto min-h-[48px] px-5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm"
          >
            Entendido
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 2. QUICK EXPENSE ENTRY MODAL ("Añadir gasto" < 10 seconds, Section 7)
// ============================================================================

export const QuickExpenseModal: React.FC<{
  isOpen: boolean;
  accounts: readonly Account[];
  defaultAccountId: string;
  defaultCategoryId: string;
  defaultDate: CalendarDateISO;
  initialAmountDecimal?: string;
  initialSmallSpending?: boolean;
  onSave: (params: {
    amountCents: number;
    description: string;
    categoryId: string;
    accountId: string;
    bookingDate: CalendarDateISO;
    scope: SpendingScope;
    smallSpendingTagged: boolean;
    userNote: string | null;
  }) => void;
  onClose: () => void;
}> = ({
  isOpen,
  accounts,
  defaultAccountId,
  defaultCategoryId,
  defaultDate,
  initialAmountDecimal = '',
  initialSmallSpending = true,
  onSave,
  onClose,
}) => {
  const [amountInput, setAmountInput] = useState(initialAmountDecimal);
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState(defaultCategoryId);
  const [accountId, setAccountId] = useState(defaultAccountId);
  const [bookingDate, setBookingDate] = useState<CalendarDateISO>(defaultDate);
  const [scope, setScope] = useState<SpendingScope>('personal');
  const [smallSpendingTagged, setSmallSpendingTagged] = useState(initialSmallSpending);
  const [userNote, setUserNote] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setAmountInput(initialAmountDecimal);
      setDescription('');
      setCategoryId(defaultCategoryId);
      setAccountId(defaultAccountId);
      setBookingDate(defaultDate);
      setScope('personal');
      setSmallSpendingTagged(initialSmallSpending);
      setUserNote('');
      setErrorMsg(null);
    }
  }, [isOpen, initialAmountDecimal, defaultCategoryId, defaultAccountId, defaultDate, initialSmallSpending]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    try {
      const cents = parseMoneyToCents(amountInput, {
        currency: 'EUR',
        allowNegative: false,
      });
      if (cents <= 0) {
        setErrorMsg('Introduce un importe mayor que 0,00 €.');
        return;
      }
      const catObj = DEFAULT_SPANISH_CATEGORIES.find((c) => c.id === categoryId);
      const finalDesc = description.trim() || catObj?.nameSpanish || 'Gasto personal';

      onSave({
        amountCents: cents,
        description: finalDesc,
        categoryId,
        accountId,
        bookingDate,
        scope,
        smallSpendingTagged: scope === 'personal' ? smallSpendingTagged : false,
        userNote: userNote.trim() || null,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Importe inválido.');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm p-3"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quick-expense-title"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-800 p-5 shadow-2xl space-y-4 max-h-[90dvh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <h2 id="quick-expense-title" className="text-lg font-bold text-slate-100 flex items-center gap-2">
            <PlusCircle className="w-5 h-5 text-emerald-400" />
            <span>Añadir gasto rápido</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar ventana de gasto"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-slate-800 text-slate-300 hover:bg-slate-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Amount First! */}
        <div>
          <label htmlFor="quick-amount-input" className="block text-xs font-semibold uppercase tracking-wider text-emerald-400 mb-1">
            Importe en EUR (acepta coma, ej. 2,50)
          </label>
          <input
            id="quick-amount-input"
            data-testid="quick-amount-input"
            type="text"
            inputMode="decimal"
            autoFocus
            placeholder="0,00"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            className="w-full rounded-xl bg-slate-950 border border-slate-700 px-4 py-3 text-2xl font-mono font-bold text-slate-100 focus:border-emerald-500 focus:outline-none"
          />
        </div>

        {/* Favorite Category Chips */}
        <div>
          <label className="block text-xs font-semibold text-slate-400 mb-1.5">
            Categoría rápida
          </label>
          <div className="grid grid-cols-2 gap-2">
            {DEFAULT_SPANISH_CATEGORIES.filter((c) => c.id !== 'income').slice(0, 6).map((cat) => {
              const active = categoryId === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => {
                    setCategoryId(cat.id);
                    setSmallSpendingTagged(cat.defaultSmallSpendingCandidate);
                  }}
                  className={`min-h-[44px] px-3 py-2 rounded-xl text-left text-xs font-medium border transition ${
                    active
                      ? 'bg-emerald-950/80 border-emerald-500 text-emerald-200'
                      : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700'
                  }`}
                >
                  {cat.nameSpanish}
                </button>
              );
            })}
          </div>
        </div>

        {/* Small Purchase & Scope Toggles */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            data-testid="toggle-small-spending"
            onClick={() => setSmallSpendingTagged((v) => !v)}
            className={`min-h-[44px] px-3 py-2 rounded-xl border text-xs font-medium flex items-center justify-between ${
              smallSpendingTagged && scope === 'personal'
                ? 'bg-amber-950/60 border-amber-500/80 text-amber-200'
                : 'bg-slate-950 border-slate-800 text-slate-400'
            }`}
          >
            <span>Compra pequeña</span>
            <span className="font-bold">{smallSpendingTagged && scope === 'personal' ? 'Sí' : 'No'}</span>
          </button>

          <button
            type="button"
            data-testid="toggle-scope"
            onClick={() => setScope((s) => (s === 'personal' ? 'non_personal' : 'personal'))}
            className={`min-h-[44px] px-3 py-2 rounded-xl border text-xs font-medium flex items-center justify-between ${
              scope === 'personal'
                ? 'bg-indigo-950/60 border-indigo-500/80 text-indigo-200'
                : 'bg-slate-950 border-slate-800 text-slate-400'
            }`}
          >
            <span>Ámbito</span>
            <span className="font-bold">{scope === 'personal' ? 'Personal' : 'No personal'}</span>
          </button>
        </div>

        {/* Account & Concept */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="quick-account-select" className="block text-xs text-slate-400 mb-1">
              Cuenta / Método de pago
            </label>
            <select
              id="quick-account-select"
              data-testid="quick-account-select"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="w-full min-h-[44px] rounded-xl bg-slate-950 border border-slate-800 px-3 text-sm text-slate-200"
            >
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="quick-date-input" className="block text-xs text-slate-400 mb-1">
              Fecha contable
            </label>
            <input
              id="quick-date-input"
              type="date"
              value={bookingDate}
              onChange={(e) => setBookingDate(e.target.value as CalendarDateISO)}
              className="w-full min-h-[44px] rounded-xl bg-slate-950 border border-slate-800 px-3 text-sm text-slate-200"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="quick-desc-input" className="block text-xs text-slate-400 mb-1">
              Concepto / Comercio (opcional)
            </label>
            <input
              id="quick-desc-input"
              data-testid="quick-desc-input"
              type="text"
              placeholder="Ej. Cafetería, Mercadona..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full min-h-[44px] rounded-xl bg-slate-950 border border-slate-800 px-3 text-sm text-slate-200"
            />
          </div>

          <div>
            <label htmlFor="quick-note-input" className="block text-xs text-slate-400 mb-1">
              Nota personal (opcional)
            </label>
            <input
              id="quick-note-input"
              type="text"
              placeholder="Nota..."
              value={userNote}
              onChange={(e) => setUserNote(e.target.value)}
              className="w-full min-h-[44px] rounded-xl bg-slate-950 border border-slate-800 px-3 text-sm text-slate-200"
            />
          </div>
        </div>

        {errorMsg && (
          <div
            role="alert"
            className="rounded-xl bg-rose-950/60 border border-rose-700 px-3 py-2 text-xs text-rose-200 flex items-center gap-2"
          >
            <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
            <span>{errorMsg}</span>
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[48px] px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium"
          >
            Cancelar
          </button>
          <button
            type="submit"
            data-testid="quick-save-button"
            className="flex-1 min-h-[48px] px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold shadow-lg shadow-emerald-950/50"
          >
            Guardar gasto
          </button>
        </div>
      </form>
    </div>
  );
};

// ============================================================================
// 3. PURCHASE SIMULATOR MODAL ("¿Puedo comprar esto?", Section 7)
// ============================================================================

export const PurchaseSimulatorModal: React.FC<{
  isOpen: boolean;
  envelopes: PersonalEnvelopesResult;
  liquidity: EstimatedLiquidityResult;
  onRegisterPurchaseFromSimulation: (amountDecimal: string, isSmallPurchase: boolean) => void;
  onClose: () => void;
}> = ({
  isOpen,
  envelopes,
  liquidity,
  onRegisterPurchaseFromSimulation,
  onClose,
}) => {
  const [amountInput, setAmountInput] = useState('15,00');
  const [targetEnvelope, setTargetEnvelope] = useState<'small_purchases' | 'flexible_personal'>(
    'small_purchases'
  );
  const [coolingSecondsLeft, setCoolingSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    if (coolingSecondsLeft === null || coolingSecondsLeft <= 0) return;
    const t = setTimeout(() => setCoolingSecondsLeft((s) => (s !== null ? s - 1 : null)), 1000);
    return () => clearTimeout(t);
  }, [coolingSecondsLeft]);

  if (!isOpen) return null;

  let simResult: ReturnType<typeof simulatePurchase> | null = null;
  let parseError: string | null = null;
  try {
    const cents = parseMoneyToCents(amountInput, { currency: 'EUR', allowNegative: false });
    if (cents > 0) {
      simResult = simulatePurchase({
        amountCents: cents,
        envelopeTarget: targetEnvelope,
        envelopes,
        liquidity,
      });
    } else {
      parseError = 'Introduce un importe mayor que 0,00 € para simular.';
    }
  } catch (e) {
    parseError = e instanceof Error ? e.message : 'Importe inválido.';
  }

  const isExceeding =
    simResult &&
    (simResult.verdict === 'EXCEEDS_SUB_ENVELOPE' ||
      simResult.verdict === 'EXCEEDS_TOTAL_BUDGET' ||
      simResult.verdict === 'EXCEEDS_LIQUIDITY');

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm p-3"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sim-modal-title"
    >
      <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-800 p-5 shadow-2xl space-y-4 max-h-[90dvh] overflow-y-auto">
        <div className="flex items-start justify-between">
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-indigo-400">
              Simulador sin guardar movimiento
            </span>
            <h2 id="sim-modal-title" className="text-lg font-bold text-slate-100 flex items-center gap-2">
              <Calculator className="w-5 h-5 text-indigo-400" />
              <span>¿Puedo comprar esto?</span>
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar simulador"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-slate-800 text-slate-300 hover:bg-slate-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Inputs */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="sim-amount-input" className="block text-xs font-semibold text-slate-400 mb-1">
              Precio a simular (EUR)
            </label>
            <input
              id="sim-amount-input"
              data-testid="sim-amount-input"
              type="text"
              inputMode="decimal"
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              className="w-full min-h-[48px] rounded-xl bg-slate-950 border border-slate-700 px-3 text-xl font-mono font-bold text-slate-100"
            />
          </div>

          <div>
            <label htmlFor="sim-envelope-select" className="block text-xs font-semibold text-slate-400 mb-1">
              Sobre afectado
            </label>
            <select
              id="sim-envelope-select"
              data-testid="sim-envelope-select"
              value={targetEnvelope}
              onChange={(e) =>
                setTargetEnvelope(e.target.value as 'small_purchases' | 'flexible_personal')
              }
              className="w-full min-h-[48px] rounded-xl bg-slate-950 border border-slate-700 px-3 text-sm text-slate-200"
            >
              <option value="small_purchases">Compras pequeñas (40 €)</option>
              <option value="flexible_personal">Gasto personal flexible (54 €)</option>
            </select>
          </div>
        </div>

        {parseError && (
          <div className="rounded-xl bg-amber-950/60 border border-amber-700 p-3 text-xs text-amber-200">
            {parseError}
          </div>
        )}

        {simResult && (
          <div className="space-y-3" data-testid="simulation-result-card">
            {/* Headline Verdict */}
            <div
              className={`rounded-xl border p-3.5 flex items-start gap-3 ${
                isExceeding
                  ? 'bg-rose-950/60 border-rose-600/80 text-rose-100'
                  : simResult.verdict === 'WITHIN_BUDGET_STALE_OR_UNKNOWN_LIQUIDITY'
                    ? 'bg-amber-950/50 border-amber-600/70 text-amber-100'
                    : 'bg-emerald-950/50 border-emerald-600/70 text-emerald-100'
              }`}
            >
              {isExceeding ? (
                <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
              ) : simResult.verdict === 'WITHIN_BUDGET_STALE_OR_UNKNOWN_LIQUIDITY' ? (
                <HelpCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              ) : (
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
              )}
              <div className="space-y-1 text-xs">
                <p className="font-bold text-sm" data-testid="sim-verdict-headline">
                  {simResult.headlineSpanish}
                </p>
                {simResult.warningsSpanish.map((w, i) => (
                  <p key={i} className="opacity-90">
                    • {w}
                  </p>
                ))}
              </div>
            </div>

            {/* Before / After Comparison Table */}
            <div className="rounded-xl bg-slate-950 border border-slate-800 divide-y divide-slate-800 text-xs">
              <div className="p-3 flex items-center justify-between">
                <span className="text-slate-400">
                  Sobre ({targetEnvelope === 'small_purchases' ? 'Compras pequeñas' : 'Flexible'})
                </span>
                <span className="font-mono">
                  <span className="text-slate-300">{formatEur(simResult.targetEnvelopeBeforeCents)}</span>
                  <span className="mx-1.5 text-slate-500">→</span>
                  <strong
                    data-testid="sim-target-after"
                    className={
                      simResult.targetEnvelopeAfterCents < 0 ? 'text-rose-400' : 'text-emerald-400'
                    }
                  >
                    {formatEur(simResult.targetEnvelopeAfterCents)}
                  </strong>
                </span>
              </div>

              <div className="p-3 flex items-center justify-between">
                <span className="text-slate-400">Presupuesto personal gastable total</span>
                <span className="font-mono">
                  <span className="text-slate-300">{formatEur(simResult.totalSpendableBeforeCents)}</span>
                  <span className="mx-1.5 text-slate-500">→</span>
                  <strong
                    data-testid="sim-total-after"
                    className={
                      simResult.totalSpendableAfterCents < 0 ? 'text-rose-400' : 'text-emerald-400'
                    }
                  >
                    {formatEur(simResult.totalSpendableAfterCents)}
                  </strong>
                </span>
              </div>

              <div className="p-3 flex items-center justify-between">
                <span className="text-slate-400">Guía orientativa por día restante</span>
                <span className="font-mono">
                  <span className="text-slate-300">
                    {formatEur(simResult.dailyPacingBeforeCents, { unknownLabel: 'N/A' })}/día
                  </span>
                  <span className="mx-1.5 text-slate-500">→</span>
                  <strong className="text-slate-100">
                    {formatEur(simResult.dailyPacingAfterCents, { unknownLabel: 'N/A' })}/día
                  </strong>
                </span>
              </div>

              <div className="p-3 flex items-center justify-between">
                <span className="text-slate-400">Liquidez libre estimada en cuenta</span>
                <span className="font-mono">
                  {simResult.liquidityBeforeCents === null ? (
                    <span className="text-amber-300">Desconocido (Sin saldo inicial)</span>
                  ) : (
                    <>
                      <span className="text-slate-300">{formatEur(simResult.liquidityBeforeCents)}</span>
                      <span className="mx-1.5 text-slate-500">→</span>
                      <strong
                        className={
                          (simResult.liquidityAfterCents ?? 0) < 0
                            ? 'text-rose-400'
                            : 'text-emerald-400'
                        }
                      >
                        {formatEur(simResult.liquidityAfterCents)}
                      </strong>
                    </>
                  )}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Voluntary Cooling-Off Timer */}
        {coolingSecondsLeft !== null && coolingSecondsLeft > 0 && (
          <div className="rounded-xl bg-indigo-950/50 border border-indigo-700/60 p-3 flex items-center justify-between text-xs text-indigo-200">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-indigo-400" />
              <span>Pausa voluntaria de reflexión: {coolingSecondsLeft}s</span>
            </div>
            <button
              type="button"
              onClick={() => setCoolingSecondsLeft(null)}
              className="underline text-indigo-300 hover:text-white"
            >
              Omitir pausa
            </button>
          </div>
        )}

        {/* Actions: Registrar compra | Esperar | Cancelar */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[48px] px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold"
          >
            Cancelar
          </button>

          <button
            type="button"
            data-testid="sim-wait-button"
            onClick={() => setCoolingSecondsLeft(60)}
            className="min-h-[48px] px-3 rounded-xl bg-indigo-950 hover:bg-indigo-900 border border-indigo-700 text-indigo-200 text-xs font-semibold flex items-center justify-center gap-1.5"
          >
            <Clock className="w-4 h-4" />
            <span>Esperar (60s)</span>
          </button>

          <button
            type="button"
            data-testid="sim-convert-to-expense-button"
            onClick={() => {
              onClose();
              onRegisterPurchaseFromSimulation(
                amountInput,
                targetEnvelope === 'small_purchases'
              );
            }}
            className="min-h-[48px] px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold"
          >
            Registrar compra
          </button>
        </div>
      </div>
    </div>
  );
};
