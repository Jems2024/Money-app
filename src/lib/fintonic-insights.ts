import {
  BankAccount,
  EnvelopeCategory,
  FixedBill,
  MonthlyEnvelopes,
  Transaction,
} from "@/types/finance";

export interface FintonicAlert {
  id: string;
  severity: "critical" | "warning" | "info";
  category: "duplicado" | "comision" | "descubierto" | "inusual" | "vencimiento";
  title: string;
  description: string;
  amount?: number;
}

export interface CategoryBreakdownItem {
  key: EnvelopeCategory;
  label: string;
  amount: number;
  percentage: number;
  colorClass: string;
}

export interface FintonicInsightsResult {
  hasData: boolean;
  finScore: number; // Escala 300 - 900 estilo FinScore
  finScoreLabel: "Excelente" | "Muy Buena" | "Buena" | "Mejorable" | "Sin datos";
  finScoreTips: string[];
  monthForecast: {
    daysElapsed: number;
    daysInMonth: number;
    daysRemaining: number;
    spentSoFar: number;
    dailyAverage: number;
    projectedMonthSpend: number;
    projectedEndBalance: number;
    isDeficitRisk: boolean;
  };
  alerts: FintonicAlert[];
  categoryBreakdown: CategoryBreakdownItem[];
}

const COMMISSION_KEYWORDS = [
  "COMISION",
  "COMISIÓN",
  "MANTENIMIENTO",
  "INTERESES DEUDORES",
  "RECARGO",
  "DESCUBIERTO",
  "GASTOS DEVOLUCION",
  "CUOTA TARJETA",
];

const CATEGORY_META: Record<
  EnvelopeCategory,
  { label: string; colorClass: string }
> = {
  necesario: { label: "Supermercado y Necesarios", colorClass: "bg-emerald-500" },
  fijo: { label: "Recibos y Suministros", colorClass: "bg-sky-500" },
  hormiga: { label: "Gastos Hormiga / Bares", colorClass: "bg-amber-500" },
  libre_esposo: { label: "Ocio y Gasto Libre", colorClass: "bg-indigo-500" },
  libre_esposa: { label: "Ocio y Gasto Libre", colorClass: "bg-pink-500" },
  libre_comun: { label: "Planes y Ocio", colorClass: "bg-violet-500" },
  ahorro: { label: "Ahorro / Inversión", colorClass: "bg-teal-500" },
};

/**
 * Motor de análisis financiero privado estilo Fintonic:
 * - Nota de salud financiera (300 - 900)
 * - Previsión de saldo a fin de mes
 * - Detector automático de cobros duplicados, comisiones bancarias y gastos inusuales
 * - Desglose por categorías
 */
