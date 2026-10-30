/**
 * STOP SPEND — Exact Money Domain (`src/domain/money`)
 *
 * Invariants:
 * 1. All monetary amounts are represented as integer cents (`Cents`).
 * 2. Binary floating-point math (`parseFloat(...) * 100`) is NEVER used to parse decimals.
 * 3. Only `EUR` is accepted for canonical calculations in v1; other currencies throw
 *    `UnsupportedCurrencyError` or are segregated before ledger ingestion.
 * 4. `null` represents an UNKNOWN amount (e.g., missing balance snapshot); `0` represents
 *    an exact zero balance. Unknown is never silently coerced to zero.
 * 5. Invalid precision (>2 decimals) is rejected by default (`RoundingPolicy = 'REJECT'`),
 *    or handled explicitly when a caller specifies `'HALF_UP'`.
 */

export type Cents = number;
export type SupportedCurrency = 'EUR';
export type RoundingPolicy = 'REJECT' | 'HALF_UP';

const MAX_ABS_CENTS = 99_999_999_999; // 999,999,999.99 EUR safe integer bound

export class MoneyError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MoneyError';
    this.code = code;
  }
}

export class UnsupportedCurrencyError extends MoneyError {
  public readonly currency: string;
  constructor(currency: string) {
    super('UNSUPPORTED_CURRENCY', `Moneda no soportada en v1: "${currency}". Solo se admite EUR.`);
    this.currency = currency;
  }
}

export class MoneyPrecisionError extends MoneyError {
  constructor(raw: string) {
    super('INVALID_PRECISION', `Precisión decimal inválida para EUR en "${raw}" (máximo 2 decimales).`);
  }
}

export function assertValidCurrency(currency: string): asserts currency is SupportedCurrency {
  const normalized = currency.trim().toUpperCase();
  if (normalized !== 'EUR') {
    throw new UnsupportedCurrencyError(currency);
  }
}

export function assertValidCents(value: number): Cents {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new MoneyError('INVALID_CENTS', `El importe en céntimos debe ser un entero seguro, recibido: ${String(value)}`);
  }
  if (Math.abs(value) > MAX_ABS_CENTS) {
    throw new MoneyError('MONEY_OVERFLOW', `Importe fuera de rango permitido: ${value} céntimos`);
  }
  return value === 0 ? 0 : value; // Normalize -0 to +0
}

/**
 * Parses a decimal string (Spanish "1.250,50", "2,50" or ISO/provider "1250.50", "-20.00")
 * into exact integer cents WITHOUT floating-point multiplication.
 */
export function parseMoneyToCents(
  rawInput: string | number,
  options: {
    currency?: string;
    rounding?: RoundingPolicy;
    allowNegative?: boolean;
  } = {}
): Cents {
  if (options.currency !== undefined) {
    assertValidCurrency(options.currency);
  }
  const rounding = options.rounding ?? 'REJECT';
  const allowNegative = options.allowNegative ?? true;

  if (typeof rawInput === 'number') {
    throw new MoneyError(
      'FLOAT_INPUT_FORBIDDEN',
      'No se permite pasar números flotantes a parseMoneyToCents; usa un string decimal o céntimos enteros.'
    );
  }

  if (typeof rawInput !== 'string') {
    throw new MoneyError('INVALID_INPUT', 'Entrada monetaria inválida.');
  }

  // Strip currency symbol, spaces and NBSP
  let cleaned = rawInput
    .replace(/€/g, '')
    .replace(/\bEUR\b/gi, '')
    .replace(/[\s\u00A0\u202F]/g, '')
    .trim();

  if (!cleaned) {
    throw new MoneyError('EMPTY_AMOUNT', 'El importe está vacío.');
  }

  let sign = 1;
  if (cleaned.startsWith('-')) {
    sign = -1;
    cleaned = cleaned.slice(1);
  } else if (cleaned.startsWith('+')) {
    cleaned = cleaned.slice(1);
  }

  if (sign < 0 && !allowNegative) {
    throw new MoneyError('NEGATIVE_NOT_ALLOWED', 'No se permite un importe negativo en este campo.');
  }

  if (!cleaned || !/^[0-9.,]+$/.test(cleaned)) {
    throw new MoneyError('INVALID_FORMAT', `Formato numérico inválido: "${rawInput}"`);
  }

  // Determine decimal separator vs thousands separator
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');

  let intPartStr = cleaned;
  let fracPartStr = '';

  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) {
      // Spanish format: 1.250,50 -> '.' is thousands, ',' is decimal
      if (cleaned.indexOf(',') !== lastComma) {
        throw new MoneyError('INVALID_FORMAT', `Múltiples comas decimales en "${rawInput}"`);
      }
      const rawInt = cleaned.slice(0, lastComma);
      if (!/^\d{1,3}(\.\d{3})+$/.test(rawInt)) {
        throw new MoneyError('INVALID_THOUSANDS', `Separador de miles inválido en "${rawInput}"`);
      }
      intPartStr = rawInt.replace(/\./g, '');
      fracPartStr = cleaned.slice(lastComma + 1);
    } else {
      // English/CSV format: 1,250.50 -> ',' is thousands, '.' is decimal
      if (cleaned.indexOf('.') !== lastDot) {
        throw new MoneyError('INVALID_FORMAT', `Múltiples puntos decimales en "${rawInput}"`);
      }
      const rawInt = cleaned.slice(0, lastDot);
      if (!/^\d{1,3}(,\d{3})+$/.test(rawInt)) {
        throw new MoneyError('INVALID_THOUSANDS', `Separador de miles inválido en "${rawInput}"`);
      }
      intPartStr = rawInt.replace(/,/g, '');
      fracPartStr = cleaned.slice(lastDot + 1);
    }
  } else if (lastComma !== -1) {
    // Only comma(s) present: in es-ES a single comma is always the decimal separator
    if (cleaned.indexOf(',') !== lastComma) {
      throw new MoneyError('INVALID_FORMAT', `Formato ambiguo con múltiples comas en "${rawInput}"`);
    }
    intPartStr = cleaned.slice(0, lastComma);
    fracPartStr = cleaned.slice(lastComma + 1);
  } else if (lastDot !== -1) {
    // Only dot(s) present:
    const dotCount = (cleaned.match(/\./g) ?? []).length;
    if (dotCount > 1) {
      // e.g. "1.000.000" Spanish thousands with no decimals
      if (!/^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
        throw new MoneyError('INVALID_FORMAT', `Puntos separadores inválidos en "${rawInput}"`);
      }
      intPartStr = cleaned.replace(/\./g, '');
      fracPartStr = '';
    } else {
      // Single dot: e.g. "2.50", "0.10", or Spanish "1.250" (3 digits after dot!)
      // Wait: in provider JSON ("1250.00", "2.50") dot is decimal. What if someone writes "1.000" in Spanish?
      // If fracPartStr has 3 digits, we handle per policy: more than 2 decimals is either Spanish thousands or invalid precision.
      intPartStr = cleaned.slice(0, lastDot);
      fracPartStr = cleaned.slice(lastDot + 1);
    }
  }

  if (intPartStr === '') {
    intPartStr = '0';
  }

  if (!/^\d+$/.test(intPartStr) || (fracPartStr !== '' && !/^\d+$/.test(fracPartStr))) {
    throw new MoneyError('INVALID_DIGITS', `Dígitos inválidos en "${rawInput}"`);
  }

  if (intPartStr.length > 10) {
    throw new MoneyError('MONEY_OVERFLOW', `Importe demasiado grande: "${rawInput}"`);
  }

  let euros = BigInt(intPartStr);
  let centsPart = 0n;

  if (fracPartStr.length === 0) {
    centsPart = 0n;
  } else if (fracPartStr.length === 1) {
    centsPart = BigInt(fracPartStr) * 10n;
  } else if (fracPartStr.length === 2) {
    centsPart = BigInt(fracPartStr);
  } else {
    if (rounding === 'REJECT') {
      throw new MoneyPrecisionError(rawInput);
    }
    // HALF_UP explicit rounding
    const firstTwo = BigInt(fracPartStr.slice(0, 2));
    const thirdDigit = Number(fracPartStr[2]);
    centsPart = thirdDigit >= 5 ? firstTwo + 1n : firstTwo;
    if (centsPart === 100n) {
      euros += 1n;
      centsPart = 0n;
    }
  }

  const totalBig = (euros * 100n + centsPart) * BigInt(sign);
  const totalNumber = Number(totalBig);
  return assertValidCents(totalNumber);
}

