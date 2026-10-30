import { addCents, Cents, subtractCents } from '../money';
import { CalendarDateISO, diffCalendarDays } from '../dates/madrid';
import {
  CanonicalTransaction,
  CategoryAttributionSource,
  getPersonalNetSpendImpactCents,
} from '../ledger';
import { normalizeMerchantText } from '../reconciliation';

export interface CategoryDefinition {
  id: string;
  nameSpanish: string;
  iconName: string;
  defaultSmallSpendingCandidate: boolean;
}

export const DEFAULT_SPANISH_CATEGORIES: readonly CategoryDefinition[] = [
  { id: 'coffee_snacks', nameSpanish: 'Cafés, snacks y kiosco', iconName: 'Coffee', defaultSmallSpendingCandidate: true },
  { id: 'groceries', nameSpanish: 'Supermercado y alimentación', iconName: 'ShoppingCart', defaultSmallSpendingCandidate: false },
  { id: 'eating_out', nameSpanish: 'Restaurantes y entregas', iconName: 'Utensils', defaultSmallSpendingCandidate: false },
  { id: 'transport', nameSpanish: 'Transporte y combustible', iconName: 'Train', defaultSmallSpendingCandidate: false },
  { id: 'subscriptions', nameSpanish: 'Suscripciones digitales', iconName: 'Repeat', defaultSmallSpendingCandidate: false },
  { id: 'housing_bills', nameSpanish: 'Vivienda y suministros', iconName: 'Home', defaultSmallSpendingCandidate: false },
  { id: 'shopping_personal', nameSpanish: 'Compras personales y ocio', iconName: 'ShoppingBag', defaultSmallSpendingCandidate: false },
  { id: 'health', nameSpanish: 'Salud y farmacia', iconName: 'HeartPulse', defaultSmallSpendingCandidate: false },
  { id: 'income', nameSpanish: 'Nómina e ingresos', iconName: 'Wallet', defaultSmallSpendingCandidate: false },
] as const;

export interface CategorizationRule {
  id: string;
  userId: string;
  patternNormalized: string; // Substring or exact merchant token
  categoryId: string;
  isUserConfirmed: boolean; // True = user-confirmed rule; False = default merchant/description rule
  suggestSmallSpendingTag: boolean;
}

export interface CategorizationDecision {
  categoryId: string | null;
  source: CategoryAttributionSource;
  heuristicConfidence: number; // 0..100 explainable heuristic score
  explanationSpanish: string;
  requiresReview: boolean;
  suggestSmallSpendingTag: boolean;
}

const BUILTIN_SPANISH_MERCHANT_HEURISTICS: ReadonlyArray<{
  keywords: string[];
  categoryId: string;
  suggestSmall: boolean;
  label: string;
}> = [
  {
    keywords: ['MERCADONA', 'CARREFOUR', 'LIDL', 'ALDI', 'CONSUM', 'EROSKI', 'SUPERMERCADO', 'DIA '],
    categoryId: 'groceries',
    suggestSmall: false, // A supermarket merchant does not reveal that the purchase was a soft drink!
    label: 'Cadena de supermercados detectada en descripción',
  },
  {
    keywords: ['STARBUCKS', 'CAFETERIA', 'PANADERIA', 'VENDING', 'KIOSCO', 'CHURRERIA', 'HELADERIA'],
    categoryId: 'coffee_snacks',
    suggestSmall: true,
    label: 'Establecimiento de cafetería/kiosco/vending',
  },
  {
    keywords: ['GLOVO', 'UBER EATS', 'JUST EAT', 'BURGER KING', 'MCDONALDS', 'TELEPIZZA', 'RESTAURANTE'],
    categoryId: 'eating_out',
    suggestSmall: false,
    label: 'Restauración o comida a domicilio',
  },
  {
    keywords: ['RENFE', 'METRO', 'EMT', 'CABIFY', 'UBER', 'REPSOL', 'CEPSA', 'BP ', 'PARKING'],
    categoryId: 'transport',
    suggestSmall: false,
    label: 'Transporte público, movilidad o estación de servicio',
  },
  {
    keywords: ['NETFLIX', 'SPOTIFY', 'AMAZON PRIME', 'ICLOUD', 'DISNEY', 'HBO'],
    categoryId: 'subscriptions',
    suggestSmall: false,
    label: 'Suscripción digital periódica',
  },
  {
    keywords: ['IBERDROLA', 'ENDESA', 'NATURGY', 'MOVISTAR', 'VODAFONE', 'ORANGE', 'DIGI', 'ALQUILER', 'COMUNIDAD'],
    categoryId: 'housing_bills',
    suggestSmall: false,
    label: 'Recibo de suministro, telecomunicaciones o vivienda',
  },
  {
    keywords: ['FARMACIA', 'OPTICA', 'CLINICA', 'DENTISTA'],
    categoryId: 'health',
    suggestSmall: false,
    label: 'Farmacia o servicio sanitario',
  },
];

