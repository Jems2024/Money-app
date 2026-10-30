/**
 * Supabase Edge Function: `alerts-dispatch`
 * Evaluates pending `alert_outbox` events, respects `Europe/Madrid` quiet hours,
 * validates Web Push subscription endpoints against SSRF (`validateSafeWebPushEndpoint`),
 * signs VAPID ES256 JWTs (`signVapidJwt`), and marks dead subscriptions (HTTP 404/410) inactive.
 */
import {
  AlertOutboxEvent,
  validateSafeWebPushEndpoint,
} from '../../../src/domain/alerts/index.ts';
import { isWithinMadridQuietHours } from '../../../src/domain/dates/madrid.ts';
import { signVapidJwt } from '../../../src/server/crypto/runtimeSpike.ts';

export interface StoredPushSubscription {
  id: string;
  userId: string;
  endpoint: string;
  isActive: boolean;
}

export async function dispatchPendingAlertOutbox(params: {
  outboxEvents: readonly AlertOutboxEvent[];
  subscriptions: readonly StoredPushSubscription[];
  vapidSubject: string;
  vapidPrivateKeyJwk: JsonWebKey;
  quietHoursEnabled: boolean;
  quietHoursStart: number;
  quietHoursEnd: number;
  nowUtc?: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  updatedEvents: AlertOutboxEvent[];
  deactivatedSubscriptionIds: string[];
}> {
  const nowUtc = params.nowUtc ?? new Date().toISOString();
  const inQuietHours =
    params.quietHoursEnabled &&
    isWithinMadridQuietHours(nowUtc, params.quietHoursStart, params.quietHoursEnd);

  const deactivatedSubscriptionIds: string[] = [];
  const updatedEvents: AlertOutboxEvent[] = [];
  const fetchFn = params.fetchImpl ?? globalThis.fetch;

  for (const ev of params.outboxEvents) {
    if (ev.deliveryState === 'sent') {
      updatedEvents.push(ev);
      continue;
    }

    if (inQuietHours) {
      updatedEvents.push({
        ...ev,
        deliveryState: 'queued_quiet_hours',
      });
      continue;
    }

    const userSubs = params.subscriptions.filter(
      (s) => s.userId === ev.userId && s.isActive
    );

    if (userSubs.length === 0) {
      updatedEvents.push(ev);
      continue;
    }

    let anySent = false;
    let allDead = true;

    for (const sub of userSubs) {
      const check = validateSafeWebPushEndpoint(sub.endpoint);
      if (!check.valid) {
        deactivatedSubscriptionIds.push(sub.id);
        continue;
      }

      const vapidJwt = await signVapidJwt({
        audienceOrigin: sub.endpoint,
        subject: params.vapidSubject,
        privateKeyJwk: params.vapidPrivateKeyJwk,
      });

      const res = await fetchFn(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `vapid t=${vapidJwt}`,
          TTL: '86400',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(ev.pushPayload),
      });

      if (res.status >= 200 && res.status < 300) {
        anySent = true;
        allDead = false;
      } else if (res.status === 404 || res.status === 410) {
        // Expired / unsubscribed endpoint -> remove dead subscription
        deactivatedSubscriptionIds.push(sub.id);
      } else {
        allDead = false;
      }
    }

    updatedEvents.push({
      ...ev,
      deliveryState: anySent
        ? 'sent'
        : allDead
          ? 'failed_permanent_dead_subscription'
          : 'failed_transient',
    });
  }

  return {
    updatedEvents,
    deactivatedSubscriptionIds,
  };
}