export function computeFintonicInsights(
  accounts: BankAccount[],
  fixedBills: FixedBill[],
  transactions: Transaction[],
  envelopes: MonthlyEnvelopes
): FintonicInsightsResult {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const currentMonthPrefix = `${year}-${String(month + 1).padStart(2, "0")}`;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysElapsed = Math.max(1, now.getDate());
  const daysRemaining = Math.max(0, daysInMonth - daysElapsed);

  const totalBalance = accounts.reduce(
    (acc, a) => acc + Number(a.current_balance || 0),
    0
  );
  const pendingBills = fixedBills.filter((b) => !b.is_paid_this_month);
  const pendingBillsTotal = pendingBills.reduce(
    (acc, b) => acc + Number(b.expected_amount || 0),
    0
  );

  const monthTransactions = transactions.filter((t) =>
    String(t.date || "").startsWith(currentMonthPrefix)
  );
  const monthExpenses = monthTransactions.filter((t) => t.type === "expense");
  const variableExpenses = monthExpenses.filter(
    (t) => t.envelope !== "fijo" && t.envelope !== "ahorro"
  );

  const spentSoFar = monthExpenses.reduce(
    (acc, t) => acc + Number(t.amount || 0),
    0
  );
  const variableSpentSoFar = variableExpenses.reduce(
    (acc, t) => acc + Number(t.amount || 0),
    0
  );
  const dailyAverage = variableSpentSoFar / daysElapsed;
  const projectedRemainingVariable = dailyAverage * daysRemaining;
  const projectedMonthSpend = spentSoFar + projectedRemainingVariable + pendingBillsTotal;
  const projectedEndBalance =
    totalBalance - pendingBillsTotal - projectedRemainingVariable;

  const hasData = accounts.length > 0 || transactions.length > 0;

  // =========================================================================
  // 1. DETECTOR DE ALERTAS TEMPRANAS (Estilo Fintonic)
  // =========================================================================
  const alerts: FintonicAlert[] = [];

  // 1A. Riesgo de descubierto inmediato o a fin de mes
  if (accounts.length > 0 && totalBalance - pendingBillsTotal < 0) {
    alerts.push({
      id: "alert-overdraft-now",
      severity: "critical",
      category: "descubierto",
      title: "Riesgo de descubierto en tu cuenta",
      description: `Tus recibos pendientes (${pendingBillsTotal.toFixed(
        2
      )} €) superan tu saldo actual (${totalBalance.toFixed(2)} €).`,
      amount: Math.abs(totalBalance - pendingBillsTotal),
    });
  } else if (accounts.length > 0 && projectedEndBalance < 0) {
    alerts.push({
      id: "alert-overdraft-forecast",
      severity: "warning",
      category: "descubierto",
      title: "Previsión negativa a fin de mes",
      description: `Si mantienes tu ritmo de ${dailyAverage.toFixed(
        2
      )} €/día, podrías acabar el mes en ${projectedEndBalance.toFixed(2)} €.`,
      amount: Math.abs(projectedEndBalance),
    });
  }

  // 1B. Detector de comisiones bancarias
  for (const tx of monthExpenses) {
    const upper = tx.concept.toUpperCase();
    if (COMMISSION_KEYWORDS.some((kw) => upper.includes(kw))) {
      alerts.push({
        id: `alert-comm-${tx.id}`,
        severity: "critical",
        category: "comision",
        title: "Posible comisión bancaria detectada",
        description: `Se ha detectado "${tx.concept}" el ${tx.date} por ${Number(
          tx.amount
        ).toFixed(2)} €. Revisa si puedes reclamarla a tu banco.`,
        amount: Number(tx.amount),
      });
    }
  }

  // 1C. Detector de cobros duplicados (mismo importe y concepto similar en <= 48h)
  const seenPairs = new Set<string>();
  for (let i = 0; i < monthExpenses.length; i++) {
    for (let j = i + 1; j < monthExpenses.length; j++) {
      const a = monthExpenses[i];
      const b = monthExpenses[j];
      if (Number(a.amount) <= 0 || Number(a.amount) !== Number(b.amount)) {
        continue;
      }
      const conceptA = a.concept.trim().toUpperCase().slice(0, 14);
      const conceptB = b.concept.trim().toUpperCase().slice(0, 14);
      if (conceptA !== conceptB) continue;

      const diffDays = Math.abs(
        (new Date(a.date).getTime() - new Date(b.date).getTime()) /
          (1000 * 60 * 60 * 24)
      );
      const pairKey = `${conceptA}-${a.amount}`;
      if (diffDays <= 2 && !seenPairs.has(pairKey)) {
        seenPairs.add(pairKey);
        alerts.push({
          id: `alert-dup-${a.id}-${b.id}`,
          severity: "critical",
          category: "duplicado",
          title: "Posible cobro duplicado en tarjeta",
          description: `Tienes 2 cargos idénticos de ${Number(a.amount).toFixed(
            2
          )} € en "${a.concept}" en menos de 48h (${a.date} y ${b.date}).`,
          amount: Number(a.amount),
        });
      }
    }
  }

  // 1D. Detector de gastos inusualmente altos (> 2.5x tu ticket medio y > 60 €)
  if (variableExpenses.length >= 4) {
    const avgTicket =
      variableExpenses.reduce((acc, t) => acc + Number(t.amount), 0) /
      variableExpenses.length;
    for (const tx of variableExpenses) {
      if (Number(tx.amount) > Math.max(60, avgTicket * 2.5)) {
        alerts.push({
          id: `alert-unusual-${tx.id}`,
          severity: "info",
          category: "inusual",
          title: "Movimiento más alto de lo habitual",
          description: `"${tx.concept}" (${Number(tx.amount).toFixed(
            2
          )} €) supera ampliamente tu gasto medio por compra (${avgTicket.toFixed(
            2
          )} €).`,
          amount: Number(tx.amount),
        });
      }
    }
  }

  // 1E. Aviso de recibos fijos pendientes por pasar
  if (pendingBills.length > 0) {
    alerts.push({
      id: "alert-pending-bills",
      severity: "info",
      category: "vencimiento",
      title: `${pendingBills.length} recibo(s) fijo(s) pendientes este mes`,
      description: `Reserva ${pendingBillsTotal.toFixed(
        2
      )} € en tu cuenta para cubrir: ${pendingBills
        .slice(0, 3)
        .map((b) => b.name)
        .join(", ")}${pendingBills.length > 3 ? "..." : ""}.`,
      amount: pendingBillsTotal,
    });
  }

  // =========================================================================
  // 2. CÁLCULO DE NOTA DE SALUD FINANCIERA PRIVADA (300 - 900 estilo FinScore)
  // =========================================================================
  let finScore = 0;
  let finScoreLabel: FintonicInsightsResult["finScoreLabel"] = "Sin datos";
  const finScoreTips: string[] = [];

  if (hasData) {
    let score = 680; // Base saludable

    // Factor 1: Liquidez frente a recibos
    if (totalBalance - pendingBillsTotal < 0) {
      score -= 180;
      finScoreTips.push(
        "Aumenta el colchón en tu cuenta para cubrir siempre tus recibos domiciliados."
      );
    } else if (totalBalance >= pendingBillsTotal + Number(envelopes.savings_goal)) {
      score += 90;
    } else {
      score += 30;
    }

    // Factor 2: Control de gastos hormiga
    const antSpent = monthExpenses
      .filter((t) => t.envelope === "hormiga")
      .reduce((acc, t) => acc + Number(t.amount), 0);
    if (envelopes.ant_expenses_limit > 0) {
      const antRatio = antSpent / envelopes.ant_expenses_limit;
      if (antRatio <= 0.6) {
        score += 65;
      } else if (antRatio > 1) {
        score -= 75;
        finScoreTips.push(
          "Has superado tu límite de Gastos Hormiga este mes; reducir cafés/bares subirá tu nota."
        );
      } else if (antRatio >= 0.8) {
        score -= 20;
        finScoreTips.push(
          "Estás cerca del 80% en Gastos Hormiga: vigila los gastos pequeños esta semana."
        );
      }
    }

    // Factor 3: Previsión de fin de mes
    if (projectedEndBalance >= Number(envelopes.savings_goal)) {
      score += 65;
    } else if (projectedEndBalance < 0) {
      score -= 90;
      finScoreTips.push(
        "A este ritmo diario terminarás el mes justo; ajusta tus gastos libres los próximos días."
      );
    }

    // Factor 4: Penalización por comisiones
    const hasCommissions = alerts.some((a) => a.category === "comision");
    if (hasCommissions) {
      score -= 35;
      finScoreTips.push(
        "Detectamos una posible comisión bancaria: revisa las condiciones de tu cuenta."
      );
    }

    if (finScoreTips.length === 0) {
      finScoreTips.push(
        "¡Excelente control! Tu liquidez cubre tus recibos y tus sobres están bajo control."
      );
    }

    finScore = Math.max(300, Math.min(900, Math.round(score)));
    if (finScore >= 780) finScoreLabel = "Excelente";
    else if (finScore >= 680) finScoreLabel = "Muy Buena";
    else if (finScore >= 560) finScoreLabel = "Buena";
    else finScoreLabel = "Mejorable";
  } else {
    finScoreTips.push(
      "Sincroniza tu banco o registra tus primeros movimientos para calcular tu nota financiera privada."
    );
  }

  // =========================================================================
  // 3. DESGLOSE POR CATEGORÍAS (Estilo Fintonic)
  // =========================================================================
  const totalsMap: Partial<Record<EnvelopeCategory, number>> = {};
  for (const tx of monthExpenses) {
    totalsMap[tx.envelope] = (totalsMap[tx.envelope] || 0) + Number(tx.amount);
  }

  const categoryBreakdown: CategoryBreakdownItem[] = Object.entries(totalsMap)
    .map(([key, amount]) => {
      const envKey = key as EnvelopeCategory;
      const meta = CATEGORY_META[envKey];
      const safeTotal = spentSoFar > 0 ? spentSoFar : 1;
      return {
        key: envKey,
        label: meta.label,
        amount: Number(amount || 0),
        percentage: Math.round((Number(amount || 0) / safeTotal) * 100),
        colorClass: meta.colorClass,
      };
    })
    .sort((a, b) => b.amount - a.amount);

  return {
    hasData,
    finScore,
    finScoreLabel,
    finScoreTips,
    monthForecast: {
      daysElapsed,
      daysInMonth,
      daysRemaining,
      spentSoFar,
      dailyAverage,
      projectedMonthSpend,
      projectedEndBalance,
      isDeficitRisk: accounts.length > 0 && projectedEndBalance < 0,
    },
    alerts,
    categoryBreakdown,
  };
}
