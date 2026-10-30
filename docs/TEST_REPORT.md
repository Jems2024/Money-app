# Informe de Pruebas y Evidencia de Aceptación (STOP SPEND)

**Fecha de ejecución:** `2026-10-30` (`Europe/Madrid`)  
**Entorno verificado:** Node.js `v24.11.0`, npm `11.6.1`, TypeScript `5.7.3`, Vite `6.4.5`, Vitest `3.2.7`, Playwright `1.50.1`.

---

## 1. Resumen de Comandos Ejecutados y Resultados Reales

| Comando | Propósito | Resultado | Duración |
| :--- | :--- | :--- | :--- |
| `npm test` (`vitest run`) | Suite unitaria, spike criptográfico M0, contrato Enable Banking, auditoría RLS/SQL y los 24 tests obligatorios de aceptación | **PASS** (4 archivos, 31 tests superados, 0 fallos) | `1.40s` |
| `npm run build` (`tsc -b && vite build`) | Verificación estricta de tipos TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`) y empaquetado PWA de producción | **PASS** (0 errores de compilación, bundle generado en `dist/`) | `9.18s` |
| `npm run test:e2e` (`playwright test`) | Flujo completo E2E en navegador real con viewport iPhone (`390x844`) contra servidor de previsualización de producción | **PASS** (1 flujo integral con 8 etapas críticas superado) | `5.2s` |

---

## 2. Matriz de Trazabilidad de los 24 Escenarios de Aceptación (Sección 12)

Todos los escenarios están implementados y verificados en `tests/unit/acceptance-24.test.ts`:

1. **Céntimos exactos (`Test 1`):** `0.10 + 0.20 = 0.30` (`30` céntimos); `"2,50"` -> `250` céntimos; `"2,505"` rechazado por defecto (`MoneyPrecisionError`) y redondeado a `251` con política explícita `'HALF_UP'`; divisas distintas de `EUR` rechazadas (`UnsupportedCurrencyError`).
2. **Efectivo y traspaso a banco (`Test 2`):** Apertura `0`, nómina `+1.250 €` en efectivo, traspaso de `1.000 €` a banco -> ingresos reconocidos `1.250 €`, efectivo `250 €`, banco `1.000 €`, fondos combinados `1.250 €`, gastos `0 €`.
3. **Ingreso sin origen registrado (`Test 3`):** Depósito bancario sin efectivo previo suficiente ni confirmación -> marcado `type: 'unknown'` y `requires_deposit_origin_review`, nunca inventado como segundo salario.
4. **Gasto manual provisional + registro bancario (`Test 4`):** Gasto manual de `2,50 €` seguido del cargo bancario de `2,50 €` -> un único gasto canónico de `2,50 €` (no `5,00 €`), conservando la categoría y nota del usuario y con enlace reversible (`undoReconciliationLink`).
5. **Dos compras reales de `2,50 €` el mismo día en el mismo comercio (`Test 5`):** Con identificadores de origen distintos (o filas distintas del mismo lote), ambas se conservan como gastos válidos (`-5,00 €` en total).
6. **Preautorización pendiente de `20 €` que asienta en `22 €` (`Test 6`):** Sustitución atómica; queda un único gasto asentado de `22 €` y cero compromiso residual de `20 €`.
7. **Saldo contable (`CLBD`) vs Saldo disponible (`ITAV`) con cargo pendiente (`Test 7`):** Saldo asentado `100 €` sin incluir cargo pendiente de `10 €` -> `90 €` estimados; saldo disponible `90 €` que ya descuenta el cargo pendiente -> sigue siendo `90 €` (no `80 €`).
8. **Pago de obligación reservada (`Test 8`):** Fondos `1.000 €` y alquiler reservado `800 €` -> `200 €` libres; tras pagar `800 €` y liberar la reserva atómicamente -> sigue siendo `200 €`.
9. **Reserva de ahorro y traspaso a cuenta excluida vs incluida (`Test 9`):** Fondos `500 €` y reserva de ahorro `100 €` -> `400 €`; al traspasar `100 €` a una cuenta de ahorro excluida y consumir la reserva -> `400 €` (no `300 €`); si la cuenta de ahorro está incluida en el alcance -> `400 €`.
10. **Plantilla de sobres personales (`Test 10`):** `174 €` asignados, `80 €` protegidos, `94 €` gastables (`40 €` compras pequeñas + `54 €` flexible). Una compra pequeña de `2,50 €` deja `37,50 €` en compras pequeñas y `91,50 €` en presupuesto gastable.
11. **Cruce de umbral del 75% e idempotencia ante concurrencia (`Test 11`):** Presupuesto `40 €`, gasto `29 €` -> añadir `2 €` -> `31 €` gastados, `9 €` restantes, una alerta del `75%`; reintento concurrente produce un único evento lógico.
12. **Salto de múltiples umbrales en una sola compra (`Test 12`):** Presupuesto `40 €`, gasto `19 €` -> añadir `25 €` -> `44 €` gastados, `-4 €` restantes -> emite una única notificación de máxima severidad (`100%`) y marca `50%`, `75%` y `90%` como gestionados.
13. **Cambio de periodo mensual y persistencia tras reinicio (`Test 13`):** El nuevo periodo `2026-11` vuelve a emitir umbrales sin que el reinicio de la app borre el historial de `2026-10`.
14. **Devolución de `5 €` sobre gasto de `20 €` y política entre periodos (`Test 14`):** Gasto neto `15 €`, ingresos inalterados; probadas explícitamente las políticas `CREDIT_CURRENT_PERIOD` y `ADJUST_ORIGINAL_PERIOD`.
15. **Previsión salarial y saldo de apertura (`Test 15`):** El salario previsto no incrementa la liquidez actual; el saldo de apertura no incrementa los ingresos mensuales.
16. **Unicidad económica entre sub-sobre y presupuesto total (`Test 16`):** Un gasto personal contado en su categoría y en el presupuesto total computa como un único gasto económico.
17. **Idempotencia de cola offline y aislamiento entre usuarios (`Test 17`):** Subir dos veces la misma operación offline crea una sola transacción; el Usuario B no puede subir la cola del Usuario A; cerrar sesión avisa si hay gastos pendientes.
18. **Reimportación CSV idéntica, solapamientos, fallos parciales e inyección de fórmulas (`Test 18`):** Reimportar el mismo CSV es idempotente; archivos solapados marcan candidatos a revisión; filas inválidas bloquean el guardado parcial silencioso; exportación CSV neutraliza `=HYPERLINK(...)` y `+SUM(...)`.
19. **Reconexión bancaria y resiliencia ante fallo de paginación (`Test 19`):** Reconectar mapea a la misma cuenta por IBAN estable; un fallo en la página 2 conserva los datos previos intactos y no avanza el cursor final.
20. **Aislamiento RLS, claves foráneas compuestas y SSRF (`Test 20`):** Usuario B no puede leer, modificar ni referenciar filas de Usuario A; acceso no autenticado rechazado; endpoints Web Push privados/HTTP bloqueados contra SSRF.
21. **Seguridad del estado OAuth bancario y ausencia de secretos en el bundle (`Test 21`):** Estados caducados, repetidos (*replay*) o de otro usuario son rechazados; no se sustituye silenciosamente `CaixaBank` por `imagin`; `dist/assets/` verificado sin claves privadas ni `service_role`.
22. **Sin configuración de proveedor (`Test 22`):** La app muestra `Sin configurar` y opera al 100% en modo manual y CSV sin simular estados bancarios falsos.
23. **Sin fondos iniciales (`Test 23`):** La liquidez libre es `null` (`"Desconocido"`), nunca `0,00 €` inventado, mientras los sobres presupuestarios siguen operativos.
24. **Fronteras de mes en Madrid, cambio de hora DST, presupuesto cero, saldos negativos, desgloses y rollover (`Test 24`):** `2026-10-31T23:30:00Z` se evalúa como `2026-11-01` en `Europe/Madrid`; cambio de hora del `2026-10-25` verificado; desglose mixto suma solo la parte personal; saldos negativos nunca se truncan a cero.

---

## 3. Verificaciones Externas Pendientes del Usuario (No Marcadas como Superadas)

Siguiendo la regla de integridad de evidencias:
1. **Conexión en vivo con CaixaBank (Sandbox / Producción restringida):** Pendiente de que el usuario registre su aplicación en Enable Banking, vincule su IBAN en *Linked Accounts* y complete el flujo SCA en CaixaBankNow.
2. **Notificaciones Web Push en iPhone físico (iOS Safari PWA):** Pendiente de ejecución manual en el iPhone físico de Jared tras desplegar en dominio HTTPS (ver `docs/SETUP_GUIDE.md`).
