"use client";

import React, { useState } from "react";
import { Loader2, PlusCircle, Sparkles, Tag, X } from "lucide-react";
import {
  BankAccount,
  EnvelopeCategory,
  FamilyRole,
  TransactionType,
} from "@/types/finance";

interface ManualTransactionModalProps {
  isOpen: boolean;
  onClose: () => void;
  userRole: FamilyRole;
  accounts: BankAccount[];
  onDataChanged: () => Promise<void>;
}

export default function ManualTransactionModal({
  isOpen,
  onClose,
  userRole,
  accounts,
  onDataChanged,
}: ManualTransactionModalProps) {
  const [selectedAccountId, setSelectedAccountId] = useState<string>(
    accounts[0]?.id || ""
  );
  const [type, setType] = useState<TransactionType>("expense");
  const [customCode, setCustomCode] = useState<string>("MOV-001");
  const [concept, setConcept] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [envelope, setEnvelope] = useState<EnvelopeCategory>("hormiga");
  const [useAiClassifier, setUseAiClassifier] = useState<boolean>(true);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const activeAccount =
    accounts.find((a) => a.id === selectedAccountId) || accounts[0];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!activeAccount) {
      setErrorMsg(
        "Primero debes configurar tu cuenta bancaria en el botón 'Configurar Mi Banco'."
      );
      return;
    }

    const numericAmount = parseFloat(amount.replace(",", "."));
    if (!concept.trim() || isNaN(numericAmount) || numericAmount <= 0) return;

    setIsSubmitting(true);
    try {
      let finalEnvelope: EnvelopeCategory = envelope;
      let needsReview = false;
      let aiReasoning = "Registrado manualmente en tu cuenta privada.";
      let finalCustomCode = customCode.trim() || "MOV-001";

      if (type === "expense" && useAiClassifier) {
        const res = await fetch("/api/classify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            concept: concept.trim(),
            amount: numericAmount,
            payerRole: userRole,
          }),
        });
        const data = await res.json();
        const first = data.results?.[0];
        if (first) {
          finalEnvelope = first.envelope;
          needsReview = first.needs_review;
          aiReasoning = first.reasoning;
          if (!customCode.trim() || customCode === "MOV-001") {
            finalCustomCode = first.suggested_custom_code || "MOV-IA";
          }
        }
      }

      const saveRes = await fetch("/api/user-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add_transactions",
          bankAccountId: activeAccount.id,
          transactions: [
            {
              bank_account_id: activeAccount.id,
              custom_code: finalCustomCode.toUpperCase(),
              date: new Date().toISOString().slice(0, 10),
              concept: concept.trim(),
              amount: numericAmount,
              type,
              envelope: finalEnvelope,
              needs_review: needsReview,
              ai_confidence: 0.95,
              ai_reasoning: aiReasoning,
            },
          ],
        }),
      });

      const saveData = await saveRes.json();
      if (!saveData.ok) {
        throw new Error(saveData.error || "Error guardando el movimiento");
      }

      await onDataChanged();
      setConcept("");
      setAmount("");
      onClose();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Error guardando movimiento"
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <PlusCircle className="w-5 h-5 text-emerald-400" />
            <h2 className="text-base font-semibold text-white">
              Registrar Mi Gasto o Ingreso
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Selección de cuenta propia */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Mi Cuenta Bancaria
            </label>
            {accounts.length === 0 ? (
              <div className="p-3 rounded-xl bg-amber-950/60 border border-amber-700/60 text-xs text-amber-200">
                Aún no has creado tu cuenta bancaria. Cierra esta ventana y
                pulsa <strong>Configurar Mi Banco</strong>.
              </div>
            ) : (
              <select
                value={activeAccount?.id || ""}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2.5 text-sm text-white"
              >
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.account_alias} ({acc.bank_name} · Saldo:{" "}
                    {Number(acc.current_balance).toFixed(2)} €)
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Tipo de Movimiento
              </label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as TransactionType)}
                className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
              >
                <option value="expense">Gasto (-)</option>
                <option value="income">Ingreso (+)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Código (`custom_code`)
              </label>
              <div className="relative">
                <Tag className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={customCode}
                  onChange={(e) => setCustomCode(e.target.value.toUpperCase())}
                  placeholder="MOV-001"
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 pl-8 pr-3 py-2 text-xs font-mono text-emerald-300 uppercase"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Concepto / Comercio
              </label>
              <input
                type="text"
                required
                value={concept}
                onChange={(e) => setConcept(e.target.value)}
                placeholder="Ej. Mercadona, Cafetería, Nómina..."
                className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Importe (€)
              </label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="25.00"
                className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
              />
            </div>
          </div>

          {type === "expense" && (
            <div className="rounded-xl bg-slate-950 border border-slate-800 p-3 space-y-2.5">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="flex items-center gap-2 text-xs font-medium text-emerald-400">
                  <Sparkles className="w-4 h-4" />
                  Clasificar automáticamente con IA (Gemini 2.5 Flash)
                </span>
                <input
                  type="checkbox"
                  checked={useAiClassifier}
                  onChange={(e) => setUseAiClassifier(e.target.checked)}
                  className="rounded accent-emerald-500"
                />
              </label>

              {!useAiClassifier && (
                <div>
                  <label className="block text-xs text-slate-400 mb-1">
                    Elegir Mi Sobre manualmente:
                  </label>
                  <select
                    value={envelope}
                    onChange={(e) =>
                      setEnvelope(e.target.value as EnvelopeCategory)
                    }
                    className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-xs text-white"
                  >
                    <option value="hormiga">🐜 Gastos Hormiga</option>
                    <option value="necesario">🛒 Supermercado / Necesarios</option>
                    <option
                      value={
                        userRole === "esposa" ? "libre_esposa" : "libre_esposo"
                      }
                    >
                      🎯 Mi Gasto Libre Personal
                    </option>
                    <option value="fijo">🏦 Recibo Fijo</option>
                    <option value="ahorro">🐷 Mi Meta de Ahorro</option>
                  </select>
                </div>
              )}
            </div>
          )}

          {errorMsg && (
            <div className="p-3 rounded-xl bg-rose-950/70 border border-rose-600/60 text-xs text-rose-200">
              {errorMsg}
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting || accounts.length === 0}
            className="w-full py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-semibold transition flex items-center justify-center gap-2"
          >
            {isSubmitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <PlusCircle className="w-4 h-4" />
            )}
            Guardar en Mi Cuenta
          </button>
        </form>
      </div>
    </div>
  );
}
