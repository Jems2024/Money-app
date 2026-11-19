"use client";

import React, { useState } from "react";
import {
  Lock,
  Loader2,
  LogIn,
  Mail,
  Phone,
  ShieldCheck,
  User,
  UserPlus,
  Wallet,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";

interface PrivateAuthScreenProps {
  onAuthenticated: () => void;
}

export default function PrivateAuthScreen({
  onAuthenticated,
}: PrivateAuthScreenProps) {
  const [mode, setMode] = useState<"login" | "register">("register");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("+34 ");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg(null);

    try {
      const supabase = createClient();

      if (mode === "register") {
        // 1. Crear usuario confirmado al instante en Supabase + guardar su teléfono
        const regRes = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            displayName: displayName.trim(),
            phone: phone.trim(),
            email: email.trim(),
            password,
            role: "esposo",
          }),
        });

        const regData = await regRes.json();
        if (!regData.ok) {
          throw new Error(regData.error || "No se pudo crear tu usuario");
        }

        // 2. Iniciar sesión inmediatamente tras crear la cuenta
        const { error: signInErr } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (signInErr) throw signInErr;

        onAuthenticated();
      } else {
        const { error: signInErr } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (signInErr) throw signInErr;

        onAuthenticated();
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : "Error de autenticación. Revisa tu correo y contraseña."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#070b14] text-slate-100 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md rounded-3xl bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden">
        {/* Cabecera */}
        <div className="p-6 pb-5 border-b border-slate-800 text-center space-y-2">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center mx-auto shadow-lg shadow-emerald-950/60">
            <Wallet className="w-6 h-6 text-slate-950" />
          </div>
          <h1 className="text-xl font-bold text-white">
            Mi Control Bancario Privado
          </h1>
          <p className="text-xs text-slate-400 leading-relaxed">
            Cada usuario tiene su propio acceso individual y 100% privado. Nadie
            más puede ver tu saldo, tus recibos ni tus movimientos.
          </p>
        </div>

        {/* Selector Crear Usuario vs Iniciar Sesión */}
        <div className="px-6 pt-5">
          <div className="grid grid-cols-2 gap-1.5 p-1 rounded-2xl bg-slate-950 border border-slate-800">
            <button
              type="button"
              onClick={() => {
                setMode("register");
                setErrorMsg(null);
              }}
              className={`py-2.5 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                mode === "register"
                  ? "bg-emerald-600 text-white shadow"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <UserPlus className="w-4 h-4" />
              Crear Mi Usuario
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("login");
                setErrorMsg(null);
              }}
              className={`py-2.5 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                mode === "login"
                  ? "bg-emerald-600 text-white shadow"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <LogIn className="w-4 h-4" />
              Iniciar Sesión
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {mode === "register" && (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Tu Nombre
                </label>
                <div className="relative">
                  <User className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                  <input
                    type="text"
                    required
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Ej. Juan / María"
                    className="w-full rounded-xl bg-slate-950 border border-slate-700 pl-10 pr-3.5 py-2.5 text-sm text-white focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Tu Teléfono Móvil (Para recibir alertas 80% y 100%)
                </label>
                <div className="relative">
                  <Phone className="w-4 h-4 text-emerald-400 absolute left-3.5 top-3" />
                  <input
                    type="tel"
                    required
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+34 600 123 456"
                    className="w-full rounded-xl bg-slate-950 border border-slate-700 pl-10 pr-3.5 py-2.5 text-sm text-white focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>
            </>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Tu Correo Electrónico
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="tucorreo@ejemplo.com"
                className="w-full rounded-xl bg-slate-950 border border-slate-700 pl-10 pr-3.5 py-2.5 text-sm text-white focus:border-emerald-500 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Tu Contraseña Privada (mín. 8 caracteres)
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
              <input
                type="password"
                minLength={8}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-xl bg-slate-950 border border-slate-700 pl-10 pr-3.5 py-2.5 text-sm text-white focus:border-emerald-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="rounded-xl bg-slate-950/90 border border-slate-800 p-3 flex items-start gap-2.5 text-[11px] text-slate-400">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <span>
              <strong>100% Privado e Individual:</strong> Tu cuenta empieza en{" "}
              <strong>0,00 €</strong>. Tus bancos, recibos y movimientos sólo
              los puedes ver tú con tu correo y contraseña.
            </span>
          </div>

          {errorMsg && (
            <div className="p-3 rounded-xl bg-rose-950/80 border border-rose-600/60 text-xs text-rose-200">
              {errorMsg}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold transition flex items-center justify-center gap-2 shadow-lg shadow-emerald-950/60"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : mode === "register" ? (
              <>
                <UserPlus className="w-4 h-4" />
                Crear Mi Cuenta Privada y Entrar
              </>
            ) : (
              <>
                <LogIn className="w-4 h-4" />
                Entrar a Mi Panel Privado
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
