import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const displayName = String(body.displayName || "").trim().slice(0, 60);
    const phone = String(body.phone || "").trim().slice(0, 25);
    const role = body.role === "esposa" ? "esposa" : "esposo";

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json(
        { ok: false, error: "Introduce un correo electrónico válido." },
        { status: 400 }
      );
    }

    if (!password || password.length < 8) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Por seguridad bancaria, la contraseña debe tener al menos 8 caracteres.",
        },
        { status: 400 }
      );
    }

    // Seguridad opcional: si el usuario configura ALLOWED_EMAILS en .env.local, solo esos correos pueden registrarse
    const allowedEmailsEnv = process.env.ALLOWED_EMAILS;
    if (allowedEmailsEnv && allowedEmailsEnv.trim().length > 0) {
      const allowedList = allowedEmailsEnv
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
      if (allowedList.length > 0 && !allowedList.includes(email)) {
        return NextResponse.json(
          {
            ok: false,
            error: "Registro restringido únicamente a correos autorizados.",
          },
          { status: 403 }
        );
      }
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json(
        { ok: false, error: "Faltan las claves de Supabase en .env.local" },
        { status: 500 }
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // Seguridad: por defecto limitar a un máximo de 2 usuarios (Esposo y Esposa)
    // para que nadie ajeno pueda crear cuentas cuando esté publicado en Vercel
    const maxUsers = Number(process.env.MAX_REGISTERED_USERS || 2);
    const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers({
      perPage: 10,
    });
    if ((existingUsers?.users?.length || 0) >= maxUsers) {
      return NextResponse.json(
        {
          ok: false,
          error: `Límite máximo de ${maxUsers} usuarios alcanzado. El registro público está cerrado por seguridad.`,
        },
        { status: 403 }
      );
    }

    const { data: createdUser, error: createError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          display_name: displayName || email.split("@")[0],
          phone,
          role,
          avatar_color: "#10b981",
        },
      });

    if (createError) {
      return NextResponse.json(
        { ok: false, error: createError.message },
        { status: 400 }
      );
    }

    if (createdUser.user) {
      await supabaseAdmin.from("profiles").upsert(
        {
          id: createdUser.user.id,
          display_name: displayName || email.split("@")[0],
          avatar_color: "#10b981",
          role,
        },
        { onConflict: "id" }
      );

      if (phone) {
        await supabaseAdmin.from("push_subscriptions").upsert(
          {
            user_id: createdUser.user.id,
            device_name: `Móvil (${phone})`,
            endpoint: `phone://${createdUser.user.id}/${encodeURIComponent(phone)}`,
            p256dh: "phone-registered",
            auth: phone,
          },
          { onConflict: "endpoint" }
        );
      }
    }

    return NextResponse.json({
      ok: true,
      userId: createdUser.user?.id,
    });
  } catch (error) {
    console.error("Error registrando usuario:", error);
    return NextResponse.json(
      { ok: false, error: "Error al crear el usuario" },
      { status: 500 }
    );
  }
}
