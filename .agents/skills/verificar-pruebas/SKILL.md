---
name: verificar-pruebas
description: Comprueba y amplía las pruebas automatizadas de un proyecto cuando se necesita validar cambios, cubrir casos límite o investigar una regresión.
---

# Verificar pruebas

1. Detectar el entorno y el comando de pruebas real del repositorio (por ejemplo `npm test`, `dotnet test` o `pytest`).
2. Ejecutar primero las pruebas existentes e informar su estado de partida.
3. Si se solicita cobertura adicional, agregar pruebas pequeñas para casos normales y límites sin modificar código productivo solo para forzar un resultado verde.
4. Ejecutar nuevamente las pruebas y detallar resultados, fallos y archivos modificados.
5. No instalar paquetes ni alterar configuración sin justificación y aprobación.
