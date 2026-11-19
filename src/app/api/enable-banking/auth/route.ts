import { NextRequest, NextResponse } from "next/server";
import { startEnableBankingAuth } from "@/lib/enable-banking";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { FamilyRole } from "@/types/finance";

export async function POST(request: NextRequest) {
  try {
    // 1. Autenticación estricta obligatoria
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Debes iniciar sesión para vincular tu banco." },
        { status: 401 }
      );
    }

    const body = await request.json();
    const aspspName = String(body.aspspName || "CaixaBank").trim().slice(0, 60);
    const role: FamilyRole =
      user.user_metadata?.role === "esposa" ? "esposa" : "esposo";

    const origin =
      process.env.NEXT_PUBLIC_APP_URL ||
      request.headers.get("origin") ||
      "http://localhost:3000";

    const authSession = await startEnableBankingAuth({
      aspspName,
      userId: user.id,
      role,
      redirectBaseUrl: origin,
    });

    const response = NextResponse.json({
      ok: true,
      mode: authSession.mode,
      authorizationUrl: authSession.url,
    });

    // 2. Cookie HttpOnly anti-CSRF para validar el callback OAuth2 de Enable Banking
    response.cookies.set("eb_oauth_state", authSession.state, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/api/enable-banking/callback",
      maxAge: 600, // 10 minutos
    });

    return response;
  } catch (error) {
    console.error("Error iniciando vinculación Enable Banking PSD2:", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Error al iniciar la conexión PSD2 con Enable Banking",
      },
      { status: 500 }
    );
  }
}