export function addCents(a: Cents, b: Cents): Cents {
  return assertValidCents(assertValidCents(a) + assertValidCents(b));
}

export function subtractCents(a: Cents, b: Cents): Cents {
  return assertValidCents(assertValidCents(a) - assertValidCents(b));
}

export function sumCents(values: readonly Cents[]): Cents {
  let acc = 0;
  for (const v of values) {
    acc = addCents(acc, v);
  }
  return acc;
}

/**
 * Divides cents by a positive integer (e.g., remaining calendar days for pacing guide),
 * using explicit rounding ('FLOOR' by default for conservative daily spending guide, or 'HALF_UP').
 */
export function divideCents(
  amount: Cents,
  divisor: number,
  mode: 'FLOOR' | 'HALF_UP' = 'FLOOR'
): Cents {
  assertValidCents(amount);
  if (!Number.isSafeInteger(divisor) || divisor <= 0) {
    throw new MoneyError('INVALID_DIVISOR', `El divisor debe ser un entero positivo, recibido: ${divisor}`);
  }
  if (mode === 'FLOOR') {
    return assertValidCents(Math.floor(amount / divisor));
  }
  const sign = amount < 0 ? -1 : 1;
  const abs = Math.abs(amount);
  const quotient = Math.floor((abs + Math.floor(divisor / 2)) / divisor);
  return assertValidCents(sign * quotient);
}

/**
 * Formats integer cents in natural Spanish (es-ES) currency format without mutating the value.
 * If `amount` is `null` or `undefined`, returns `"Desconocido"` so unknown is never shown as `0,00 €`.
 */
export function formatEur(
  amount: Cents | null | undefined,
  options: { showSign?: boolean; unknownLabel?: string } = {}
): string {
  if (amount === null || amount === undefined) {
    return options.unknownLabel ?? 'Desconocido';
  }
  const valid = assertValidCents(amount);
  const sign = valid < 0 ? '-' : options.showSign && valid > 0 ? '+' : '';
  const abs = Math.abs(valid);
  const euros = Math.floor(abs / 100);
  const cents = abs % 100;

  // Format integer part with Spanish dot thousands separator for >= 1.000
  const euroStr = euros.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const centStr = cents.toString().padStart(2, '0');
  return `${sign}${euroStr},${centStr}\u00A0€`;
}

/**
 * Formats integer cents as a plain Spanish decimal string (e.g. `250` -> `"2,50"`) for inputs/CSV.
 */
export function centsToSpanishDecimal(amount: Cents): string {
  const valid = assertValidCents(amount);
  const sign = valid < 0 ? '-' : '';
  const abs = Math.abs(valid);
  const euros = Math.floor(abs / 100);
  const cents = abs % 100;
  return `${sign}${euros},${cents.toString().padStart(2, '0')}`;
}
