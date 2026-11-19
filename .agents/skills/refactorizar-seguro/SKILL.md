---
name: refactorizar-seguro
description: Refactoriza código para mejorar legibilidad y organización sin cambiar el comportamiento observable, comprobándolo con pruebas antes y después.
---

# Refactorizar de forma segura

1. Revisar el módulo indicado y ejecutar pruebas existentes como línea base.
2. Identificar cambios internos pequeños que mejoren nombres, estructura o duplicación.
3. Mantener firmas públicas, resultados, errores y reglas de negocio existentes.
4. Realizar el refactor mínimo y volver a ejecutar las pruebas.
5. Revisar `git diff` y describir modificaciones, pruebas y límites de la validación.
6. No introducir correcciones funcionales encubiertas: tratarlas como tareas aparte.
