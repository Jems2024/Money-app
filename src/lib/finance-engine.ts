import {
  AccountLiquidityMetrics,
  BankAccount,
  EnvelopeCategory,
  FamilyFinancialSummary,
  FixedBill,
  MonthlyEnvelopes,
  Profile,
  Transaction,
} from "@/types/finance";

export const INITIAL_PROFILES: Profile[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    display_name: "Carlos (Esposo)",
    avatar_color: "#2563eb",
    role: "esposo",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    display_name: "Elena (Esposa)",
    avatar_color: "#db2777",
    role: "esposa",
  },
];

export const INITIAL_BANK_ACCOUNTS: BankAccount[] = [
  {
    id: "aaaa1111-1111-4111-8111-111111111111",
    owner_user_id: "11111111-1111-4111-8111-111111111111",
    bank_name: "CaixaBank",
    account_alias: "Nómina Esposo (CaixaBank)",
    iban_masked: "ES91 2100 **** **** **** 4821",
    enable_banking_account_id: "eb-caixabank-esposo-001",
    current_balance: 2140.5,
    last_synced_at: "2026-11-16T21:15:00Z",
  },
  {
    id: "bbbb2222-2222-4222-8222-222222222222",
    owner_user_id: "22222222-2222-4222-8222-222222222222",
    bank_name: "BBVA",
    account_alias: "Nómina Esposa (BBVA)",
    iban_masked: "ES66 0182 **** **** **** 9034",
    enable_banking_account_id: "eb-bbva-esposa-002",
    current_balance: 1480.25,
    last_synced_at: "2026-11-16T21:18:00Z",
  },
];

export const INITIAL_MONTHLY_ENVELOPES: MonthlyEnvelopes = {
  id: "eeee0000-0000-4000-8000-000000002026",
  month_year: "2026-11",
  ant_expenses_limit: 180,
  husband_free_limit: 200,
  wife_free_limit: 200,
  shared_free_limit: 250,
  savings_goal: 600,
  groceries_limit: 550,
  notified_thresholds: {
    "hormiga:80": true,
  },
};

export const INITIAL_FIXED_BILLS: FixedBill[] = [
  {
    id: "f1111111-1111-4111-8111-111111111111",
    custom_code: "REC-HIPOTECA",
    name: "Hipoteca Vivienda Familiar",
    expected_amount: 785.0,
    charged_account_id: "aaaa1111-1111-4111-8111-111111111111",
    match_keyword: "PRESTAMO HIPOTECARIO",
    is_paid_this_month: true,
    paid_date: "2026-11-02",
    auto_matched: true,
  },
  {
    id: "f2222222-2222-4222-8222-222222222222",
    custom_code: "REC-LUZ",
    name: "Endesa Energía Luz",
    expected_amount: 94.5,
    charged_account_id: "aaaa1111-1111-4111-8111-111111111111",
    match_keyword: "ENDESA ENERGIA",
    is_paid_this_month: false,
    paid_date: null,
    auto_matched: false,
  },
  {
    id: "f3333333-3333-4333-8333-333333333333",
    custom_code: "REC-FIBRA",
    name: "Digi Fibra + 2 Móviles",
    expected_amount: 42.0,
    charged_account_id: "bbbb2222-2222-4222-8222-222222222222",
    match_keyword: "DIGI SPAIN TELECOM",
    is_paid_this_month: true,
    paid_date: "2026-11-05",
    auto_matched: true,
  },
  {
    id: "f4444444-4444-4444-8444-444444444444",
    custom_code: "REC-COMUNIDAD",
    name: "Comunidad de Propietarios",
    expected_amount: 85.0,
    charged_account_id: "aaaa1111-1111-4111-8111-111111111111",
    match_keyword: "COMUNIDAD PROP",
    is_paid_this_month: false,
    paid_date: null,
    auto_matched: false,
  },
  {
    id: "f5555555-5555-4555-8555-555555555555",
    custom_code: "REC-GUARDERIA",
    name: "Escuela Infantil / Comedor",
    expected_amount: 260.0,
    charged_account_id: "bbbb2222-2222-4222-8222-222222222222",
    match_keyword: "ESCUELA INFANTIL",
    is_paid_this_month: false,
    paid_date: null,
    auto_matched: false,
  },
  {
    id: "f6666666-6666-4666-8666-666666666666",
    custom_code: "REC-SEGURO-HOGAR",
    name: "Seguro Hogar Mapfre",
    expected_amount: 58.0,
    charged_account_id: "bbbb2222-2222-4222-8222-222222222222",
    match_keyword: "MAPFRE ESPAÑA",
    is_paid_this_month: false,
    paid_date: null,
    auto_matched: false,
  },
];