/**
 * Deterministic categorization priority:
 * 1. Transaction-specific locked user correction (`existingSource === 'user_locked'`) -> 100%
 * 2. User-confirmed rules (`rule.isUserConfirmed === true`) -> 95%
 * 3. Merchant/description rules (`rule.isUserConfirmed === false` or built-in heuristics) -> 80%
 * 4. Provider hints (`providerCategoryHint`) -> 55% (sent to review queue if < 65%)
 * 5. Unknown -> 0% (sent to review queue)
 */
export function categorizeTransactionDeterministic(params: {
  description: string;
  existingCategoryId?: string | null;
  existingCategorySource?: CategoryAttributionSource;
  userRules: readonly CategorizationRule[];
  providerCategoryHint?: string | null;
}): CategorizationDecision {
  // 1. Locked transaction-specific correction is NEVER overwritten by rules
  if (params.existingCategorySource === 'user_locked' && params.existingCategoryId) {
    return {
      categoryId: params.existingCategoryId,
      source: 'user_locked',
      heuristicConfidence: 100,
      explanationSpanish: 'Categoría fijada manualmente para este movimiento.',
      requiresReview: false,
      suggestSmallSpendingTag: false,
    };
  }

  const normalizedDesc = normalizeMerchantText(params.description);

  // 2. User-confirmed rules
  for (const rule of params.userRules) {
    if (rule.isUserConfirmed) {
      const pattern = normalizeMerchantText(rule.patternNormalized);
      if (pattern && normalizedDesc.includes(pattern)) {
        return {
          categoryId: rule.categoryId,
          source: 'user_rule',
          heuristicConfidence: 95,
          explanationSpanish: `Regla confirmada por el usuario para "${rule.patternNormalized}".`,
          requiresReview: false,
          suggestSmallSpendingTag: rule.suggestSmallSpendingTag,
        };
      }
    }
  }

  // 3. Custom merchant/description rules (non-locked) & built-in merchant heuristics
  for (const rule of params.userRules) {
    if (!rule.isUserConfirmed) {
      const pattern = normalizeMerchantText(rule.patternNormalized);
      if (pattern && normalizedDesc.includes(pattern)) {
        return {
          categoryId: rule.categoryId,
          source: 'merchant_rule',
          heuristicConfidence: 82,
          explanationSpanish: `Regla de comercio por coincidencia con "${rule.patternNormalized}".`,
          requiresReview: false,
          suggestSmallSpendingTag: rule.suggestSmallSpendingTag,
        };
      }
    }
  }

  for (const h of BUILTIN_SPANISH_MERCHANT_HEURISTICS) {
    for (const kw of h.keywords) {
      if (normalizedDesc.includes(kw.trim())) {
        return {
          categoryId: h.categoryId,
          source: 'merchant_rule',
          heuristicConfidence: 80,
          explanationSpanish: `Heurística determinista: ${h.label} ("${kw.trim()}").`,
          requiresReview: false,
          suggestSmallSpendingTag: h.suggestSmall,
        };
      }
    }
  }

  // 4. Provider hint
  if (params.providerCategoryHint) {
    return {
      categoryId: params.providerCategoryHint,
      source: 'provider_hint',
      heuristicConfidence: 55,
      explanationSpanish: `Sugerencia del proveedor bancario ("${params.providerCategoryHint}"). Confianza media-baja; requiere revisión.`,
      requiresReview: true,
      suggestSmallSpendingTag: false,
    };
  }

  // 5. Unknown
  return {
    categoryId: null,
    source: 'unknown',
    heuristicConfidence: 0,
    explanationSpanish: 'Sin coincidencias en reglas ni heurísticas; pendiente de clasificar.',
    requiresReview: true,
    suggestSmallSpendingTag: false,
  };
}

