# Resumen: Cambios en la Filosofia Empresarial

## De equipo a fabrica

La diferencia no es de tamano, es de naturaleza.

| Antes (equipo) | Despues (fabrica) |
|---|---|
| El humano es el operador | El humano es el product owner y auditor |
| Cada handoff requiere prompt | Los handoffs son contratos automaticos |
| El contexto vive en la conversacion | El contexto vive en estado durable |
| Trabajamos una historia a la vez | Multiples pipelines en paralelo |
| Calidad se valida al final | Calidad se valida en cada etapa |
| La fabrica se apaga cuando el operador duerme | La fabrica produce 24/7 |
| El conocimiento se pierde | El conocimiento se acumula en artefactos |

## Principios nuevos

1. **Default to autonomy**: si una decision tiene reversa barata, ejecutarla; si tiene reversa cara, gate humano.
2. **Tickets sobre conversacion**: ningun trabajo arranca sin un ticket estructurado.
3. **Hashing sobre confianza**: cada artefacto se firma. La trazabilidad es no opcional.
4. **Presupuesto explicito**: cada pipeline declara su budget de tokens antes de arrancar.
5. **Rollback como primera clase**: toda etapa es reversible o tiene compensacion.
6. **El humano gana en tiempo, no en control**: el operador puede pausar todo en 60 segundos.
7. **Aprendizaje aglomerado**: los patrones de bug detectados por Sofia se inyectan como checklists pre-commit.

## Lo que dejamos de hacer

- Pedirle al humano que decida cosas obvias.
- Repetir el contexto en cada prompt.
- Tener acuerdos verbales entre etapas.
- Mezclar "discusion" con "ejecucion": las discusiones siguen siendo humanas; la ejecucion es automatica.
- Improvisar gates de calidad. Ahora estan escritos.

## Lo que empezamos a hacer

- Disenar cada feature pensando en ser ejecutado por la fabrica (no por humanos artesanales).
- Tratar al orquestador como producto, no como herramienta interna.
- Medir costo por feature, no costo total mensual.
- Ver al operador humano como "supervisor de fabrica", no como tecleador.

## Relacion humano-IA

- El humano sigue siendo el unico que decide **que** y **por que**.
- La IA decide **como** y ejecuta.
- Las zonas grises (arquitectura, deploy a prod, hotfix) son gates explicitos.
- Confianza calibrada: cada agente tiene un track record que sube su nivel de autonomia con el tiempo.
