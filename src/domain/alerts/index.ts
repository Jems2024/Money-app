import { assertValidCents, Cents, formatEur, subtractCents } from '../money';
import { isWithinMadridQuietHours, PeriodMonthKey } from '../dates/madrid';

export const DEFAULT_BUDGET_THRESHOLDS = [50, 75, 90, 100] as const;

export type ThresholdPercent = number;

export type AlertDeliveryState =
  | 'generated'
  | 'queued_quiet_hours'
  | 'sent'
  | 'failed_transient'
  | 'failed_permanent_dead_subscription';

export interface HandledThresholdRecord {
  idempotencyKey: string; // `${userId}:${budgetId}:${periodKey}:${thresholdPercent}`
  userId: string;
  budgetId: string;
  periodKey: PeriodMonthKey;
  thresholdPercent: ThresholdPercent;
  resolution: 'emitted_alert' | 'suppressed_by_higher_jump' | 'handled_silently_import_or_edit';
  recordedAtUtc: string;
}

export interface AlertOutboxEvent {
  id: string;
  idempotencyKey: string; // Unique constraint in DB: `${userId}:${budgetId}:${periodKey}:${thresholdPercent}`
  clientNotificationTag: string; // Tag for client ServiceWorker deduplication
  userId: string;
  budgetId: string;
  budgetName: string;
  periodKey: PeriodMonthKey;
  thresholdPercent: ThresholdPercent;
  lowerThresholdsCrossedAndMarkedHandled: ThresholdPercent[];
  budgetAllocatedCents: Cents;
  spentAfterCents: Cents;
  remainingAfterCents: Cents;
  inAppTitleSpanish: string;
  inAppBodySpanish: string;
  pushPayload: {
    title: string;
    body: string;
    tag: string;
    deepLinkUrl: string; // Never contains sensitive amounts or merchant details!
  };
  deliveryState: AlertDeliveryState;
  seenByUserAtUtc: string | null; // Explicit: 'sent' is never equated with 'seen'!
  createdAtUtc: string;
}

export interface ThresholdEvaluationResult {
  emittedEvent: AlertOutboxEvent | null;
  updatedHandledRecords: HandledThresholdRecord[];
  updatedOutboxEvents: AlertOutboxEvent[];
  spentAfterCents: Cents;
  remainingAfterCents: Cents;
}

export function buildThresholdIdempotencyKey(params: {
  userId: string;
  budgetId: string;
  periodKey: PeriodMonthKey;
  thresholdPercent: ThresholdPercent;
}): string {
  return `${params.userId}:${params.budgetId}:${params.periodKey}:${params.thresholdPercent}`;
}

/**
 * Evaluates budget threshold crossings deterministically and idempotently.
 *
 * Enforces Acceptance Tests 11, 12, 13 & Section 10 rules:
 * 1. If a single expense jumps across multiple thresholds (e.g. 19 -> 44 on a 40 budget,
 *    crossing 50%, 75%, 90%, 100%), emits ONLY ONE alert for the highest crossed level (100%)
 *    and marks 50%, 75%, 90% as `suppressed_by_higher_jump` so they never fire later.
 * 2. Concurrent retries or duplicate worker executions with the same `(userId, budgetId, periodKey, threshold)`
 *    produce at most ONE logical event in `updatedOutboxEvents`.
 * 3. Refunds (`spentAfterCents < spentBeforeCents`) do NOT re-arm already handled thresholds
 *    in the same period by default (`rearmOnRefund: false`).
 * 4. Historical import, budget edit, or live bank reconciliation of an already-notified manual
 *    expense (`suppressAlertEmission: true`) marks crossed thresholds as handled silently without
 *    emitting a notification storm.
 */
