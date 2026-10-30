import { test, expect } from '@playwright/test';

test.describe('STOP SPEND — Critical Browser E2E Flows (Section 12)', () => {
  test('Authenticate, confirm budget, add/undo/edit expense (<10s), simulate purchase without saving, filter, correct category, import/export CSV, see threshold alert, handle API error & reconnect offline queue', async ({
    page,
  }) => {
    await page.goto('/');

    // 1. Authenticate as Jared
    await expect(page.getByTestId('auth-email-input')).toBeVisible();
    await page.getByTestId('auth-email-input').fill('jared@stopspend.es');
    await page.getByTestId('auth-password-input').fill('clave-privada-jared');
    await page.getByTestId('auth-submit-button').click();

    // Verify bank status is honestly "Sin configurar" when no credentials exist, and liquidity is "Desconocido" (not 0,00 €!)
    await expect(page.getByTestId('bank-status-pill')).toContainText('Sin configurar');
    await expect(page.getByTestId('liquidity-value')).toContainText('Desconocido');

    // 2. Confirm personal budget (174 EUR total: 40 small purchases, 54 flexible, 80 protected savings -> 94 spendable)
    await expect(page.getByTestId('onboarding-card')).toBeVisible();
    await page.getByTestId('confirm-onboarding-button').click();
    await expect(page.getByTestId('spendable-remaining-value')).toContainText('94,00');
    await expect(page.getByTestId('small-purchases-remaining-value')).toContainText('40,00');

    // 3. Preview a purchase in Simulator ("¿Puedo comprar esto?") WITHOUT saving it
    await page.getByTestId('primary-simulate-purchase-btn').click();
    await page.getByTestId('sim-amount-input').fill('10,00');
    await expect(page.getByTestId('sim-target-after')).toContainText('30,00');
    await expect(page.getByTestId('sim-total-after')).toContainText('84,00');

    // Simulate exceeding the 40 EUR small-purchases budget
    await page.getByTestId('sim-amount-input').fill('45,00');
    await expect(page.getByTestId('sim-verdict-headline')).toContainText('Supera tu presupuesto');

    // Close simulator and verify NO transaction was saved (still 94,00 € and 40,00 €!)
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByTestId('spendable-remaining-value')).toContainText('94,00');
    await expect(page.getByTestId('small-purchases-remaining-value')).toContainText('40,00');

    // 4. Quick Expense Entry (< 10 seconds timed interaction!) + Undo
    const t0 = Date.now();
    await page.getByTestId('primary-add-expense-btn').click();
    await page.getByTestId('quick-amount-input').fill('2,50');
    await page.getByTestId('quick-desc-input').fill('Café expreso');
    await page.getByTestId('quick-save-button').click();
    const elapsedMs = Date.now() - t0;
    expect(elapsedMs).toBeLessThan(10000); // Verified real interaction well under 10 seconds!

    // Verify 2,50 € deducted once from small purchases (37,50 €) and once from total spendable (91,50 €)
    await expect(page.getByTestId('small-purchases-remaining-value')).toContainText('37,50');
    await expect(page.getByTestId('spendable-remaining-value')).toContainText('91,50');

    // Undo the expense and verify balances return to 40,00 € and 94,00 €
    await page.getByTestId('undo-expense-button').click();
    await expect(page.getByTestId('small-purchases-remaining-value')).toContainText('40,00');
    await expect(page.getByTestId('spendable-remaining-value')).toContainText('94,00');

    // 5. Add an expense that crosses 75% of the 40,00 € small purchases budget (31,00 € -> 9,00 € remaining)
    await page.getByTestId('primary-add-expense-btn').click();
    await page.getByTestId('quick-amount-input').fill('31,00');
    await page.getByTestId('quick-desc-input').fill('Snacks y kiosco mes');
    await page.getByTestId('quick-save-button').click();

    await expect(page.getByTestId('small-purchases-remaining-value')).toContainText('9,00');
    await expect(page.getByTestId('home-threshold-alerts')).toBeVisible();
    await expect(page.getByTestId('alert-item-75')).toContainText('75%');

    // 6. Open "Cómo se calcula" breakdown modal
    await page.getByTestId('how-calc-envelopes-btn').click();
    await expect(page.getByRole('dialog')).toContainText('Cómo se calcula');
    await page.getByRole('button', { name: 'Entendido' }).click();

    // 7. Navigate to Movimientos: filter movements, edit & lock category, import/export CSV
    await page.getByTestId('nav-tab-movimientos').click();
    await page.getByTestId('movements-search-input').fill('Snacks');
    await expect(page.getByText('Snacks y kiosco mes')).toBeVisible();
    await page.getByTestId('movements-search-input').fill('');

    // Edit the transaction and lock its category
    const editBtn = page.locator('[data-testid^="edit-tx-btn-"]').first();
    await editBtn.click();
    await page.getByTestId('edit-tx-category-select').selectOption('eating_out');
    await page.getByTestId('save-edit-tx-btn').click();
    await expect(page.getByTestId('toast-banner')).toContainText('actualizados');

    // CSV Import & Export
    const csvSample = [
      'Fecha;Concepto;Importe;Moneda',
      '20/10/2026;MERCADONA VALENCIA;-15,00;EUR',
    ].join('\n');
    await page.getByTestId('csv-import-textarea').fill(csvSample);
    await page.getByTestId('csv-commit-button').click();
    await expect(page.getByText('MERCADONA VALENCIA')).toBeVisible();

    await page.getByTestId('export-csv-button').click();
    await expect(page.getByTestId('toast-banner')).toContainText('CSV exportado');

    // 8. Navigate to Ajustes: handle simulated API error and offline queue reconnection
    await page.getByTestId('nav-tab-ajustes').click();
    await page.getByTestId('toggle-simulate-api-error-btn').click();

    await page.getByTestId('nav-tab-inicio').click();
    await page.getByTestId('primary-add-expense-btn').click();
    await page.getByTestId('quick-amount-input').fill('3,00');
    await page.getByTestId('quick-desc-input').fill('Intento con error API');
    await page.getByTestId('quick-save-button').click();
    await expect(page.getByTestId('toast-banner')).toContainText('Error de servidor simulado');
    await page.getByRole('button', { name: 'Cancelar' }).click();

    // Enable Offline Mode, add an offline expense, then reconnect and flush the queue
    await page.getByTestId('nav-tab-ajustes').click();
    await page.getByTestId('toggle-simulate-offline-btn').click();
    await expect(page.getByTestId('offline-badge')).toContainText('Sin conexión');

    await page.getByTestId('nav-tab-inicio').click();
    await page.getByTestId('primary-add-expense-btn').click();
    await page.getByTestId('quick-amount-input').fill('4,00');
    await page.getByTestId('quick-desc-input').fill('Gasto en metro sin cobertura');
    await page.getByTestId('quick-save-button').click();
    await expect(page.getByTestId('toast-banner')).toContainText('Pendiente de sincronizar');

    await page.getByTestId('nav-tab-ajustes').click();
    await expect(page.getByTestId('offline-queue-panel')).toContainText('1 gasto(s) Pendiente');
    await page.getByTestId('flush-offline-queue-btn').click();
    await expect(page.getByTestId('toast-banner')).toContainText('Cola sincronizada: 1 movimiento');

    // 9. Verify persistence after reloading page and signing out / signing back in (Point 7)
    await page.reload();
    await page.getByTestId('nav-tab-movimientos').click();
    await expect(page.getByText('Gasto en metro sin cobertura')).toBeVisible();

    // Sign out and sign back in as Jared
    await page.getByTestId('nav-tab-ajustes').click();
    await page.getByTestId('logout-button').click();
    await expect(page.getByTestId('auth-email-input')).toBeVisible();

    await page.getByTestId('auth-email-input').fill('jared@stopspend.es');
    await page.getByTestId('auth-password-input').fill('clave-privada-jared');
    await page.getByTestId('auth-submit-button').click();

    await page.getByTestId('nav-tab-movimientos').click();
    await expect(page.getByText('Gasto en metro sin cobertura')).toBeVisible();
  });
});
