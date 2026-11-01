-- ============================================================================
-- STOP SPEND — Migration 004: Atomic Bank Authorization State Management RPCs
-- Project Ref: zsnvclyoypabmgqqaizj
-- ============================================================================

-- 1. Create one-time bank authorization state bound to user
CREATE OR REPLACE FUNCTION public.create_bank_auth_state(
  p_id TEXT,
  p_state_hash_hex TEXT,
  p_initiating_user_id UUID,
  p_aspsp_name TEXT,
  p_aspsp_country TEXT,
  p_redirect_uri TEXT,
  p_expires_at TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_private, pg_temp
AS $$
BEGIN
  INSERT INTO app_private.bank_auth_states (
    id,
    state_hash_hex,
    initiating_user_id,
    aspsp_name,
    aspsp_country,
    redirect_uri,
    expires_at
  ) VALUES (
    p_id,
    p_state_hash_hex,
    p_initiating_user_id,
    p_aspsp_name,
    p_aspsp_country,
    p_redirect_uri,
    p_expires_at
  );
END;
$$;

-- 2. Atomically consume single-use state on callback
CREATE OR REPLACE FUNCTION public.consume_bank_auth_state(
  p_state_hash_hex TEXT
)
RETURNS TABLE (
  id TEXT,
  initiating_user_id UUID,
  aspsp_name TEXT,
  aspsp_country TEXT,
  redirect_uri TEXT,
  created_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_private, pg_temp
AS $$
DECLARE
  v_rec RECORD;
BEGIN
  SELECT s.id, s.initiating_user_id, s.aspsp_name, s.aspsp_country, s.redirect_uri, s.created_at, s.expires_at
  INTO v_rec
  FROM app_private.bank_auth_states s
  WHERE s.state_hash_hex = p_state_hash_hex
    AND s.consumed_at IS NULL
    AND s.expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE app_private.bank_auth_states
  SET consumed_at = now()
  WHERE app_private.bank_auth_states.id = v_rec.id;

  RETURN QUERY SELECT v_rec.id, v_rec.initiating_user_id, v_rec.aspsp_name, v_rec.aspsp_country, v_rec.redirect_uri, v_rec.created_at, v_rec.expires_at;
END;
$$;

REVOKE ALL ON FUNCTION public.create_bank_auth_state(TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_bank_auth_state(TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_bank_auth_state(TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_bank_auth_state(TEXT) TO service_role;
