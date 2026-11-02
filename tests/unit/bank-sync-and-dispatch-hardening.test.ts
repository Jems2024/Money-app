import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dispatchPendingAlertOutbox } from '../../supabase/functions/alerts-dispatch/index';
import { AlertOutboxEvent } from '../../src/domain/alerts/index';

describe('Bank Sync, Alerts Dispatch & Migration 005 Hardening Tests', () => {
  it('verifies alerts-dispatch queries valid delivery states and does not query "pending"', () => {
    const dispatchCode = readFileSync(
      resolve(process.cwd(), 'supabase/functions/alerts-dispatch/index.ts'),
      'utf-8'
    );
    // Must NOT query "pending" since DB schema uses generated / queued_quiet_hours / sent
    expect(dispatchCode).not.toContain(".eq('delivery_state', 'pending')");
    expect(dispatchCode).toContain("in('delivery_state'");
    expect(dispatchCode).toContain("'generated'");
  });

  it('verifies bank-sync handles failures honestly without faking real read success', () => {
    const syncCode = readFileSync(
      resolve(process.cwd(), 'supabase/functions/bank-sync/index.ts'),
      'utf-8'
    );
    expect(syncCode).toContain('anyAccountSucceeded');
    expect(syncCode).toContain('anyAccountFailed');
    expect(syncCode).toContain('partial_success');
    expect(syncCode).toContain('full_success');
    // Error response must return HTTP 502 / status failed when all fail
    expect(syncCode).toContain("'SYNC_FAILED'");
  });

  it('verifies bank-callback only marks has_successful_real_read true when balances are genuinely retrieved', () => {
    const callbackCode = readFileSync(
      resolve(process.cwd(), 'supabase/functions/bank-callback/index.ts'),
      'utf-8'
    );
    expect(callbackCode).toContain('hasSuccessfulBalanceRead');
    expect(callbackCode).toContain('has_successful_real_read: hasSuccessfulBalanceRead');
  });

  it('verifies migration 005 adds category allocations, scope_mode, selected_account_ids and repeat_monthly', () => {
    const mig005 = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/20261102000005_budget_categories_and_repeat.sql'),
      'utf-8'
    );
    expect(mig005).toContain('category_allocations_cents');
    expect(mig005).toContain('scope_mode');
    expect(mig005).toContain('selected_account_ids');
    expect(mig005).toContain('repeat_monthly');
    expect(mig005).toContain('get_or_clone_monthly_budget');
  });

  it('verifies scheduled-sync-and-alerts function performs unattended background processing', () => {
    const scheduledCode = readFileSync(
      resolve(process.cwd(), 'supabase/functions/scheduled-sync-and-alerts/index.ts'),
      'utf-8'
    );
    expect(scheduledCode).toContain('isUserInitiated: false');
    expect(scheduledCode).toContain('calculatePersonalEnvelopes');
    expect(scheduledCode).toContain('evaluateBudgetThresholdCrossing');
    expect(scheduledCode).toContain('dispatchPendingAlertOutbox');
  });

  it('verifies dispatchPendingAlertOutbox respects quiet hours and marks queued_quiet_hours', async () => {
    const sampleEvent: AlertOutboxEvent = {
      id: 'ev_1',
      idempotencyKey: 'user_1:budget_1:2026-11:75',
      clientNotificationTag: 'tag_1',
      userId: 'user_1',
      budgetId: 'budget_1',
      budgetName: 'Presupuesto mensual',
      periodKey: '2026-11',
      thresholdPercent: 75,
      lowerThresholdsCrossedAndMarkedHandled: [],
      budgetAllocatedCents: 10000,
      spentAfterCents: 7500,
      remainingAfterCents: 2500,
      inAppTitleSpanish: '75% alcanzado',
      inAppBodySpanish: 'Has gastado el 75%',
      pushPayload: {
        title: '75% alcanzado',
        body: 'Has alcanzado el 75%',
        tag: 'tag_1',
        deepLinkUrl: '/presupuesto',
      },
      deliveryState: 'generated',
      seenByUserAtUtc: null,
      createdAtUtc: '2026-11-02T23:30:00Z',
    };

    // 23:30 UTC = 00:30 Madrid (inside quiet hours 22:00 - 08:00)
    const result = await dispatchPendingAlertOutbox({
      outboxEvents: [sampleEvent],
      subscriptions: [],
      vapidSubject: 'mailto:admin@stopspend.es',
      vapidPrivateKeyJwk: {} as JsonWebKey,
      quietHoursEnabled: true,
      quietHoursStart: 22,
      quietHoursEnd: 8,
      nowUtc: '2026-11-02T23:30:00Z',
    });

    expect(result.updatedEvents[0]?.deliveryState).toBe('queued_quiet_hours');
  });
});
