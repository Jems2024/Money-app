import { GoogleGenAI, Type } from "@google/genai";
import { EnvelopeCategory, FamilyRole } from "@/types/finance";

export interface ClassificationInput {
  concept: string;
  amount: number;
  payerRole: FamilyRole;
}

export interface ClassificationResult {
  envelope: EnvelopeCategory;
  needs_review: boolean;
  confidence: number;
  reasoning: string;
  suggested_custom_code: string;
}

const SUPERMARKET_KEYWORDS = [
  "MERCADONA",
  "CARREFOUR",
  "LIDL",
  "ALDI",
  "CONSUM",
  "EROSKI",
  "ALCAMPO",
  "DIA ",
  "SUPERMERCADO",
  "HIPERCOR",
  "EL CORTE INGLES",
  "BONPREU",
  "AHORRAMAS",
  "GADIS",
  "FROIZ",
];

const ANT_EXPENSE_KEYWORDS = [
  "BAR ",
  "CAFETERIA",
  "CAFE ",
  "STARBUCKS",
  "PANADERIA",
  "GRANIER",
  "VENDING",
  "CERVECERIA",
  "TABERNA",
  "CHURRERIA",
  "HELADERIA",
  "PASTELERIA",
  "GLOVO",
  "UBER EATS",
  "KIOSKO",
  "ESTANCO",
  "TAPAS",
];

const FIXED_BILL_KEYWORDS = [
  "HIPOTECA",
  "PRESTAMO",
  "ALQUILER",
  "ENDESA",
  "IBERDROLA",
  "NATURGY",
  "REPSOL LUZ",
  "DIGI",
  "MOVISTAR",
  "VODAFONE",
  "ORANGE",
  "COMUNIDAD PROP",
  "MAPFRE",
  "ALLIANZ",
  "MUTUA",
  "ESCUELA INFANTIL",
  "GUARDERIA",
  "AYUNTAMIENTO IBI",
];

/**
 * Regla heurística determinista de respaldo y validación estricta de las Reglas del Skill:
 * - Bares, cafeterías y panaderías van directo a `hormiga` (`needs_review = false`).
 * - Supermercados y comercios mixtos van a `needs_review = true` para confirmar con 1 toque.
 */
export function fallbackRuleClassifier(
  input: ClassificationInput
): ClassificationResult {
  const upper = input.concept.toUpperCase();

  if (SUPERMARKET_KEYWORDS.some((kw) => upper.includes(kw))) {
    const brand =
      SUPERMARKET_KEYWORDS.find((kw) => upper.includes(kw))?.trim() || "SUPER";
    return {
      envelope: "necesario",
      needs_review: true,
      confidence: 0.62,
      reasoning:
        "Supermercado o comercio mixto detectado: requiere confirmación de 1 toque (Compra Necesaria, Gasto Hormiga o Mi Gasto Libre).",
      suggested_custom_code: `SUP-${brand.slice(0, 8).replace(/\s+/g, "")}`,
    };
  }

  if (ANT_EXPENSE_KEYWORDS.some((kw) => upper.includes(kw))) {
    return {
      envelope: "hormiga",
      needs_review: false,
      confidence: 0.96,
      reasoning:
        "Bar, cafetería o panadería detectado: asignado automáticamente al sobre de Gastos Hormiga.",
      suggested_custom_code: "HOR-CAFE-BAR",
    };
  }

  if (FIXED_BILL_KEYWORDS.some((kw) => upper.includes(kw))) {
    return {
      envelope: "fijo",
      needs_review: false,
      confidence: 0.94,
      reasoning: "Recibo o suministro domiciliado del hogar.",
      suggested_custom_code: "REC-HOGAR",
    };
  }

  if (
    upper.includes("FARMACIA") ||
    upper.includes("PEDIATRA") ||
    upper.includes("GASOLINERA") ||
    upper.includes("REPSOL") ||
    upper.includes("CEPSA")
  ) {
    return {
      envelope: "necesario",
      needs_review: false,
      confidence: 0.91,
      reasoning: "Gasto básico necesario familiar (salud / transporte).",
      suggested_custom_code: "NEC-BASICO",
    };
  }

  if (upper.includes("AHORRO") || upper.includes("FONDO INDEXADO")) {
    return {
      envelope: "ahorro",
      needs_review: false,
      confidence: 0.98,
      reasoning: "Aportación a la meta de ahorro familiar.",
      suggested_custom_code: "AHO-META",
    };
  }

  return {
    envelope: input.payerRole === "esposa" ? "libre_esposa" : "libre_esposo",
    needs_review: false,
    confidence: 0.8,
    reasoning: `Gasto discrecional asignado al sobre libre individual (${
      input.payerRole === "esposa" ? "Esposa" : "Esposo"
    }).`,
    suggested_custom_code:
      input.payerRole === "esposa" ? "LIB-ELLA" : "LIB-EL",
  };
}

