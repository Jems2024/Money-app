import { NextRequest, NextResponse } from "next/server";
import {
  ClassificationInput,
  classifyTransactionsWithGemini,
} from "@/lib/gemini-classifier";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    // 1. Autenticación estricta obligatoria para proteger tu cuota de Gemini
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Debes iniciar sesión para usar el clasificador IA." },
        { status: 401 }
      );
    }

    const body = await request.json();
    const rawItems: ClassificationInput[] = Array.isArray(body.items)
      ? body.items
      : [
          {
            concept: String(body.concept || ""),
            amount: Number(body.amount || 0),
            payerRole: user.user_metadata?.role === "esposa" ? "esposa" : "esposo",
          },
        ];

    // Limitar tamaño de lote para evitar abuso
    const items = rawItems.slice(0, 100);

    const results = await classifyTransactionsWithGemini(items);

    return NextResponse.json({
      ok: true,
      model: "gemini-2.5-flash",
      results,
    });
  } catch (error) {
    console.error("Error en /api/classify:", error);
    return NextResponse.json(
      {
        ok: false,
        error: "Error clasificando movimientos con Gemini 2.5 Flash",
      },
      { status: 500 }
    );
  }
}
