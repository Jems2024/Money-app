# Decisión de Proveedor Bancario y Spike de Viabilidad (M0)

**Fecha de consulta y verificación documental:** `2026-10-30` (Europa/Madrid)  
**Estado de la integración bancaria en esta entrega:**
- **Código del adaptador y pruebas de contrato:** Implementado (`EnableBankingProvider`).
- **Pruebas en Sandbox:** Soportadas y verificadas con fixtures de contrato; requiere credenciales de cuenta de desarrollador del usuario para tráfico en vivo.
- **Producción con cuenta propia (CaixaBank):** **Pendiente de alta y vinculación manual por el usuario (Jared)**. No se ha accedido a ninguna cuenta real ni se afirma verificación en producción.

---

## 1. Matriz de decisión de proveedores (España / CaixaBank / Uso personal privado)

| Proveedor | Elegibilidad para uso personal (1 usuario privado) | Cobertura España / CaixaBank | Modelo técnico / Seguridad | Decisión |
| :--- | :--- | :--- | :--- | :--- |
| **Enable Banking** | **Sí (Modo Restringido / Uso personal)**. Sus *Terms of Service* y la guía *Whitelisting own accounts* permiten registrar una aplicación en producción en modo restringido vinculada exclusivamente a las cuentas propias del desarrollador sin contrato comercial B2B. | **Sí (`CaixaBank`, país `ES`)**. Documentado en `enablebanking.com/docs/markets/es` y guía oficial en `tilisy.enablebanking.com/guides/ES/CaixaBank/` (vía pasarela PSD2 Redsys / CaixaBankNow). | API REST autenticada con JWT firmado en servidor (`RS256`, cabecera `kid` = Application ID, `iss: enablebanking.com`, `aud: api.enablebanking.com`). Flujo `POST /auth` -> redirección SCA CaixaBankNow -> `POST /sessions` -> `GET /accounts/{id}/balances` y `/transactions` paginados con `continuation_key`. | **SELECCIONADO (Candidato primario)** |
| **Salt Edge (AIS v5)** | **No confirmado / Enfoque B2B**. Ofrece entorno Sandbox para pruebas técnicas, pero el acceso a datos reales en producción requiere proceso comercial y validación de entidad empresarial. | Lista España en su catálogo dinámico, pero la ficha específica y condiciones para un particular no están garantizadas sin contrato. | API v5 con firma de peticiones. | **Descartado para v1 (Solo reserva documental)** |
| **Tink** | **No**. Tink publica explícitamente en `tink.com/get-started/` que no da servicio a casos de uso no empresariales (*non-business use cases*). | Sí en ámbito corporativo, no disponible para un particular. | OAuth2 B2B. | **Descartado** |
| **Acceso directo PSD2 CaixaBank (Redsys XS2A)** | **No**. Requiere licencia regulatoria AISP (Banco de España / EBA) y certificados cualificados eIDAS (QWAC / QSealC). Además, el nodo documental `market.apis-i.redsys.es/psd2/xs2a/nodos/caixabank` devolvió HTTP 502 en la revisión del `2026-10-30`. | Directo para TPPs regulados. | Certificados eIDAS + Berlin Group NextGenPSD2. | **Descartado** |
| **Fintonic / Scraping / APIs privadas** | **Prohibido por contrato de producto**. | N/A | Solicitud de credenciales bancarias o APIs privadas no documentadas. | **Prohibido** |

---

## 2. Distinción entre Evidencia, Inferencia e Incógnitas (CaixaBank vía Enable Banking)

