# Modelo Financiero e Invariantes Contables (STOP SPEND)

## 1. Aritmética Monetaria Exacta (`src/domain/money/index.ts`)
- **Representación:** Todos los importes se almacenan y procesan en **céntimos enteros (`Cents`, `BIGINT` en PostgreSQL)**.
- **Prohibición de coma flotante:** Nunca se utiliza `parseFloat(x) * 100`. Las cadenas decimales españolas (`"2,50"`, `"1.250,50"`) y las cadenas de proveedores PSD2 (`"12.25"`, `"-20.00"`) se descomponen léxicamente en parte entera y fraccionaria mediante enteros de precisión arbitraria (`BigInt`) antes de validarse como entero seguro.
- **Política de precisión:** Si una entrada tiene más de 2 decimales (p. ej. `"2,505"`), la política por defecto (`RoundingPolicy = 'REJECT'`) lanza `MoneyPrecisionError`. Si un cálculo requiere redondeo explícito, se especifica `'HALF_UP'` o `'FLOOR'`.
- **Moneda única inicial:** Solo se admite `EUR` en v1. Cualquier otra divisa es rechazada con `UnsupportedCurrencyError` antes de entrar al libro mayor.
- **Desconocido vs Cero:** Un importe desconocido se representa como `null` y se formatea como `"Desconocido"`, nunca como `0` (`"0,00 €"`).

---

## 2. Fechas Contables y Zona Horaria `Europe/Madrid` (`src/domain/dates/madrid.ts`)
- **Fechas contables (`booking_date`):** Se conservan como fecha calendario pura (`YYYY-MM-DD`). Cuando el banco o un CSV solo suministra `booking_date`, `occurredAtUtc` permanece en `null`; **nunca se inventa una hora de compra (`00:00:00`)**.
- **Fronteras de presupuesto y cambios de hora (DST):** Los límites de mes (`YYYY-MM`), los días restantes del mes (incluyendo hoy) y las horas de silencio nocturno se evalúan en `Europe/Madrid` (gestionando tanto días de 23 horas en primavera como de 25 horas en otoño).

---

## 3. Las Tres Vistas Financieras (`src/domain/budgets/index.ts`)

### Vista A: Flujo de Caja Mensual (`calculateMonthlyCashFlow`)
$$\text{Flujo Neto Mensual} = \text{Ingresos Externos Asentados} - (\text{Gastos Brutos} - \text{Devoluciones Aplicadas})$$
- **Exclusiones estrictas:** Excluye traspasos internos (`internal_transfer`), saldos iniciales (`opening_balance`), ingresos previstos aún no cobrados (`plannedUnreceivedIncomeCents`) e ingresos en efectivo cuyo origen aún no ha sido confirmado (`requires_deposit_origin_review`).
- **Devoluciones (`refund`):** Reducen el gasto neto y **nunca inflan los ingresos**. Cuando una devolución cruza de mes respecto a la compra original, se aplica y expone la política configurada (`CREDIT_CURRENT_PERIOD` por defecto para abonar el margen del mes actual, o `ADJUST_ORIGINAL_PERIOD` para informes históricos).

### Vista B: Sobres de Presupuesto Personal (`calculatePersonalEnvelopes`)
$$\text{Gastable Restante} = (\text{Asignación Gastable Base} + \text{Rollover} + \text{Ajustes}) - \text{Gasto Personal Neto}$$
- **Plantilla opcional (confirmada por el usuario en onboarding):**
  - Asignación personal total: `174,00 €` (`17400` céntimos).
  - Ahorro personal protegido: `80,00 €` (`8000` céntimos) — **no es dinero para gastar**.
  - Presupuesto personal gastable: `94,00 €` (`9400` céntimos), compuesto por:
    - *Compras pequeñas*: `40,00 €` (`4000` céntimos).
    - *Gasto flexible*: `54,00 €` (`5400` céntimos).