export function evaluateBudgetThresholdCrossing(params: {
  userId: string;
  budgetId: string;
  budgetName: string;
  periodKey: PeriodMonthKey;
  budgetAllocatedCents: Cents;
  spentBeforeCents: Cents;
  spentAfterCents: Cents;
  thresholds?: readonly ThresholdPercent[];
  existingHandledRecords: readonly HandledThresholdRecord[];
  existingOutboxEvents: readonly AlertOutboxEvent[];
  suppressAlertEmission?: boolean;
  includeSensitiveAmountsInPush?: boolean;
  nowInstantUtc?: string;
  quietHoursConfig?: { enabled: boolean; startHour: number; endHour: number };
}): ThresholdEvaluationResult {
  assertValidCents(params.budgetAllocatedCents);
  assertValidCents(params.spentBeforeCents);
  assertValidCents(params.spentAfterCents);

  const remainingAfterCents = subtractCents(params.budgetAllocatedCents, params.spentAfterCents);
  const nowUtc = params.nowInstantUtc ?? new Date().toISOString();

  // Zero or negative budget allocation cannot compute percentage thresholds safely
  if (params.budgetAllocatedCents <= 0) {
    return {
      emittedEvent: null,
      updatedHandledRecords: [...params.existingHandledRecords],
      updatedOutboxEvents: [...params.existingOutboxEvents],
      spentAfterCents: params.spentAfterCents,
      remainingAfterCents,
    };
  }

  // Refunds or decreasing spend do not emit threshold crossings or re-arm handled records
  if (params.spentAfterCents <= params.spentBeforeCents && !params.suppressAlertEmission) {
    return {
      emittedEvent: null,
      updatedHandledRecords: [...params.existingHandledRecords],
      updatedOutboxEvents: [...params.existingOutboxEvents],
      spentAfterCents: params.spentAfterCents,
      remainingAfterCents,
    };
  }

  const sortedThresholds = [...(params.thresholds ?? DEFAULT_BUDGET_THRESHOLDS)].sort(
    (a, b) => a - b
  );
  const percentAfter = (params.spentAfterCents / params.budgetAllocatedCents) * 100;

  const handledSet = new Set(params.existingHandledRecords.map((r) => r.idempotencyKey));
  const outboxByKey = new Map(params.existingOutboxEvents.map((e) => [e.idempotencyKey, e]));

  // Find all thresholds reached by `percentAfter` that have NOT yet been handled in this period
  const newlyCrossedThresholds: ThresholdPercent[] = [];
  for (const t of sortedThresholds) {
    if (percentAfter >= t) {
      const key = buildThresholdIdempotencyKey({
        userId: params.userId,
        budgetId: params.budgetId,
        periodKey: params.periodKey,
        thresholdPercent: t,
      });
      if (!handledSet.has(key) && !outboxByKey.has(key)) {
        newlyCrossedThresholds.push(t);
      }
    }
  }

  if (newlyCrossedThresholds.length === 0) {
    return {
      emittedEvent: null,
      updatedHandledRecords: [...params.existingHandledRecords],
      updatedOutboxEvents: [...params.existingOutboxEvents],
      spentAfterCents: params.spentAfterCents,
      remainingAfterCents,
    };
  }

  const nextHandled = [...params.existingHandledRecords];

  // If suppressed (e.g. budget edit, initial historical import, or live bank reconciliation of already-alerted manual entry)
  if (params.suppressAlertEmission) {
    for (const t of newlyCrossedThresholds) {
      const key = buildThresholdIdempotencyKey({
        userId: params.userId,
        budgetId: params.budgetId,
        periodKey: params.periodKey,
        thresholdPercent: t,
      });
      nextHandled.push({
        idempotencyKey: key,
        userId: params.userId,
        budgetId: params.budgetId,
        periodKey: params.periodKey,
        thresholdPercent: t,
        resolution: 'handled_silently_import_or_edit',
        recordedAtUtc: nowUtc,
      });
    }
    return {
      emittedEvent: null,
      updatedHandledRecords: nextHandled,
      updatedOutboxEvents: [...params.existingOutboxEvents],
      spentAfterCents: params.spentAfterCents,
      remainingAfterCents,
    };
  }

  // Highest crossed threshold wins; lower crossed levels are marked `suppressed_by_higher_jump`
  const highestThreshold = newlyCrossedThresholds[newlyCrossedThresholds.length - 1]!;
  const lowerThresholds = newlyCrossedThresholds.slice(0, -1);

  for (const lower of lowerThresholds) {
    const lowerKey = buildThresholdIdempotencyKey({
      userId: params.userId,
      budgetId: params.budgetId,
      periodKey: params.periodKey,
      thresholdPercent: lower,
    });
    nextHandled.push({
      idempotencyKey: lowerKey,
      userId: params.userId,
      budgetId: params.budgetId,
      periodKey: params.periodKey,
      thresholdPercent: lower,
      resolution: 'suppressed_by_higher_jump',
      recordedAtUtc: nowUtc,
    });
  }

  const highestKey = buildThresholdIdempotencyKey({
    userId: params.userId,
    budgetId: params.budgetId,
    periodKey: params.periodKey,
    thresholdPercent: highestThreshold,
  });

  nextHandled.push({
    idempotencyKey: highestKey,
    userId: params.userId,
    budgetId: params.budgetId,
    periodKey: params.periodKey,
    thresholdPercent: highestThreshold,
    resolution: 'emitted_alert',
    recordedAtUtc: nowUtc,
  });

  const isOverBudget = remainingAfterCents < 0;
  const inAppTitleSpanish = isOverBudget
    ? `Presupuesto superado (${highestThreshold}%) — ${params.budgetName}`
    : `Aviso de presupuesto (${highestThreshold}%) — ${params.budgetName}`;

  const inAppBodySpanish = isOverBudget
    ? `Has gastado ${formatEur(params.spentAfterCents)} de ${formatEur(params.budgetAllocatedCents)} en ${params.budgetName}. Saldo restante: ${formatEur(remainingAfterCents)}.`
    : `Has alcanzado el ${highestThreshold}% de ${params.budgetName} (${formatEur(params.spentAfterCents)} gastados, te quedan ${formatEur(remainingAfterCents)}).`;

  // Push payload hides exact amounts by default unless user explicitly opted in
  const pushBody = params.includeSensitiveAmountsInPush
    ? inAppBodySpanish
    : `Has alcanzado el umbral del ${highestThreshold}% en tu sobre "${params.budgetName}". Abre STOP SPEND para revisar tu margen.`;

  const inQuietHours =
    params.quietHoursConfig?.enabled
      ? isWithinMadridQuietHours(
          nowUtc,
          params.quietHoursConfig.startHour,
          params.quietHoursConfig.endHour
        )
      : false;

  const clientTag = `stopspend-threshold-${params.budgetId}-${params.periodKey}-${highestThreshold}`;

  const event: AlertOutboxEvent = {
    id: `alert_${params.budgetId}_${params.periodKey}_${highestThreshold}`,
    idempotencyKey: highestKey,
    clientNotificationTag: clientTag,
    userId: params.userId,
    budgetId: params.budgetId,
    budgetName: params.budgetName,
    periodKey: params.periodKey,
    thresholdPercent: highestThreshold,
    lowerThresholdsCrossedAndMarkedHandled: lowerThresholds,
    budgetAllocatedCents: params.budgetAllocatedCents,
    spentAfterCents: params.spentAfterCents,
    remainingAfterCents,
    inAppTitleSpanish,
    inAppBodySpanish,
    pushPayload: {
      title: 'STOP SPEND — Aviso de presupuesto',
      body: pushBody,
      tag: clientTag,
      deepLinkUrl: '/presupuestos', // Never embeds amounts or merchant names in URL!
    },
    deliveryState: inQuietHours ? 'queued_quiet_hours' : 'generated',
    seenByUserAtUtc: null,
    createdAtUtc: nowUtc,
  };

  return {
    emittedEvent: event,
    updatedHandledRecords: nextHandled,
    updatedOutboxEvents: [...params.existingOutboxEvents, event],
    spentAfterCents: params.spentAfterCents,
    remainingAfterCents,
  };
}

