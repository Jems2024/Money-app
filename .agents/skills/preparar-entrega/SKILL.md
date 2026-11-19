---
name: preparar-entrega
description: Prepara un resumen para revisión o pull request después de cambios de código, pruebas o documentación, verificando el estado Git y los controles disponibles.
---

# Preparar entrega

1. Ejecutar `git status --short`, `git diff --check` y `git diff --stat`; incluir archivos no seguidos al resumir el alcance.
2. Ejecutar el comando de pruebas disponible e indicar el resultado real.
3. Proponer un título breve de pull request y un resumen de cambios.
4. Enumerar pruebas ejecutadas, riesgos pendientes y lista breve para revisión humana.
5. No ejecutar `git add`, `git commit`, `git push`, crear PR ni afirmar que hubo despliegue, salvo autorización explícita.
