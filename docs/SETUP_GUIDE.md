# STOP SPEND — Guía Operativa, Configuración Supabase y Despliegue

## 1. Datos conocidos del proyecto

- **Nombre del proyecto:** `STOP SPEND`
- **Supabase Project Reference ID:** `zsnvclyoypabmgqqaizj`
- **URL del proyecto Supabase:** `https://zsnvclyoypabmgqqaizj.supabase.co`
- **Región actual:** `us-east-1` (North Virginia)
- **Repositorio GitHub:** `https://github.com/Jems2024/Money-app.git`
- **URL HTTPS desplegada (GitHub Pages):** `https://jems2024.github.io/Money-app/`

---

## 2. Evaluación de región: `us-east-1` vs Región Europea (`eu-west-1` / `eu-central-1`)

Tu proyecto Supabase actual (`zsnvclyoypabmgqqaizj`) está alojado en **`us-east-1` (North Virginia, EE. UU.)**. Antes de importar extractos bancarios reales de CaixaBank o registrar tu historial financiero personal desde España, ten en cuenta:

1. **Soberanía de datos y RGPD (GDPR):**
   - Al residir en España y conectar datos financieros personales (movimientos de CaixaBank, IBAN enmascarado, saldos y comercios), alojar la base de datos en la Unión Europea (`eu-central-1` Frankfurt o `eu-west-1` Irlanda) mantiene tus datos bancarios íntegramente bajo jurisdicción europea.
   - Además, proveedores PSD2 europeos como **Enable Banking** operan desde la UE (Finlandia); mantener los webhooks/callbacks y la base de datos en la UE simplifica el cumplimiento normativo y evita transferencias internacionales innecesarias.
2. **Latencia desde España (iPhone y Edge Functions):**
   - Desde España, una consulta a `us-east-1` añade ~90–120 ms de latencia de red por viaje de ida y vuelta, frente a ~25–35 ms hacia `eu-west-1` o `eu-central-1`. En una app móvil pensada para comprobar tu disponible en menos de 10 segundos antes de pagar, la respuesta desde Europa es notablemente más ágil.
3. **Recomendación práctica:**
   - **No hemos eliminado ni recreado automáticamente tu proyecto `zsnvclyoypabmgqqaizj`.** Toda la configuración de este repositorio está lista para funcionar hoy mismo contra `zsnvclyoypabmgqqaizj`.
   - **¿Merece la pena cambiar antes de importar datos reales?** **Sí, es recomendable** si aún no has cargado datos reales en `zsnvclyoypabmgqqaizj`. Dado que las migraciones SQL (`supabase/migrations/`) y las Edge Functions (`supabase/functions/`) están 100% automatizadas en este repositorio, crear un proyecto nuevo en `eu-west-1` o `eu-central-1` y ejecutar `npx supabase link` + `npx supabase db push` lleva menos de 3 minutos. Si prefieres conservar `zsnvclyoypabmgqqaizj` en `us-east-1`, para uso estrictamente personal funciona sin ningún impedimento técnico.

---

## 3. Distinción estricta: Variables públicas (Frontend) vs Secretos de servidor

> **Regla de seguridad:** Nunca pegues contraseñas de base de datos, tokens de acceso, `SUPABASE_SERVICE_ROLE_KEY` ni claves privadas RSA en el chat ni en archivos `.env` subidos a Git.

### A. Variables públicas del Frontend (seguras en el navegador bajo RLS estricto)
Se configuran en tu archivo local `.env.local` (ignorado por Git) y en **GitHub Repository Variables** (`Settings -> Secrets and variables -> Actions -> Variables`):