/**
 * Clasifica uno o varios movimientos bancarios usando el SDK oficial `@google/genai`
 * con el modelo `gemini-2.5-flash`.
 */
export async function classifyTransactionsWithGemini(
  items: ClassificationInput[]
): Promise<ClassificationResult[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.includes("AIzaSy...")) {
    return items.map(fallbackRuleClassifier);
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    const prompt = `
Eres el motor de inteligencia artificial financiera para un matrimonio en España (esposo y esposa) con cuentas separadas pero presupuesto familiar unido.
Clasifica cada movimiento bancario siguiendo ESTRICTAMENTE estas reglas de negocio:
1. BARES, CAFETERÍAS, PANADERÍAS, PASTELERÍAS, HELADERÍAS, VENDING:
   - Asigna SIEMPRE envelope = "hormiga" y needs_review = false.
2. SUPERMERCADOS Y COMERCIOS MIXTOS (Mercadona, Carrefour, Lidl, Aldi, Consum, Dia, Alcampo, Hipercor, El Corte Inglés, etc.):
   - Asigna SIEMPRE envelope = "necesario" y needs_review = true (para enviarlo a la Bandeja de Confirmación de Supermercado donde el usuario elegirá en 1 toque entre Compra Necesaria, Gasto Hormiga o Mi Gasto Libre).
3. RECIBOS FIJOS DOMICILIADOS (Hipoteca, Alquiler, Luz, Agua, Gas, Fibra/Móvil, Seguros, Guardería/Colegio, Comunidad):
   - Asigna envelope = "fijo" y needs_review = false.
4. COMPRAS PERSONALES / OCIO INDIVIDUAL:
   - Si payerRole es "esposo", asigna envelope = "libre_esposo".
   - Si payerRole es "esposa", asigna envelope = "libre_esposa".
5. FARMACIA, SALUD, TRANSPORTE BÁSICO:
   - Asigna envelope = "necesario" y needs_review = false.
6. TRASPASOS A AHORRO / INVERSIÓN:
   - Asigna envelope = "ahorro" y needs_review = false.

Movimientos a clasificar:
${JSON.stringify(items, null, 2)}
`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              envelope: {
                type: Type.STRING,
                enum: [
                  "hormiga",
                  "libre_esposo",
                  "libre_esposa",
                  "libre_comun",
                  "necesario",
                  "fijo",
                  "ahorro",
                ],
              },
              needs_review: {
                type: Type.BOOLEAN,
              },
              confidence: {
                type: Type.NUMBER,
              },
              reasoning: {
                type: Type.STRING,
              },
              suggested_custom_code: {
                type: Type.STRING,
              },
            },
            required: [
              "envelope",
              "needs_review",
              "confidence",
              "reasoning",
              "suggested_custom_code",
            ],
          },
        },
      },
    });

    const rawText = response.text;
    if (!rawText) {
      return items.map(fallbackRuleClassifier);
    }

    const parsed = JSON.parse(rawText) as ClassificationResult[];
    return items.map((item, idx) => {
      const candidate = parsed[idx];
      if (!candidate) return fallbackRuleClassifier(item);

      // Garantizar invariante de supermercados y bares
      const upper = item.concept.toUpperCase();
      if (SUPERMARKET_KEYWORDS.some((kw) => upper.includes(kw))) {
        candidate.needs_review = true;
        candidate.envelope = "necesario";
      } else if (ANT_EXPENSE_KEYWORDS.some((kw) => upper.includes(kw))) {
        candidate.needs_review = false;
        candidate.envelope = "hormiga";
      }
      return candidate;
    });
  } catch (error) {
    console.error("Error en @google/genai gemini-2.5-flash, usando motor de reglas local:", error);
    return items.map(fallbackRuleClassifier);
  }
}
