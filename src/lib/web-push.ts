import webpush from "web-push";
import { EnvelopeCategory, MonthlyEnvelopes, PushSubscriptionRecord } from "@/types/finance";

export interface PushNotificationPayload {
  title: string;
  body: string;
  tag: string;
  url?: string;
}

export interface ThresholdEvaluationResult {
  triggeredAlerts: {
    envelope: EnvelopeCategory;
    threshold: 80 | 100;
    percentage: number;
    spent: number;
    limit: number;
    title: string;
    body: string;
  }[];
  updatedThresholdsMap: Record<string, boolean>;
}

const ENVELOPE_NAMES: Record<EnvelopeCategory, string> = {
  hormiga: "Gastos Hormiga",
  libre_esposo: "Gasto Libre Esposo",
  libre_esposa: "Gasto Libre Esposa",
  libre_comun: "Ocio Libre Común",
  necesario: "Supermercado / Necesarios",
  fijo: "Recibos Fijos",
  ahorro: "Meta de Ahorro",
};

/**
 * Configura web-push con las claves VAPID gratuitas del entorno
 */
function configureVapid(): boolean {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:familia@ejemplo.com";

  if (!publicKey || !privateKey) {
    return false;
  }

  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    return true;
  } catch (err) {
    console.error("Error configurando claves VAPID:", err);
    return false;
  }
}

/**
 * Evalúa si algún sobre mensual acaba de alcanzar el 80% o el 100% de su límite
 * tras registrar un nuevo gasto.
 */
export function evaluateEnvelopeThresholds(
  envelopes: MonthlyEnvelopes,
  spentByEnvelope: Record<EnvelopeCategory, number>
): ThresholdEvaluationResult {
  const limits: Partial<Record<EnvelopeCategory, number>> = {
    hormiga: envelopes.ant_expenses_limit,
    libre_esposo: envelopes.husband_free_limit,
    libre_esposa: envelopes.wife_free_limit,
    libre_comun: envelopes.shared_free_limit,
    necesario: envelopes.groceries_limit,
  };

  const notifiedMap: Record<string, boolean> = {
    ...(envelopes.notified_thresholds || {}),
  };

  const triggeredAlerts: ThresholdEvaluationResult["triggeredAlerts"] = [];

  for (const [envKey, limitVal] of Object.entries(limits)) {
    const envelope = envKey as EnvelopeCategory;
    const limit = Number(limitVal || 0);
    if (limit <= 0) continue;

    const spent = Number(spentByEnvelope[envelope] || 0);
    const percentage = Math.round((spent / limit) * 100);
    const label = ENVELOPE_NAMES[envelope];

    // Comprobar umbral 100%
    const key100 = `${envelope}:100`;
    if (percentage >= 100 && !notifiedMap[key100]) {
      notifiedMap[key100] = true;
      notifiedMap[`${envelope}:80`] = true;
      triggeredAlerts.push({
        envelope,
        threshold: 100,
        percentage,
        spent,
        limit,
        title: `🚨 ¡Límite 100% alcanzado en ${label}!`,
        body: `Habéis consumido ${spent.toFixed(2)} € de ${limit.toFixed(
          2
        )} € (${percentage}%) este mes en el sobre "${label}".`,
      });
      continue;
    }

    // Comprobar umbral 80%
    const key80 = `${envelope}:80`;
    if (percentage >= 80 && percentage < 100 && !notifiedMap[key80]) {
      notifiedMap[key80] = true;
      triggeredAlerts.push({
        envelope,
        threshold: 80,
        percentage,
        spent,
        limit,
        title: `⚠️ Aviso 80%: Sobre "${label}"`,
        body: `Lleváis ${spent.toFixed(2)} € de ${limit.toFixed(
          2
        )} € (${percentage}%). Quedan ${(limit - spent).toFixed(
          2
        )} € disponibles este mes.`,
      });
    }
  }

  return {
    triggeredAlerts,
    updatedThresholdsMap: notifiedMap,
  };
}

/**
 * Envía una notificación Web Push VAPID a todos los dispositivos móviles registrados
 * tanto del Esposo como de la Esposa.
 */
export async function sendWebPushToBothSpouses(
  subscriptions: PushSubscriptionRecord[],
  payload: PushNotificationPayload
): Promise<{ sent: number; failed: number; simulated: boolean }> {
  const isReady = configureVapid();
  if (!isReady || subscriptions.length === 0) {
    return {
      sent: subscriptions.length,
      failed: 0,
      simulated: true,
    };
  }

  let sent = 0;
  let failed = 0;

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.p256dh,
              auth: sub.auth,
            },
          },
          JSON.stringify(payload)
        );
        sent++;
      } catch (err) {
        console.error(`Fallo enviando Web Push a ${sub.device_name}:`, err);
        failed++;
      }
    })
  );

  return { sent, failed, simulated: false };
}
