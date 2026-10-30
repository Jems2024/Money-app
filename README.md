# STOP SPEND — Control de Gasto Personal, Sobres y Liquidez Libre

Aplicación web progresiva (PWA) instalable, mobile-first en modo oscuro y en español (`es-ES`), diseñada para un único usuario privado (Jared, España, `EUR`, zona horaria `Europe/Madrid`, iPhone como dispositivo principal).

Responde de forma inmediata y verificable a la pregunta central:
> **«¿Cuánto me queda en mi presupuesto personal y cómo cambia si compro esto?»**

Y separa en tres vistas financieras rigurosas (nunca mezcladas en una única fórmula engañosa):
1. **Sobres de Presupuesto Personal (`src/domain/budgets` — Vista B):** Asignación confirmada más rollover/ajustes menos gasto personal neto y compromisos pendientes contados una sola vez. Incluye plantilla opcional de `174,00 €` (`94,00 €` gastables = `40,00 €` en *Compras pequeñas* + `54,00 €` en *Gasto flexible*, y `80,00 €` en *Ahorro personal protegido* no gastable).
2. **Liquidez Libre Estimada (`src/domain/budgets` — Vista C):** Fondos propios en cuentas incluidas (conciliando instantáneas bancarias con movimientos posteriores y cargos pendientes no reflejados) menos obligaciones reservadas impagadas y reservas de ahorro retenidas. Si falta saldo inicial o instantánea verificada, muestra **`Desconocido` (`null`)**, nunca `0,00 €`.
3. **Flujo de Caja Mensual (`src/domain/budgets` — Vista A):** Ingresos externos realmente cobrados y asentados menos gastos reales netos de devoluciones (excluyendo traspasos internos, saldos iniciales e ingresos previstos no cobrados).

---

## Estado de la Entrega (Release Status)

Siguiendo el contrato de honestidad operativa (Sección 13):

| Componente | Estado | Detalle |
| :--- | :--- | :--- |
| **Núcleo Manual y CSV (`manual/CSV core`)** | **LISTO Y VERIFICADO** | Aritmética exacta en céntimos enteros, entrada rápida `< 10s` con deshacer, simulador de compra sin persistencia, importación/exportación CSV con reversión de lotes y defensa ante inyección de fórmulas. |
| **Código de integración bancaria (`banking code implemented`)** | **IMPLEMENTADO** | Adaptador `EnableBankingAdapter` (`RS256` JWT con Web Crypto API, `/aspsps`, `POST /auth`, `POST /sessions`, `/balances`, `/transactions` con `continuation_key`, `DELETE /sessions/{id}`, estado OAuth de un solo uso y motor de sincronización atómico). |
| **Pruebas de contrato / Sandbox (`sandbox verified`)** | **VERIFICADO CON FIXTURES DE CONTRATO** | Pruebas automatizadas de contrato superadas (`tests/unit/enable-banking-contract.test.ts`). El tráfico en vivo contra el Sandbox de Enable Banking requiere que el usuario configure su `ENABLE_BANKING_APP_ID` y clave privada RSA. |
| **Producción con cuenta propia (`own-account production verified`)** | **PENDIENTE DEL USUARIO** | Requiere que Jared complete el alta en Enable Banking (*Linked Accounts*) y la autenticación SCA en CaixaBankNow. La UI muestra honestamente `Sin configurar` hasta entonces. |
| **Web Push en iPhone físico (`physical iPhone push verified`)** | **PENDIENTE DE DISPOSITIVO FÍSICO** | La lógica de servidor VAPID (`ES256`), el Service Worker (`public/sw.js`) y la protección SSRF están implementados y probados en suite automatizada, pero la recepción real con la app cerrada en iOS Safari requiere ejecución manual en el iPhone físico de Jared (la emulación de navegador no sustituye esta prueba). |

---

## Estructura del Proyecto

