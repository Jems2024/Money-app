/**
 * Supabase Edge Function: `bank-auth`
 * Initiates Enable Banking PSD2 authorization (`POST /auth`) for CaixaBank (ES)
 * bound to the authenticated user's JWT, persisting a one-use SHA-256 hashed state in `app_private.bank_auth_states`.
 * Also handles session revocation (`action: 'disconnect'`).
 */
import { createClient } from '@supabase/supabase-js';
import {
  createBoundAuthState,
  EnableBankingAdapter,
} from '../../../src/server/providers/enableBanking.ts';
import { requireAuthenticatedUser } from '../../../src/server/security/rlsEnforcement.ts';

declare const Deno: {
  env: { get(key: string): string | undefined };
  serve: (handler: (req: Request) => Promise<Response> | Response) => void;
} | undefined;

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

export async function handleBankAuthRequest(params: {
  authenticatedUserId: string | null;
  mode: 'unconfigured' | 'sandbox' | 'production';
  appId: string;
  privateKeyPem: string;
  redirectUri: string;
  allowedOrigins: string[];
  fetchImpl?: typeof fetch;
}) {
  const userId = requireAuthenticatedUser(params.authenticatedUserId);

  if (params.mode === 'unconfigured' || !params.appId || !params.privateKeyPem) {
    return {
      status: 400,
      body: {
        error: 'PROVIDER_UNCONFIGURED',
        messageSpanish: 'La conexión bancaria todavía no está disponible.',
      },
    };
  }

  const adapter = new EnableBankingAdapter(
    {
      mode: params.mode,
      baseUrl: 'https://api.enablebanking.com',
      appId: params.appId,
      privateKeyPem: params.privateKeyPem,
      redirectUri: params.redirectUri,
      allowedOrigins: params.allowedOrigins,
    },
    params.fetchImpl
  );

  const institution = await adapter.discoverCaixaBankInstitution('ES', 'CaixaBank');
  const stateBundle = await createBoundAuthState({
    id: `st_${Date.now()}`,
    initiatingUserId: userId,
    aspspName: institution.name,
    aspspCountry: institution.country,
    redirectUri: params.redirectUri,
    allowedOrigins: params.allowedOrigins,
    ttlSeconds: 600,
  });

  const validUntil = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
  const { authorizationUrl } = await adapter.startAuthorization({
    aspspName: institution.name,
    aspspCountry: institution.country,
    state: stateBundle.rawState,
    validUntilIso: validUntil,
  });

  return {
    status: 200,
    body: {
      authorizationUrl,
      persistedStateRecord: stateBundle.record,
    },
  };
}

if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') {
  Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders });
    }

    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
      const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
      const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
      const authHeader = req.headers.get('Authorization') ?? '';

      if (!authHeader) {
        return new Response(
          JSON.stringify({
            error: 'UNAUTHENTICATED',
            messageSpanish: 'Debes iniciar sesión para conectar tu banco.',
          }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Authenticate user via Supabase Auth
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const {
        data: { user },
        error: authError,
      } = await userClient.auth.getUser();

      if (authError || !user) {
        return new Response(
          JSON.stringify({
            error: 'UNAUTHENTICATED',
            messageSpanish: 'Sesión no válida o expirada.',
          }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const reqBody = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

      // Handle disconnect / session revocation
      if (reqBody.action === 'disconnect') {
        const serviceClient = createClient(supabaseUrl, serviceRoleKey);
        const { data: bankConn } = await serviceClient
          .from('bank_connections')
          .select('*')
          .eq('user_id', user.id)
          .maybeSingle();

        const appId = Deno.env.get('ENABLE_BANKING_APP_ID') ?? '';
        const privateKeyPem = Deno.env.get('ENABLE_BANKING_PRIVATE_KEY_PEM') ?? '';
        const mode = (Deno.env.get('ENABLE_BANKING_MODE') as 'production' | 'sandbox') ?? 'production';

        if (bankConn?.provider_session_id && appId && privateKeyPem) {
          try {
            const adapter = new EnableBankingAdapter({
              mode,
              baseUrl: 'https://api.enablebanking.com',
              appId,
              privateKeyPem,
              redirectUri: '',
              allowedOrigins: [],
            });
            await adapter.deleteSession(bankConn.provider_session_id);
          } catch {
            // Ignore provider deletion error if session was already expired
          }
        }

        await serviceClient
          .from('bank_connections')
          .update({
            status: 'session_revoked',
            has_valid_session: false,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', user.id);

        return new Response(
          JSON.stringify({ success: true, messageSpanish: 'Sesión bancaria desconectada y revocada.' }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Bank Auth Initiation
      const appId = Deno.env.get('ENABLE_BANKING_APP_ID') ?? '';
      const privateKeyPem = Deno.env.get('ENABLE_BANKING_PRIVATE_KEY_PEM') ?? '';
      const mode = (Deno.env.get('ENABLE_BANKING_MODE') as 'production' | 'sandbox' | 'unconfigured') ??
        (appId && privateKeyPem ? 'production' : 'unconfigured');

      const origin = req.headers.get('origin') ?? req.headers.get('referer');
      const originBase = origin ? new URL(origin).origin : 'https://stopspend.example.com';
      const redirectUri = Deno.env.get('APP_REDIRECT_URI') ?? `${supabaseUrl}/functions/v1/bank-callback`;

      const result = await handleBankAuthRequest({
        authenticatedUserId: user.id,
        mode,
        appId,
        privateKeyPem,
        redirectUri,
        allowedOrigins: [new URL(redirectUri).origin, originBase],
      });

      if (result.status === 200 && result.body.persistedStateRecord) {
        const serviceClient = createClient(supabaseUrl, serviceRoleKey);
        const rec = result.body.persistedStateRecord;
        await serviceClient.rpc('create_bank_auth_state', {
          p_id: rec.id,
          p_state_hash_hex: rec.stateHashHex,
          p_initiating_user_id: user.id,
          p_aspsp_name: rec.aspspName,
          p_aspsp_country: rec.aspspCountry,
          p_redirect_uri: rec.redirectUri,
          p_expires_at: rec.expiresAtUtc,
        });
      }

      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({ error: 'INTERNAL_ERROR', messageSpanish: msg }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  });
}
