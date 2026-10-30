/**
 * Supabase Edge Function: `bank-auth`
 * Initiates Enable Banking PSD2 authorization (`POST /auth`) for CaixaBank (ES)
 * bound to the authenticated user's JWT, persisting a one-use SHA-256 hashed state in `app_private.bank_auth_states`.
 */
import {
  createBoundAuthState,
  EnableBankingAdapter,
} from '../../../src/server/providers/enableBanking.ts';
import { requireAuthenticatedUser } from '../../../src/server/security/rlsEnforcement.ts';

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
        messageSpanish: 'Enable Banking está sin configurar en el servidor.',
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
