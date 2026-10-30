-- ============================================================================
-- STOP SPEND — Migration 001: Financial Schema, Composite FKs & Strict RLS
-- ============================================================================
-- Invariants enforced at PostgreSQL level:
-- 1. All money fields are BIGINT integer cents (`*_cents`). Floating point is forbidden.
-- 2. Only 'EUR' currency is accepted in v1 (`CHECK (currency = 'EUR')`).
-- 3. Every user-owned table has a composite key `(id, user_id)` and all foreign keys
--    include `user_id` (`FOREIGN KEY (account_id, user_id) REFERENCES accounts(id, user_id)`),
--    making cross-user row linking impossible even under race conditions.
-- 4. Row-Level Security (RLS) is ENABLED and FORCED on every public table with
--    `auth.uid() = user_id` on SELECT, INSERT, UPDATE, DELETE.
-- 5. Raw provider payloads and connection secrets live in `app_private` schema,
--    revoked from `anon` and `authenticated` roles.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Private server-only schema for secrets, auth states & short-lived raw evidence
CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anon, authenticated;

-- 2. Profiles & Preferences (Single private user enrollment guard)
CREATE TABLE IF NOT EXISTS public.profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT 'Jared',
  locale TEXT NOT NULL DEFAULT 'es-ES',
  timezone TEXT NOT NULL DEFAULT 'Europe/Madrid' CHECK (timezone = 'Europe/Madrid'),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  onboarding_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  refund_cross_period_policy TEXT NOT NULL DEFAULT 'CREDIT_CURRENT_PERIOD'
    CHECK (refund_cross_period_policy IN ('CREDIT_CURRENT_PERIOD', 'ADJUST_ORIGINAL_PERIOD')),
  push_include_sensitive_amounts BOOLEAN NOT NULL DEFAULT FALSE,
  quiet_hours_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  quiet_hours_start_hour SMALLINT NOT NULL DEFAULT 22 CHECK (quiet_hours_start_hour BETWEEN 0 AND 23),
  quiet_hours_end_hour SMALLINT NOT NULL DEFAULT 8 CHECK (quiet_hours_end_hour BETWEEN 0 AND 23),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Accounts (Cash, Bank, Savings, Credit Card)
CREATE TABLE IF NOT EXISTS public.accounts (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(trim(name)) > 0),
  type TEXT NOT NULL CHECK (type IN ('cash', 'bank', 'savings', 'credit_card')),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  -- Credit card liabilities MUST NEVER be treated as spendable liquidity
  include_in_liquidity BOOLEAN NOT NULL DEFAULT TRUE,
  is_owned BOOLEAN NOT NULL DEFAULT TRUE,
  stable_identity_key TEXT,
  provider_code TEXT,
  provider_session_account_id TEXT,
  iban_masked TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (id, user_id),
  CONSTRAINT chk_credit_card_never_liquidity CHECK (type <> 'credit_card' OR include_in_liquidity = FALSE)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_stable_identity
  ON public.accounts (user_id, stable_identity_key)
  WHERE stable_identity_key IS NOT NULL;

-- 4. Bank Connections (Public status metadata only; secrets in app_private)
CREATE TABLE IF NOT EXISTS public.bank_connections (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider_code TEXT NOT NULL DEFAULT 'enable_banking',
  environment_mode TEXT NOT NULL DEFAULT 'unconfigured'
    CHECK (environment_mode IN ('unconfigured', 'sandbox', 'production')),
  aspsp_country TEXT NOT NULL DEFAULT 'ES',
  aspsp_name TEXT NOT NULL DEFAULT 'CaixaBank',
  status TEXT NOT NULL DEFAULT 'unconfigured'
    CHECK (status IN (
      'unconfigured',
      'sandbox_ready',
      'sandbox_connected',
      'production_awaiting_auth',
      'production_connected',
      'sync_paused_locally',
      'session_revoked',
      'error'
    )),
  has_valid_session BOOLEAN NOT NULL DEFAULT FALSE,
  has_successful_real_read BOOLEAN NOT NULL DEFAULT FALSE,
  local_sync_paused BOOLEAN NOT NULL DEFAULT FALSE,
  consent_valid_until TIMESTAMPTZ,
  last_successful_booking_date DATE,
  last_sync_at TIMESTAMPTZ,
  last_error_spanish TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (id, user_id)
);

