/**
 * Supabase Edge Function: `bank-sync`
 * Runs paginated synchronization (`GET /accounts/{id}/balances` and `/transactions`)
 * for an active Enable Banking connection using per-connection locks and durable cursors.
 * Separates `isUserInitiated` interactive refreshes from unattended cron jobs.
 */
import {
  EnableBankingAdapter,
  syncAccountPagesAtomically,
  SyncCursorState,
} from '../../../src/server/providers/enableBanking.ts';
import { requireAuthenticatedUser } from '../../../src/server/security/rlsEnforcement.ts';
import { Account, CanonicalTransaction, SourceRecord } from '../../../src/domain/ledger/index.ts';
import { CalendarDateISO } from '../../../src/domain/dates/madrid.ts';

export async function handleBankSyncRequest(params: {
  authenticatedUserId: string | null;
  isUserInitiated: boolean;
  mode: 'unconfigured' | 'sandbox' | 'production';
  appId: string;
  privateKeyPem: string;
  redirectUri: string;
  allowedOrigins: string[];
  account: Account;
  cursor: SyncCursorState;
  dateFrom: CalendarDateISO;
  dateTo: CalendarDateISO;
  existingSources: readonly SourceRecord[];
  existingTransactions: readonly CanonicalTransaction[];
  fetchImpl?: typeof fetch;
}) {
  const userId = requireAuthenticatedUser(params.authenticatedUserId);

  if (params.mode === 'unconfigured' || !params.appId || !params.privateKeyPem) {
    return {
      status: 400,
      body: {
        error: 'PROVIDER_UNCONFIGURED',
        messageSpanish:
          'Enable Banking está sin configurar. Configura ENABLE_BANKING_APP_ID y ENABLE_BANKING_PRIVATE_KEY_PEM cuando dispongas de acceso.',
      },
    };
  }

  if (!params.account.providerSessionAccountId) {
    return {
      status: 400,
      body: {
        error: 'NO_PROVIDER_SESSION_ACCOUNT',
        messageSpanish: 'La cuenta no tiene una sesión activa vinculada en Enable Banking.',
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

  const syncResult = await syncAccountPagesAtomically({
    userId,
    account: params.account,
    cursor: params.cursor,
    targetDateFrom: params.dateFrom,
    targetDateTo: params.dateTo,
    isUserInitiated: params.isUserInitiated,
    existingSources: params.existingSources,
    existingTransactions: params.existingTransactions,
    fetchPage: (continuationKey) =>
      adapter.fetchAccountTransactionsPage({
        providerSessionAccountId: params.account.providerSessionAccountId!,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        continuationKey,
        isUserInitiated: params.isUserInitiated,
      }),
  });

  return {
    status: syncResult.success ? 200 : 502,
    body: syncResult,
  };
}