/**
 * Re-applies rules across transactions while strictly preserving any transaction with
 * `categorySource === 'user_locked'`.
 */
export function applyRulesPreservingLockedCorrections(
  transactions: readonly CanonicalTransaction[],
  rules: readonly CategorizationRule[]
): CanonicalTransaction[] {
  return transactions.map((tx) => {
    if (tx.categorySource === 'user_locked') {
      return tx;
    }
    const decision = categorizeTransactionDeterministic({
      description: tx.description,
      existingCategoryId: tx.categoryId,
      existingCategorySource: tx.categorySource,
      userRules: rules,
    });
    return {
      ...tx,
      categoryId: decision.categoryId,
      categorySource: decision.source,
      categoryConfidence: decision.heuristicConfidence,
      categoryExplanation: decision.explanationSpanish,
      reviewStatus:
        tx.reviewStatus === 'none' && decision.requiresReview
          ? 'requires_category_review'
          : tx.reviewStatus,
    };
  });
}

// ============================================================================
// RECURRING-PAYMENT CANDIDATE DETECTION (Section 8)
// ============================================================================

export interface RecurringPaymentCandidate {
  merchantNormalized: string;
  displayDescription: string;
  estimatedAmountCents: Cents;
  approximateDayOfMonth: number;
  occurrenceDates: CalendarDateISO[];
  evidenceSpanish: string;
}

/**
 * Detects recurring payment candidates from historical canonical expenses without
 * automatically reserving funds until the user confirms the candidate into an Obligation.
 * Excludes merchants that already have an active user-created Obligation.
 */
export function detectRecurringPaymentCandidates(params: {
  transactions: readonly CanonicalTransaction[];
  existingObligationNames: readonly string[];
}): RecurringPaymentCandidate[] {
  const existingNormalized = new Set(
    params.existingObligationNames.map((n) => normalizeMerchantText(n))
  );

  const byMerchant = new Map<string, CanonicalTransaction[]>();
  for (const tx of params.transactions) {
    if (tx.status === 'superseded' || tx.type !== 'expense') {
      continue;
    }
    const key = tx.merchantNormalized || normalizeMerchantText(tx.description);
    if (!key || existingNormalized.has(key)) {
      continue;
    }
    const list = byMerchant.get(key) ?? [];
    list.push(tx);
    byMerchant.set(key, list);
  }

  const candidates: RecurringPaymentCandidate[] = [];
  for (const [merchant, txs] of byMerchant.entries()) {
    if (txs.length < 2) {
      continue;
    }
    const sorted = [...txs].sort((a, b) => a.bookingDate.localeCompare(b.bookingDate));
    // Check if intervals are roughly monthly (25..35 days) and amounts within 15%
    let monthlyMatches = 0;
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const curr = sorted[i]!;
      const days = diffCalendarDays(curr.bookingDate, prev.bookingDate);
      const prevAbs = Math.abs(prev.amountCents);
      const currAbs = Math.abs(curr.amountCents);
      const amountDiffRatio = prevAbs > 0 ? Math.abs(currAbs - prevAbs) / prevAbs : 1;
      if (days >= 25 && days <= 35 && amountDiffRatio <= 0.15) {
        monthlyMatches++;
      }
    }

    if (monthlyMatches >= 1) {
      const latest = sorted[sorted.length - 1]!;
      const approxDay = Number(latest.bookingDate.slice(8, 10));
      candidates.push({
        merchantNormalized: merchant,
        displayDescription: latest.description,
        estimatedAmountCents: Math.abs(latest.amountCents),
        approximateDayOfMonth: approxDay,
        occurrenceDates: sorted.map((t) => t.bookingDate),
        evidenceSpanish: `Detectados ${sorted.length} cargos mensuales similares (día aprox. ${approxDay}). Confírmalo si deseas reservar este importe en tu liquidez.`,
      });
    }
  }

  return candidates;
}

