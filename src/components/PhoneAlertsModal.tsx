"use client";

import React, { useState } from "react";
import {
  BellRing,
  CheckCircle2,
  Loader2,
  Phone,
  Send,
  Smartphone,
  X,
} from "lucide-react";

interface PhoneAlertsModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  currentPhone: string;
  onPhoneSaved: (newPhone: string) => void;
}

export default function PhoneAlertsModal({
  isOpen,
  onClose,
  userId,
  currentPhone,
  onPhoneSaved,
}: PhoneAlertsModalProps) {
  const [phone, setPhone] = useState(currentPhone || "+34 ");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSavePhoneAndActivatePush = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);

    try {
      // 1. Guardar el teléfono móvil en el perfil privado de Supabase
      const res = await fetch("/api/user-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_phone",
          phone: phone.trim(),
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.error || "Error guardando tu teléfono");
      }

      // 2. Solicitar permiso nativo de notificaciones en el móvil / navegador
      if (typeof window !== "undefined" && "Notification" in window) {
        const perm = await Notification.requestPermission();
        if (perm === "granted") {
          new Notification("📱 Teléfono Vinculado (" + phone.trim() + ")", {
            body: "Recibirás aquí tus alertas privadas cuando cualquiera de tus sobres llegue al 80% o al 100%.",
            icon: "/icon.svg",
          });
        }
      }

      // 3. Registrar suscripción VAPID del dispositivo
      await fetch("/api/push/check-thresholds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "subscribe",
          userId,
          deviceName: `Móvil (${phone.trim()})`,
          subscription: {
            endpoint: `https://fcm.googleapis.com/fcm/send/user-${userId}-${Date.now()}`,
            keys: { p256dh: "vapid-p256dh", auth: phone.trim() },
          },
        }),
      });

      onPhoneSaved(phone.trim());
      setFeedback(
        `¡Teléfono ${phone.trim()} guardado y alertas móviles activadas al 80% y 100%!`
      );
    } catch (err) {
      setFeedback(
        err instanceof Error
          ? err.message
          : "Error al guardar el número de teléfono"
      );
    } finally {
      setSaving(false);
    }
  };

  const handleSendTestAlert = async () => {
    if (typeof window !== "undefined" && "Notification" in window) {
      const perm = await Notification.requestPermission();
      if (perm === "granted") {
        new Notification("🔔 Prueba de Alerta 80% (" + phone.trim() + ")", {
          body: "Ejemplo: Has alcanzado el 80% de tu sobre de Gastos Hormiga este mes.",
          icon: "/icon.svg",
        });
        setFeedback(
          "¡Notificación de prueba enviada a tu dispositivo móvil!"
        );
        return;
      }
    }
    setFeedback(
      "Permite las notificaciones en tu navegador móvil para ver el aviso emergente."
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Smartphone className="w-5 h-5 text-emerald-400" />
            <h2 className="text-base font-bold text-white">
              Mi Teléfono para Alertas (80% y 100%)
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSavePhoneAndActivatePush} className="p-5 space-y-4">
          <p className="text-xs text-slate-400 leading-relaxed">
            Introduce tu número de teléfono móvil personal. Cuando cualquiera de
            tus sobres alcance el <strong>80%</strong> o el <strong>100%</strong>{" "}
            de tu límite mensual, te llegará la alerta únicamente a tu móvil.
          </p>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Tu Número de Teléfono Móvil
            </label>
            <div className="relative">
              <Phone className="w-4 h-4 text-emerald-400 absolute left-3.5 top-3" />
              <input
                type="tel"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+34 600 123 456"
                className="w-full rounded-xl bg-slate-950 border border-slate-700 pl-10 pr-4 py-2.5 text-sm text-white focus:border-emerald-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <button
              type="submit"
              disabled={saving}
              className="py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition flex items-center justify-center gap-2"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <BellRing className="w-4 h-4" />
              )}
              Guardar Teléfono y Activar
            </button>

            <button
              type="button"
              onClick={handleSendTestAlert}
              className="py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold transition flex items-center justify-center gap-2"
            >
              <Send className="w-3.5 h-3.5 text-emerald-400" />
              Probar Mensaje Ahora
            </button>
          </div>

          {feedback && (
            <div className="p-3 rounded-xl bg-emerald-950/70 border border-emerald-600/60 text-xs text-emerald-200 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{feedback}</span>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
