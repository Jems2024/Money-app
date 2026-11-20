import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { sendWhatsAppAlert } from "@/lib/whatsapp";

const ALLOWED_ENVELOPES = new Set([
  "hormiga",
  "libre_esposo",
  "libre_esposa",
  "libre_comun",
  "necesario",
  "fijo",
  "ahorro",
]);

function getAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function getAuthenticatedUser() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

function safeNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export async function GET() {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, unauthenticated: true },
        { status: 401 }
      );
    }

    const admin = getAdminClient();
    const currentMonthKey = `${new Date().toISOString().slice(0, 7)}_${user.id}`;

    // 1. Perfil del usuario
    let { data: profile } = await admin
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

    if (!profile) {
      const newProfile = {
        id: user.id,
        display_name:
          user.user_metadata?.display_name ||
          user.email?.split("@")[0] ||
          "Mi Cuenta",
        avatar_color: "#10b981",
        role: user.user_metadata?.role === "esposa" ? "esposa" : "esposo",
      };
      await admin.from("profiles").upsert(newProfile, { onConflict: "id" });
      profile = newProfile;
    }

    // 2. Cuentas bancarias EXCLUSIVAS de este usuario
    const { data: accounts } = await admin
      .from("bank_accounts")
      .select("*")
      .eq("owner_user_id", user.id)
      .order("created_at", { ascending: true });

    const safeAccounts = accounts || [];
    const accountIds = safeAccounts.map((a) => a.id);

    // 3. Recibos fijos EXCLUSIVOS de las cuentas de este usuario
    let safeBills: Record<string, unknown>[] = [];
    if (accountIds.length > 0) {
      const { data: bills } = await admin
        .from("fixed_bills")
        .select("*")
        .in("charged_account_id", accountIds)
        .order("created_at", { ascending: true });
      safeBills = bills || [];
    }

    // 4. Movimientos EXCLUSIVOS de este usuario
    const { data: transactions } = await admin
      .from("transactions")
      .select("*")
      .eq("user_id", user.id)
      .order("date", { ascending: false })
      .order("created_at", { ascending: false });

    // 5. Sobres mensuales EXCLUSIVOS de este usuario
    let { data: envelopes } = await admin
      .from("monthly_envelopes")
      .select("*")
      .eq("month_year", currentMonthKey)
      .single();

    if (!envelopes) {
      const { data: insertedEnv } = await admin
        .from("monthly_envelopes")
        .insert({
          month_year: currentMonthKey,
          ant_expenses_limit: 150,
          husband_free_limit: 200,
          wife_free_limit: 200,
          shared_free_limit: 150,
          savings_goal: 300,
          groceries_limit: 400,
          notified_thresholds: {},
        })
        .select("*")
        .single();
      envelopes = insertedEnv;
    }

    // 6. Suscripciones Push y Teléfono de este usuario
    const { data: pushSubs } = await admin
      .from("push_subscriptions")
      .select("*")
      .eq("user_id", user.id);

    const phone =
      user.user_metadata?.phone ||
      pushSubs?.find((s) => s.endpoint?.startsWith("phone://"))?.auth ||
      "";
    const whatsappApiKey = String(user.user_metadata?.whatsapp_apikey || "");

    return NextResponse.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        display_name: profile.display_name,
        role: profile.role,
        phone,
        whatsappApiKey,
      },
      accounts: safeAccounts,
      fixedBills: safeBills,
      transactions: transactions || [],
      envelopes: envelopes || {
        id: "temp",
        month_year: currentMonthKey,
        ant_expenses_limit: 150,
        husband_free_limit: 200,
        wife_free_limit: 200,
        shared_free_limit: 150,
        savings_goal: 300,
        groceries_limit: 400,
        notified_thresholds: {},
      },
      pushSubscriptions: pushSubs || [],
    });
  } catch (error) {
    console.error("Error cargando datos privados del usuario:", error);
    return NextResponse.json(
      { ok: false, error: "Error al cargar tus datos privados" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, unauthenticated: true },
        { status: 401 }
      );
    }

    const admin = getAdminClient();
    const body = await request.json();
    const action = body.action as string;

    // Función auxiliar de verificación estricta de propiedad de cuenta (Anti-IDOR)
    const verifyAccountOwnership = async (accountId: string) => {
      const { data: acc } = await admin
        .from("bank_accounts")
        .select("id, current_balance")
        .eq("id", accountId)
        .eq("owner_user_id", user.id)
        .single();
      return acc;
    };

    // 1. Crear una cuenta bancaria propia del usuario
    if (action === "create_bank_account") {
      const bankName = String(body.bankName || "CaixaBank").trim().slice(0, 60);
      const accountAlias = String(
        body.accountAlias || `Mi Cuenta ${bankName}`
      )
        .trim()
        .slice(0, 80);
      const last4 = String(body.ibanLast4 || "0000")
        .replace(/\D/g, "")
        .slice(-4)
        .padStart(4, "0");
      const initialBalance = safeNumber(body.currentBalance, 0);

      const { data: created, error } = await admin
        .from("bank_accounts")
        .insert({
          owner_user_id: user.id,
          bank_name: bankName,
          account_alias: accountAlias,
          iban_masked: `ES** **** **** **** **** ${last4}`,
          current_balance: initialBalance,
          last_synced_at: new Date().toISOString(),
        })
        .select("*")
        .single();

      if (error) throw error;
      return NextResponse.json({ ok: true, account: created });
    }

    // 2. Actualizar el saldo de una cuenta bancaria propia (verificado por owner_user_id)
    if (action === "update_balance") {
      const accountId = String(body.accountId || "");
      const currentBalance = safeNumber(body.currentBalance, NaN);
      if (!accountId || Number.isNaN(currentBalance)) {
        return NextResponse.json(
          { ok: false, error: "Saldo o cuenta inválidos" },
          { status: 400 }
        );
      }

      const { data: updated, error } = await admin
        .from("bank_accounts")
        .update({
          current_balance: currentBalance,
          last_synced_at: new Date().toISOString(),
        })
        .eq("id", accountId)
        .eq("owner_user_id", user.id)
        .select("*")
        .single();

      if (error || !updated) {
        return NextResponse.json(
          { ok: false, error: "Cuenta no encontrada o sin permiso" },
          { status: 403 }
        );
      }
      return NextResponse.json({ ok: true, account: updated });
    }

    // 3. Guardar límites de sobres mensuales propios (Anti-IDOR: verifica sufijo _<user.id>)
    if (action === "save_envelopes") {
      const env = body.envelopes;
      const { data: updated, error } = await admin
        .from("monthly_envelopes")
        .update({
          ant_expenses_limit: Math.max(0, safeNumber(env.ant_expenses_limit, 150)),
          husband_free_limit: Math.max(0, safeNumber(env.husband_free_limit, 200)),
          wife_free_limit: Math.max(0, safeNumber(env.wife_free_limit, 200)),
          shared_free_limit: Math.max(0, safeNumber(env.shared_free_limit, 150)),
          savings_goal: Math.max(0, safeNumber(env.savings_goal, 300)),
          groceries_limit: Math.max(0, safeNumber(env.groceries_limit, 400)),
          updated_at: new Date().toISOString(),
        })
        .eq("id", env.id)
        .like("month_year", `%_${user.id}`)
        .select("*")
        .single();

      if (error || !updated) {
        return NextResponse.json(
          { ok: false, error: "No tienes permiso para editar estos sobres" },
          { status: 403 }
        );
      }
      return NextResponse.json({ ok: true, envelopes: updated });
    }

    // 4. Crear recibo fijo propio (Anti-IDOR: verifica que la cuenta pertenezca a user.id)
    if (action === "create_fixed_bill") {
      const chargedAccountId = String(body.chargedAccountId || "");
      const ownedAccount = await verifyAccountOwnership(chargedAccountId);
      if (!ownedAccount) {
        return NextResponse.json(
          { ok: false, error: "La cuenta bancaria no te pertenece" },
          { status: 403 }
        );
      }

      const expectedAmount = Math.max(0, safeNumber(body.expectedAmount, 0));
      const { data: created, error } = await admin
        .from("fixed_bills")
        .insert({
          custom_code: String(body.customCode || "REC-FIJO")
            .toUpperCase()
            .slice(0, 32),
          name: String(body.name || "").trim().slice(0, 100),
          expected_amount: expectedAmount,
          charged_account_id: ownedAccount.id,
          match_keyword: String(body.matchKeyword || body.name || "")
            .toUpperCase()
            .slice(0, 60),
          is_paid_this_month: false,
          auto_matched: false,
        })
        .select("*")
        .single();

      if (error) throw error;
      return NextResponse.json({ ok: true, bill: created });
    }

    // 5. Alternar Pagado / Pendiente en un recibo fijo (Anti-IDOR: verifica propiedad de cuenta)
    if (action === "toggle_fixed_bill") {
      const billId = String(body.billId || "");
      const { data: userAccounts } = await admin
        .from("bank_accounts")
        .select("id")
        .eq("owner_user_id", user.id);

      const userAccountIds = (userAccounts || []).map((a) => a.id);
      if (userAccountIds.length === 0) {
        return NextResponse.json({ ok: false, error: "Sin permiso" }, { status: 403 });
      }

      const { data: updated, error } = await admin
        .from("fixed_bills")
        .update({
          is_paid_this_month: Boolean(body.isPaid),
          paid_date: body.isPaid ? new Date().toISOString().slice(0, 10) : null,
        })
        .eq("id", billId)
        .in("charged_account_id", userAccountIds)
        .select("*")
        .single();

      if (error || !updated) {
        return NextResponse.json(
          { ok: false, error: "Recibo no encontrado o sin permiso" },
          { status: 403 }
        );
      }
      return NextResponse.json({ ok: true, bill: updated });
    }

    // 6. Registrar movimientos (Anti-IDOR: verifica propiedad de bankAccountId y matchedBillIds)
    if (action === "add_transactions") {
      const items = Array.isArray(body.transactions) ? body.transactions : [];
      const bankAccountId = String(body.bankAccountId || "");

      const ownedAccount = await verifyAccountOwnership(bankAccountId);
      if (!ownedAccount) {
        return NextResponse.json(
          { ok: false, error: "La cuenta bancaria no te pertenece" },
          { status: 403 }
        );
      }

      const rowsToInsert = items.slice(0, 500).map((t: Record<string, unknown>) => {
        const rawEnv = String(t.envelope || "hormiga");
        const safeEnv = ALLOWED_ENVELOPES.has(rawEnv) ? rawEnv : "hormiga";
        const safeType = t.type === "income" ? "income" : "expense";
        const safeAmount = Math.abs(safeNumber(t.amount, 0));

        return {
          bank_account_id: ownedAccount.id,
          user_id: user.id,
          external_tx_id:
            String(t.external_tx_id || "") ||
            `TX-${user.id.slice(0, 6)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          custom_code: String(t.custom_code || "MOV-01").slice(0, 32),
          date: /^\d{4}-\d{2}-\d{2}$/.test(String(t.date || ""))
            ? String(t.date)
            : new Date().toISOString().slice(0, 10),
          concept: String(t.concept || "Movimiento").trim().slice(0, 140),
          amount: safeAmount,
          type: safeType,
          envelope: safeEnv,
          needs_review: Boolean(t.needs_review),
          linked_bill_id: t.linked_bill_id || null,
          ai_confidence: Math.min(1, Math.max(0, safeNumber(t.ai_confidence, 0.95))),
          ai_reasoning: String(t.ai_reasoning || "").slice(0, 240),
        };
      });

      const { data: inserted, error } = await admin
        .from("transactions")
        .insert(rowsToInsert)
        .select("*");

      if (error) throw error;

      const netDelta = rowsToInsert.reduce(
        (acc: number, item: { type: string; amount: number }) =>
          acc + (item.type === "income" ? item.amount : -item.amount),
        0
      );

      await admin
        .from("bank_accounts")
        .update({
          current_balance: Number(
            (Number(ownedAccount.current_balance) + netDelta).toFixed(2)
          ),
          last_synced_at: new Date().toISOString(),
        })
        .eq("id", ownedAccount.id)
        .eq("owner_user_id", user.id);

      if (Array.isArray(body.matchedBillIds) && body.matchedBillIds.length > 0) {
        await admin
          .from("fixed_bills")
          .update({
            is_paid_this_month: true,
            paid_date: new Date().toISOString().slice(0, 10),
            auto_matched: true,
          })
          .in("id", body.matchedBillIds)
          .eq("charged_account_id", ownedAccount.id);
      }

      return NextResponse.json({ ok: true, inserted: inserted || [] });
    }

    // 7. Confirmar compra de supermercado en 1 toque
    if (action === "confirm_supermarket_tx") {
      const txId = String(body.txId || "");
      const envelope = String(body.envelope || "necesario");
      if (!ALLOWED_ENVELOPES.has(envelope)) {
        return NextResponse.json(
          { ok: false, error: "Sobre no válido" },
          { status: 400 }
        );
      }

      const { data: updated, error } = await admin
        .from("transactions")
        .update({
          envelope,
          needs_review: false,
          ai_reasoning: `Confirmado en 1 toque como ${envelope.toUpperCase()}`,
        })
        .eq("id", txId)
        .eq("user_id", user.id)
        .select("*")
        .single();

      if (error || !updated) {
        return NextResponse.json(
          { ok: false, error: "Movimiento no encontrado o sin permiso" },
          { status: 403 }
        );
      }
      return NextResponse.json({ ok: true, transaction: updated });
    }

    // 8. Guardar número de WhatsApp y API Key gratuita de CallMeBot del usuario
    if (action === "save_phone") {
      const phone = String(body.phone || "").trim().slice(0, 25);
      const whatsappApiKey = String(body.whatsappApiKey || "").trim().slice(0, 40);

      await admin.auth.admin.updateUserById(user.id, {
        user_metadata: {
          ...user.user_metadata,
          phone,
          whatsapp_apikey: whatsappApiKey,
        },
      });

      await admin.from("push_subscriptions").upsert(
        {
          user_id: user.id,
          device_name: `WhatsApp (${phone})`,
          endpoint: `phone://${user.id}/${encodeURIComponent(phone)}`,
          p256dh: whatsappApiKey || "phone-registered",
          auth: phone,
        },
        { onConflict: "endpoint" }
      );

      return NextResponse.json({ ok: true, phone, whatsappApiKey });
    }

    // 8B. Enviar mensaje real de prueba por WhatsApp al número del usuario
    if (action === "test_whatsapp") {
      const phone = String(body.phone || user.user_metadata?.phone || "").trim();
      const apiKey = String(
        body.whatsappApiKey || user.user_metadata?.whatsapp_apikey || ""
      ).trim();

      const result = await sendWhatsAppAlert({
        phone,
        apiKey,
        message:
          "✅ *StopEnds Bancario*: ¡Tus alertas privadas por WhatsApp están activas! Te avisaré aquí cuando cualquier sobre llegue al 80% o al 100%.",
      });

      if (!result.ok) {
        return NextResponse.json(
          { ok: false, error: result.error },
          { status: 400 }
        );
      }

      return NextResponse.json({ ok: true, sent: true });
    }

    // 9. Eliminar una cuenta bancaria propia (y en cascada sus movimientos/recibos)
    if (action === "delete_bank_account") {
      const accountId = String(body.accountId || "");
      const owned = await verifyAccountOwnership(accountId);
      if (!owned) {
        return NextResponse.json(
          { ok: false, error: "Cuenta no encontrada o sin permiso" },
          { status: 403 }
        );
      }

      const { error } = await admin
        .from("bank_accounts")
        .delete()
        .eq("id", accountId)
        .eq("owner_user_id", user.id);

      if (error) throw error;
      return NextResponse.json({ ok: true, deletedAccountId: accountId });
    }

    // 10. Eliminar un recibo fijo propio
    if (action === "delete_fixed_bill") {
      const billId = String(body.billId || "");
      const { data: userAccounts } = await admin
        .from("bank_accounts")
        .select("id")
        .eq("owner_user_id", user.id);
      const userAccountIds = (userAccounts || []).map((a) => a.id);

      const { error } = await admin
        .from("fixed_bills")
        .delete()
        .eq("id", billId)
        .in("charged_account_id", userAccountIds);

      if (error) throw error;
      return NextResponse.json({ ok: true, deletedBillId: billId });
    }

    // 11. Eliminar un movimiento propio
    if (action === "delete_transaction") {
      const txId = String(body.txId || "");
      const { error } = await admin
        .from("transactions")
        .delete()
        .eq("id", txId)
        .eq("user_id", user.id);

      if (error) throw error;
      return NextResponse.json({ ok: true, deletedTxId: txId });
    }

    return NextResponse.json(
      { ok: false, error: "Acción no reconocida" },
      { status: 400 }
    );
  } catch (error) {
    console.error("Error en POST /api/user-data:", error);
    return NextResponse.json(
      {
        ok: false,
        error: "Error guardando en Supabase",
      },
      { status: 500 }
    );
  }
}