| Variable exacta | Valor / Dónde obtenerla |
| :--- | :--- |
| `VITE_SUPABASE_URL` | `https://zsnvclyoypabmgqqaizj.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | En Supabase Dashboard -> **Project Settings -> API**. Copia la **Publishable key** (`sb_publishable_...`) o la clave `anon` `public`. |
| `VITE_SUPABASE_ANON_KEY` | Opcional si ya definiste `VITE_SUPABASE_PUBLISHABLE_KEY`. Acepta la clave `anon` `public` tradicional (`eyJ...`). |
| `VITE_VAPID_PUBLIC_KEY` | Opcional. Clave pública VAPID si activas notificaciones Web Push. |

### B. Secretos exclusivos de servidor (Supabase Edge Functions Vault)
Nunca llevan el prefijo `VITE_` y **jamás** se exponen al navegador. Se configuran mediante `npx supabase secrets set` directamente desde tu terminal:

- `SUPABASE_SERVICE_ROLE_KEY` (inyectado automáticamente por Supabase en Edge Functions).
- `CRON_SHARED_SECRET` (secreto aleatorio generado por ti para autenticar la ejecución programada de `bank-sync` y `alerts-dispatch`).
- `ENABLE_BANKING_APP_ID`, `ENABLE_BANKING_PRIVATE_KEY_PEM`, `ENABLE_BANKING_REDIRECT_URI` (permanecen **sin configurar** hasta que tengas tu alta real en Enable Banking).

---

## 4. Paso a paso para conectar `zsnvclyoypabmgqqaizj`, aplicar migraciones y desplegar funciones

Ejecuta estos pasos directamente en tu terminal local (PowerShell) dentro de `d:\0000 Autonomo\Webs\App dinero`:

### Paso 1: Configurar `.env.local` para desarrollo local
1. Copia la plantilla:
   ```powershell
   Copy-Item .env.example .env.local
   ```
2. Abre https://supabase.com/dashboard/project/zsnvclyoypabmgqqaizj/settings/api
3. Copia tu clave pública (`anon` / `publishable`) y pégala en `.env.local` en `VITE_SUPABASE_PUBLISHABLE_KEY=...`.

### Paso 2: Autenticar Supabase CLI y enlazar el proyecto
1. Inicia sesión en la CLI de Supabase (abrirá el navegador para autorizar tu sesión de forma segura):
   ```powershell
   npx supabase login
   ```
2. Enlaza el directorio local con tu proyecto `zsnvclyoypabmgqqaizj`:
   ```powershell
   npx supabase link --project-ref zsnvclyoypabmgqqaizj
   ```
   *(Cuando te solicite la contraseña de la base de datos de Supabase, introdúcela directamente en la terminal).*

### Paso 3: Inspeccionar el estado de migraciones y aplicar el esquema con RLS
1. Comprueba qué migraciones están pendientes sin alterar datos existentes:
   ```powershell
   npx supabase migration list
   ```
2. Aplica las 3 migraciones del proyecto (`20261030000001_stop_spend_schema_rls.sql`, `20261030000002_cron_and_rpcs.sql`, `20261030000003_scheduled_jobs_and_triggers.sql`):
   ```powershell
   npx supabase db push
   ```
   Esto crea las 17 tablas públicas con importes en céntimos enteros (`BIGINT`), claves foráneas compuestas `(id, user_id)`, `FORCE ROW LEVEL SECURITY`, el esquema privado `app_private` y el trigger automático `on_auth_user_created` que aprovisiona tus 3 cuentas base vacías y el estado `unconfigured` de CaixaBank.

### Paso 4: Desplegar las Edge Functions
```powershell
npx supabase functions deploy bank-auth --project-ref zsnvclyoypabmgqqaizj
npx supabase functions deploy bank-callback --project-ref zsnvclyoypabmgqqaizj
npx supabase functions deploy bank-sync --project-ref zsnvclyoypabmgqqaizj
npx supabase functions deploy alerts-dispatch --project-ref zsnvclyoypabmgqqaizj
```

### Paso 5: Configurar Auth privado para tu cuenta personal (sin registro público)
1. En https://supabase.com/dashboard/project/zsnvclyoypabmgqqaizj/auth/url-configuration:
   - **Site URL:** `https://jems2024.github.io/Money-app`
   - **Redirect URLs:**
     - `https://jems2024.github.io/Money-app/**`
     - `http://localhost:5173/**`
2. En https://supabase.com/dashboard/project/zsnvclyoypabmgqqaizj/auth/providers (Email):
   - Desactiva **Allow new users to sign up** para impedir el registro público.
3. En https://supabase.com/dashboard/project/zsnvclyoypabmgqqaizj/auth/users:
   - Pulsa **Add user -> Create new user**, introduce tu correo personal y contraseña, y marca **Auto Confirm User**.
   - Al crearse el usuario, el trigger `on_auth_user_created` inicializará automáticamente tus cuentas (`Efectivo en mano`, `Cuenta CaixaBank`, `Cuenta Ahorro Separada`) y dejará Enable Banking en estado **Sin configurar**.

### Paso 6: Añadir la clave pública al despliegue HTTPS en GitHub Pages
Para que la versión publicada en `https://jems2024.github.io/Money-app/` conecte directamente con tu proyecto Supabase:
1. Ve a `https://github.com/Jems2024/Money-app/settings/variables/actions`
2. Pulsa **New repository variable**:
   - **Name:** `VITE_SUPABASE_PUBLISHABLE_KEY`
   - **Value:** *(tu clave pública `anon` / `publishable` de Supabase)*
3. Re-ejecuta el workflow **Deploy STOP SPEND PWA to GitHub Pages** en la pestaña **Actions** de GitHub.

---

## 5. Integración bancaria CaixaBank (Enable Banking) — Estado actual: `Sin configurar`

- La interfaz muestra explícitamente **Sin configurar** hasta que dispongas del Application ID, la clave privada RSA y completes la autorización PSD2 real.
- Cuando decidas activarla en el futuro:
  1. **Paso A (Panel del proveedor — Activación restringida):** Vincula tu cuenta propia en el panel de control de Enable Banking para uso personal restringido.
  2. **Paso B (Secretos en Supabase):**
     ```powershell
     npx supabase secrets set ENABLE_BANKING_APP_ID=tu_app_id --project-ref zsnvclyoypabmgqqaizj
     npx supabase secrets set ENABLE_BANKING_KEY_ID=tu_key_id --project-ref zsnvclyoypabmgqqaizj
     npx supabase secrets set ENABLE_BANKING_REDIRECT_URI=https://zsnvclyoypabmgqqaizj.supabase.co/functions/v1/bank-callback --project-ref zsnvclyoypabmgqqaizj
     ```
  3. **Paso C (Autorización en STOP SPEND):** Inicia el flujo desde la pestaña **Banco** para autenticar tu lectura de 90 días directamente en CaixaBank.

---

## 6. Instalación de la PWA en tu iPhone (iOS Safari)

1. Abre **Safari** en tu iPhone y entra en `https://jems2024.github.io/Money-app/`.
2. Toca el botón **Compartir** (icono de cuadrado con flecha hacia arriba en la barra inferior).
3. Desliza hacia abajo y selecciona **Añadir a pantalla de inicio**.
4. Pulsa **Añadir** arriba a la derecha.
5. Abre **STOP SPEND** desde el icono en tu pantalla de inicio: se ejecutará a pantalla completa (`standalone`), en modo oscuro nativo y con soporte de cola offline (`IndexedDB`) para apuntar gastos incluso sin cobertura.