### Evidencia verificada (30/10/2026)
1. **Licencia de uso restringido para cuentas propias:** Enable Banking documenta en `https://enablebanking.com/terms/` y `https://enablebanking.com/docs/api/linked-accounts` que una aplicación de producción sin acuerdo comercial permanece en estado **Restricted**, pudiendo consultar únicamente cuentas bancarias previamente vinculadas (*whitelisted/linked*) por el propio titular en el panel de control.
2. **Separación de dos pasos obligatorios:**
   - **Paso A (Panel de Enable Banking):** El titular debe vincular primero su cuenta de CaixaBank en la sección *Linked Accounts* del Control Panel para autorizar que su aplicación restringida pueda acceder a ese IBAN.
   - **Paso B (Flujo dentro de STOP SPEND):** La aplicación inicia `POST /auth` para el ASPSP `CaixaBank` (`ES`), redirige al usuario a la autenticación SCA de CaixaBankNow y canjea el `code` recibido en el callback mediante `POST /sessions`.
3. **Autenticación servidor a servidor:** Todas las llamadas a `https://api.enablebanking.com` requieren `Authorization: Bearer <JWT>` firmado con clave privada RSA (`RS256`), donde `header.kid` es el UUID de la aplicación y el payload incluye `iss: "enablebanking.com"`, `aud: "api.enablebanking.com"`, `iat` y `exp` (<= 24h, recomendado 5–60 min). No utiliza endpoints OAuth `/token` ni `refresh_token`.
4. **No sustitución silenciosa de entidad:** `CaixaBank` y `imagin` (o antiguas marcas) pueden aparecer como entradas diferenciadas o compartidas en el catálogo ASPSP según el canal; el adaptador consulta explícitamente el nombre configurado (`CaixaBank`, país `ES`) y nunca sustituye silenciosamente `CaixaBank` por otra marca sin selección explícita.
5. **Límites regulatorios de acceso desatendido (PSD2 / EBA Q&A 2018_4210):** Cuando la consulta se realiza sin presencia activa del usuario (*unattended / cron*), los ASPSPs españoles aplican límites de frecuencia (típicamente hasta 4 sincronizaciones en segundo plano cada 24 horas por consentimiento activo, con validez máxima del consentimiento de hasta 90–180 días según normativa vigente y configuración del banco).

### Inferencias razonables de diseño
1. **Tipos de saldo (`balance_type`):** CaixaBank a través de Redsys XS2A devuelve habitualmente códigos ISO 20022 / Berlin Group como `CLBD` (*Closing Booked*), `ITBD` (*Interim Booked*), `ITAV` (*Interim Available*) o `XPCD` (*Expected*). No siempre se garantiza que `ITAV` descuente todas las retenciones de tarjeta al instante; por tanto, el motor de liquidez de STOP SPEND registra en cada instantánea (`balance_snapshots`) el `balance_type` exacto y si los cargos pendientes ya están descontados (`includes_pending_debits`).
2. **Mutabilidad de identificadores entre pendiente y asentado:** En pasarelas Redsys/CaixaBank, un movimiento en estado `PDNG` puede carecer de `entry_reference` definitivo o cambiar su identificador cuando pasa a `BOOK` (asentado), e incluso variar ligeramente de importe (p. ej., preautorización de gasolinera/hotel de 20,00 EUR que asienta en 22,00 EUR). Por ello, STOP SPEND no confía únicamente en `entry_reference`/`transaction_id`, sino que implementa reconciliación determinista por ventana temporal, cuenta, moneda, comercio y estado.

### Incógnitas que requieren validación con la cuenta real de Jared
1. **Cobertura exacta de subproductos:** Mientras las cuentas corrientes de pago (IBAN ES...) están cubiertas por PSD2, ciertas tarjetas de crédito, cuentas de ahorro no transaccionales o depósitos pueden no devolverse en `POST /sessions` o requerir permisos específicos.
2. **Profundidad histórica sin SCA adicional:** La primera lectura tras SCA suele permitir más de 90 días, pero lecturas posteriores o cuentas específicas en CaixaBank pueden limitar el rango sin reautenticación.
3. **Efecto exacto de `DELETE /sessions/{session_id}` en CaixaBankNow:** `DELETE /sessions/{session_id}` invalida la sesión en Enable Banking e intenta revocar el consentimiento en el ASPSP cuando éste lo soporta, pero STOP SPEND diferencia claramente en UI entre:
   - *Pausar sincronización local*,
   - *Eliminar sesión en el proveedor (`DELETE /sessions/{id}`)*, y
   - *Revocación confirmada en CaixaBankNow* (recomendando verificarlo en la app del banco si se desea revocación inmediata garantizada).