export const INITIAL_TRANSACTIONS: Transaction[] = [
  {
    id: "tx-001",
    bank_account_id: "aaaa1111-1111-4111-8111-111111111111",
    user_id: "11111111-1111-4111-8111-111111111111",
    external_tx_id: "EB-20261116-MERCADONA-01",
    custom_code: "POS-MERCADONA",
    date: "2026-11-16",
    concept: "MERCADONA S.A. AVDA EUROPA",
    amount: 96.4,
    type: "expense",
    envelope: "necesario",
    needs_review: true,
    ai_confidence: 0.65,
    ai_reasoning:
      "Supermercado mixto detectado: requiere confirmación de 1 toque (Compra Necesaria vs Hormiga / Libre).",
  },
  {
    id: "tx-002",
    bank_account_id: "bbbb2222-2222-4222-8222-222222222222",
    user_id: "22222222-2222-4222-8222-222222222222",
    external_tx_id: "EB-20261115-CARREFOUR-02",
    custom_code: "POS-CARREFOUR",
    date: "2026-11-15",
    concept: "CARREFOUR EXPRESS CENTRO",
    amount: 28.9,
    type: "expense",
    envelope: "necesario",
    needs_review: true,
    ai_confidence: 0.58,
    ai_reasoning:
      "Comercio mixto/supermercado rápido: confirmar si fue despensa necesaria o picoteo/gasto hormiga.",
  },
  {
    id: "tx-003",
    bank_account_id: "bbbb2222-2222-4222-8222-222222222222",
    user_id: "22222222-2222-4222-8222-222222222222",
    external_tx_id: "EB-20261114-LIDL-03",
    custom_code: "POS-LIDL",
    date: "2026-11-14",
    concept: "SUPERMERCADOS LIDL BAZAR",
    amount: 54.2,
    type: "expense",
    envelope: "necesario",
    needs_review: true,
    ai_confidence: 0.61,
    ai_reasoning:
      "Lidl incluye alimentación y bazar: pendiente de clasificar por Elena.",
  },
  {
    id: "tx-004",
    bank_account_id: "aaaa1111-1111-4111-8111-111111111111",
    user_id: "11111111-1111-4111-8111-111111111111",
    external_tx_id: "EB-20261114-CAFE-04",
    custom_code: "HOR-CAFETERIA",
    date: "2026-11-14",
    concept: "CAFETERIA PANADERIA GRANIER",
    amount: 14.8,
    type: "expense",
    envelope: "hormiga",
    needs_review: false,
    ai_confidence: 0.96,
    ai_reasoning: "Cafetería/Panadería asignada automáticamente a Gasto Hormiga.",
  },
  {
    id: "tx-005",
    bank_account_id: "bbbb2222-2222-4222-8222-222222222222",
    user_id: "22222222-2222-4222-8222-222222222222",
    external_tx_id: "EB-20261112-BAR-05",
    custom_code: "HOR-TAPAS",
    date: "2026-11-12",
    concept: "CERVECERIA LA SUREÑA",
    amount: 34.5,
    type: "expense",
    envelope: "hormiga",
    needs_review: false,
    ai_confidence: 0.95,
    ai_reasoning: "Bar/Cervecería detectado directamente como Gasto Hormiga.",
  },
  {
    id: "tx-006",
    bank_account_id: "aaaa1111-1111-4111-8111-111111111111",
    user_id: "11111111-1111-4111-8111-111111111111",
    external_tx_id: "EB-20261111-VENDING-06",
    custom_code: "HOR-CAFE-TRABAJO",
    date: "2026-11-11",
    concept: "STARBUCKS COFFEE ESPAÑA",
    amount: 99.2,
    type: "expense",
    envelope: "hormiga",
    needs_review: false,
    ai_confidence: 0.98,
    ai_reasoning: "Cafetería asignada a Gasto Hormiga.",
  },
  {
    id: "tx-007",
    bank_account_id: "aaaa1111-1111-4111-8111-111111111111",
    user_id: "11111111-1111-4111-8111-111111111111",
    external_tx_id: "EB-20261110-PADEL-07",
    custom_code: "LIB-PADEL-EL",
    date: "2026-11-10",
    concept: "CLUB PADEL INDOOR + EQUIPACION",
    amount: 142.0,
    type: "expense",
    envelope: "libre_esposo",
    needs_review: false,
  },
  {
    id: "tx-008",
    bank_account_id: "bbbb2222-2222-4222-8222-222222222222",
    user_id: "22222222-2222-4222-8222-222222222222",
    external_tx_id: "EB-20261109-ZARA-08",
    custom_code: "LIB-MODA-ELLA",
    date: "2026-11-09",
    concept: "ZARA ESPAÑA ONLINE",
    amount: 168.0,
    type: "expense",
    envelope: "libre_esposa",
    needs_review: false,
  },
  {
    id: "tx-009",
    bank_account_id: "aaaa1111-1111-4111-8111-111111111111",
    user_id: "11111111-1111-4111-8111-111111111111",
    external_tx_id: "EB-20261108-CONSUM-09",
    custom_code: "NEC-COMPRA-MES",
    date: "2026-11-08",
    concept: "CONSUM COOPERATIVA ALIMENTACION",
    amount: 285.0,
    type: "expense",
    envelope: "necesario",
    needs_review: false,
  },
  {
    id: "tx-010",
    bank_account_id: "bbbb2222-2222-4222-8222-222222222222",
    user_id: "22222222-2222-4222-8222-222222222222",
    external_tx_id: "EB-20261106-AHORRO-10",
    custom_code: "AHO-FONDO-COMUN",
    date: "2026-11-06",
    concept: "TRASPASO CUENTA AHORRO REMUNERADA",
    amount: 450.0,
    type: "expense",
    envelope: "ahorro",
    needs_review: false,
  },
  {
    id: "tx-011",
    bank_account_id: "aaaa1111-1111-4111-8111-111111111111",
    user_id: "11111111-1111-4111-8111-111111111111",
    external_tx_id: "EB-20261102-HIPOTECA-11",
    custom_code: "REC-HIPOTECA",
    date: "2026-11-02",
    concept: "PRESTAMO HIPOTECARIO VIVIENDA",
    amount: 785.0,
    type: "expense",
    envelope: "fijo",
    needs_review: false,
    linked_bill_id: "f1111111-1111-4111-8111-111111111111",
  },
];

