-- ============================================================================
-- STOP SPEND — Migration 002: Safe Atomic RPCs, Retention & Scheduled Jobs
-- ============================================================================

-- 1. Atomic obligation payment settlement (SECURITY INVOKER, fixed search_path)
CREATE OR REPLACE FUNCTION public.settle_obligation_atomic(
  p_obligation_id TEXT,
  p_transaction_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_tx_amount BIGINT;
  v_expected BIGINT;
  v_paid BIGINT;
  v_new_paid BIGINT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED';
  END IF;

  SELECT abs(amount_cents) INTO v_tx_amount
  FROM public.canonical_transactions
  WHERE id = p_transaction_id AND user_id = v_user_id;

  IF v_tx_amount IS NULL OR v_tx_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_TRANSACTION_FOR_OBLIGATION';
  END IF;

  SELECT expected_amount_cents, paid_amount_cents
  INTO v_expected, v_paid
  FROM public.obligations
  WHERE id = p_obligation_id AND user_id = v_user_id
  FOR UPDATE;

  IF v_expected IS NULL THEN
    RAISE EXCEPTION 'OBLIGATION_NOT_FOUND';
  END IF;

  v_new_paid := v_paid + v_tx_amount;

  UPDATE public.obligations
  SET paid_amount_cents = v_new_paid,
      status = CASE WHEN v_new_paid >= v_expected THEN 'settled' ELSE 'partially_paid' END
  WHERE id = p_obligation_id AND user_id = v_user_id;

  UPDATE public.canonical_transactions
  SET settled_obligation_id = p_obligation_id
  WHERE id = p_transaction_id AND user_id = v_user_id;
END;
$$;

-- 2. Account Data Deletion (GDPR / User-confirmed full wipe)
CREATE OR REPLACE FUNCTION public.delete_my_financial_data(p_confirmation_phrase TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED';
  END IF;

  IF p_confirmation_phrase <> 'ELIMINAR MIS DATOS' THEN
    RAISE EXCEPTION 'INVALID_CONFIRMATION_PHRASE';
  END IF;

  DELETE FROM public.offline_sync_receipts WHERE user_id = v_user_id;
  DELETE FROM public.reconciliation_links WHERE user_id = v_user_id;
  DELETE FROM public.transaction_splits WHERE user_id = v_user_id;
  DELETE FROM public.canonical_transactions WHERE user_id = v_user_id;
  DELETE FROM public.source_records WHERE user_id = v_user_id;
  DELETE FROM public.import_batches WHERE user_id = v_user_id;
  DELETE FROM public.balance_snapshots WHERE user_id = v_user_id;
  DELETE FROM public.obligations WHERE user_id = v_user_id;
  DELETE FROM public.savings_reservations WHERE user_id = v_user_id;
  DELETE FROM public.budget_allocations WHERE user_id = v_user_id;
  DELETE FROM public.categorization_rules WHERE user_id = v_user_id;
  DELETE FROM public.alert_handled_thresholds WHERE user_id = v_user_id;
  DELETE FROM public.alert_outbox WHERE user_id = v_user_id;
  DELETE FROM public.push_subscriptions WHERE user_id = v_user_id;
  DELETE FROM public.bank_connections WHERE user_id = v_user_id;
  DELETE FROM public.accounts WHERE user_id = v_user_id;
END;
$$;

-- 3. Short retention cleanup for raw payloads (30 days) and expired OAuth states
CREATE OR REPLACE FUNCTION app_private.purge_expired_evidence()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_private, pg_temp
AS $$
BEGIN
  DELETE FROM app_private.raw_provider_payloads WHERE expires_at < now();
  DELETE FROM app_private.bank_auth_states WHERE expires_at < (now() - INTERVAL '1 day');
END;
$$;

REVOKE ALL ON FUNCTION app_private.purge_expired_evidence() FROM PUBLIC, anon, authenticated;