---

## 3. Spike de Compatibilidad del Runtime (Edge Functions / Web Crypto)

**Requisito de la sección 2:** *"Test RSA signing and Web Push library compatibility with the deployed Edge runtime early. If a required library is incompatible, record a small architecture decision and use one suitable server runtime; do not add redundant backends."*

### Decisión de Arquitectura (ADR-001: Criptografía nativa con Web Crypto API)
- **Problema:** Librerías clásicas de Node como `jsonwebtoken`, `node-rsa` o `web-push` dependen frecuentemente de módulos nativos o APIs específicas de Node (`crypto.createSign`, `Buffer` heredado, streams de Node) que fallan o requieren polyfills frágiles en el runtime Deno de **Supabase Edge Functions**.
- **Solución adoptada:** Implementar la firma JWT `RS256` (para Enable Banking), la firma JWT `ES256` sobre curva `P-256` (para cabeceras VAPID RFC 8292), el cifrado `AES-256-GCM` de secretos y la generación de estados de autorización directamente sobre el estándar **W3C Web Crypto API (`globalThis.crypto.subtle`)**.
- **Resultado del Spike:** Código 100% compartido e idéntico entre Node 24 (tests Vitest) y Supabase Edge Functions (Deno), con cero dependencias externas pesadas ni backends redundantes.

---

## 4. Fuentes Oficiales Consultadas (`2026-10-30`)
1. **Enable Banking — Terms of Service:** https://enablebanking.com/terms/ (Licencia de evaluación y uso personal restringido).
2. **Enable Banking — Whitelisting own accounts:** https://enablebanking.com/docs/api/linked-accounts (Proceso en dos pasos para vincular cuentas propias en modo restringido).
3. **Enable Banking — España:** https://enablebanking.com/docs/markets/es (Particularidades de ASPSPs en España).
4. **Enable Banking — Guía CaixaBank:** https://tilisy.enablebanking.com/guides/ES/CaixaBank/ (Flujo de autenticación personal con CaixaBankNow).
5. **Enable Banking — API Reference:** https://enablebanking.com/docs/api/reference/ (Esquemas de `/aspsps`, `POST /auth`, `POST /sessions`, `/accounts/{id}/balances`, `/accounts/{id}/transactions`, `continuation_key`, `DELETE /sessions/{id}`).
6. **EBA — Q&A 2018_4210:** https://www.eba.europa.eu/single-rule-book-qa/qna/view/publicId/2018_4210 (Distinción entre solicitudes iniciadas activamente por el PSU y sincronización desatendida).
7. **Salt Edge — Cobertura España y AIS v5:** https://www.saltedge.com/products/account_information/coverage/es y https://docs.saltedge.com/account_information/v5/
8. **Tink — Get Started & Pricing:** https://tink.com/get-started/ y https://tink.com/pricing/ (Exclusión expresa de casos de uso no empresariales).
9. **Redsys — Portal PSD2 CaixaBank:** https://redsys.es/productos-y-servicios y https://market.apis-i.redsys.es/psd2/xs2a/nodos/caixabank (HTTP 502 en la consulta del 30/10/2026).
10. **WebKit — Web Push for Web Apps on iOS and iPadOS:** https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ (Requisito de PWA añadida a pantalla de inicio y gesto explícito del usuario para solicitar permiso).
11. **Supabase — Row Level Security & Cron:** https://supabase.com/docs/guides/database/postgres/row-level-security y https://supabase.com/docs/guides/cron
