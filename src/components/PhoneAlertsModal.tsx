"use client";

import React, { useEffect, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  MessageCircle,
  Phone,
  Send,
  X,
} from "lucide-react";

interface PhoneAlertsModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  currentPhone: string;
  currentWhatsappApiKey: string;
  onPhoneSaved: (newPhone: string, newApiKey: string) => void;
}

const CALLMEBOT_WHATSAPP_URL =
  "https://wa.me/34623786449?text=I%20allow%20callmebot%20to%20send%20me%20messages";

export default function PhoneAlertsModal({
  isOpen,
  onClose,
  currentPhone,
  currentWhatsappApiKey,
  onPhoneSaved,
}: PhoneAlertsModalProps) {
  const [phone, setPhone] = useState(currentPhone || "+34 ");
  const [apiKey, setApiKey] = useState(currentWhatsappApiKey || "");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    if (isOpen) {
      setPhone(currentPhone || "+34 ");
      setApiKey(currentWhatsappApiKey || "");
      setFeedback(null);
    }
  }, [isOpen, currentPhone, currentWhatsappApiKey]);

  if (!isOpen) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);

    try {
      const res = await fetch("/api/user-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_phone",
          phone: phone.trim(),
          whatsappApiKey: apiKey.trim(),
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.error || "Error guardando tus datos de WhatsApp");
      }

      onPhoneSaved(phone.trim(), apiKey.trim());
      setFeedback({
        type: "success",
        text: "¡Guardado! Pulsa ahora 'Enviar WhatsApp de Prueba' para confirmar que te llega al móvil.",
      });
    } catch (err) {
      setFeedback({
        type: "error",
        text:
          err instanceof Error
            ? err.message
            : "Error al guardar la configuración de WhatsApp",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTestWhatsApp = async () => {
    setTesting(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/user-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "test_whatsapp",
          phone: phone.trim(),
          whatsappApiKey: apiKey.trim(),
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.error || "No se pudo enviar el WhatsApp");
      }
      setFeedback({
        type: "success",
        text: "¡WhatsApp enviado! Mira tu móvil, te acaba de llegar el mensaje de prueba.",
      });
    } catch (err) {
      setFeedback({
        type: "error",
        text:
          err instanceof Error
            ? err.message
            : "Error enviando WhatsApp de prueba",
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-3xl bg-[#111216] border border-zinc-800 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <MessageCircle className="w-5 h-5 text-[#00D084]" />
            <h2 className="text-base font-bold text-white">
              Alertas Directas a Tu WhatsApp (0 €)
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-5 space-y-4">
          {/* Paso 1: Activar CallMeBot en 1 toque */}
          <div className="rounded-2xl bg-black border border-zinc-800 p-3.5 space-y-2.5">
            <div className="text-xs font-bold text-[#00D084]">
              Paso 1 (Solo 1 vez · Gratis): Activa tu WhatsApp
            </div>
            <p className="text-[11px] text-zinc-400 leading-relaxed">
              Pulsa este botón desde tu móvil para enviar el mensaje de permiso
              al bot gratuito <strong>CallMeBot (+34 623 78 64 49)</strong>. En
              5 segundos te responderá por WhatsApp con un código{" "}
              <strong>APIKEY</strong> de 6-7 números.
            </p>
            <a
              href={CALLMEBOT_WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full py-2.5 px-3 rounded-xl bg-[#25D366]/15 hover:bg-[#25D366]/25 border border-[#25D366]/40 text-[#25D366] text-xs font-bold flex items-center justify-center gap-2 transition"
            >
              <MessageCircle className="w-4 h-4" />
              Abrir WhatsApp y Pedir Mi Código Gratis
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>

          {/* Paso 2: Pegar número y código APIKEY */}
          <div className="space-y-3">
            <div className="text-xs font-bold text-white">
              Paso 2: Introduce tu número y el código recibido
            </div>

            <div>
              <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                Tu Número de WhatsApp (con +34)
              </label>
              <div className="relative">
                <Phone className="w-4 h-4 text-[#00D084] absolute left-3.5 top-3" />
                <input
                  type="tel"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+34 612 345 678"
                  className="w-full rounded-xl bg-black border border-zinc-700 pl-10 pr-4 py-2.5 text-sm text-white focus:border-[#00D084] focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                Código APIKEY que te respondió CallMeBot
              </label>
              <div className="relative">
                <KeyRound className="w-4 h-4 text-[#00D084] absolute left-3.5 top-3" />
                <input
                  type="text"
                  required
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Ej. 1234567"
                  className="w-full rounded-xl bg-black border border-zinc-700 pl-10 pr-4 py-2.5 text-sm font-mono text-white focus:border-[#00D084] focus:outline-none"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
            <button
              type="submit"
              disabled={saving}
              className="py-2.5 px-4 rounded-xl bg-[#00D084] hover:bg-[#00b874] text-black text-xs font-bold transition flex items-center justify-center gap-2"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <CheckCircle2 className="w-4 h-4" />
              )}
              Guardar WhatsApp
            </button>

            <button
              type="button"
              disabled={testing || !apiKey.trim()}
              onClick={handleTestWhatsApp}
              className="py-2.5 px-4 rounded-xl bg-zinc-900 hover:bg-zinc-800 disabled:opacity-50 border border-zinc-700 text-white text-xs font-semibold transition flex items-center justify-center gap-2"
            >
              {testing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5 text-[#00D084]" />
              )}
              Enviar WhatsApp de Prueba
            </button>
          </div>

          {feedback && (
            <div
              className={`p-3 rounded-xl border text-xs ${
                feedback.type === "success"
                  ? "bg-emerald-950/70 border-[#00D084]/50 text-emerald-200"
                  : "bg-rose-950/70 border-rose-500/50 text-rose-200"
              }`}
            >
              {feedback.text}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
