import { formatEur } from '../money';
import { MonthlyFinancialReport } from './index';

/**
 * STOP SPEND — Deterministic Multi-Page PDF-1.4 Report Generator
 *
 * Generates a self-contained, multi-page PDF document (`application/pdf`) directly on the device
 * with zero external AI services or third-party cloud uploads.
 *
 * Supports:
 * - Full Spanish typography (`WinAnsiEncoding`: accents, ñ/Ñ, ¿/¡, € symbol)
 * - Selected month, account scope, generation timestamp, data coverage & last bank sync
 * - Income, net expenses, and monthly result (clearly distinct from bank balance)
 * - Budget comparison when configured
 * - Category breakdown with percentages and optional category limits
 * - Notes on internal transfers, pending transactions, non-personal exclusions & unclassified rows
 * - Paginated transaction table (`Página X de Y`) with source and status columns
 */

const WIN_ANSI_MAP: Record<string, string> = {
  '€': '\\200',
  '¡': '\\241',
  '¿': '\\277',
  'Á': '\\301',
  'É': '\\311',
  'Í': '\\315',
  'Ñ': '\\321',
  'Ó': '\\323',
  'Ú': '\\332',
  'Ü': '\\334',
  'á': '\\341',
  'é': '\\351',
  'í': '\\355',
  'ñ': '\\361',
  'ó': '\\363',
  'ú': '\\372',
  'ü': '\\374',
  '·': '\\267',
  '—': '-',
  '–': '-',
};

export function encodePdfWinAnsiString(input: string): string {
  // Replace non-breaking spaces (used by Intl currency formatting) with regular spaces
  const normalized = input.replace(/[\u00A0\u202F]/g, ' ');
  let out = '';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]!;
    if (ch === '\\') {
      out += '\\\\';
    } else if (ch === '(') {
      out += '\\(';
    } else if (ch === ')') {
      out += '\\)';
    } else if (WIN_ANSI_MAP[ch]) {
      out += WIN_ANSI_MAP[ch];
    } else {
      const code = ch.charCodeAt(0);
      if (code >= 32 && code <= 126) {
        out += ch;
      } else if (code >= 160 && code <= 255) {
        out += `\\${code.toString(8).padStart(3, '0')}`;
      } else {
        out += ' ';
      }
    }
  }
  return out;
}

