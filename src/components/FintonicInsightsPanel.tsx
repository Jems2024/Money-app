"use client";

import React from "react";
import {
  AlertOctagon,
  AlertTriangle,
  Award,
  CalendarClock,
  Info,
  PieChart,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { FintonicInsightsResult } from "@/lib/fintonic-insights";

function formatEUR(amount: number): string {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
  }).format(amount);
}

interface FintonicInsightsPanelProps {
  insights: FintonicInsightsResult;
}

export default function FintonicInsightsPanel({
  insights,
}: FintonicInsightsPanelProps) {
  const scorePercent = insights.hasData
    ? Math.max(0, Math.min(100, ((insights.finScore - 300) / 600) * 100))
    : 0;

  const scoreBadgeColor =
    insights.finScoreLabel === "Excelente"
      ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
      : insights.finScoreLabel === "Muy Buena"
      ? "bg-teal-500/20 text-teal-300 border-teal-500/40"
      : insights.finScoreLabel === "Buena"
      ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
      : insights.finScoreLabel === "Mejorable"
      ? "bg-rose-500/20 text-rose-300 border-rose-500/40"
      : "bg-slate-800 text-slate-400 border-slate-700";

  return (
    <div className="space-y-6">
      {/* =====================================================================
          FILA 1: NOTA FINANCIERA PRIVADA (300-900) + PREVISIÓN FIN DE MES
         ===================================================================== */}
      <div className="grid grid-cols-1 gap-4">
        {/* Tarjeta Nota Financiera estilo FinScore */}
        <div className="rounded-3xl bg-[#111216] border border-zinc-800 p-5 space-y-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#00D084]">
                <Award className="w-4 h-4" />
                <span>Mi FinScore Privado</span>
              </div>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                Escala 300–900 · 100% privado (sin anuncios ni cesión a bancos)
              </p>
            </div>
            <span
              className={`px-2.5 py-0.5 rounded-full text-xs font-bold border ${scoreBadgeColor}`}
            >
              {insights.finScoreLabel}
            </span>
          </div>

          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-extrabold text-white tracking-tight">
              {insights.hasData ? insights.finScore : "—"}
            </span>
            <span className="text-sm text-slate-400 font-medium">/ 900 pts</span>
          </div>

          {/* Barra visual degradada estilo FinScore */}
          <div className="space-y-1.5">
            <div className="relative h-3 w-full rounded-full bg-gradient-to-r from-rose-500 via-amber-400 to-emerald-500 opacity-85">
              {insights.hasData && (
                <div
                  className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-white border-2 border-slate-950 shadow-md transition-all duration-500"
                  style={{ left: `calc(${scorePercent}% - 8px)` }}
                />
              )}
            </div>
            <div className="flex justify-between text-[10px] text-slate-400 font-mono">
              <span>300</span>
              <span>550</span>
              <span>750</span>
              <span>900</span>
            </div>
          </div>

          <div className="rounded-2xl bg-slate-950/80 border border-slate-800 p-3 space-y-1.5">
            {insights.finScoreTips.map((tip, idx) => (
              <p
                key={idx}
                className="text-xs text-slate-300 flex items-start gap-2 leading-relaxed"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                <span>{tip}</span>
              </p>
            ))}
          </div>
        </div>

        {/* Tarjeta Previsión de Fin de Mes */}
        <div className="rounded-3xl bg-[#111216] border border-zinc-800 p-5 space-y-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-sky-400">
                <CalendarClock className="w-4 h-4" />
                <span>Previsión a Fin de Mes</span>
              </div>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Día {insights.monthForecast.daysElapsed} de{" "}
                {insights.monthForecast.daysInMonth} (quedan{" "}
                {insights.monthForecast.daysRemaining} días)
              </p>
            </div>
            {insights.monthForecast.isDeficitRisk ? (
              <TrendingDown className="w-5 h-5 text-rose-400" />
            ) : (
              <TrendingUp className="w-5 h-5 text-emerald-400" />
            )}
          </div>

          <div>
            <div className="text-xs text-slate-400">
              Saldo estimado el último día del mes:
            </div>
            <div
              className={`text-3xl sm:text-4xl font-extrabold mt-0.5 tracking-tight ${
                insights.monthForecast.isDeficitRisk
                  ? "text-rose-400"
                  : "text-white"
              }`}
            >
              {insights.hasData
                ? formatEUR(insights.monthForecast.projectedEndBalance)
                : "0,00 €"}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div className="rounded-2xl bg-slate-950/80 border border-slate-800 p-3">
              <div className="text-[11px] text-slate-400">Ritmo diario actual</div>
              <div className="text-sm font-bold text-white mt-0.5">
                {formatEUR(insights.monthForecast.dailyAverage)} / día
              </div>
            </div>
            <div className="rounded-2xl bg-slate-950/80 border border-slate-800 p-3">
              <div className="text-[11px] text-slate-400">Gasto mes proyectado</div>
              <div className="text-sm font-bold text-amber-300 mt-0.5">
                {formatEUR(insights.monthForecast.projectedMonthSpend)}
              </div>
            </div>
          </div>

          <p className="text-[11px] text-slate-400 leading-relaxed">
            Calculado automáticamente con tu ritmo real de compras variables +
            tus recibos fijos pendientes por cobrar este mes.
          </p>
        </div>
      </div>

      {/* =====================================================================
          FILA 2: RADAR DE ALERTAS TEMPRANAS + DESGLOSE POR CATEGORÍAS
         ===================================================================== */}
      <div className="grid grid-cols-1 gap-4">
        {/* Radar de Alertas estilo Fintonic */}
        <div className="rounded-3xl bg-[#111216] border border-zinc-800 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <AlertOctagon className="w-4 h-4 text-amber-400" />
              Radar de Alertas (Duplicados, Comisiones y Recibos)
            </h3>
            <span className="text-xs font-semibold text-slate-400">
              {insights.alerts.length} aviso(s)
            </span>
          </div>

          {insights.alerts.length === 0 ? (
            <div className="rounded-2xl bg-emerald-950/40 border border-emerald-700/40 p-4 text-xs text-emerald-200 flex items-center gap-2.5">
              <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
              <span>
                Todo limpio: sin cobros duplicados, sin comisiones bancarias y
                sin riesgo de descubierto detectado.
              </span>
            </div>
          ) : (
            <div className="space-y-2.5">
              {insights.alerts.map((alert) => {
                const styles =
                  alert.severity === "critical"
                    ? "bg-rose-950/60 border-rose-500/50 text-rose-200"
                    : alert.severity === "warning"
                    ? "bg-amber-950/50 border-amber-500/40 text-amber-200"
                    : "bg-slate-950/80 border-slate-700 text-slate-200";

                return (
                  <div
                    key={alert.id}
                    className={`rounded-2xl border p-3.5 text-xs space-y-1 ${styles}`}
                  >
                    <div className="flex items-center justify-between gap-2 font-bold">
                      <span className="flex items-center gap-1.5">
                        {alert.severity === "critical" ? (
                          <AlertOctagon className="w-4 h-4 text-rose-400 shrink-0" />
                        ) : alert.severity === "warning" ? (
                          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                        ) : (
                          <Info className="w-4 h-4 text-sky-400 shrink-0" />
                        )}
                        {alert.title}
                      </span>
                      {alert.amount !== undefined && (
                        <span className="font-mono shrink-0">
                          {formatEUR(alert.amount)}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] opacity-90 leading-relaxed">
                      {alert.description}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Desglose por Categorías del Mes */}
        <div className="rounded-3xl bg-[#111216] border border-zinc-800 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <PieChart className="w-4 h-4 text-emerald-400" />
              En Qué Se Va Tu Dinero Este Mes
            </h3>
            <span className="text-xs font-bold text-slate-300">
              {formatEUR(insights.monthForecast.spentSoFar)}
            </span>
          </div>

          {insights.categoryBreakdown.length === 0 ? (
            <div className="rounded-2xl bg-slate-950/60 border border-slate-800 p-5 text-center text-xs text-slate-400">
              Cuando sincronices tu cuenta de imagin o registres gastos, verás
              aquí el reparto automático por categorías.
            </div>
          ) : (
            <div className="space-y-3">
              {insights.categoryBreakdown.map((cat) => (
                <div key={cat.key} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-200">
                      {cat.label}
                    </span>
                    <span className="font-bold text-white">
                      {formatEUR(cat.amount)}{" "}
                      <span className="text-slate-400 font-normal">
                        ({cat.percentage}%)
                      </span>
                    </span>
                  </div>
                  <div className="h-2.5 w-full rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${cat.colorClass}`}
                      style={{ width: `${Math.min(cat.percentage, 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
