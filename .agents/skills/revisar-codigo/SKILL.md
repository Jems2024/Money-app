---
name: revisar-codigo
description: Revisa cambios o módulos de código para detectar errores lógicos, casos límite sin cubrir, riesgos de seguridad y áreas de mejora en mantenibilidad antes de integrar cambios.
---

# Revisar código

1. Leer los archivos objetivo, sus pruebas relacionadas y `git diff` (si aplica) antes de emitir conclusiones.
2. Analizar el código por orden de prioridad: errores de lógica o regresiones, casos límite no manejados, riesgos de seguridad y oportunidades claras de legibilidad o mantenibilidad.
3. Presentar los hallazgos ordenados por severidad (`Crítico`, `Alto`, `Medio`, `Bajo`), indicando archivo, líneas afectadas, motivo concreto y propuesta de solución.
4. No modificar archivos de producción ni pruebas durante la revisión salvo solicitud explícita del usuario.
5. Cerrar con un veredicto breve indicando si el código está listo para continuar o qué puntos conviene corregir primero.
