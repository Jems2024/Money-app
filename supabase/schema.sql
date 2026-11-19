-- ============================================================================
-- CONTROL FINANCIERO INDIVIDUAL Y PRIVADO POR USUARIO (SUPABASE)
-- Esquema completo para Supabase (PostgreSQL + RLS Privado por Usuario)
-- Cada usuario tiene su propio login, su teléfono, su cuenta y sus sobres 100% privados
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. TABLA: profiles (Vinculada a auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  phone TEXT,
  avatar_color TEXT NOT NULL DEFAULT '#10b981',
  role TEXT NOT NULL DEFAULT 'esposo' CHECK (role IN ('esposo', 'esposa')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone TEXT;

-- 2. TABLA: bank_accounts (Cuentas bancarias privadas de cada usuario)
CREATE TABLE IF NOT EXISTS public.bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  bank_name TEXT NOT NULL DEFAULT 'CaixaBank',
  account_alias TEXT NOT NULL,
  iban_masked TEXT NOT NULL,
  enable_banking_account_id TEXT UNIQUE,
  enable_banking_session_id TEXT,
  current_balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  last_synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. TABLA: monthly_envelopes (Presupuesto mensual privado por usuario)
CREATE TABLE IF NOT EXISTS public.monthly_envelopes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  month_year TEXT NOT NULL UNIQUE, -- Formato 'YYYY-MM_<user_id>' para privacidad individual
  ant_expenses_limit NUMERIC(12, 2) NOT NULL DEFAULT 150.00,
  husband_free_limit NUMERIC(12, 2) NOT NULL DEFAULT 200.00,
  wife_free_limit NUMERIC(12, 2) NOT NULL DEFAULT 200.00,
  shared_free_limit NUMERIC(12, 2) NOT NULL DEFAULT 150.00,
  savings_goal NUMERIC(12, 2) NOT NULL DEFAULT 300.00,
  groceries_limit NUMERIC(12, 2) NOT NULL DEFAULT 400.00,
  notified_thresholds JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. TABLA: fixed_bills (Recibos fijos privados de las cuentas del usuario)
CREATE TABLE IF NOT EXISTS public.fixed_bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  custom_code TEXT NOT NULL,
  name TEXT NOT NULL,
  expected_amount NUMERIC(12, 2) NOT NULL CHECK (expected_amount >= 0),
  charged_account_id UUID NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  match_keyword TEXT NOT NULL,
  due_day INTEGER DEFAULT 5 CHECK (due_day BETWEEN 1 AND 31),
  is_paid_this_month BOOLEAN NOT NULL DEFAULT FALSE,
  paid_date DATE,
  auto_matched BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Permitir que distintos usuarios usen el mismo código (ej. REC-LUZ cada uno en su cuenta)
ALTER TABLE public.fixed_bills DROP CONSTRAINT IF EXISTS fixed_bills_custom_code_key;

-- 5. TABLA: transactions (Movimientos privados de cada usuario)
CREATE TABLE IF NOT EXISTS public.transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id UUID NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  external_tx_id TEXT UNIQUE,
  custom_code TEXT,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  concept TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  envelope TEXT NOT NULL CHECK (
    envelope IN (
      'hormiga',
      'libre_esposo',
      'libre_esposa',
      'libre_comun',
      'necesario',
      'fijo',
      'ahorro'
    )
  ),
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  linked_bill_id UUID REFERENCES public.fixed_bills(id) ON DELETE SET NULL,
  ai_confidence NUMERIC(3, 2) DEFAULT 1.00,
  ai_reasoning TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. TABLA: push_subscriptions (Teléfono y suscripción Push privada del usuario)
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL DEFAULT 'Mi Móvil',
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. ROW LEVEL SECURITY (RLS) ESTRICTAMENTE PRIVADO POR USUARIO (auth.uid())
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monthly_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fixed_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Trigger automático al registrar usuario en Supabase Auth
CREATE OR REPLACE FUNCTION public.handle_new_family_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_display_name TEXT;
  v_phone TEXT;
BEGIN
  v_role := COALESCE(NEW.raw_user_meta_data->>'role', 'esposo');
  IF v_role NOT IN ('esposo', 'esposa') THEN
    v_role := 'esposo';
  END IF;

  v_display_name := COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1));
  v_phone := COALESCE(NEW.raw_user_meta_data->>'phone', NULL);

  INSERT INTO public.profiles (id, display_name, phone, avatar_color, role)
  VALUES (NEW.id, v_display_name, v_phone, '#10b981', v_role)
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        phone = COALESCE(EXCLUDED.phone, public.profiles.phone);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_family_user();

-- ============================================================================
-- 8. POLÍTICAS RLS ESTRICTAMENTE PRIVADAS POR USUARIO (EJECUTAR EN SUPABASE)
-- Elimina cualquier política familiar compartida anterior y aísla cada usuario
-- ============================================================================
DROP POLICY IF EXISTS "Miembros familiares ven ambos perfiles" ON public.profiles;
DROP POLICY IF EXISTS "Familia ve todas las cuentas bancarias del hogar" ON public.bank_accounts;
DROP POLICY IF EXISTS "Familia inserta y actualiza cuentas del hogar" ON public.bank_accounts;
DROP POLICY IF EXISTS "Familia gestiona sobres mensuales" ON public.monthly_envelopes;
DROP POLICY IF EXISTS "Familia gestiona recibos fijos" ON public.fixed_bills;
DROP POLICY IF EXISTS "Familia gestiona transacciones" ON public.transactions;
DROP POLICY IF EXISTS "Familia lee suscripciones push para enviar alertas a ambos" ON public.push_subscriptions;

DROP POLICY IF EXISTS "privado_profiles_own" ON public.profiles;
CREATE POLICY "privado_profiles_own" ON public.profiles
  FOR ALL TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "privado_bank_accounts_own" ON public.bank_accounts;
CREATE POLICY "privado_bank_accounts_own" ON public.bank_accounts
  FOR ALL TO authenticated
  USING (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

DROP POLICY IF EXISTS "privado_monthly_envelopes_own" ON public.monthly_envelopes;
CREATE POLICY "privado_monthly_envelopes_own" ON public.monthly_envelopes
  FOR ALL TO authenticated
  USING (month_year LIKE '%_' || auth.uid()::text)
  WITH CHECK (month_year LIKE '%_' || auth.uid()::text);

DROP POLICY IF EXISTS "privado_fixed_bills_own" ON public.fixed_bills;
CREATE POLICY "privado_fixed_bills_own" ON public.fixed_bills
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.bank_accounts ba
      WHERE ba.id = fixed_bills.charged_account_id
        AND ba.owner_user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.bank_accounts ba
      WHERE ba.id = fixed_bills.charged_account_id
        AND ba.owner_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "privado_transactions_own" ON public.transactions;
CREATE POLICY "privado_transactions_own" ON public.transactions
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "privado_push_subscriptions_own" ON public.push_subscriptions;
CREATE POLICY "privado_push_subscriptions_own" ON public.push_subscriptions
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
