/**
 * Supabase Edge Function: `bank-callback`
 * Validates and consumes the one-use authorization state against `app_private.bank_auth_states`,
 * exchanges the authorization code via `POST /sessions`, strips sensitive query parameters,
 * and returns a neutral completion payload safe for cross-context iOS Safari -> Standalone PWA returns.
 */
import {
  EnableBankingAdapter,
  validateAndConsumeAuthStateCallback,
  AuthorizationStateRecord,
} from '../../../src/server/providers/enableBanking.ts';

export async function handleBankCallbackRequest(params: {
  rawStateFromQuery: string;
  codeFromQuery: string;
  storedStateRecords: readonly AuthorizationStateRecord[];
  authenticatedCallbackUserId?: string | null;
  currentCallbackUrl: string;
  mode: 'unconfigured' | 'sandbox' | 'production';
  appId: string;
  privateKeyPem: string;
  redirectUri: string;
  allowedOrigins: string[];
  fetchImpl?: typeof fetch;
}) {
  const consumed = await validateAndConsumeAuthStateCallback({
    rawStateFromQuery: params.rawStateFromQuery,
    codeFromQuery: params.codeFromQuery,
    storedRecords: params.storedStateRecords,
    authenticatedCallbackUserId: params.authenticatedCallbackUserId,
    currentCallbackUrl: params.currentCallbackUrl,
  });

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

  const session = await adapter.exchangeCodeForSession(params.codeFromQuery);

  return {
    status: 200,
    body: {
      initiatingUserId: consumed.consumedRecord.initiatingUserId,
      sanitizedBrowserPath: consumed.sanitizedBrowserPath,
      neutralCompletionMessageSpanish: consumed.neutralCompletionMessageSpanish,
      accountsDiscoveredCount: session.accounts.length,
      validUntilIso: session.validUntilIso,
    },
  };
}
