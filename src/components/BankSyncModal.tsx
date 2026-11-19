"use client";

import React, { useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import {
  Building2,
  CheckCircle2,
  FileSpreadsheet,
  Link2,
  Loader2,
  PlusCircle,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import { SPANISH_BANKS_PSD2 } from "@/lib/enable-banking";
import { BankAccount, FamilyRole, FixedBill } from "@/types/finance";
import { matchTransactionToFixedBill } from "@/lib/finance-engine";

interface BankSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  userRole: FamilyRole;
  accounts: BankAccount[];
  fixedBills: FixedBill[];
  onDataChanged: () => Promise<void>;
}

export default function BankSyncModal({
  isOpen,
  onClose,
  userId,
  userRole,
  accounts,
  fixedBills,
  onDataChanged,
}: BankSyncModalProps) {
  const [tab, setTab] = useState<"create" | "csv" | "psd2">(
    accounts.length === 0 ? "create" : "csv"
  );
  const [bankName, setBankName] = useState("CaixaBank");
  const [accountAlias, setAccountAlias] = useState("Mi Cuenta Principal");
  const [ibanLast4, setIbanLast4] = useState("");
  const [initialBalance, setInitialBalance] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState(
    accounts[0]?.id || ""
  );

  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const activeAccount =
    accounts.find((a) => a.id === selectedAccountId) || accounts[0];

  // 1. Dar de alta la cuenta bancaria privada del usuario en Supabase
  const handleCreateBankAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setStatusMessage(null);
    setErrorMessage(null);

    try {
      const balanceNum = parseFloat(initialBalance.replace(",", ".") || "0");
      const res = await fetch("/api/user-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_bank_account",
          bankName,
          accountAlias: accountAlias.trim() || `Cuenta ${bankName}`,
          ibanLast4: ibanLast4.trim() || "0000",
          currentBalance: isNaN(balanceNum) ? 0 : balanceNum,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.error || "No se pudo guardar tu cuenta bancaria");
      }

      await onDataChanged();
      setStatusMessage(
        `¡Cuenta "${data.account.account_alias}" guardada con éxito en tu espacio privado!`
      );
      setIbanLast4("");
      setInitialBalance("");
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Error creando cuenta bancaria"
      );
    } finally {
      setIsLoading(false);
    }
  };

  // 2. Importar archivo CSV o Excel real en la cuenta privada del usuario
  const processImportedRows = async (
    rows: Record<string, unknown>[],
    sourceFileName: string
  ) => {
    if (!activeAccount) {
      setErrorMessage(
        "Primero da de alta tu cuenta bancaria en la pestaña '1. Configurar Mi Banco'."
      );
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);
    setStatusMessage("Clasificando movimientos con Gemini 2.5 Flash...");

    try {
      const parsedItems: {
        date: string;
        concept: string;
        amount: number;
        type: "income" | "expense";
      }[] = [];

      for (const row of rows) {
        const keys = Object.keys(row);
        const conceptKey = keys.find((k) =>
          /concepto|descripcion|comercio|detalle|concept|movement/i.test(k)
        );
        const amountKey = keys.find((k) =>
          /importe|cantidad|valor|monto|amount/i.test(k)
        );
        const dateKey = keys.find((k) => /fecha|date|dia/i.test(k));

        const rawConcept = String(
          (conceptKey ? row[conceptKey] : Object.values(row)[1]) || ""
        ).trim();
        const rawAmountStr = String(
          (amountKey ? row[amountKey] : Object.values(row)[2]) || "0"
        )
          .replace(/\./g, "")
          .replace(",", ".")
          .replace(/[^0-9.-]/g, "");

        const numericAmount = parseFloat(rawAmountStr);
        if (!rawConcept || isNaN(numericAmount) || numericAmount === 0) continue;

        const rawDate = dateKey
          ? String(row[dateKey]).slice(0, 10)
          : new Date().toISOString().slice(0, 10);

        parsedItems.push({
          date: /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
            ? rawDate
            : new Date().toISOString().slice(0, 10),
          concept: rawConcept,
          amount: Math.abs(numericAmount),
          type: rawAmountStr.startsWith("+") ? "income" : "expense",
        });
      }

      if (parsedItems.length === 0) {
        setErrorMessage(
          "No se encontraron filas válidas en el archivo. Verifica que tenga columnas Concepto e Importe."
        );
        setIsLoading(false);
        return;
      }

      const aiRes = await fetch("/api/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: parsedItems.map((p) => ({
            concept: p.concept,
            amount: p.amount,
            payerRole: userRole,
          })),
        }),
      });
      const aiData = await aiRes.json();
      const classifications = aiData.results || [];

      const matchedBillIds: string[] = [];
      const transactionsPayload = parsedItems.map((item, idx) => {
        const ai = classifications[idx] || {
          envelope: userRole === "esposa" ? "libre_esposa" : "libre_esposo",
          needs_review: false,
          confidence: 0.9,
          reasoning: "Importado desde archivo bancario",
          suggested_custom_code: "CSV-01",
        };

        const matchedBill = matchTransactionToFixedBill(
          item.concept,
          item.amount,
          activeAccount.id,
          fixedBills
        );

        if (matchedBill) {
          matchedBillIds.push(matchedBill.id);
        }

        return {
          bank_account_id: activeAccount.id,
          external_tx_id: `CSV-${userId.slice(0, 6)}-${sourceFileName}-${Date.now()}-${idx}`,
          custom_code: matchedBill
            ? matchedBill.custom_code
            : ai.suggested_custom_code,
          date: item.date,
          concept: item.concept,
          amount: item.amount,
          type: item.type,
          envelope: matchedBill ? "fijo" : ai.envelope,
          needs_review: matchedBill ? false : ai.needs_review,
          linked_bill_id: matchedBill ? matchedBill.id : null,
          ai_confidence: ai.confidence,
          ai_reasoning: ai.reasoning,
        };
      });

      const saveRes = await fetch("/api/user-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add_transactions",
          bankAccountId: activeAccount.id,
          transactions: transactionsPayload,
          matchedBillIds,
        }),
      });

      const saveData = await saveRes.json();
      if (!saveData.ok) {
        throw new Error(saveData.error || "Error guardando movimientos");
      }

      await onDataChanged();
      setStatusMessage(
        `¡Se han importado ${transactionsPayload.length} movimientos en tu cuenta "${activeAccount.account_alias}"!`
      );
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Error importando archivo"
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext === "csv") {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          processImportedRows(
            results.data as Record<string, unknown>[],
            file.name
          );
        },
      });
    } else if (ext === "xlsx" || ext === "xls") {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet) as Record<
        string,
        unknown
      >[];
      await processImportedRows(rows, file.name);
    } else {
      setErrorMessage("Formato no soportado. Sube un archivo .csv o .xlsx");
    }
  };

  // 3. Conectar vía PSD2 Enable Banking
  const handleConnectPSD2 = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/enable-banking/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aspspName: bankName,
          role: userRole,
          userId,
        }),
      });
      const data = await res.json();
      if (data.ok && data.authorizationUrl) {
        window.location.href = data.authorizationUrl;
      } else {
        setErrorMessage(data.error || "No se pudo conectar con PSD2");
      }
    } catch {
      setErrorMessage("Error iniciando pasarela PSD2.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <Building2 className="w-5 h-5 text-emerald-400" />
            <h2 className="text-base font-bold text-white">
              Configurar y Sincronizar Mi Cuenta Bancaria
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Pestañas claras */}
          <div className="grid grid-cols-3 gap-1.5 bg-slate-950 p-1 rounded-xl border border-slate-800">
            <button
              type="button"
              onClick={() => setTab("create")}
              className={`py-2 px-2 rounded-lg text-xs font-semibold transition ${
                tab === "create"
                  ? "bg-emerald-600 text-white"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              1. Configurar Banco
            </button>
            <button
              type="button"
              onClick={() => setTab("csv")}
              className={`py-2 px-2 rounded-lg text-xs font-semibold transition ${
                tab === "csv"
                  ? "bg-emerald-600 text-white"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              2. Subir CSV/Excel
            </button>
            <button
              type="button"
              onClick={() => setTab("psd2")}
              className={`py-2 px-2 rounded-lg text-xs font-semibold transition ${
                tab === "psd2"
                  ? "bg-emerald-600 text-white"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              3. PSD2 Online
            </button>
          </div>

          {tab === "create" && (
            <form onSubmit={handleCreateBankAccount} className="space-y-3.5">
              <p className="text-xs text-slate-400">
                Introduce los datos de tu cuenta bancaria personal. Nadie más
                podrá ver tu saldo ni tus movimientos.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Tu Banco
                  </label>
                  <select
                    value={bankName}
                    onChange={(e) => setBankName(e.target.value)}
                    className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2.5 text-sm text-white"
                  >
                    {SPANISH_BANKS_PSD2.map((b) => (
                      <option key={b.bic} value={b.name}>
                        {b.name}
                      </option>
                    ))}
                    <option value="Otro Banco">Otro Banco</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Alias de tu Cuenta
                  </label>
                  <input
                    type="text"
                    required
                    value={accountAlias}
                    onChange={(e) => setAccountAlias(e.target.value)}
                    placeholder="Ej. Mi Cuenta Nómina"
                    className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Últimos 4 dígitos de tu IBAN
                  </label>
                  <input
                    type="text"
                    maxLength={4}
                    required
                    value={ibanLast4}
                    onChange={(e) => setIbanLast4(e.target.value)}
                    placeholder="Ej. 4821"
                    className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-sm font-mono text-white"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Saldo Actual en tu Banco (€)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={initialBalance}
                    onChange={(e) => setInitialBalance(e.target.value)}
                    placeholder="Ej. 1500.00"
                    className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <PlusCircle className="w-4 h-4" />
                )}
                Guardar Mi Cuenta Bancaria
              </button>
            </form>
          )}

          {tab === "csv" && (
            <div className="space-y-4">
              {accounts.length === 0 ? (
                <div className="p-4 rounded-xl bg-amber-950/60 border border-amber-700/60 text-xs text-amber-200">
                  Primero guarda tu cuenta bancaria en la pestaña{" "}
                  <strong>1. Configurar Banco</strong> para poder subir tus
                  movimientos.
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      Selecciona tu cuenta de destino:
                    </label>
                    <select
                      value={selectedAccountId}
                      onChange={(e) => setSelectedAccountId(e.target.value)}
                      className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
                    >
                      {accounts.map((acc) => (
                        <option key={acc.id} value={acc.id}>
                          {acc.account_alias} ({acc.bank_name} ·{" "}
                          {acc.iban_masked})
                        </option>
                      ))}
                    </select>
                  </div>

                  <label className="flex flex-col items-center justify-center border-2 border-dashed border-slate-700 hover:border-emerald-500 rounded-2xl p-6 cursor-pointer bg-slate-950/60 transition">
                    <Upload className="w-8 h-8 text-emerald-400 mb-2" />
                    <span className="text-sm font-medium text-white">
                      Seleccionar archivo CSV o Excel de tu banco (.csv, .xlsx)
                    </span>
                    <span className="text-xs text-slate-400 mt-1 text-center">
                      Tus movimientos se clasificarán con IA y sólo los verás tú
                    </span>
                    <input
                      type="file"
                      accept=".csv,.xlsx,.xls"
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                  </label>
                </>
              )}
            </div>
          )}

          {tab === "psd2" && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Selecciona tu entidad española (Enable Banking PSD2):
                </label>
                <select
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3.5 py-2.5 text-sm text-white"
                >
                  {SPANISH_BANKS_PSD2.map((bank) => (
                    <option key={bank.bic} value={bank.name}>
                      {bank.name} ({bank.bic})
                    </option>
                  ))}
                </select>
              </div>

              <div className="rounded-xl bg-slate-950 border border-slate-800 p-3.5 text-xs text-slate-300 space-y-1.5">
                <div className="flex items-center gap-2 text-emerald-400 font-medium">
                  <ShieldCheck className="w-4 h-4" />
                  <span>Pasarela PSD2 Individual</span>
                </div>
                <p className="text-slate-400 leading-relaxed">
                  Redirige a la banca online de {bankName} para autorizar la
                  lectura de tu cuenta personal. Requiere configurar tu
                  certificado de Enable Banking en <code>.env.local</code> o usa
                  las pestañas 1 y 2 sin certificados.
                </p>
              </div>

              <button
                type="button"
                disabled={isLoading}
                onClick={handleConnectPSD2}
                className="w-full py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Link2 className="w-4 h-4" />
                )}
                Iniciar Autorización en {bankName}
              </button>
            </div>
          )}

          {statusMessage && (
            <div className="p-3 rounded-xl bg-emerald-950/70 border border-emerald-600/60 text-xs text-emerald-200 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{statusMessage}</span>
            </div>
          )}

          {errorMessage && (
            <div className="p-3 rounded-xl bg-rose-950/70 border border-rose-600/60 text-xs text-rose-200">
              {errorMessage}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