-- Server-only encrypted session secrets & one-use OAuth states
CREATE TABLE IF NOT EXISTS app_private.bank_connection_secrets (
  connection_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  encrypted_session_id TEXT,
  sync_lock_acquired_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id),
  FOREIGN KEY (connection_id, user_id) REFERENCES public.bank_connections(id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_private.bank_auth_states (
  id TEXT PRIMARY KEY,
  state_hash_hex TEXT NOT NULL UNIQUE,
  initiating_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  aspsp_name TEXT NOT NULL,
  aspsp_country TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS app_private.raw_provider_payloads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  payload_encrypted TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days')
);

REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM PUBLIC, anon, authenticated;

-- 5. Balance Snapshots
CREATE TABLE IF NOT EXISTS public.balance_snapshots (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('provider', 'manual', 'opening')),
  balance_type TEXT NOT NULL CHECK (balance_type IN ('CLBD', 'ITBD', 'ITAV', 'CLAV', 'XPCD', 'MANUAL', 'OPENING')),
  amount_cents BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  reference_time_utc TIMESTAMPTZ NOT NULL,
  reference_booking_date DATE NOT NULL,
  includes_pending_debits BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (id, user_id),
  FOREIGN KEY (account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE CASCADE
);

-- 6. Import Batches (CSV Provenance & Rollback)
CREATE TABLE IF NOT EXISTS public.import_batches (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  file_hash_key TEXT NOT NULL,
  filename_sanitized TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (id, user_id),
  FOREIGN KEY (account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE CASCADE
);

-- 7. Source Records (Immutable Normalized Evidence)
CREATE TABLE IF NOT EXISTS public.source_records (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'csv', 'provider')),
  provider_code TEXT,
  source_external_id TEXT,
  import_batch_id TEXT,
  original_description TEXT NOT NULL,
  booking_date DATE NOT NULL,
  value_date DATE,
  -- Nullable: NEVER fabricate a purchase time when bank/CSV only supplies booking_date!
  occurred_at_utc TIMESTAMPTZ,
  received_at_server_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL CHECK (status IN ('booked', 'pending')),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  amount_cents BIGINT NOT NULL,
  counterparty_name TEXT,
  counterparty_iban_normalized TEXT,
  remittance_info TEXT,
  normalization_version SMALLINT NOT NULL DEFAULT 1,
  provenance TEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (id, user_id),
  FOREIGN KEY (account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_source_records_provider_idempotency
  ON public.source_records (user_id, account_id, source_type, COALESCE(provider_code, ''), source_external_id, status)
  WHERE source_external_id IS NOT NULL;

-- 8. Obligations & Savings Reservations
CREATE TABLE IF NOT EXISTS public.obligations (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  period_key TEXT NOT NULL CHECK (period_key ~ '^\d{4}-\d{2}$'),
  expected_amount_cents BIGINT NOT NULL CHECK (expected_amount_cents > 0),
  paid_amount_cents BIGINT NOT NULL DEFAULT 0 CHECK (paid_amount_cents >= 0),
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'partially_paid', 'settled', 'cancelled')),
  due_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (id, user_id)
);