/**
 * Validates a Web Push endpoint URL against an allowlist of official browser push services
 * to prevent Server-Side Request Forgery (SSRF) via user-supplied push subscription URLs.
 */
const ALLOWED_PUSH_ENDPOINT_HOST_SUFFIXES = [
  '.push.apple.com', // Safari / iOS Web Push
  'fcm.googleapis.com', // Chrome / Android / Desktop
  '.push.services.mozilla.com', // Firefox
  '.notify.windows.com', // Edge / WNS
] as const;

export function validateSafeWebPushEndpoint(endpointUrl: string): {
  valid: boolean;
  reason?: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    return { valid: false, reason: 'URL de suscripción push mal formada.' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, reason: 'El endpoint Web Push debe usar HTTPS obligatoriamente.' };
  }

  if (parsed.username || parsed.password || parsed.port !== '') {
    return { valid: false, reason: 'El endpoint Web Push no puede incluir credenciales ni puertos no estándar.' };
  }

  const host = parsed.hostname.toLowerCase();
  // Reject localhost, private IPs, and non-push hosts (SSRF defense)
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.startsWith('[')
  ) {
    return { valid: false, reason: 'Dirección IP o host privado prohibido (protección SSRF).' };
  }

  const allowed = ALLOWED_PUSH_ENDPOINT_HOST_SUFFIXES.some(
    (suffix) => host === suffix.replace(/^\./, '') || host.endsWith(suffix)
  );
  if (!allowed) {
    return {
      valid: false,
      reason: `Dominio de servicio push no reconocido: "${host}".`,
    };
  }

  return { valid: true };
}
