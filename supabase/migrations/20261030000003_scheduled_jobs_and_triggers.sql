-- ============================================================================
-- STOP SPEND — Migration 003: Automatic Profile Provisioning & pg_cron Jobs
-- Project Ref: zsnvclyoypabmgqqaizj
-- ============================================================================

-- 1. Automatically provision a profile and the 3 default owned accounts
--    (Efectivo en mano, Cuenta CaixaBank, Cuenta Ahorro Separada) with ZERO
--    invented balances whenever an authorized user is created in auth.users.
CREATE OR REPLACE FUNCTION public.handle_new_authenticated_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, display_name, locale, timezone, currency, onboarding_confirmed)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', 'Jared'),
    'es-ES',
    'Europe/Madrid',
    'EUR',
    FALSE
  )
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.accounts (id, user_id, name, type, currency, include_in_liquidity, is_owned)
  VALUES
    ('acc_cash_main_' || NEW.id::text, NEW.id, 'Efectivo en mano', 'cash', 'EUR', TRUE, TRUE),
    ('acc_bank_caixabank_' || NEW.id::text, NEW.id, 'Cuenta CaixaBank', 'bank', 'EUR', TRUE, TRUE),
    ('acc_savings_excluded_' || NEW.id::text, NEW.id, 'Cuenta Ahorro Separada', 'savings', 'EUR', FALSE, TRUE)
  ON CONFLICT (id) DO NOTHING;

  -- Register unconfigured bank connection row so UI honestly reflects "Sin configurar"
  INSERT INTO public.bank_connections (
    id, user_id, provider_code, environment_mode, aspsp_country, aspsp_name, status
  )
  VALUES (
    'conn_caixabank_' || NEW.id::text,
    NEW.id,
    'enable_banking',
    'unconfigured',
    'ES',
    'CaixaBank',
    'unconfigured'
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_authenticated_user();

-- 2. Configure pg_cron scheduled maintenance if pg_cron extension is available on the project
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
    -- Purge expired raw payloads (30-day retention) and expired OAuth states daily at 03:15 UTC
    PERFORM cron.schedule(
      'stop-spend-purge-expired-evidence',
      '15 3 * * *',
      $cron$SELECT app_private.purge_expired_evidence();$cron$
    );
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    -- If pg_cron is not yet enabled on the Supabase plan/instance, do not fail the migration
    RAISE NOTICE 'pg_cron extension not active yet; skipping cron.schedule registration.';
END $$;