/**
 * Calcula las métricas financieras exactas según las reglas de negocio de SKILL.md:
 * 1. Dinero Real Libre Familiar = (Suma de current_balance de ambas cuentas) - (Suma de fixed_bills pendientes de ambos) - savings_goal
 * 2. Liquidez por Cuenta Individual = Saldo Cuenta X - Recibos Fijos Pendientes domiciliados en la Cuenta X
 * 3. Progreso de Sobres Dinámicos y alertas al 80% y 100%
 */
export function computeFamilyFinancialSummary(
  profiles: Profile[],
  accounts: BankAccount[],
  envelopes: MonthlyEnvelopes,
  fixedBills: FixedBill[],
  transactions: Transaction[]
): FamilyFinancialSummary {
  const husbandProfile =
    profiles.find((p) => p.role === "esposo") || INITIAL_PROFILES[0];
  const wifeProfile =
    profiles.find((p) => p.role === "esposa") || INITIAL_PROFILES[1];

  const husbandAccount =
    accounts.find((a) => a.owner_user_id === husbandProfile.id) ||
    INITIAL_BANK_ACCOUNTS[0];
  const wifeAccount =
    accounts.find((a) => a.owner_user_id === wifeProfile.id) ||
    INITIAL_BANK_ACCOUNTS[1];

  const computeAccountMetrics = (
    account: BankAccount,
    ownerProfile: Profile
  ): AccountLiquidityMetrics => {
    const accountBills = fixedBills.filter(
      (b) => b.charged_account_id === account.id
    );
    const pendingBillsTotal = accountBills
      .filter((b) => !b.is_paid_this_month)
      .reduce((acc, b) => acc + Number(b.expected_amount), 0);
    const paidBillsTotal = accountBills
      .filter((b) => b.is_paid_this_month)
      .reduce((acc, b) => acc + Number(b.expected_amount), 0);

    const realFreeLiquidity = Number(account.current_balance) - pendingBillsTotal;
    const hasOverdraftRisk = realFreeLiquidity < 0;
    const shortfallAmount = hasOverdraftRisk ? Math.abs(realFreeLiquidity) : 0;

    return {
      account,
      ownerProfile,
      pendingBillsTotal,
      paidBillsTotal,
      realFreeLiquidity,
      hasOverdraftRisk,
      shortfallAmount,
      accountBills,
    };
  };

  const husbandMetrics = computeAccountMetrics(husbandAccount, husbandProfile);
  const wifeMetrics = computeAccountMetrics(wifeAccount, wifeProfile);

  const totalCombinedBalance =
    Number(husbandAccount.current_balance) + Number(wifeAccount.current_balance);

  const totalPendingBills = fixedBills
    .filter((b) => !b.is_paid_this_month)
    .reduce((acc, b) => acc + Number(b.expected_amount), 0);

  const totalPaidBills = fixedBills
    .filter((b) => b.is_paid_this_month)
    .reduce((acc, b) => acc + Number(b.expected_amount), 0);

  const savingsGoal = Number(envelopes.savings_goal);

  // Fórmula exacta de SKILL.md:
  // Dinero Real Libre Familiar = (Saldo Cuenta Esposo + Saldo Cuenta Esposa) - Total Recibos Fijos Pendientes de ambos - Meta de Ahorro Familiar del Mes
  const familyRealFreeMoney =
    totalCombinedBalance - totalPendingBills - savingsGoal;

  // Cálculo de acumulados en sobres (solo gastos confirmados, Needs Review se suma tras confirmar o también en su sobre provisional)
  const confirmedExpenses = transactions.filter(
    (t) => t.type === "expense" && !t.needs_review
  );

  const sumByEnvelope = (env: EnvelopeCategory) =>
    confirmedExpenses
      .filter((t) => t.envelope === env)
      .reduce((acc, t) => acc + Number(t.amount), 0);

  const buildEnvelopeItem = (
    key: EnvelopeCategory,
    label: string,
    subtitle: string,
    limit: number,
    ownerRole?: "esposo" | "esposa" | "comun"
  ) => {
    const spent = sumByEnvelope(key);
    const safeLimit = limit > 0 ? limit : 1;
    const percentage = Math.round((spent / safeLimit) * 100);
    const status: "safe" | "warning80" | "exceeded100" =
      percentage >= 100 ? "exceeded100" : percentage >= 80 ? "warning80" : "safe";

    return {
      key,
      label,
      subtitle,
      spent,
      limit,
      percentage,
      status,
      ownerRole,
    };
  };

  const envelopeUsage = [
    buildEnvelopeItem(
      "hormiga",
      "Gastos Hormiga",
      "Bares, cafeterías, panaderías y caprichos pequeños",
      envelopes.ant_expenses_limit,
      "comun"
    ),
    buildEnvelopeItem(
      "libre_esposo",
      "Gasto Libre Esposo",
      `Ocio y compras personales de ${husbandProfile.display_name.split(" ")[0]}`,
      envelopes.husband_free_limit,
      "esposo"
    ),
    buildEnvelopeItem(
      "libre_esposa",
      "Gasto Libre Esposa",
      `Ocio y compras personales de ${wifeProfile.display_name.split(" ")[0]}`,
      envelopes.wife_free_limit,
      "esposa"
    ),
    buildEnvelopeItem(
      "necesario",
      "Supermercado / Necesarios",
      "Alimentación del hogar, farmacia y suministros básicos",
      envelopes.groceries_limit,
      "comun"
    ),
    buildEnvelopeItem(
      "libre_comun",
      "Ocio Libre Común",
      "Planes en pareja, salidas familiares y escapadas",
      envelopes.shared_free_limit,
      "comun"
    ),
    buildEnvelopeItem(
      "ahorro",
      "Meta de Ahorro Familiar",
      "Aportación al colchón familiar este mes",
      envelopes.savings_goal,
      "comun"
    ),
  ];

  return {
    totalCombinedBalance,
    totalPendingBills,
    totalPaidBills,
    savingsGoal,
    familyRealFreeMoney,
    husbandMetrics,
    wifeMetrics,
    envelopeUsage,
  };
}

/**
 * Concilia automáticamente un movimiento bancario con la lista de recibos fijos pendientes (`fixed_bills`)
 */
export function matchTransactionToFixedBill(
  concept: string,
  amount: number,
  bankAccountId: string,
  fixedBills: FixedBill[]
): FixedBill | null {
  const normalizedConcept = concept.toUpperCase().trim();

  for (const bill of fixedBills) {
    if (bill.is_paid_this_month) continue;
    if (bill.charged_account_id !== bankAccountId) continue;

    const keyword = bill.match_keyword.toUpperCase().trim();
    const keywordMatch =
      keyword.length > 0 && normalizedConcept.includes(keyword);
    const codeMatch = normalizedConcept.includes(
      bill.custom_code.toUpperCase().trim()
    );

    // Tolerancia del 12% para recibos variables como luz, o coincidencia exacta por palabra clave
    const amountDiffRatio =
      bill.expected_amount > 0
        ? Math.abs(amount - bill.expected_amount) / bill.expected_amount
        : 1;

    if ((keywordMatch || codeMatch) && amountDiffRatio <= 0.25) {
      return bill;
    }
  }

  return null;
}
