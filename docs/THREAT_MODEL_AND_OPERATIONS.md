# Modelo de Amenazas, Operaciones, Costes, Despliegue y Limitaciones Conocidas

## 1. Modelo de Amenazas y Controles de Seguridad (Sección 11)

| Amenaza / Superficie | Control Implementado | Ubicación en Código |
| :--- | :--- | :--- |
| **Acceso cruzado entre usuarios (IDOR / BOLA) o manipulación de `user_id`** | Row-Level Security (`ENABLE` + `FORCE ROW LEVEL SECURITY`) en las 17 tablas públicas de PostgreSQL con `(SELECT auth.uid()) = user_id`. Claves foráneas compuestas `(id, user_id)` impiden enlazar registros propios a cuentas o transacciones de otro usuario. El servidor valida la propiedad con `enforceRowOwnership` y `enforceCompositeReferenceOwnership`. | `supabase/migrations/20261030000001_stop_spend_schema_rls.sql`, `src/server/security/rlsEnforcement.ts` |
| **Exposición de claves privadas bancarias o `service_role` en el navegador** | Separación estricta en `.env.example` y verificación automatizada sobre `dist/assets/` (`tests/integration/database-rls-constraints.test.ts`). Secretos de conexión y payloads crudos viven en el esquema privado `app_private` con `REVOKE ALL FROM PUBLIC, anon, authenticated`. | `.env.example`, `supabase/migrations/20261030000001_stop_spend_schema_rls.sql` |
| **Ataques de CSRF, Replay o vinculación cruzada en el callback bancario** | Estado criptográfico aleatorio de 256 bits de un solo uso (`generateOneTimeAuthState`), almacenado como hash `SHA-256` con TTL de 10 minutos y vinculado al `initiating_user_id`. Rechaza estados caducados, repetidos (`consumed_at IS NOT NULL`) o de otro usuario, y limpia `code`/`state` de la URL tras procesarlos. | `src/server/providers/enableBanking.ts` |
| **SSRF mediante URLs de suscripción Web Push manipuladas** | Lista blanca estricta de dominios oficiales de servicios push (`.push.apple.com`, `fcm.googleapis.com`, `.push.services.mozilla.com`, `.notify.windows.com`) exigiendo `https:` sin puertos ni credenciales, bloqueando IPs privadas y `localhost`. | `src/domain/alerts/index.ts` (`validateSafeWebPushEndpoint`) |
| **Inyección de fórmulas en exportación CSV (CSV Injection)** | Sanitización de celdas que comienzan por `=`, `+`, `-`, `@`, `\t` o `\r` anteponiendo comilla simple `'` y escapando comillas dobles. | `src/domain/csv/index.ts` (`sanitizeCsvCellForExport`) |
| **XSS / Interpretación de texto bancario o CSV como instrucciones** | Renderizado exclusivo mediante nodos de texto de React (cero uso de `dangerouslySetInnerHTML`), cabeceras de seguridad (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`) y ausencia total de LLMs que procesen descripciones bancarias. | `vite.config.ts`, `src/App.tsx` |
| **Fuga de datos financieros en caché offline o al cambiar de usuario** | El Service Worker (`public/sw.js`) solo cachea el shell estático, nunca respuestas de API ni datos bancarios. La cola offline (`src/domain/offline/index.ts`) aísla cada entrada por `userId`, impide que un segundo usuario suba la cola del primero y advierte antes de cerrar sesión si existen entradas sin sincronizar. | `public/sw.js`, `src/domain/offline/index.ts` |

### Procedimiento de Rotación de Claves
1. **Clave RSA de Enable Banking (`ENABLE_BANKING_PRIVATE_KEY_PEM`):** Generar un nuevo par RSA 2048/4096 bits, registrar el nuevo certificado en el Control Panel de Enable Banking, actualizar `ENABLE_BANKING_APP_ID` y `ENABLE_BANKING_PRIVATE_KEY_PEM` en Supabase Secrets y revocar la clave anterior en el panel de Enable Banking.
2. **Claves VAPID (`VAPID_PRIVATE_KEY_JWK` / `VITE_VAPID_PUBLIC_KEY`):** Generar un nuevo par P-256, actualizar el secreto en el servidor y la clave pública en el cliente, y solicitar la renovación de suscripción en los dispositivos activos.

---

## 2. Lista de Control de Costes y Límites de Uso (Cost Checklist)
- **Cero servicios de IA de pago:** Categorización, simulación, reconciliación y analítica son 100% deterministas en TypeScript/SQL sin llamadas a APIs de LLMs ni OCR.
- **Supabase (Plan Free / Pro acotado):**
  - Retención automática de 30 días para payloads crudos en `app_private.raw_provider_payloads` (`app_private.purge_expired_evidence()`) para evitar crecimiento indefinido de almacenamiento.
  - Sincronización bancaria programada acotada a un máximo de 2–4 ejecuciones diarias por conexión activa con bloqueo por conexión (`isLocked`), respetando los límites regulatorios PSD2 sin bucles de reintento infinitos.
- **Enable Banking:** Uso bajo modalidad *Restricted (Personal Use)* vinculada únicamente a las cuentas propias del titular en el panel de control, sin coste por volumen de usuarios terceros.

---

## 3. Instrucciones de Despliegue, Copia de Seguridad y Rollback

### Despliegue a Producción
1. Verificar que todas las pruebas pasan localmente:
   ```bash
   npm test
   npm run build
   npm run test:e2e
   ```
2. Aplicar migraciones en Supabase (`npx supabase db push`) y desplegar las Edge Functions (`npx supabase functions deploy bank-auth` y `bank-callback`).
3. Desplegar la carpeta estática `dist/` en un alojamiento HTTPS con soporte de reescritura SPA (`/* -> /index.html`, conservando `/manifest.webmanifest` y `/sw.js` en la raíz).

### Copia de Seguridad y Restauración (Backup & Restore)
- **Desde la aplicación:** En **Movimientos -> Exportar CSV** puedes descargar en cualquier momento una copia íntegra de las transacciones canónicas.
- **Desde PostgreSQL (Supabase):** Ejecutar `pg_dump --schema=public --data-only` para respaldar las tablas del usuario y `psql` para restaurarlas en caso necesario.

### Procedimiento de Rollback
- **Rollback de importación CSV errónea:** Desde **Movimientos -> Lotes CSV importados**, pulsa **«Revertir lote»** junto al lote correspondiente para eliminar de forma limpia únicamente los registros de ese lote.
- **Rollback de versión de frontend PWA:** Revertir el despliegue estático al commit anterior; el Service Worker versionado actualizará el shell estático sin borrar la cola local de gastos pendientes (`stopspend_device_offline_queue_v1`).

---

## 4. Limitaciones Conocidas (Known Limitations)
1. **No bloquea pagos con tarjeta:** STOP SPEND es una herramienta de control presupuestario y lectura (AIS); no puede interceptar ni denegar pagos en el TPV o en la tarjeta de CaixaBank.
2. **Sin alertas bancarias en tiempo real garantizadas:** PSD2 en España no ofrece webhooks universales en tiempo real para cuentas particulares; la actualización depende de la sincronización programada o manual dentro de los límites de frecuencia del ASPSP.
3. **Almacenamiento local del navegador:** La cola offline utiliza almacenamiento local del dispositivo para permitir anotar gastos sin cobertura, el cual puede ser purgado por iOS si el dispositivo se queda sin espacio crítico o si el usuario borra los datos de Safari.
4. **Jurisdicción y cumplimiento:** Seleccionar una región europea en Supabase reduce la latencia y mantiene el alojamiento en la UE, pero por sí solo no constituye una certificación o auditoría legal.
