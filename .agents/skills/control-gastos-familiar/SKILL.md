---
name: control-gastos-familiar
description: Sistema de control financiero familiar multi-usuario con cuentas separadas y presupuesto unido para CaixaBank. Usar para gestionar recibos fijos, gastos hormiga, sobres y PWA.
---

# Control Gastos Familiar (Multi-Usuario)

Este skill actua como el cerebro financiero y arquitecto tecnico para un matrimonio donde cada uno tiene su propia cuenta bancaria y su propio usuario, pero unen sus finanzas en un fondo familiar comun.

## Reglas de Negocio Multi-Usuario

1. **Dos Usuarios y Dos Cuentas Bancarias (`Supabase Auth`):**
   - Existen dos perfiles autenticados (`Usuario 1: Esposo` y `Usuario 2: Esposa`).
   - Cada usuario vincula su propia cuenta bancaria (via Enable Banking PSD2 o subida de CSV/manual). Cada cuenta guarda su propio saldo y su `owner_user_id`.

2. **Doble Calculo de Dinero Real Libre (Familiar vs. Por Cuenta):**
   - **Dinero Real Libre Familiar:** `(Saldo Cuenta Esposo + Saldo Cuenta Esposa) - Total Recibos Fijos Pendientes de ambos - Meta de Ahorro Familiar`.
   - **Liquidez por Cuenta Individual:** `Saldo Cuenta X - Recibos Fijos Pendientes domiciliados en esa cuenta`. Advierte si falta saldo para cubrir sus propios recibos.

3. **Recibos Fijos con Identificador y Cuenta de Cargo:**
   - Cada recibo tiene un `custom_code` (ej. `REC-ALQUILER`), estado (`Pagado` / `Pendiente`) y la cuenta de cargo asignada.

4. **Sobres Dinamicos Mensuales:**
   - Configurables cada mes: **Gastos Hormiga**, **Gasto Libre Individual**, **Supermercado** y **Meta de Ahorro**.

5. **Regla del Supermercado y Bandeja de Dudas:**
   - Bares y cafeterias van directo a `hormiga`. Los supermercados quedan en `needs_review = true` para confirmar con 1 toque si fue compra necesaria o capricho.

6. **Alertas Web Push (80% y 100%):**
   - Notificaciones nativas gratuitas a los dos moviles al alcanzar el 80% y el 100% de los sobres.