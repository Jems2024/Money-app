"use client";

import React, { useState } from "react";
import { KeyRound, Loader2, LogIn, UserCheck, X } from "lucide-react";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { FamilyRole } from "@/types/finance";

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeRole: FamilyRole;
  onSelectRole: (role: FamilyRole) => void;
}

export default function AuthModal({
  isOpen,
  onClose,
  activeRole,
  onSelectRole,
}: AuthModalProps) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [role, setRole] = useState<FamilyRole>(activeRole);
  const [displayName, setDisplayName] = useState<string>("");
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSupabaseAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setFeedback(null);

    if (!isSupabaseConfigured()) {
      onSelectRole(role);
      setFeedback(
        `Sesión rápida activada como ${
          role === "esposa" ? "Elena (Esposa)" : "Carlos (Esposo)"
        }. Configura NEXT_PUBLIC_SUPABASE_URL en .env.local para persistencia en la nube.`
      );
      setLoading(false);
      setTimeout(onClose, 1100);
      return;
    }

    try {
      const supabase = createClient();
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              role,
              display_name:
                displayName || (role === "esposa" ? "Esposa" : "Esposo"),
              avatar_color: role === "esposa" ? "#db2777" : "#2563eb",
            },
          },
        });
        if (error) throw error;
        setFeedback("¡Cuenta familiar creada! Revisa tu correo o inicia sesión.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        onSelectRole(role);
        onClose();
      }
    } catch (err) {
      setFeedback(
        err instanceof Error ? err.message : "Error de autenticación Supabase"
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-emerald-400" />
            <h2 className="text-base font-semibold text-white">
              Acceso Familiar (Supabase Auth)
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Cambio Rápido de Usuario en 1 Toque */}
          <div>
            <span className="block text-xs font-medium text-slate-400 mb-2">
              Cambio Rápido de Sesión (1 Toque):
            </span>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setRole("esposo");
                  onSelectRole("esposo");
                  onClose();
                }}
                className={`p-3 rounded-xl border flex items-center gap-2.5 transition ${
                  activeRole === "esposo"
                    ? "bg-blue-600/25 border-blue-500 text-white"
                    : "bg-slate-950 border-slate-800 text-slate-300"
                }`}
              >
                <span className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold">
                  ÉL
                </span>
                <div className="text-left">
                  <div className="text-xs font-semibold">Carlos (Esposo)</div>
                  <div className="text-[11px] text-slate-400">CaixaBank</div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  setRole("esposa");
                  onSelectRole("esposa");
                  onClose();
                }}
                className={`p-3 rounded-xl border flex items-center gap-2.5 transition ${
                  activeRole === "esposa"
                    ? "bg-pink-600/25 border-pink-500 text-white"
                    : "bg-slate-950 border-slate-800 text-slate-300"
                }`}
              >
                <span className="w-8 h-8 rounded-full bg-pink-600 flex items-center justify-center text-xs font-bold">
                  ELLA
                </span>
                <div className="text-left">
                  <div className="text-xs font-semibold">Elena (Esposa)</div>
                  <div className="text-[11px] text-slate-400">BBVA</div>
                </div>
              </button>
            </div>
          </div>

          <div className="border-t border-slate-800 pt-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-slate-300">
                Credenciales Supabase Auth (`auth.users`)
              </span>
              <button
                type="button"
                onClick={() =>
                  setMode(mode === "login" ? "signup" : "login")
                }
                className="text-xs text-emerald-400 hover:underline"
              >
                {mode === "login"
                  ? "Crear cuenta de cónyuge"
                  : "Ya tengo cuenta"}
              </button>
            </div>

            <form onSubmit={handleSupabaseAuth} className="space-y-3">
              {mode === "signup" && (
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="Nombre (ej. Elena)"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-xs text-white"
                  />
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value as FamilyRole)}
                    className="rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-xs text-white"
                  >
                    <option value="esposo">Rol: Esposo</option>
                    <option value="esposa">Rol: Esposa</option>
                  </select>
                </div>
              )}

              <input
                type="email"
                required
                placeholder="correo@familia.es"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3.5 py-2 text-sm text-white"
              />
              <input
                type="password"
                required
                placeholder="Contraseña"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3.5 py-2 text-sm text-white"
              />

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition flex items-center justify-center gap-2"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : mode === "login" ? (
                  <LogIn className="w-4 h-4" />
                ) : (
                  <UserCheck className="w-4 h-4" />
                )}
                {mode === "login"
                  ? "Entrar con Supabase Auth"
                  : "Registrar Miembro Familiar"}
              </button>
            </form>
          </div>

          {feedback && (
            <div className="p-3 rounded-xl bg-slate-950 border border-slate-700 text-xs text-emerald-300">
              {feedback}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
