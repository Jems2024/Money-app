import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { exchangeEnableBankingCode } from "@/lib/enable-banking";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { FamilyRole } from "@/types/finance";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const expectedStateCookie = request.cookies.get("eb_oauth_state")?.value;

  if (!code || !state) {
    return NextResponse.redirect(
      new URL("/?psd2_error=missing_code_or_state", request.url)
    );
  }

  // 1. Verificación anti-CSRF: el state devuelto por el banco DEBE coincidir con la cookie HttpOnly
  if (!expectedStateCookie || expectedStateCookie !== state) {
    return NextResponse.redirect(
      new URL("/?psd2_error=invalid_csrf_state", request.url)
    );
  }

  try {
    // 2. Verificar sesión activa del usuario
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.redirect(
        new URL("/?psd2_error=unauthenticated", request.url)
      );
    }

    const decodedState = JSON.parse(
      Buffer.from(state, "base64url").toString("utf-8")
    ) as {
      userId: string;
      role: FamilyRole;
      aspspName: string;
    };

    // 3. Garantizar que el usuario autenticado es el mismo que inició la autorización
    if (decodedState.userId !== user.id) {
      return NextResponse.redirect(
        new URL("/?psd2_error=user_mismatch", request.url)
      );
    }

    const sessionResult = await exchangeEnableBankingCode(code);
    const primaryAccount = sessionResult.accounts[0];

    if (primaryAccount && process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const admin = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { auth: { autoRefreshToken: false, persistSession: false } }
      );

      // Enmascarar IBAN antes de guardarlo (solo guardamos últimos 4 dígitos visibles)
      const cleanIban = String(primaryAccount.iban || "").replace(/\s+/g, "");
      const last4 = cleanIban.slice(-4) || "0000";
      const maskedIban = `ES** **** **** **** **** ${last4}`;

      await admin.from("bank_accounts").upsert(
        {
          owner_user_id: user.id,
          bank_name: decodedState.aspspName,
          account_alias: `${primaryAccount.name} (${decodedState.aspspName})`,
          iban_masked: maskedIban,
          enable_banking_account_id: primaryAccount.uid,
          enable_banking_session_id: sessionResult.session_id,
          current_balance: Number(primaryAccount.balance || 0),
          last_synced_at: new Date().toISOString(),
        },
        { onConflict: "enable_banking_account_id" }
      );
    }

    const redirectUrl = new URL("/", request.url);
    redirectUrl.searchParams.set("psd2_connected", "true");
    redirectUrl.searchParams.set("bank", decodedState.aspspName);

    const response = NextResponse.redirect(redirectUrl);
    // Limpiar la cookie de estado de un solo uso
    response.cookies.delete("eb_oauth_state");
    return response;
  } catch (error) {
    console.error("Error en callback PSD2 Enable Banking:", error);
    return NextResponse.redirect(
      new URL("/?psd2_error=session_failed", request.url)
    );
  }
}
