export type FamilyRole = "esposo" | "esposa";

export type TransactionType = "income" | "expense";

export type EnvelopeCategory =
  | "hormiga"
  | "libre_esposo"
  | "libre_esposa"
  | "libre_comun"
  | "necesario"
  | "fijo"
  | "ahorro";

export type DashboardViewTab = "familiar" | "esposo" | "esposa";

export interface Profile {
  id: string;
  display_name: string;
  avatar_color: string;
  role: FamilyRole;
}

export interface BankAccount {
  id: string;
  owner_user_id: string;
  bank_name: string;
  account_alias: string;
  iban_masked: string;
  enable_banking_account_id?: string | null;
  enable_banking_session_id?: string | null;
  current_balance: number;
  last_synced_at: string;
}

export interface MonthlyEnvelopes {
  id: string;
  month_year: string;
  ant_expenses_limit: number;
  husband_free_limit: number;
  wife_free_limit: number;
  shared_free_limit: number;
  savings_goal: number;
  groceries_limit: number;
  notified_thresholds?: Record<string, boolean>;
}

export interface FixedBill {
  id: string;
  custom_code: string;
  name: string;
  expected_amount: number;
  charged_account_id: string;
  match_keyword: string;
  is_paid_this_month: boolean;
  paid_date?: string | null;
  auto_matched: boolean;
}

export interface Transaction {
  id: string;
  bank_account_id: string;
  user_id: string;
  external_tx_id?: string | null;
  custom_code?: string | null;
  date: string;
  concept: string;
  amount: number;
  type: TransactionType;
  envelope: EnvelopeCategory;
  needs_review: boolean;
  linked_bill_id?: string | null;
  ai_confidence?: number;
  ai_reasoning?: string;
}

export interface PushSubscriptionRecord {
  id: string;
  user_id: string;
  device_name: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface AccountLiquidityMetrics {
  account: BankAccount;
  ownerProfile: Profile;
  pendingBillsTotal: number;
  paidBillsTotal: number;
  realFreeLiquidity: number;
  hasOverdraftRisk: boolean;
  shortfallAmount: number;
  accountBills: FixedBill[];
}

export interface FamilyFinancialSummary {
  totalCombinedBalance: number;
  totalPendingBills: number;
  totalPaidBills: number;
  savingsGoal: number;
  familyRealFreeMoney: number;
  husbandMetrics: AccountLiquidityMetrics;
  wifeMetrics: AccountLiquidityMetrics;
  envelopeUsage: {
    key: EnvelopeCategory;
    label: string;
    subtitle: string;
    spent: number;
    limit: number;
    percentage: number;
    status: "safe" | "warning80" | "exceeded100";
    ownerRole?: FamilyRole | "comun";
  }[];
}
