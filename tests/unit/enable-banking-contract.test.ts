import { describe, it, expect } from 'vitest';
import {
  EnableBankingAdapter,
  parseEnableBankingBalance,
  parseEnableBankingTransaction,
} from '../../src/server/providers/enableBanking';
import {
  applyRulesPreservingLockedCorrections,
  categorizeTransactionDeterministic,
  computeLikeForLikeAnalytics,
  detectRecurringPaymentCandidates,
} from '../../src/domain/categorization';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

describe('Enable Banking Adapter Contract & Categorization/Analytics Tests', () => {
  it('parses Enable Banking balances and transactions without floating point and executes full contract against mocked API', async () => {
    const keyPair = await globalThis.crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify']
    );
    const pkcs8Der = await globalThis.crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    const pem = `-----BEGIN PRIVATE KEY-----\n${arrayBufferToBase64(pkcs8Der)}\n-----END PRIVATE KEY-----`;

    const balanceDto = parseEnableBankingBalance(
      {
        balance_type: 'ITAV',
        balance_amount: { amount: '1250.75', currency: 'EUR' },
        reference_date: '2026-10-30',
        last_change_date_time: '2026-10-30T10:00:00Z',
      },
      '2026-10-30'
    );
    expect(balanceDto.amountCents).toBe(125075);
    expect(balanceDto.includesPendingDebits).toBe(true);

    const txDto = parseEnableBankingTransaction(
      {
        entry_reference: 'CAIXA_987654',
        booking_date: '2026-10-29',
        status: 'BOOK',
        credit_debit_indicator: 'DBIT',
        transaction_amount: { amount: '14.90', currency: 'EUR' },
        creditor: { name: 'MERCADONA SA' },
        remittance_information: ['COMPRA TARJETA'],
      },
      '2026-10-29'
    );
    expect(txDto.amountCents).toBe(-1490);
    expect(txDto.bookingDate).toBe('2026-10-29');
    expect(txDto.sourceExternalId).toBe('CAIXA_987654');

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const authHeader = (init?.headers as Record<string, string>)?.Authorization ?? '';
      expect(authHeader.startsWith('Bearer ')).toBe(true);

      if (url.includes('/aspsps?country=ES')) {
        return new Response(
          JSON.stringify({
            aspsps: [
              { name: 'imagin', country: 'ES' },
              { name: 'CaixaBank', country: 'ES', bic: 'CAIXESBBXXX' },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/auth') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ url: 'https://caixabank.example/sca?state=test' }),
          { status: 200 }
        );
      }
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            session_id: 'sess_caixabank_01',
            accounts: [
              {
                uid: 'acc_uid_1',
                account_id: { iban: 'ES9121000418450200051332' },
                name: 'Cuenta Corriente CaixaBank',
                currency: 'EUR',
                cash_account_type: 'CACC',
              },
            ],
            access: { valid_until: '2027-01-28T00:00:00Z' },
          }),
          { status: 200 }
        );
      }
      if (url.includes('/sessions/sess_caixabank_01') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    };

    const adapter = new EnableBankingAdapter(
      {
        mode: 'sandbox',
        baseUrl: 'https://api.enablebanking.com',
        appId: '00000000-1111-2222-3333-444444444444',
        privateKeyPem: pem,
        redirectUri: 'https://stopspend.example.com/auth/bank/callback',
        allowedOrigins: ['https://stopspend.example.com'],
      },
      mockFetch
    );

    const inst = await adapter.discoverCaixaBankInstitution('ES', 'CaixaBank');
    expect(inst.name).toBe('CaixaBank');

    const authStart = await adapter.startAuthorization({
      aspspName: inst.name,
      aspspCountry: inst.country,
      state: 'state_123',
      validUntilIso: '2027-01-28T00:00:00Z',
    });
    expect(authStart.authorizationUrl).toContain('caixabank.example');

    const session = await adapter.exchangeCodeForSession('code_abc');
    expect(session.sessionId).toBe('sess_caixabank_01');
    expect(session.accounts[0]?.ibanMasked).toBe('ES91 **** **** 1332');

    const deletion = await adapter.deleteSession('sess_caixabank_01');
    expect(deletion.deletedInProvider).toBe(true);
    expect(deletion.guaranteedBankConsentRevoked).toBe(false);

    // Verify PIS is explicitly unsupported
    expect(adapter.initiatePaymentUnsupported().supported).toBe(false);
  });

  it('enforces deterministic categorization priority, preserves locked corrections, detects recurring candidates, and avoids zero-denominator division', () => {
    const decisionSupermarket = categorizeTransactionDeterministic({
      description: 'MERCADONA S.A. VALENCIA',
      userRules: [],
    });
    expect(decisionSupermarket.categoryId).toBe('groceries');
    // Supermarket merchant never automatically marks purchase as small spending!
    expect(decisionSupermarket.suggestSmallSpendingTag).toBe(false);

    // Locked transaction correction is preserved when rules change
    const updated = applyRulesPreservingLockedCorrections(
      [
        {
          id: 'tx_locked',
          userId: 'u1',
          accountId: 'acc_1',
          type: 'expense',
          status: 'booked',
          amountCents: -500,
          currency: 'EUR',
          bookingDate: '2026-09-10',
          valueDate: '2026-09-10',
          occurredAtUtc: null,
          createdAtUtc: '2026-09-10T10:00:00Z',
          description: 'MERCADONA S.A.',
          merchantNormalized: 'MERCADONA S A',
          userNote: null,
          categoryId: 'coffee_snacks',
          categorySource: 'user_locked',
          categoryConfidence: 100,
          categoryExplanation: 'Locked',
          scope: 'personal',
          smallSpendingTagged: true,
          splits: [],
          linkedExpenseId: null,
          transferPairId: null,
          counterpartAccountId: null,
          untrackedOwnedDestinationLabel: null,
          settledObligationId: null,
          consumedSavingsReservationId: null,
          supersededByTransactionId: null,
          reviewStatus: 'none',
          sourceRecordIds: [],
        },
      ],
      [
        {
          id: 'r1',
          userId: 'u1',
          patternNormalized: 'MERCADONA',
          categoryId: 'groceries',
          isUserConfirmed: true,
          suggestSmallSpendingTag: false,
        },
      ]
    );
    expect(updated[0]?.categoryId).toBe('coffee_snacks'); // Still locked!

    // Recurring payment candidate detection (requires >= 2 monthly occurrences)
    const recurring = detectRecurringPaymentCandidates({
      transactions: [
        {
          ...updated[0]!,
          id: 'tx_sub_1',
          description: 'SPOTIFY AB',
          merchantNormalized: 'SPOTIFY AB',
          amountCents: -1099,
          bookingDate: '2026-09-05',
        },
        {
          ...updated[0]!,
          id: 'tx_sub_2',
          description: 'SPOTIFY AB',
          merchantNormalized: 'SPOTIFY AB',
          amountCents: -1099,
          bookingDate: '2026-10-05',
        },
      ],
      existingObligationNames: [],
    });
    expect(recurring).toHaveLength(1);
    expect(recurring[0]?.estimatedAmountCents).toBe(1099);

    // Analytics with 0 spend in previous window -> deltaPercent is null (never Infinity/NaN)
    const analytics = computeLikeForLikeAnalytics({
      transactions: [
        {
          ...updated[0]!,
          id: 'tx_oct',
          bookingDate: '2026-10-10',
          amountCents: -500,
        },
      ],
      currentWindowStart: '2026-10-01',
      currentWindowEnd: '2026-10-15',
      previousWindowStart: '2026-09-01',
      previousWindowEnd: '2026-09-15',
      hasCompletePreviousHistory: true,
    });
    expect(analytics.currentWindowNetSpendCents).toBe(500);
    expect(analytics.previousWindowNetSpendCents).toBe(0);
    expect(analytics.deltaPercent).toBeNull();
  });
});