- `src/domain/money/index.ts` — Aritmética exacta en céntimos enteros (`Cents`), parseo español/ISO sin coma flotante binaria, rechazo de monedas distintas de `EUR` y distinción estricta entre `null` (`Desconocido`) y `0` (`0,00 €`).
- `src/domain/dates/madrid.ts` — Límites mensuales y horarios de silencio en `Europe/Madrid` (incluyendo cambios de hora CET/CEST) y preservación de `booking_date` (`YYYY-MM-DD`) sin fabricar horas falsas.
- `src/domain/ledger/` — Cuentas (`cash`, `bank`, `savings`, `credit_card` nunca como liquidez), instantáneas de saldo (`CLBD`, `ITAV`, etc.), registros fuente inmutables, transacciones canónicas, desgloses (`splits`), nómina en efectivo y revisión obligatoria de depósitos sin origen registrado.
- `src/domain/budgets/index.ts` — Las 3 vistas financieras, liquidación atómica de obligaciones reservadas, traspaso de ahorro protegido a cuentas excluidas/incluidas, guía de ritmo diario y simulador de compras.
- `src/domain/reconciliation/index.ts` — Idempotencia por proveedor/lote, conciliación de gasto manual provisional con extracto bancario (preservando categoría/notas y con enlace reversible), actualización atómica de pendiente a asentado (`20 €` -> `22 €`) y retención de compras legítimas del mismo importe en el mismo día.
- `src/domain/alerts/index.ts` — Detección de cruce de umbrales (`50%`, `75%`, `90%`, `100%`), emisión de una única alerta de máxima severidad al saltar varios umbrales, idempotencia por `(user_id, budget_id, period_key, threshold_percent)` y validación SSRF de endpoints Web Push.
- `src/domain/categorization/index.ts` — Jerarquía determinista de categorización (corrección bloqueada > regla de usuario > heurística de comercio > sugerencia de proveedor > desconocido), detección de candidatos recurrentes y analítica comparativa.
- `src/domain/csv/index.ts` — Previsualización, mapeo de columnas, rechazo de éxitos parciales silenciosos, reversión por lote y sanitización contra inyección de fórmulas.
- `src/domain/offline/index.ts` — Cola local por usuario con claves de idempotencia, bloqueo de subida cruzada entre usuarios y aviso antes de cerrar sesión con datos pendientes.
- `src/server/providers/enableBanking.ts` — Adaptador Enable Banking y motor de sincronización paginada resistente a fallos intermedios.
- `supabase/migrations/` — Esquema PostgreSQL con `BIGINT`, claves foráneas compuestas `(id, user_id)`, `FORCE ROW LEVEL SECURITY`, esquema privado `app_private` y RPCs atómicos.
- `supabase/functions/` — Funciones de servidor (`bank-auth`, `bank-callback`).

---

## Comandos de Desarrollo y Pruebas

```bash
# Instalar dependencias (con package-lock.json fijado)
npm install

# Ejecutar suite de pruebas unitarias, de aceptación (24 escenarios) e integración
npm test

# Compilar TypeScript estricto y generar bundle de producción PWA
npm run build

# Ejecutar pruebas E2E de navegador con Playwright
npm run test:e2e
```

## Documentación Operativa y Técnica

- [Guía de Configuración, Enable Banking (2 pasos) y Checklist iPhone](file:///d:/0000%20Autonomo/Webs/App%20dinero/docs/SETUP_GUIDE.md)
- [Decisión de Proveedor Bancario y Spike de Runtime (M0)](file:///d:/0000%20Autonomo/Webs/App%20dinero/docs/PROVIDER_DECISION.md)
- [Documentación del Modelo Financiero e Invariantes](file:///d:/0000%20Autonomo/Webs/App%20dinero/docs/FINANCIAL_MODEL.md)
- [Modelo de Amenazas, Seguridad, Costes y Despliegue/Rollback](file:///d:/0000%20Autonomo/Webs/App%20dinero/docs/THREAT_MODEL_AND_OPERATIONS.md)
- [Informe de Pruebas y Evidencia de Aceptación](file:///d:/0000%20Autonomo/Webs/App%20dinero/docs/TEST_REPORT.md)
