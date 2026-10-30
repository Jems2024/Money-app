import {
  assertValidCurrency,
  centsToSpanishDecimal,
  parseMoneyToCents,
} from '../money';
import { CalendarDateISO, isValidCalendarDate } from '../dates/madrid';
import { CanonicalTransaction, SourceRecord } from '../ledger';
import { ingestAndReconcileSourceRecord } from '../reconciliation';

export interface CsvColumnMapping {
  dateColumnIndex: number;
  descriptionColumnIndex: number;
  /** Either `amountColumnIndex` OR (`debitColumnIndex` + `creditColumnIndex`) */
  amountColumnIndex?: number;
  debitColumnIndex?: number;
  creditColumnIndex?: number;
  currencyColumnIndex?: number;
  externalIdColumnIndex?: number;
  dateFormat: 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'DD-MM-YYYY';
  delimiter: ';' | ',' | '\t';
  hasHeaderRow: boolean;
}

export interface CsvValidationError {
  rowNumber: number; // 1-based row number in file
  rawLine: string;
  messageSpanish: string;
}

export interface CsvParsedRow {
  rowNumber: number;
  bookingDate: CalendarDateISO;
  description: string;
  amountCents: number;
  currency: 'EUR';
  externalRowId: string;
}

export interface CsvPreviewResult {
  fileHashKey: string;
  validRows: CsvParsedRow[];
  errors: CsvValidationError[];
  canCommit: boolean; // False if any validation errors exist (no silent partial success!)
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

export function parseSpanishDateToISO(
  rawDate: string,
  format: CsvColumnMapping['dateFormat']
): CalendarDateISO {
  const cleaned = rawDate.trim();
  if (format === 'YYYY-MM-DD') {
    if (!isValidCalendarDate(cleaned)) {
      throw new Error(`Fecha inválida "${rawDate}" (esperado YYYY-MM-DD)`);
    }
    return cleaned;
  }

  const sep = format === 'DD/MM/YYYY' ? '/' : '-';
  const parts = cleaned.split(sep);
  if (parts.length !== 3) {
    throw new Error(`Fecha inválida "${rawDate}" (esperado ${format})`);
  }
  const [dd, mm, yyyy] = parts as [string, string, string];
  const iso = `${yyyy.padStart(4, '0')}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  if (!isValidCalendarDate(iso)) {
    throw new Error(`Fecha calendario inexistente "${rawDate}"`);
  }
  return iso;
}

/**
 * Simple deterministic string hash for file/row provenance in synchronous preview.
 */
function deterministicHash(content: string): string {
  let h1 = 0xdeadbeef ^ content.length;
  let h2 = 0x41c6ce57 ^ content.length;
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * Parses and validates a CSV statement before committing.
 * Never assumes a hardcoded bank schema; uses user column mapping and forbids silent partial success.
 */
export function previewCsvStatement(
  rawCsvText: string,
  mapping: CsvColumnMapping
): CsvPreviewResult {
  const normalizedText = rawCsvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const fileHashKey = `csv_${deterministicHash(normalizedText.trim())}`;
  const lines = normalizedText.split('\n');

  const validRows: CsvParsedRow[] = [];
  const errors: CsvValidationError[] = [];

  const startIdx = mapping.hasHeaderRow ? 1 : 0;
  for (let i = startIdx; i < lines.length; i++) {
    const rawLine = lines[i]!.trim();
    if (!rawLine) {
      continue;
    }
    const rowNumber = i + 1;

    try {
      const cols = parseCsvLine(rawLine, mapping.delimiter);
      const rawDate = cols[mapping.dateColumnIndex] ?? '';
      const rawDesc = cols[mapping.descriptionColumnIndex] ?? '';

      if (!rawDate) {
        throw new Error('Columna de fecha vacía.');
      }
      if (!rawDesc) {
        throw new Error('Columna de concepto/descripción vacía.');
      }

      const bookingDate = parseSpanishDateToISO(rawDate, mapping.dateFormat);
      const rawCurrency =
        mapping.currencyColumnIndex !== undefined
          ? (cols[mapping.currencyColumnIndex] || 'EUR')
          : 'EUR';
      assertValidCurrency(rawCurrency);

      let amountCents: number;
      if (mapping.amountColumnIndex !== undefined) {
        const rawAmt = cols[mapping.amountColumnIndex] ?? '';
        amountCents = parseMoneyToCents(rawAmt, { currency: rawCurrency });
      } else if (
        mapping.debitColumnIndex !== undefined ||
        mapping.creditColumnIndex !== undefined
      ) {
        const rawDebit =
          mapping.debitColumnIndex !== undefined ? (cols[mapping.debitColumnIndex] ?? '').trim() : '';
        const rawCredit =
          mapping.creditColumnIndex !== undefined
            ? (cols[mapping.creditColumnIndex] ?? '').trim()
            : '';

        if (rawDebit && rawDebit !== '0' && rawDebit !== '0,00') {
          const parsedDebit = parseMoneyToCents(rawDebit, { currency: rawCurrency });
          amountCents = -Math.abs(parsedDebit);
        } else if (rawCredit && rawCredit !== '0' && rawCredit !== '0,00') {
          const parsedCredit = parseMoneyToCents(rawCredit, { currency: rawCurrency });
          amountCents = Math.abs(parsedCredit);
        } else {
          throw new Error('Tanto cargo como abono están vacíos o son cero.');
        }
      } else {
        throw new Error('Configuración de columnas de importe incompleta.');
      }

      const explicitExtId =
        mapping.externalIdColumnIndex !== undefined
          ? (cols[mapping.externalIdColumnIndex] ?? '').trim()
          : '';

      // Row identity: if the CSV has an explicit bank reference ID, use it; otherwise scope to
      // `(fileHashKey, rowNumber)` so identical file re-imports are idempotent, while two same-day
      // purchases on different rows in the same file remain distinct!
      const externalRowId = explicitExtId || `${fileHashKey}:row:${rowNumber}`;

      validRows.push({
        rowNumber,
        bookingDate,
        description: rawDesc,
        amountCents,
        currency: 'EUR',
        externalRowId,
      });
    } catch (err) {
      errors.push({
        rowNumber,
        rawLine,
        messageSpanish: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    fileHashKey,
    validRows,
    errors,
    canCommit: errors.length === 0 && validRows.length > 0,
  };
}

/**
 * Commits a validated CSV preview into the ledger via the reconciliation engine.
 * Rejects commits if the preview contains validation errors (preventing silent partial imports).
 */
export function commitCsvImportBatch(params: {
  batchId: string;
  userId: string;
  accountId: string;
  preview: CsvPreviewResult;
  existingSources: readonly SourceRecord[];
  existingTransactions: readonly CanonicalTransaction[];
  nowUtc?: string;
}): {
  transactions: CanonicalTransaction[];
  sourceRecords: SourceRecord[];
  importedCount: number;
  idempotentSkippedCount: number;
  duplicateReviewCount: number;
} {
  if (!params.preview.canCommit) {
    throw new Error(
      `No se puede confirmar la importación CSV: existen ${params.preview.errors.length} errores de validación.`
    );
  }

  let transactions = [...params.existingTransactions];
  let sourceRecords = [...params.existingSources];
  let auditLinks: never[] = [];
  let importedCount = 0;
  let idempotentSkippedCount = 0;
  let duplicateReviewCount = 0;
  const nowUtc = params.nowUtc ?? new Date().toISOString();

  for (const row of params.preview.validRows) {
    const src: SourceRecord = {
      id: `src_csv_${params.batchId}_r${row.rowNumber}`,
      userId: params.userId,
      accountId: params.accountId,
      sourceType: 'csv',
      providerCode: 'csv_import',
      sourceExternalId: row.externalRowId,
      importBatchId: params.batchId,
      originalDescription: row.description,
      bookingDate: row.bookingDate,
      valueDate: row.bookingDate,
      occurredAtUtc: null, // Never fabricate a timestamp from a CSV booking date!
      receivedAtServerUtc: nowUtc,
      status: 'booked',
      currency: row.currency,
      amountCents: row.amountCents,
      counterpartyName: null,
      counterpartyIbanNormalized: null,
      remittanceInfo: null,
      normalizationVersion: 1,
      provenance: `csv:${params.preview.fileHashKey}:row:${row.rowNumber}`,
    };

    const res = ingestAndReconcileSourceRecord({
      incomingSource: src,
      existingSources: sourceRecords,
      existingTransactions: transactions,
      existingAuditLinks: auditLinks,
    });

    transactions = res.transactions;
    sourceRecords = res.sourceRecords;

    if (res.action === 'idempotent_noop') {
      idempotentSkippedCount++;
    } else if (res.action === 'flagged_duplicate_review') {
      importedCount++;
      duplicateReviewCount++;
    } else {
      importedCount++;
    }
  }

  return {
    transactions,
    sourceRecords,
    importedCount,
    idempotentSkippedCount,
    duplicateReviewCount,
  };
}

/**
 * Safely rolls back an entire CSV import batch by `importBatchId`.
 */
export function rollbackCsvImportBatch(params: {
  batchId: string;
  transactions: readonly CanonicalTransaction[];
  sourceRecords: readonly SourceRecord[];
}): {
  transactions: CanonicalTransaction[];
  sourceRecords: SourceRecord[];
} {
  const batchSourceIds = new Set(
    params.sourceRecords.filter((s) => s.importBatchId === params.batchId).map((s) => s.id)
  );

  const remainingSources = params.sourceRecords.filter((s) => s.importBatchId !== params.batchId);
  const remainingTransactions = params.transactions.filter(
    (tx) => !tx.sourceRecordIds.every((sid) => batchSourceIds.has(sid))
  );

  return {
    transactions: remainingTransactions,
    sourceRecords: remainingSources,
  };
}

/**
 * Sanitizes a text cell against CSV / Spreadsheet Formula Injection (OWASP CSV Injection).
 * Prefixes cells starting with `=`, `+`, `-`, `@`, `\t`, `\r` with a single quote `'`
 * and wraps in double quotes.
 */
export function sanitizeCsvCellForExport(value: string): string {
  const trimmed = value.replace(/\r?\n/g, ' ');
  const dangerousStart = /^[=+\-@\t\r]/.test(trimmed);
  const safeContent = dangerousStart ? `'${trimmed}` : trimmed;
  return `"${safeContent.replace(/"/g, '""')}"`;
}

/**
 * Exports canonical transactions to a Spanish CSV string (`;` delimiter, comma decimal, formula-injection defended).
 */
export function exportTransactionsToSpanishCsv(
  transactions: readonly CanonicalTransaction[]
): string {
  const header = 'Fecha contable;Concepto;Importe (EUR);Moneda;Tipo;Estado;Ámbito;Nota';
  const rows = transactions
    .filter((tx) => tx.status !== 'superseded')
    .map((tx) => {
      return [
        tx.bookingDate,
        sanitizeCsvCellForExport(tx.description),
        centsToSpanishDecimal(tx.amountCents),
        tx.currency,
        tx.type,
        tx.status,
        tx.scope,
        sanitizeCsvCellForExport(tx.userNote ?? ''),
      ].join(';');
    });

  return [header, ...rows].join('\n');
}
