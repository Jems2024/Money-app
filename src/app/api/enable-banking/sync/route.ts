import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fetchEnableBankingAccountSync } from "@/lib/enable-banking";
import { classifyTransactionsWithGemini } from "@/lib/gemini-classifier";
import { matchTransactionToFixedBill } from "@/lib/finance-engine";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { FamilyRole, FixedBill, Transaction } from "@/types/finance";

export async function POST(request: NextRequest) {
  try {
    // 1. Autenticación estricta obligatoria
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Debes iniciar sesión para sincronizar tu banco." },
        { status: 401 }
      );
    }

    const body = await request.json();
    const bankAccountId = String(body.bankAccountId || "");
    const role: FamilyRole =
      user.user_metadata?.role === "esposa" ? "esposa" : "esposo";

    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // 2. Anti-IDOR: verificar que la cuenta bancaria pertenece al usuario autenticado
    const { data: ownedAccount } = await admin
      .from("bank_accounts")
      .select("*")
      .eq("id", bankAccountId)
      .eq("owner_user_id", user.id)
      .single();

    if (!ownedAccount) {
      return NextResponse.json(
        { ok: false, error: "Cuenta bancaria no encontrada o sin permiso." },
        { status: 403 }
      );
    }

    const enableBankingAccountId = ownedAccount.enable_banking_account_id;
    if (!enableBankingAccountId) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Esta cuenta aún no está vinculada por PSD2. Vincúlala primero en '3. PSD2 Online'.",
        },
        { status: 400 }
      );
    }

    // Obtener recibos fijos reales de esta cuenta para conciliación automática
    const { data: accountBills } = await admin
      .from("fixed_bills")
      .select("*")
      .eq("charged_account_id", ownedAccount.id);

    const fixedBills = (accountBills || []) as FixedBill[];

    // 3. Descargar saldo y movimientos desde Enable Banking PSD2
    const syncData = await fetchEnableBankingAccountSync(
      enableBankingAccountId,
      role
    );

    // 4. Clasificar con @google/genai (gemini-2.5-flash)
    const classifications = await classifyTransactionsWithGemini(
      syncData.transactions.map((tx) => ({
        concept: tx.concept,
        amount: tx.amount,
        payerRole: role,
      }))
    );

    const processedTransactions: Transaction[] = [];
    const matchedBillIds: string[] = [];

    for (let i = 0; i < syncData.transactions.length; i++) {
      const rawTx = syncData.transactions[i];
      const aiResult = classifications[i];

      const matchedBill = matchTransactionToFixedBill(
        rawTx.concept,
        rawTx.amount,
        ownedAccount.id,
        fixedBills
      );

      if (matchedBill) {
        matchedBillIds.push(matchedBill.id);
      }

      processedTransactions.push({
        id: `tx-sync-${Date.now()}-${i}`,
        bank_account_id: ownedAccount.id,
        user_id: user.id,
        external_tx_id: rawTx.external_tx_id,
        custom_code: matchedBill
          ? matchedBill.custom_code
          : aiResult.suggested_custom_code,
        date: rawTx.date,
        concept: rawTx.concept,
        amount: rawTx.amount,
        type: rawTx.type,
        envelope: matchedBill ? "fijo" : aiResult.envelope,
        needs_review: matchedBill ? false : aiResult.needs_review,
        linked_bill_id: matchedBill ? matchedBill.id : null,
        ai_confidence: aiResult.confidence,
        ai_reasoning: matchedBill
          ? `Conciliado automáticamente con el recibo fijo ${matchedBill.custom_code}`
          : aiResult.reasoning,
      });
    }

    // 5. Guardar en Supabase de forma segura y aislada por usuario
    await admin
      .from("bank_accounts")
      .update({
        current_balance: syncData.currentBalance,
        last_synced_at: new Date().toISOString(),
      })
      .eq("id", ownedAccount.id)
      .eq("owner_user_id", user.id);

    if (processedTransactions.length > 0) {
      await admin.from("transactions").upsert(
        processedTransactions.map((t) => ({
          bank_account_id: ownedAccount.id,
          user_id: user.id,
          external_tx_id: t.external_tx_id,
          custom_code: t.custom_code,
          date: t.date,
          concept: t.concept,
          amount: t.amount,
          type: t.type,
          envelope: t.envelope,
          needs_review: t.needs_review,
          linked_bill_id: t.linked_bill_id,
          ai_confidence: t.ai_confidence,
          ai_reasoning: t.ai_reasoning,
        })),
        { onConflict: "external_tx_id" }
      );
    }

    if (matchedBillIds.length > 0) {
      await admin
        .from("fixed_bills")
        .update({
          is_paid_this_month: true,
          paid_date: new Date().toISOString().slice(0, 10),
          auto_matched: true,
        })
        .in("id", matchedBillIds)
        .eq("charged_account_id", ownedAccount.id);
    }

    return NextResponse.json({
      ok: true,
      currentBalance: syncData.currentBalance,
      syncedAt: new Date().toISOString(),
      newTransactions: processedTransactions,
      matchedBillIds,
    });
  } catch (error) {
    console.error("Error sincronizando cuenta Enable Banking:", error);
    return NextResponse.json(
      {
        ok: false,
        error: "Error en la sincronización PSD2",
      },
      { status: 500 }
    );
  }
}