- **Invariante de unicidad económica:** Una compra personal pequeña de `2,50 €` reduce el sobre de *Compras pequeñas* a `37,50 €` y el *Presupuesto personal gastable* total a `91,50 €` (se cuenta una sola vez como gasto económico de `2,50 €`, nunca como `5,00 €`).
- **No ocultación de déficits:** Si el gasto supera el sobre, el saldo restante se muestra negativo (p. ej. `-4,00 €`), nunca truncado a `0,00 €`.

### Vista C: Liquidez Libre Estimada (`calculateEstimatedUncommittedLiquidity`)
$$\text{Liquidez Libre} = \text{Fondos Propios en Cuentas Incluidas} - \text{Obligaciones Reservadas Impagadas} - \text{Reservas de Ahorro Retenidas}$$
- **Saldos iniciales desconocidos:** Si una cuenta incluida carece de instantánea (`BalanceSnapshot`) y de saldo inicial (`opening_balance`), la liquidez libre devuelve `null` (`"Desconocido"`). Los presupuestos (Vista B) siguen funcionando con normalidad.
- **Instantáneas y cargos pendientes:** Cada instantánea registra `balanceType` (`CLBD`, `ITBD`, `ITAV`, etc.) e `includesPendingDebits`. Los cargos pendientes (`pending` / `provisional`) solo se restan cuando la instantánea no los refleja ya (`includesPendingDebits === false`).
- **Liquidación atómica de obligaciones (`settleObligationWithPayment`):** Con `1.000 €` de fondos y `800 €` reservados para alquiler, la liquidez libre es `200 €`. Al pagar los `800 €`, los fondos bajan a `200 €` y la reserva de `800 €` se libera en la misma operación atómica, manteniendo la liquidez libre en `200 €`.
- **Traspaso de ahorro reservado (`transferReservedSavings`):** Con `500 €` de fondos y `100 €` de reserva de ahorro, la liquidez libre es `400 €`. Al traspasar `100 €` a una cuenta de ahorro **excluida**, los fondos incluidos pasan a `400 €` y la reserva se consume (`0 €`), resultando en `400 €` (no `300 €`). Si la cuenta de ahorro está **incluida** en el alcance, los fondos totales siguen siendo `500 €` y la reserva protegida de `100 €` se retiene una vez (`400 €`).

---

## 4. Efectivo, Conciliación y Desgloses (`src/domain/ledger` y `src/domain/reconciliation`)
1. **Nómina en efectivo e ingreso en cajero (`recordCashDepositIntoBank`):**
   - Cobrar la nómina en efectivo incrementa la cuenta `cash` y los ingresos reconocidos.
   - Ingresar ese efectivo en el banco crea un par vinculado de `internal_transfer` (`-1.000 €` en efectivo, `+1.000 €` en banco), sin duplicar ingresos ni inflar gastos.
   - Si aparece un ingreso en efectivo en el banco sin saldo en efectivo registrado ni confirmación del usuario, se marca como `type: 'unknown'` y `reviewStatus: 'requires_deposit_origin_review'`, solicitando confirmación sin inventar nunca un segundo salario.
2. **Conciliación de gasto manual provisional con banco (`ingestAndReconcileSourceRecord`):**
   - Un gasto bancario anotado manualmente (`2,50 €`, estado `provisional`) se enlaza automáticamente cuando llega el movimiento bancario correspondiente, marcando el provisional como `superseded`, conservando la categoría y nota del usuario, y generando un `ReconciliationAuditLink` reversible (`undoReconciliationLink`).
3. **Actualización de pendiente a asentado:**
   - Una preautorización pendiente de `20,00 €` que se asienta en `22,00 €` reemplaza atómicamente el compromiso de `20,00 €` por un único gasto final de `22,00 €`.
4. **Compras legítimas idénticas en el mismo día:**
   - Dos cargos bancarios reales de `2,50 €` en el mismo comercio y fecha con distinto `sourceExternalId` (o distinta fila dentro del mismo lote CSV) se conservan ambos como gastos válidos.
5. **Desgloses (`splits`):**
   - La suma de las líneas de un desglose debe cuadrar exactamente con el valor absoluto de la transacción padre (`validateSplitsForTransaction`). Nunca se suman padre e hijos juntos, y solo las líneas con `scope === 'personal'` computan contra el presupuesto personal.