function truncateText(text: string, maxChars: number): string {
  const clean = text.replace(/\r?\n/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(1, maxChars - 1))}...`;
}

interface PdfLineItem {
  y: number;
  x: number;
  font: 'F1' | 'F2'; // F1 = Helvetica, F2 = Helvetica-Bold
  size: number;
  text: string;
  plainText: string;
  colorRgb?: [number, number, number];
}

interface PdfRectItem {
  x: number;
  y: number;
  w: number;
  h: number;
  fillRgb: [number, number, number];
}

interface PdfPageSpec {
  rects: PdfRectItem[];
  lines: PdfLineItem[];
}

export interface GeneratedPdfDocument {
  bytes: Uint8Array;
  pageCount: number;
  filename: string;
  /** Human-readable plain text mirror of all pages for automated verification */
  plainTextPages: string[];
}

export function generateMonthlyReportPdf(
  report: MonthlyFinancialReport
): GeneratedPdfDocument {
  const pages: PdfPageSpec[] = [];

  const createPage = (): PdfPageSpec => ({
    rects: [],
    lines: [],
  });

  const addText = (
    page: PdfPageSpec,
    params: {
      x: number;
      y: number;
      text: string;
      font?: 'F1' | 'F2';
      size?: number;
      colorRgb?: [number, number, number];
    }
  ) => {
    page.lines.push({
      x: params.x,
      y: params.y,
      font: params.font ?? 'F1',
      size: params.size ?? 9.5,
      text: encodePdfWinAnsiString(params.text),
      plainText: params.text.replace(/[\u00A0\u202F]/g, ' '),
      colorRgb: params.colorRgb,
    });
  };

  // ============================================================================
  // PAGE 1: EXECUTIVE SUMMARY, COVERAGE, BUDGET, CATEGORIES & NOTES
  // ============================================================================
  let currentPage = createPage();
  pages.push(currentPage);

  // Top Header Banner
  currentPage.rects.push({
    x: 36,
    y: 760,
    w: 523,
    h: 52,
    fillRgb: [0.06, 0.09, 0.16],
  });
  addText(currentPage, {
    x: 48,
    y: 792,
    text: `STOP SPEND - Informe Mensual: ${report.periodLabelSpanish} (${report.periodKey})`,
    font: 'F2',
    size: 13,
    colorRgb: [0.95, 0.97, 1.0],
  });
  addText(currentPage, {
    x: 48,
    y: 774,
    text: `Ambito de cuentas: ${truncateText(report.accountScopeLabelSpanish, 65)} | Generado: ${report.generatedAtMadridFormatted}`,
    font: 'F1',
    size: 8.5,
    colorRgb: [0.75, 0.82, 0.9],
  });

  let y = 740;

  // Section 1: Data Coverage & Last Sync
  addText(currentPage, {
    x: 40,
    y,
    text: '1. COBERTURA DE DATOS Y ULTIMA SINCRONIZACION',
    font: 'F2',
    size: 10,
    colorRgb: [0.05, 0.35, 0.25],
  });
  y -= 15;
  addText(currentPage, {
    x: 44,
    y,
    text: `Cobertura del mes: ${truncateText(report.dataCoverage.coverageNoticeSpanish, 95)}`,
    size: 9,
  });
  y -= 13;
  const syncText = report.dataCoverage.lastSyncUtc
    ? `Ultima sincronizacion bancaria: ${new Date(report.dataCoverage.lastSyncUtc).toLocaleString(
        'es-ES',
        { timeZone: 'Europe/Madrid' }
      )}`
    : 'Ultima sincronizacion bancaria: Sin sincronizacion bancaria automatica (Datos manuales / CSV)';
  addText(currentPage, {
    x: 44,
    y,
    text: syncText,
    size: 9,
  });
  y -= 20;

  // Section 2: Income, Expenses & Monthly Result
  addText(currentPage, {
    x: 40,
    y,
    text: '2. RESUMEN FINANCIERO DEL MES (DISTINTO DEL SALDO BANCARIO)',
    font: 'F2',
    size: 10,
    colorRgb: [0.05, 0.35, 0.25],
  });
  y -= 16;

  currentPage.rects.push({
    x: 40,
    y: y - 42,
    w: 515,
    h: 54,
    fillRgb: [0.95, 0.97, 0.99],
  });

  addText(currentPage, {
    x: 50,
    y: y - 4,
    text: `Ingresos del mes (externos asentados): ${formatEur(report.totalExternalIncomeCents)}`,
    font: 'F2',
    size: 9.5,
  });
  addText(currentPage, {
    x: 310,
    y: y - 4,
    text: `Gastos netos del mes: ${formatEur(report.totalNetExpensesCents)}`,
    font: 'F2',
    size: 9.5,
  });
  addText(currentPage, {
    x: 50,
    y: y - 20,
    text: `(Gastos brutos: ${formatEur(report.grossExpensesCents)} | Devoluciones descontadas: ${formatEur(report.refundsAppliedCents)})`,
    size: 8.5,
  });
  addText(currentPage, {
    x: 50,
    y: y - 35,
    text: `Resultado del mes (Ingresos - Gastos): ${formatEur(report.monthlyResultCents, { showSign: true })}  [No equivale al saldo en banco]`,
    font: 'F2',
    size: 9.5,
  });
  y -= 58;

  // Section 3: Budget Comparison (if configured)
  addText(currentPage, {
    x: 40,
    y,
    text: '3. COMPARATIVA CON PRESUPUESTO MENSUAL',
    font: 'F2',
    size: 10,
    colorRgb: [0.05, 0.35, 0.25],
  });
  y -= 15;

  if (report.budgetComparison) {
    addText(currentPage, {
      x: 44,
      y,
      text: `Presupuesto del mes: ${formatEur(report.budgetComparison.monthlyLimitCents)} | Gastado: ${formatEur(report.budgetComparison.spentInBudgetScopeCents)} (${report.budgetComparison.usedPercent}%) | Te quedan: ${formatEur(report.budgetComparison.remainingCents)}`,
      font: 'F2',
      size: 9,
    });
    y -= 13;
    const scopeNote =
      report.budgetComparison.scopeMode === 'personal_only'
        ? `Ambito del presupuesto: Solo gasto personal (${report.budgetComparison.excludedNonPersonalCount} gastos no personales por ${formatEur(report.budgetComparison.excludedNonPersonalCents)} excluidos del limite).`
        : 'Ambito del presupuesto: Incluye todos los gastos de las cuentas seleccionadas.';
    addText(currentPage, {
      x: 44,
      y,
      text: scopeNote,
      size: 8.5,
    });
    y -= 18;
  } else {
    addText(currentPage, {
      x: 44,
      y,
      text: 'Sin presupuesto mensual configurado por el usuario para este mes.',
      size: 9,
    });
    y -= 18;
  }

  // Section 4: Notes on Internal Transfers, Pending, Excluded & Unclassified
  addText(currentPage, {
    x: 40,
    y,
    text: '4. NOTAS DE ANALISIS (TRASPASOS, PENDIENTES Y EXCLUSIONES)',
    font: 'F2',
    size: 10,
    colorRgb: [0.05, 0.35, 0.25],
  });
  y -= 14;
  addText(currentPage, {
    x: 44,
    y,
    text: `- Traspasos internos entre cuentas propias (excluidos de ingresos/gastos): ${report.internalTransfersCount} (${formatEur(report.internalTransfersTotalCents)})`,
    size: 8.5,
  });
  y -= 12;
  addText(currentPage, {
    x: 44,
    y,
    text: `- Movimientos pendientes o provisionales incluidos una sola vez: ${report.pendingTransactionsCount} (${formatEur(report.pendingTransactionsExpenseCents)})`,
    size: 8.5,
  });
  y -= 12;
  addText(currentPage, {
    x: 44,
    y,
    text: `- Movimientos no personales identificados: ${report.nonPersonalTransactionsCount} (${formatEur(report.nonPersonalExpensesCents)}) | Sin clasificar / En revision: ${report.unclassifiedOrReviewCount} (${formatEur(report.unclassifiedOrReviewCents)})`,
    size: 8.5,
  });
  y -= 18;

  // Section 5: Category Breakdown
  addText(currentPage, {
    x: 40,
    y,
    text: '5. DESGLOSE DE GASTOS POR CATEGORIA',
    font: 'F2',
    size: 10,
    colorRgb: [0.05, 0.35, 0.25],
  });
  y -= 14;

  if (report.categoryBreakdown.length === 0) {
    addText(currentPage, {
      x: 44,
      y,
      text: 'No hay gastos registrados en las cuentas seleccionadas durante este mes.',
      size: 9,
    });
    y -= 16;
  } else {
    for (const cat of report.categoryBreakdown.slice(0, 8)) {
      const limitStr =
        cat.categoryLimitCents !== null
          ? ` | Limite cat.: ${formatEur(cat.categoryLimitCents)} (Restan: ${formatEur(cat.categoryRemainingCents)})`
          : '';
      addText(currentPage, {
        x: 44,
        y,
        text: `- ${truncateText(cat.categoryNameSpanish, 28)}: ${formatEur(cat.netExpenseCents)} (${cat.percentageOfTotal}% | ${cat.transactionCount} mov.)${limitStr}`,
        size: 8.5,
      });
      y -= 12;
    }
    y -= 6;
  }

  // ============================================================================
  // SECTION 6: PAGINATED DETAILED TRANSACTION TABLE
  // ============================================================================
  const renderTableHeader = (page: PdfPageSpec, topY: number): number => {
    addText(page, {
      x: 40,
      y: topY,
      text: '6. TABLA DETALLADA DE MOVIMIENTOS DEL MES',
      font: 'F2',
      size: 10,
      colorRgb: [0.05, 0.35, 0.25],
    });
    const headerY = topY - 16;
    page.rects.push({
      x: 40,
      y: headerY - 4,
      w: 515,
      h: 16,
      fillRgb: [0.88, 0.92, 0.96],
    });
    addText(page, { x: 44, y: headerY, text: 'Fecha', font: 'F2', size: 8 });
    addText(page, { x: 100, y: headerY, text: 'Concepto / Comercio', font: 'F2', size: 8 });
    addText(page, { x: 255, y: headerY, text: 'Categoria', font: 'F2', size: 8 });
    addText(page, { x: 365, y: headerY, text: 'Origen / Estado', font: 'F2', size: 8 });
    addText(page, { x: 485, y: headerY, text: 'Importe', font: 'F2', size: 8 });
    return headerY - 16;
  };

  if (y < 140) {
    currentPage = createPage();
    pages.push(currentPage);
    y = 770;
  }

  y = renderTableHeader(currentPage, y);

  if (report.allScopedTransactions.length === 0) {
    addText(currentPage, {
      x: 44,
      y,
      text: 'Sin movimientos registrados para el mes y ambito seleccionados.',
      size: 8.5,
    });
  } else {
    for (const item of report.allScopedTransactions) {
      if (y < 62) {
        currentPage = createPage();
        pages.push(currentPage);
        y = renderTableHeader(currentPage, 780);
      }

      const tx = item.transaction;
      addText(currentPage, {
        x: 44,
        y,
        text: tx.bookingDate,
        size: 8,
      });
      addText(currentPage, {
        x: 100,
        y,
        text: truncateText(tx.description, 28),
        size: 8,
      });
      addText(currentPage, {
        x: 255,
        y,
        text: truncateText(item.categoryNameSpanish, 20),
        size: 8,
      });
      addText(currentPage, {
        x: 365,
        y,
        text: truncateText(`${item.sourceLabelSpanish} · ${item.statusLabelSpanish}`, 23),
        size: 7.5,
      });
      addText(currentPage, {
        x: 480,
        y,
        text: formatEur(tx.amountCents, { showSign: true }),
        font: 'F2',
        size: 8,
      });
      y -= 13;
    }
  }

  // Add page footers (`Página X de Y`) on every page
  const totalPages = pages.length;
  for (let i = 0; i < totalPages; i++) {
    const page = pages[i]!;
    addText(page, {
      x: 40,
      y: 30,
      text: `STOP SPEND · Informe financiero personal (${report.periodKey}) · Sin datos enviados a IA externa`,
      size: 7.5,
      colorRgb: [0.4, 0.45, 0.5],
    });
    addText(page, {
      x: 485,
      y: 30,
      text: `Pagina ${i + 1} de ${totalPages}`,
      font: 'F2',
      size: 8,
      colorRgb: [0.3, 0.35, 0.4],
    });
  }

  // ============================================================================
  // ASSEMBLE VALID PDF-1.4 BINARY
  // ============================================================================
  // Object IDs:
  // 1: Catalog
  // 2: Pages
  // 3: Font F1 (Helvetica / WinAnsiEncoding)
  // 4: Font F2 (Helvetica-Bold / WinAnsiEncoding)
  // For each page i (0..N-1):
  //   pageObjId = 5 + i * 2
  //   contentObjId = 6 + i * 2
  const objects: string[] = [];
  const pageObjIds: number[] = [];
  const plainTextPages: string[] = [];

  for (let i = 0; i < totalPages; i++) {
    pageObjIds.push(5 + i * 2);
  }

  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${totalPages} >>\nendobj\n`
  );
  objects.push(
    '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n'
  );
  objects.push(
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n'
  );

  for (let i = 0; i < totalPages; i++) {
    const page = pages[i]!;
    const pageObjId = 5 + i * 2;
    const contentObjId = 6 + i * 2;

    const streamOps: string[] = [];
    for (const r of page.rects) {
      const [rr, gg, bb] = r.fillRgb;
      streamOps.push(`${rr.toFixed(2)} ${gg.toFixed(2)} ${bb.toFixed(2)} rg`);
      streamOps.push(`${r.x} ${r.y} ${r.w} ${r.h} re f`);
    }

    for (const line of page.lines) {
      const [rr, gg, bb] = line.colorRgb ?? [0.1, 0.12, 0.16];
      streamOps.push('BT');
      streamOps.push(`${rr.toFixed(2)} ${gg.toFixed(2)} ${bb.toFixed(2)} rg`);
      streamOps.push(`/${line.font} ${line.size} Tf`);
      streamOps.push(`1 0 0 1 ${line.x} ${line.y} Tm`);
      streamOps.push(`(${line.text}) Tj`);
      streamOps.push('ET');
    }

    const streamContent = streamOps.join('\n');
    plainTextPages.push(page.lines.map((l) => l.plainText).join('\n'));

    objects.push(
      `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjId} 0 R >>\nendobj\n`
    );
    objects.push(
      `${contentObjId} 0 obj\n<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream\nendobj\n`
    );
  }

  let pdfStr = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(pdfStr.length);
    pdfStr += obj;
  }

  const xrefOffset = pdfStr.length;
  pdfStr += `xref\n0 ${objects.length + 1}\n`;
  pdfStr += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i++) {
    pdfStr += `${String(offsets[i]!).padStart(10, '0')} 00000 n \n`;
  }
  pdfStr += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  const encoder = new TextEncoder();
  return {
    bytes: encoder.encode(pdfStr),
    pageCount: totalPages,
    filename: `informe-stop-spend-${report.periodKey}.pdf`,
    plainTextPages,
  };
}
