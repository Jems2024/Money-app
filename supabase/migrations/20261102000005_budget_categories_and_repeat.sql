-- ============================================================================
-- STOP SPEND — Migration 005: Budget Categories, Scope Mode, Account Selection & Monthly Repeat
-- Project Ref: zsnvclyoypabmgqqaizj
-- ============================================================================

-- 1. Add category allocations, scope mode, selected accounts and repeat toggle to budget_allocations
ALTER TABLE public.budget_allocations
  ADD COLUMN IF NOT EXISTS category_allocations_cents JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS scope_mode TEXT NOT NULL DEFAULT 'personal_only' CHECK (scope_mode IN ('personal_only', 'all_spending')),
  ADD COLUMN IF NOT EXISTS selected_account_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS repeat_monthly BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Function to auto-carryforward budget if repeat_monthly is active and no budget exists for target period
CREATE OR REPLACE FUNCTION public.get_or_clone_monthly_budget(
  p_period_key TEXT
)
RETURNS TABLE (
  id TEXT,
  user_id UUID,
  period_key TEXT,
  confirmed_by_user BOOLEAN,
  total_personal_allocated_cents BIGINT,
  protected_savings_allocated_cents BIGINT,
  small_purchases_allocated_cents BIGINT,
  flexible_spending_allocated_cents BIGINT,
  rollover_from_previous_cents BIGINT,
  manual_adjustments_cents BIGINT,
  category_allocations_cents JSONB,
  scope_mode TEXT,
  selected_account_ids JSONB,
  repeat_monthly BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_latest RECORD;
  v_cloned_id TEXT;
BEGIN
  -- First check if a budget already exists for this period
  RETURN QUERY
  SELECT
    b.id,
    b.user_id,
    b.period_key,
    b.confirmed_by_user,
    b.total_personal_allocated_cents,
    b.protected_savings_allocated_cents,
    b.small_purchases_allocated_cents,
    b.flexible_spending_allocated_cents,
    b.rollover_from_previous_cents,
    b.manual_adjustments_cents,
    b.category_allocations_cents,
    b.scope_mode,
    b.selected_account_ids,
    b.repeat_monthly
  FROM public.budget_allocations b
  WHERE b.user_id = v_user_id AND b.period_key = p_period_key;

  IF FOUND THEN
    RETURN;
  END IF;

  -- Look for the latest confirmed budget with repeat_monthly = TRUE
  SELECT *
  INTO v_latest
  FROM public.budget_allocations b
  WHERE b.user_id = v_user_id
    AND b.confirmed_by_user = TRUE
    AND b.repeat_monthly = TRUE
  ORDER BY b.period_key DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_cloned_id := 'bud_' || p_period_key || '_' || substr(gen_random_uuid()::text, 1, 8);

  INSERT INTO public.budget_allocations (
    id,
    user_id,
    period_key,
    confirmed_by_user,
    total_personal_allocated_cents,
    protected_savings_allocated_cents,
    small_purchases_allocated_cents,
    flexible_spending_allocated_cents,
    rollover_from_previous_cents,
    manual_adjustments_cents,
    category_allocations_cents,
    scope_mode,
    selected_account_ids,
    repeat_monthly
  ) VALUES (
    v_cloned_id,
    v_user_id,
    p_period_key,
    TRUE,
    v_latest.total_personal_allocated_cents,
    v_latest.protected_savings_allocated_cents,
    v_latest.small_purchases_allocated_cents,
    v_latest.flexible_spending_allocated_cents,
    0,
    0,
    v_latest.category_allocations_cents,
    v_latest.scope_mode,
    v_latest.selected_account_ids,
    TRUE
  );

  RETURN QUERY
  SELECT
    b.id,
    b.user_id,
    b.period_key,
    b.confirmed_by_user,
    b.total_personal_allocated_cents,
    b.protected_savings_allocated_cents,
    b.small_purchases_allocated_cents,
    b.flexible_spending_allocated_cents,
    b.rollover_from_previous_cents,
    b.manual_adjustments_cents,
    b.category_allocations_cents,
    b.scope_mode,
    b.selected_account_ids,
    b.repeat_monthly
  FROM public.budget_allocations b
  WHERE b.id = v_cloned_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_or_clone_monthly_budget(TEXT) TO authenticated;
