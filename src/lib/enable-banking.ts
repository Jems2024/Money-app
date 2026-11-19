import { importPKCS8, SignJWT } from "jose";
import { FamilyRole } from "@/types/finance";

const ENABLE_BANKING_BASE_URL = "https://api.enablebanking.com";

export interface SpanishBankASPSP {
  name: string;
  country: "ES";
  bic: string;
  logoColor: string;
}

export const SPANISH_BANKS_PSD2: SpanishBankASPSP[] = [
  { name: "CaixaBank", country: "ES", bic: "CAIXESBBXXX", logoColor: "#007eae" },
  { name: "BBVA", country: "ES", bic: "BBVAESMMXXX", logoColor: "#004481" },
  { name: "Banco Santander", country: "ES", bic: "BSCHESMMXXX", logoColor: "#ec0000" },
  { name: "Banco Sabadell", country: "ES", bic: "BSABESBBXXX", logoColor: "#006dff" },
  { name: "ING España", country: "ES", bic: "INGDESMMXXX", logoColor: "#ff6200" },
  { name: "Bankinter", country: "ES", bic: "BKBKESMMXXX", logoColor: "#ff7300" },
  { name: "Openbank", country: "ES", bic: "OPENESMMXXX", logoColor: "#e6004c" },
  { name: "Unicaja Banco", country: "ES", bic: "UCJAES2MXXX", logoColor: "#289948" },
];

export function isEnableBankingConfigured(): boolean {
  const appId = process.env.ENABLE_BANKING_APP_ID;
  const privateKey = process.env.ENABLE_BANKING_PRIVATE_KEY;
  return Boolean(
    appId &&
      privateKey &&
      !appId.includes("tu-application-id") &&
      privateKey.includes("BEGIN PRIVATE KEY")
  );
}

/**
 * Genera el JWT firmado con RS256 requerido por Enable Banking PSD2 API
 */
export async function createEnableBankingJWT(): Promise<string> {
  const appId = process.env.ENABLE_BANKING_APP_ID!;
  const rawPem = process.env.ENABLE_BANKING_PRIVATE_KEY!.replace(/\\n/g, "\n");

  const privateKey = await importPKCS8(rawPem, "RS256");
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    iss: "enablebanking.com",
    aud: "api.enablebanking.com",
    iat: now,
    exp: now + 3600,
  })
    .setProtectedHeader({
      typ: "JWT",
      alg: "RS256",
      kid: appId,
    })
    .sign(privateKey);
}

/**
 * Inicia el flujo PSD2 en Enable Banking para vincular la cuenta bancaria del Esposo o la Esposa
 */