// ============================================================================
// ANALYTICS & LIKE-FOR-LIKE WINDOW COMPARISONS (Section 8)
// ============================================================================

export interface WindowComparisonAnalytics {
  currentWindowNetSpendCents: Cents;
  previousWindowNetSpendCents: Cents | null;
  deltaCents: Cents | null;
  /** Null when previous window is 0 or missing history (never divides by zero or fabricates history!) */
  deltaPercent: number | null;
  smallPurchaseCount: number;
  smallPurchaseNetCents: Cents;
  byCategoryNetCents: Record<string, Cents>;
  byMerchantNetCents: Record<string, Cents>;
}

export function computeLikeForLikeAnalytics(params: {
  transactions: readonly CanonicalTransaction[];
  currentWindowStart: CalendarDateISO;
  currentWindowEnd: CalendarDateISO;
  previousWindowStart: CalendarDateISO;
  previousWindowEnd: CalendarDateISO;
  hasCompletePreviousHistory: boolean;
}): WindowComparisonAnalytics {
  let currentWindowNetSpendCents = 0;
  let previousWindowNetSpendCents = 0;
  let smallPurchaseCount = 0;
  let smallPurchaseNetCents = 0;
  const byCategoryNetCents: Record<string, Cents> = {};
  const byMerchantNetCents: Record<string, Cents> = {};

  for (const tx of params.transactions) {
    if (tx.status === 'superseded') {
      continue;
    }
    const impact = getPersonalNetSpendImpactCents(tx);
    const netSpend = subtractCents(
      impact.personalGrossExpenseCents,
      impact.personalRefundCreditCents
    );
    if (netSpend === 0) {
      continue;
    }

    if (
      tx.bookingDate >= params.currentWindowStart &&
      tx.bookingDate <= params.currentWindowEnd
    ) {
      currentWindowNetSpendCents = addCents(currentWindowNetSpendCents, netSpend);
      if (impact.smallPurchaseGrossCents > 0) {
        smallPurchaseCount++;
      }
      smallPurchaseNetCents = addCents(smallPurchaseNetCents, impact.smallPurchaseGrossCents);

      for (const [cat, amt] of Object.entries(impact.byCategoryNetCents)) {
        byCategoryNetCents[cat] = addCents(byCategoryNetCents[cat] ?? 0, amt);
      }

      const merchantKey = tx.merchantNormalized || tx.description;
      byMerchantNetCents[merchantKey] = addCents(
        byMerchantNetCents[merchantKey] ?? 0,
        netSpend
      );
    } else if (
      params.hasCompletePreviousHistory &&
      tx.bookingDate >= params.previousWindowStart &&
      tx.bookingDate <= params.previousWindowEnd
    ) {
      previousWindowNetSpendCents = addCents(previousWindowNetSpendCents, netSpend);
    }
  }

  if (!params.hasCompletePreviousHistory) {
    return {
      currentWindowNetSpendCents,
      previousWindowNetSpendCents: null,
      deltaCents: null,
      deltaPercent: null,
      smallPurchaseCount,
      smallPurchaseNetCents,
      byCategoryNetCents,
      byMerchantNetCents,
    };
  }

  const deltaCents = subtractCents(currentWindowNetSpendCents, previousWindowNetSpendCents);
  const deltaPercent =
    previousWindowNetSpendCents > 0
      ? Math.round((deltaCents / previousWindowNetSpendCents) * 1000) / 10
      : null; // Never divide by zero when previous window had 0 spend!

  return {
    currentWindowNetSpendCents,
    previousWindowNetSpendCents,
    deltaCents,
    deltaPercent,
    smallPurchaseCount,
    smallPurchaseNetCents,
    byCategoryNetCents,
    byMerchantNetCents,
  };
}