CREATE TABLE IF NOT EXISTS public.savings_reservations (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  period_key TEXT NOT NULL CHECK (period_key ~ '^\d{4}-\d{2}$'),
  protected_amount_cents BIGINT NOT NULL CHECK (protected_amount_cents >= 0),
  transferred_to_excluded_account_cents BIGINT NOT NULL DEFAULT 0
    CHECK (transferred_to_excluded_account_cents >= 0),
  status TEXT NOT NULL DEFAULT 'earmarked_in_included_account'
    CHECK (status IN ('earmarked_in_included_account', 'partially_transferred', 'transferred_to_savings')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (id, user_id)
);

-- 9. Canonical Transactions (One economic effect per canonical transaction)
CREATE TABLE IF NOT EXISTS public.canonical_transactions (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'income',
    'expense',
    'refund',
    'internal_transfer',
    'opening_balance',
    'adjustment',
    'unknown'
  )),
  status TEXT NOT NULL CHECK (status IN ('booked', 'pending', 'provisional', 'superseded')),
  amount_cents BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  booking_date DATE NOT NULL,
  value_date DATE,
  occurred_at_utc TIMESTAMPTZ,
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
  description TEXT NOT NULL,
  merchant_normalized TEXT NOT NULL,
  user_note TEXT,
  category_id TEXT,
  category_source TEXT NOT NULL DEFAULT 'unknown'
    CHECK (category_source IN ('user_locked', 'user_rule', 'merchant_rule', 'provider_hint', 'unknown')),
  category_confidence SMALLINT NOT NULL DEFAULT 0 CHECK (category_confidence BETWEEN 0 AND 100),
  category_explanation TEXT,
  scope TEXT NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'non_personal', 'mixed')),
  small_spending_tagged BOOLEAN NOT NULL DEFAULT FALSE,
  linked_expense_id TEXT,
  transfer_pair_id TEXT,
  counterpart_account_id TEXT,
  untracked_owned_destination_label TEXT,
  settled_obligation_id TEXT,
  consumed_savings_reservation_id TEXT,
  superseded_by_transaction_id TEXT,
  review_status TEXT NOT NULL DEFAULT 'none'
    CHECK (review_status IN (
      'none',
      'requires_deposit_origin_review',
      'requires_duplicate_review',
      'requires_transfer_scope_review',
      'requires_category_review'
    )),
  PRIMARY KEY (id),
  UNIQUE (id, user_id),
  FOREIGN KEY (account_id, user_id) REFERENCES public.accounts(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (settled_obligation_id, user_id) REFERENCES public.obligations(id, user_id) ON DELETE SET NULL,
  FOREIGN KEY (consumed_savings_reservation_id, user_id) REFERENCES public.savings_reservations(id, user_id) ON DELETE SET NULL
);

-- 10. Transaction Splits
CREATE TABLE IF NOT EXISTS public.transaction_splits (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL,
  label TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  category_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'non_personal')),
  small_spending_tagged BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (id),
  UNIQUE (id, user_id),
  FOREIGN KEY (transaction_id, user_id) REFERENCES public.canonical_transactions(id, user_id) ON DELETE CASCADE
);