export async function startEnableBankingAuth(params: {
  aspspName: string;
  userId: string;
  role: FamilyRole;
  redirectBaseUrl: string;
}) {
  const statePayload = Buffer.from(
    JSON.stringify({
      userId: params.userId,
      role: params.role,
      aspspName: params.aspspName,
      ts: Date.now(),
    })
  ).toString("base64url");

  if (!isEnableBankingConfigured()) {
    // Modo Sandbox Interactivo Gratuito cuando aún no se ha cargado el certificado PEM PSD2
    return {
      mode: "sandbox" as const,
      url: `${params.redirectBaseUrl}/api/enable-banking/callback?code=SANDBOX_PSD2_CODE_${params.role.toUpperCase()}&state=${statePayload}`,
      state: statePayload,
    };
  }

  const jwt = await createEnableBankingJWT();
  const validUntil = new Date(Date.now() + 89 * 24 * 60 * 60 * 1000).toISOString();

  const response = await fetch(`${ENABLE_BANKING_BASE_URL}/auth`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      access: {
        valid_until: validUntil,
        balances: true,
        transactions: true,
      },
      aspsp: {
        name: params.aspspName,
        country: "ES",
      },
      state: statePayload,
      redirect_url: `${params.redirectBaseUrl}/api/enable-banking/callback`,
      psu_type: "personal",
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Error PSD2 Enable Banking (${response.status}): ${errText}`);
  }

  const data = (await response.json()) as { url: string };
  return {
    mode: "live" as const,
    url: data.url,
    state: statePayload,
  };
}

/**
 * Autoriza la sesión en Enable Banking tras el callback OAuth2 del banco (`POST /sessions`)
 */
export async function exchangeEnableBankingCode(code: string) {
  if (!isEnableBankingConfigured() || code.startsWith("SANDBOX_PSD2_CODE")) {
    const isWife = code.includes("ESPOSA");
    return {
      session_id: `eb-session-${Date.now()}`,
      accounts: [
        {
          uid: isWife
            ? "eb-caixabank-esposa-live"
            : "eb-caixabank-esposo-live",
          iban: isWife
            ? "ES66 0182 **** **** **** 9034"
            : "ES91 2100 **** **** **** 4821",
          name: isWife ? "Cuenta Nómina Ella" : "Cuenta Nómina Él",
          balance: isWife ? 1560.4 : 2290.8,
        },
      ],
    };
  }

  const jwt = await createEnableBankingJWT();
  const response = await fetch(`${ENABLE_BANKING_BASE_URL}/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Error creando sesión PSD2 (${response.status}): ${errText}`);
  }

  const sessionData = await response.json();
  return {
    session_id: sessionData.session_id as string,
    accounts: (sessionData.accounts || []).map((acc: Record<string, unknown>) => ({
      uid: String(acc.uid || acc.resource_id || ""),
      iban: String(
        (acc.account_id as Record<string, unknown>)?.iban || "ES** **** **** ****"
      ),
      name: String(acc.name || acc.product || "Cuenta PSD2"),
      balance: 0,
    })),
  };
}

/**
 * Descarga saldo actual y últimos movimientos desde Enable Banking PSD2 para una cuenta vinculada
 */
export async function fetchEnableBankingAccountSync(
  enableBankingAccountId: string,
  role: FamilyRole
) {
  if (!isEnableBankingConfigured() || enableBankingAccountId.startsWith("eb-")) {
    const today = new Date().toISOString().slice(0, 10);
    return {
      currentBalance: role === "esposa" ? 1545.8 : 2215.4,
      transactions:
        role === "esposa"
          ? [
              {
                external_tx_id: `EB-SYNC-${Date.now()}-1`,
                date: today,
                concept: "MERCADONA COMPRA SEMANAL",
                amount: 64.3,
                type: "expense" as const,
              },
              {
                external_tx_id: `EB-SYNC-${Date.now()}-2`,
                date: today,
                concept: "CAFETERIA PANADERIA TURRIS",
                amount: 8.4,
                type: "expense" as const,
              },
            ]
          : [
              {
                external_tx_id: `EB-SYNC-${Date.now()}-3`,
                date: today,
                concept: "ENDESA ENERGIA FACTURA LUZ",
                amount: 94.5,
                type: "expense" as const,
              },
              {
                external_tx_id: `EB-SYNC-${Date.now()}-4`,
                date: today,
                concept: "CARREFOUR MARKET",
                amount: 41.2,
                type: "expense" as const,
              },
            ],
    };
  }

  const jwt = await createEnableBankingJWT();

  const [balRes, txRes] = await Promise.all([
    fetch(
      `${ENABLE_BANKING_BASE_URL}/accounts/${enableBankingAccountId}/balances`,
      {
        headers: { Authorization: `Bearer ${jwt}` },
      }
    ),
    fetch(
      `${ENABLE_BANKING_BASE_URL}/accounts/${enableBankingAccountId}/transactions`,
      {
        headers: { Authorization: `Bearer ${jwt}` },
      }
    ),
  ]);

  let currentBalance = 0;
  if (balRes.ok) {
    const balJson = await balRes.json();
    const firstBal = balJson.balances?.[0];
    currentBalance = Number(firstBal?.balance_amount?.amount || 0);
  }

  const transactions: {
    external_tx_id: string;
    date: string;
    concept: string;
    amount: number;
    type: "income" | "expense";
  }[] = [];

  if (txRes.ok) {
    const txJson = await txRes.json();
    for (const rawTx of txJson.transactions || []) {
      const signedAmount = Number(rawTx.transaction_amount?.amount || 0);
      const isCredit =
        rawTx.credit_debit_indicator === "CRDT" || signedAmount > 0;
      transactions.push({
        external_tx_id: String(
          rawTx.entry_reference || rawTx.transaction_id || `${Date.now()}-${Math.random()}`
        ),
        date: String(rawTx.booking_date || rawTx.value_date || new Date().toISOString().slice(0, 10)),
        concept: String(
          rawTx.remittance_information?.[0] ||
            rawTx.creditor?.name ||
            rawTx.debtor?.name ||
            "Movimiento Bancario PSD2"
        ),
        amount: Math.abs(signedAmount),
        type: isCredit ? "income" : "expense",
      });
    }
  }

  return { currentBalance, transactions };
}
