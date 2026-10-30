/**
 * STOP SPEND — Europe/Madrid Timezone, Booking Dates & Period Boundaries
 *
 * Invariants:
 * 1. Bank booking dates (`YYYY-MM-DD`) are preserved as calendar dates when that is all
 *    the source supplies. We NEVER fabricate a purchase time (`HH:mm:ss`) for bank records.
 * 2. System/event timestamps are stored as UTC ISO-8601 instants (`created_at_utc`).
 * 3. Budget periods and quiet hours are evaluated in `Europe/Madrid` (handling CET UTC+1
 *    and CEST UTC+2 daylight-saving transitions accurately).
 */

export const MADRID_TIMEZONE = 'Europe/Madrid';

export type CalendarDateISO = `${number}-${string}-${string}`; // YYYY-MM-DD
export type PeriodMonthKey = `${number}-${string}`; // YYYY-MM

export function isValidCalendarDate(dateStr: string): dateStr is CalendarDateISO {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return false;
  }
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export function assertValidCalendarDate(dateStr: string): CalendarDateISO {
  if (!isValidCalendarDate(dateStr)) {
    throw new Error(`Fecha contable inválida: "${dateStr}". Se esperaba formato YYYY-MM-DD.`);
  }
  return dateStr;
}

/**
 * Converts a UTC instant (ISO string or Date) into its local calendar parts in Europe/Madrid.
 */
export function getMadridDateParts(instant: Date | string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  calendarDate: CalendarDateISO;
  periodKey: PeriodMonthKey;
} {
  const dateObj = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(dateObj.getTime())) {
    throw new Error(`Instante UTC inválido: "${String(instant)}"`);
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: MADRID_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(dateObj);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }

  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  // Handle "24" hour edge case in some Intl implementations
  const rawHour = Number(map.hour);
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = Number(map.minute);
  const second = Number(map.second);

  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    calendarDate: `${year}-${mm}-${dd}` as CalendarDateISO,
    periodKey: `${year}-${mm}` as PeriodMonthKey,
  };
}

/**
 * Extracts the budget period (`YYYY-MM`) for a transaction.
 * - If `bookingDate` (`YYYY-MM-DD`) is present, it is authoritative for budget reporting.
 * - Otherwise, if an event timestamp is provided, converts it using `Europe/Madrid`.
 */
export function getTransactionPeriodKey(tx: {
  bookingDate?: CalendarDateISO | string | null;
  occurredAtUtc?: string | null;
}): PeriodMonthKey {
  if (tx.bookingDate && isValidCalendarDate(tx.bookingDate)) {
    return tx.bookingDate.slice(0, 7) as PeriodMonthKey;
  }
  if (tx.occurredAtUtc) {
    return getMadridDateParts(tx.occurredAtUtc).periodKey;
  }
  throw new Error('La transacción carece de bookingDate y de occurredAtUtc válido.');
}

/**
 * Returns the number of calendar days in a given month (`YYYY-MM`).
 */
export function getDaysInMonth(periodKey: PeriodMonthKey): number {
  const [y, m] = periodKey.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Calculates remaining calendar days in the given `periodKey` (`YYYY-MM`) including "today"
 * evaluated in `Europe/Madrid`. Never assumes 4 weeks (28 days) per month.
 */
export function getRemainingCalendarDaysInPeriod(
  periodKey: PeriodMonthKey,
  nowInstant: Date | string
): {
  totalDaysInMonth: number;
  currentDayOfMonth: number;
  remainingDaysIncludingToday: number;
  isCurrentPeriod: boolean;
  isPastPeriod: boolean;
  isFuturePeriod: boolean;
} {
  const totalDaysInMonth = getDaysInMonth(periodKey);
  const madridNow = getMadridDateParts(nowInstant);

  if (madridNow.periodKey === periodKey) {
    const remainingDaysIncludingToday = Math.max(1, totalDaysInMonth - madridNow.day + 1);
    return {
      totalDaysInMonth,
      currentDayOfMonth: madridNow.day,
      remainingDaysIncludingToday,
      isCurrentPeriod: true,
      isPastPeriod: false,
      isFuturePeriod: false,
    };
  }

  if (madridNow.periodKey > periodKey) {
    return {
      totalDaysInMonth,
      currentDayOfMonth: totalDaysInMonth,
      remainingDaysIncludingToday: 0,
      isCurrentPeriod: false,
      isPastPeriod: true,
      isFuturePeriod: false,
    };
  }

  return {
    totalDaysInMonth,
    currentDayOfMonth: 0,
    remainingDaysIncludingToday: totalDaysInMonth,
    isCurrentPeriod: false,
    isPastPeriod: false,
    isFuturePeriod: true,
  };
}

/**
 * Difference in calendar days between two `YYYY-MM-DD` strings (`a - b`).
 */
export function diffCalendarDays(dateA: CalendarDateISO | string, dateB: CalendarDateISO | string): number {
  const [y1, m1, d1] = assertValidCalendarDate(dateA).split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = assertValidCalendarDate(dateB).split('-').map(Number) as [number, number, number];
  const utc1 = Date.UTC(y1, m1 - 1, d1);
  const utc2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((utc1 - utc2) / 86_400_000);
}

/**
 * Evaluates whether a given UTC instant falls within quiet hours in `Europe/Madrid`.
 * Supports overnight windows (e.g., 22:00 to 08:00) across DST transitions.
 */
export function isWithinMadridQuietHours(
  instant: Date | string,
  quietStartHour: number = 22,
  quietEndHour: number = 8
): boolean {
  const { hour } = getMadridDateParts(instant);
  if (quietStartHour === quietEndHour) {
    return false;
  }
  if (quietStartHour < quietEndHour) {
    return hour >= quietStartHour && hour < quietEndHour;
  }
  // Overnight window (e.g. 22:00 -> 08:00)
  return hour >= quietStartHour || hour < quietEndHour;
}
