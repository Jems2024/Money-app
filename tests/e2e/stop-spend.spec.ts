import { test, expect } from '@playwright/test';

test.describe('STOP SPEND — Redesigned Bank-First & Financial Reports E2E Flows', () => {
  test('Bank-first onboarding, Prominent Bank Balance, User Budget Setup, Monthly Reports (PDF & CSV), and Offline Queue', async ({
    page,
  }) => {
    await page.goto('/');

    // 1. Authenticate as Jared
    await expect(page.getByTestId('auth-email-input')).toBeVisible();
    await page.getByTestId('auth-email-input').fill('jared@stopspend.es');
    await page.getByTestId('auth-password-input').fill('clave-privada-jared');
    await page.getByTestId('auth-submit-button').click();

    // 2. Bank-First Onboarding Welcome Screen
    // Title: “Conecta tu banco para ver tu saldo y tus movimientos.”
    await expect(page.getByTestId('bank-onboarding-screen')).toBeVisible();
    await expect(page.getByTestId('bank-onboarding-title')).toContainText(
      'Conecta tu banco para ver tu saldo y tus movimientos.'
    );

    // If Enable Banking is not configured, clicking "Conectar mi banco" explains:
    // "La conexión bancaria todavía no está disponible."
    await page.getByTestId('onboard-connect-bank-btn').click();
    await expect(page.getByTestId('bank-unconfigured-notice')).toContainText(
      'La conexión bancaria todavía no está disponible.'
    );

    // Continue without bank -> Takes to Home showing "Banco sin conectar" (never an invented or 0 € balance)
    await page.getByTestId('onboard-continue-without-bank-btn').click();

    // 3. Home Screen Hierarchy
    // A. Main Card: “Saldo en tu banco” -> "Banco sin conectar"
    await expect(page.getByTestId('home-bank-balance-card')).toBeVisible();
    await expect(page.getByTestId('home-bank-balance-value')).toContainText('Banco sin conectar');

    // B. Primary Action: "Crear presupuesto" / "¿Cuánto quieres gastar este mes?"
    // Before a budget exists, shows setup action, not preset 174/94/80 EUR
    await expect(page.getByTestId('open-budget-modal-btn')).toBeVisible();
    await page.getByTestId('open-budget-modal-btn').click();

    // Setting a budget does not move money or change bank balance note is present
    await expect(page.getByTestId('budget-does-not-move-money-note')).toContainText(
      'no mueve dinero ni cambia el saldo de tu banco'
    );
    await page.getByTestId('budget-monthly-limit-input').fill('500,00');
    await page.getByTestId('save-budget-button').click();

    // Once configured, shows: "Presupuesto del mes", "Gastado: X €", "Te quedan: Y €", and progress bar
    await expect(page.getByTestId('home-budget-card')).toContainText('Presupuesto del mes');
    await expect(page.getByTestId('home-budget-spent')).toContainText('Gastado: 0,00');
    await expect(page.getByTestId('home-budget-remaining')).toContainText('Te quedan: 500,00');
    await expect(page.getByTestId('home-budget-progress-bar')).toBeVisible();

    // Verify creating budget did NOT change bank balance ("Banco sin conectar" still uninvented!)
    await expect(page.getByTestId('home-bank-balance-value')).toContainText('Banco sin conectar');

    // C. Monthly Summary: Month selector, "Ingresos del mes", "Gastos del mes", Button: "Ver informe mensual"
    await expect(page.getByTestId('home-month-selector')).toBeVisible();
    await expect(page.getByTestId('home-month-income')).toContainText('0,00');
    await expect(page.getByTestId('home-month-expenses')).toContainText('0,00');
    await expect(page.getByTestId('home-view-report-btn')).toBeVisible();

    // 4. Quick Expense Entry (< 10 seconds interaction!) + Undo
    const t0 = Date.now();
    await page.getByTestId('primary-add-expense-btn').click();
    await page.getByTestId('quick-amount-input').fill('12,50');
    await page.getByTestId('quick-desc-input').fill('Cafetería centro');
    await page.getByTestId('quick-save-button').click();
    const elapsedMs = Date.now() - t0;
    expect(elapsedMs).toBeLessThan(10000);

    // Verify spent increased and remaining decreased in budget card
    await expect(page.getByTestId('home-budget-spent')).toContainText('12,50');
    await expect(page.getByTestId('home-budget-remaining')).toContainText('487,50');

    // Undo expense and verify reversion
    await page.getByTestId('undo-expense-button').click();
    await expect(page.getByTestId('home-budget-spent')).toContainText('0,00');
    await expect(page.getByTestId('home-budget-remaining')).toContainText('500,00');

    // Re-add an expense for reports
    await page.getByTestId('primary-add-expense-btn').click();
    await page.getByTestId('quick-amount-input').fill('25,00');
    await page.getByTestId('quick-desc-input').fill('Cena con amigos');
    await page.getByTestId('quick-save-button').click();
    await expect(page.getByTestId('home-budget-spent')).toContainText('25,00');

    // 5. Navigate to Presupuesto screen: Secondary "¿Puedo comprar esto?" simulator
    await page.getByTestId('nav-tab-presupuesto').click();
    await page.getByTestId('primary-simulate-purchase-btn').click();
    await page.getByTestId('sim-amount-input').fill('15,00');
    await expect(page.getByTestId('sim-total-after')).toContainText('460,00');
    await page.getByRole('button', { name: 'Cancelar' }).click();

    // 6. Navigate to Informes: Monthly Report, Budget Comparison, PDF & CSV downloads
    await page.getByTestId('nav-tab-informes').click();
    await expect(page.getByTestId('monthly-reports-screen')).toBeVisible();
    await expect(page.getByTestId('report-expenses-value')).toContainText('25,00');
    await expect(page.getByTestId('report-result-value')).toContainText('-25,00');
    await expect(page.getByTestId('report-coverage-banner')).toBeVisible();

    // Download PDF (verify client-side generation without external AI uploads)
    await page.getByTestId('download-report-pdf-btn').click();
    await expect(page.getByTestId('generated-pdf-verification-box')).toContainText('Documento PDF generado');
    await expect(page.getByTestId('toast-banner')).toContainText('Informe PDF descargado');

    // Download CSV
    await page.getByTestId('download-report-csv-btn').click();
    await expect(page.getByTestId('toast-banner')).toContainText('Informe CSV descargado');

    // 7. Navigate to Movimientos: CSV Import
    await page.getByTestId('nav-tab-movimientos').click();
    const csvSample = [
      'Fecha;Concepto;Importe;Moneda',
      '02/11/2026;MERCADONA VALENCIA;-35,00;EUR',
    ].join('\n');
    await page.getByTestId('csv-import-textarea').fill(csvSample);
    await page.getByTestId('csv-commit-button').click();
    await expect(page.getByText('MERCADONA VALENCIA')).toBeVisible();

    // 8. Offline Mode resilience
    await page.getByTestId('nav-tab-ajustes').click();
    await page.getByTestId('toggle-simulate-offline-btn').click();
    await expect(page.getByTestId('offline-badge')).toContainText('Sin conexión');

    await page.getByTestId('nav-tab-inicio').click();
    await page.getByTestId('primary-add-expense-btn').click();
    await page.getByTestId('quick-amount-input').fill('5,00');
    await page.getByTestId('quick-desc-input').fill('Metro sin cobertura');
    await page.getByTestId('quick-save-button').click();
    await expect(page.getByTestId('toast-banner')).toContainText('Pendiente de sincronizar');

    // Reconnect and flush
    await page.getByTestId('nav-tab-ajustes').click();
    await expect(page.getByTestId('offline-queue-panel')).toContainText('1 gasto(s) Pendiente');
    await page.getByTestId('flush-offline-queue-btn').click();
    await expect(page.getByTestId('toast-banner')).toContainText('Cola sincronizada: 1 movimiento');

    // 9. Persistence across reload and logout / login
    await page.reload();
    await page.getByTestId('nav-tab-movimientos').click();
    await expect(page.getByText('Metro sin cobertura')).toBeVisible();

    await page.getByTestId('nav-tab-ajustes').click();
    await page.getByTestId('logout-button').click();
    await expect(page.getByTestId('auth-email-input')).toBeVisible();

    await page.getByTestId('auth-email-input').fill('jared@stopspend.es');
    await page.getByTestId('auth-password-input').fill('clave-privada-jared');
    await page.getByTestId('auth-submit-button').click();

    await page.getByTestId('nav-tab-movimientos').click();
    await expect(page.getByText('Metro sin cobertura')).toBeVisible();
  });
});
