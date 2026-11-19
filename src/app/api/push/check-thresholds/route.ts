import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  evaluateEnvelopeThresholds,
  sendWebPushToBothSpouses,
} from "@/lib/web-push";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  EnvelopeCategory,
  MonthlyEnvelopes,
  PushSubscriptionRecord,
  Transaction,
} from "@/types/finance";

export async function POST(request: NextRequest) {
  try {
    // 1. Autenticación estricta obligatoria
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { ok: false, error: "No autenticado" },
        { status: 401 }
      );
    }

    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const body = await request.json();

    // Acción 1: Registrar suscripción Web Push EXCLUSIVAMENTE para el usuario autenticado
    if (body.action === "subscribe" && body.subscription) {
      const subRecord: PushSubscriptionRecord = {
        id: `push-${Date.now()}`,
        user_id: user.id,
        device_name: String(body.deviceName || "Mi Móvil").slice(0, 60),
        endpoint: String(body.subscription.endpoint || "").slice(0, 500),
        p256dh: String(body.subscription.keys?.p256dh || "").slice(0, 200),
        auth: String(body.subscription.keys?.auth || "").slice(0, 200),
      };

      await admin.from("push_subscriptions").upsert(
        {
          user_id: user.id,
          device_name: subRecord.device_name,
          endpoint: subRecord.endpoint,
          p256dh: subRecord.p256dh,
          auth: subRecord.auth,
        },
        { onConflict: "endpoint" }
      );

      return NextResponse.json({
        ok: true,
        subscribed: true,
      });
    }

    // Acción 2: Verificar acumulados SOLO del usuario autenticado y enviar Push SOLO a sus dispositivos
    const envelopes: MonthlyEnvelopes = body.envelopes;
    const transactions: Transaction[] = Array.isArray(body.transactions)
      ? body.transactions
      : [];

    if (!envelopes || !envelopes.id) {
      return NextResponse.json({
        ok: true,
        triggeredAlerts: [],
      });
    }

    const spentByEnvelope: Record<EnvelopeCategory, number> = {
      hormiga: 0,
      libre_esposo: 0,
      libre_esposa: 0,
      libre_comun: 0,
      necesario: 0,
      fijo: 0,
      ahorro: 0,
    };

    for (const tx of transactions) {
      if (tx.type === "expense" && !tx.needs_review) {
        spentByEnvelope[tx.envelope] =
          (spentByEnvelope[tx.envelope] || 0) + Number(tx.amount);
      }
    }

    const evaluation = evaluateEnvelopeThresholds(envelopes, spentByEnvelope);

    // Obtener SOLO las suscripciones de ESTE usuario (privacidad total)
    let subscriptions: PushSubscriptionRecord[] = [];
    if (evaluation.triggeredAlerts.length > 0) {
      const { data: dbSubs } = await admin
        .from("push_subscriptions")
        .select("*")
        .eq("user_id", user.id);

      if (dbSubs && dbSubs.length > 0) {
        subscriptions = dbSubs as PushSubscriptionRecord[];
      }

      // Anti-IDOR: actualizar solo el sobre que corresponde a este usuario
      await admin
        .from("monthly_envelopes")
        .update({
          notified_thresholds: evaluation.updatedThresholdsMap,
        })
        .eq("id", envelopes.id)
        .like("month_year", `%_${user.id}`);
    }

    const pushResults = [];
    for (const alert of evaluation.triggeredAlerts) {
      const dispatch = await sendWebPushToBothSpouses(subscriptions, {
        title: alert.title,
        body: alert.body,
        tag: `envelope-${alert.envelope}-${alert.threshold}`,
        url: "/",
      });
      pushResults.push({
        ...alert,
        dispatch,
      });
    }

    return NextResponse.json({
      ok: true,
      triggeredAlerts: pushResults,
      updatedThresholdsMap: evaluation.updatedThresholdsMap,
    });
  } catch (error) {
    console.error("Error en /api/push/check-thresholds:", error);
    return NextResponse.json(
      {
        ok: false,
        error: "Error al verificar los umbrales 80% / 100% de Web Push",
      },
      { status: 500 }
    );
  }
}