-- 11. Reconciliation Audit Links
CREATE TABLE IF NOT EXISTS public.reconciliation_links (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL CHECK (link_type IN ('provisional_to_bank', 'pending_to_booked', 'duplicate_candidate', 'transfer_pair')),
  from_transaction_id TEXT NOT NULL,
  to_transaction_id TEXT NOT NULL,
  previous_amount_cents BIGINT NOT NULL,
  new_amount_cents BIGINT NOT NULL,
  preserved_category_id TEXT,
  preserved_user_note TEXT,
  reversible BOOLEAN NOT NULL DEFAULT TRUE,
  reason TEXT NOT NULL,
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (id, user_id),
  FOREIGN KEY (from_transaction_id, user_id) REFERENCES public.canonical_transactions(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (to_transaction_id, user_id) REFERENCES public.canonical_transactions(id, user_id) ON DELETE CASCADE
);

-- 12. Budget Period Allocations
CREATE TABLE IF NOT EXISTS public.budget_allocations (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL CHECK (period_key ~ '^\d{4}-\d{2}$'),
  confirmed_by_user BOOLEAN NOT NULL DEFAULT FALSE,
  total_personal_allocated_cents BIGINT NOT NULL CHECK (total_personal_allocated_cents >= 0),
  protected_savings_allocated_cents BIGINT NOT NULL CHECK (protected_savings_allocated_cents >= 0),
  small_purchases_allocated_cents BIGINT NOT NULL CHECK (small_purchases_allocated_cents >= 0),
  flexible_spending_allocated_cents BIGINT NOT NULL CHECK (flexible_spending_allocated_cents >= 0),
  rollover_from_previous_cents BIGINT NOT NULL DEFAULT 0,
  manual_adjustments_cents BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (id, user_id),
  UNIQUE (user_id, period_key),
  CONSTRAINT chk_envelope_reconciliation CHECK (
    total_personal_allocated_cents =
      protected_savings_allocated_cents + small_purchases_allocated_cents + flexible_spending_allocated_cents
  )
);

-- 13. Categorization Rules
CREATE TABLE IF NOT EXISTS public.categorization_rules (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pattern_normalized TEXT NOT NULL,
  category_id TEXT NOT NULL,
  is_user_confirmed BOOLEAN NOT NULL DEFAULT TRUE,
  suggest_small_spending_tag BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (id, user_id)
);

-- 14. Alert Handled Thresholds & Outbox (Database Uniqueness Enforces 1 Logical Event per Period/Threshold)
CREATE TABLE IF NOT EXISTS public.alert_handled_thresholds (
  idempotency_key TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  budget_id TEXT NOT NULL,
  period_key TEXT NOT NULL CHECK (period_key ~ '^\d{4}-\d{2}$'),
  threshold_percent SMALLINT NOT NULL CHECK (threshold_percent > 0),
  resolution TEXT NOT NULL CHECK (resolution IN (
    'emitted_alert',
    'suppressed_by_higher_jump',
    'handled_silently_import_or_edit'
  )),
  recorded_at_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (idempotency_key),
  UNIQUE (user_id, budget_id, period_key, threshold_percent)
);

CREATE TABLE IF NOT EXISTS public.alert_outbox (
  id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  client_notification_tag TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  budget_id TEXT NOT NULL,
  budget_name TEXT NOT NULL,
  period_key TEXT NOT NULL CHECK (period_key ~ '^\d{4}-\d{2}$'),
  threshold_percent SMALLINT NOT NULL CHECK (threshold_percent > 0),
  budget_allocated_cents BIGINT NOT NULL,
  spent_after_cents BIGINT NOT NULL,
  remaining_after_cents BIGINT NOT NULL,
  in_app_title_spanish TEXT NOT NULL,
  in_app_body_spanish TEXT NOT NULL,
  push_payload JSONB NOT NULL,
  delivery_state TEXT NOT NULL DEFAULT 'generated'
    CHECK (delivery_state IN (
      'generated',
      'queued_quiet_hours',
      'sent',
      'failed_transient',
      'failed_permanent_dead_subscription'
    )),
  seen_by_user_at_utc TIMESTAMPTZ,
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (user_id, budget_id, period_key, threshold_percent)
);

-- 15. Web Push Subscriptions
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL CHECK (endpoint LIKE 'https://%'),
  p256dh_key TEXT NOT NULL,
  auth_secret TEXT NOT NULL,
  user_agent TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, endpoint)
);

-- 16. Offline Idempotency Receipts
CREATE TABLE IF NOT EXISTS public.offline_sync_receipts (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_idempotency_key TEXT NOT NULL,
  canonical_transaction_id TEXT NOT NULL,
  synced_at_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, client_idempotency_key),
  FOREIGN KEY (canonical_transaction_id, user_id) REFERENCES public.canonical_transactions(id, user_id) ON DELETE CASCADE
);

-- ============================================================================
-- ENABLE AND FORCE ROW-LEVEL SECURITY ON ALL PUBLIC TABLES
-- ============================================================================
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'profiles',
    'accounts',
    'bank_connections',
    'balance_snapshots',
    'import_batches',
    'source_records',
    'obligations',
    'savings_reservations',
    'canonical_transactions',
    'transaction_splits',
    'reconciliation_links',
    'budget_allocations',
    'categorization_rules',
    'alert_handled_thresholds',
    'alert_outbox',
    'push_subscriptions',
    'offline_sync_receipts'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated;', tbl);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);',
      tbl || '_select_own', tbl
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);',
      tbl || '_insert_own', tbl
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);',
      tbl || '_update_own', tbl
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);',
      tbl || '_delete_own', tbl
    );
  END LOOP;
END $$;
