/**
 * Envía alertas reales gratuitas por WhatsApp personal (iPhone y Android)
 * utilizando CallMeBot API (0 €, sin servidores intermedios ni suscripciones).
 */
export async function sendWhatsAppAlert(params: {
  phone: string;
  apiKey: string;
  message: string;
}): Promise<{ ok: boolean; error?: string }> {
  const cleanPhone = params.phone.replace(/[^\d]/g, "");
  const cleanKey = params.apiKey.trim();

  if (!cleanPhone || cleanPhone.length < 9) {
    return {
      ok: false,
      error: "Introduce tu número completo con prefijo de país (ej. +34 612 345 678).",
    };
  }

  if (!cleanKey) {
    return {
      ok: false,
      error: "Falta tu código API Key de CallMeBot (paso 1).",
    };
  }

  try {
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(
      cleanPhone
    )}&text=${encodeURIComponent(params.message)}&apikey=${encodeURIComponent(
      cleanKey
    )}`;

    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
    });

    const responseText = await res.text();
    if (!res.ok || /error|invalid|not allowed/i.test(responseText)) {
      return {
        ok: false,
        error:
          "CallMeBot rechazó el envío. Revisa que tu número incluya +34 y que el API Key sea exacto.",
      };
    }

    return { ok: true };
  } catch (err) {
    console.error("Error enviando alerta por WhatsApp:", err);
    return {
      ok: false,
      error: "Error de conexión al enviar el mensaje de WhatsApp.",
    };
  }
}
