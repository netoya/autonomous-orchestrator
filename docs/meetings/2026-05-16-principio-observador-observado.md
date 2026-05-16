# Reunion: Principio de separacion observador / objeto observado
**Fecha:** 2026-05-16
**Equipo:** softwarefactory
**Convocada por:** Angel
**Participantes:** Roman (Tech Lead), Camila (PM)

## Contexto

Angel pasa un texto formal para incorporar al spec como subseccion conceptual. El texto formaliza un principio arquitectonico que ya esta implicito en la spec v0.4 pero nunca fue declarado explicitamente:

> Las tareas no controlan el futuro del flujo. Los observadores coordinan la continuidad a partir de estados verificables.

En palabras de Angel: el sistema no funciona por "encadenamiento imperativo", sino por **observacion desacoplada de condiciones**.

## Discusion

### Roman (Tech Lead)

**Coherencia con la implementacion actual**: si, es coherente. Los waiters activos/pasivos ya implementan este patron. Las tasks emiten eventos (trigger SQLite -> tabla `events`); los waiters observan y deciden.

**Zona gris detectada**: si permitimos que un agente encole otra task mediante un `enqueueTask()` directo, **estariamos violando el principio**. El agente actuaria como continuador, no como observador externo. Necesitamos cerrar esa puerta a nivel API.

**Ubicacion recomendada (opcion c)**:
- **Seccion 1.7** como principio arquitectonico fundamental (al nivel de inmutabilidad / idempotencia).
- **Referencia cruzada desde 7.10** (coordinacion reactiva) marcando que waiters + scheduler son la manifestacion practica de este principio.

**Consecuencias practicas sobre la API**: los agentes NO deben llamar `enqueueTask()` directamente. En su lugar emiten eventos de dominio (`task.finished`, `artifact.ready`, `gate.approved`). El scheduler lee esos eventos, evalua waiters, encola dependientes. Excepcion controlada: tasks de orquestacion explicita (ej. un flow-coordinator) pueden encolar subtasks, pero modelado como responsabilidad declarada, no side-effect oculto.

**4 reglas accionables derivadas**:
1. **Prohibicion de llamadas encadenadas**: una task no invoca `enqueueTask()` para su continuacion. Solo emite estado final.
2. **Waiters como unica fuente de continuidad**: toda dependencia task→task se modela como waiter con condicion verificable.
3. **Idempotencia de decisiones**: si un waiter evalua dos veces el mismo estado, decide lo mismo.
4. **Separacion de responsabilidades**: tasks ejecutan logica de negocio; waiters deciden coordinacion; scheduler orquesta ejecucion.

### Camila (Product Manager)

**Cambio mental para stakeholders**: antes pensamos "si esto termina bien, ejecuta aquello"; ahora "esta tarea existe porque esta otra ya paso". Giro de 180 grados: de **empujar trabajo** a **declarar prerequisitos**. Mas natural para negocio: "no puedo cobrar hasta que haya validacion" vs "la validacion debe disparar cobranza".

**Plantilla de sprint**: hay que reforzarlo. Propone eliminar cualquier campo tipo `onSuccess`, `nextTask`, `callbackTo` en la API de declaracion de tasks. Solo se permiten `dependsOn`, `dependsOnTag`, `waitFor`. Si alguien quiere encadenar, lo declara desde la tarea **dependiente**, no desde la que termina.

**Comunicacion al equipo y operadores externos**: usar analogia clara: *"Las tareas no tienen telefonos. Terminan y se van. Otras tareas estan atentas y arrancan cuando ven que ya pueden hacerlo"*. Comparable a semaforos vs coordinadores de trafico.

## Convergencias

- El principio se incorpora al spec en **dos lugares**: declaracion en 1.7 + referencia operativa desde 7.10.
- Las tasks **no pueden invocar `enqueueTask()`** ni equivalentes. Solo emiten estado.
- La API de declaracion de tasks **prohibe campos imperativos** (`onSuccess`, `nextTask`, `callbackTo`); solo acepta declarativos (`dependsOn`, `dependsOnTag`, `waitFor`).
- Excepcion controlada: un `flow-coordinator` agent puede expandir subtasks, pero eso esta modelado explicitamente como rol y no como side-effect.
- Comunicacion publica usa la analogia *"las tareas no tienen telefonos"* para evitar lenguaje filosofico.

## Decisiones

1. Spec pasa a v0.5. Se agrega **seccion 1.7 "Separacion entre observador y objeto observado"** con el texto literal aportado por Angel + ampliacion de Roman.
2. Las 4 reglas accionables se incorporan como **subseccion 1.7.1 "Reglas operativas derivadas"**.
3. Seccion 7.10 abre con una nota cruzada al principio 1.7.
4. La API de declaracion de tasks (`defineTask`) prohibe campos imperativos. Cualquier intento de definir `onSuccess`, `nextTask` o `callbackTo` falla con error de validacion al cargar el sprint.
5. Auditoria de coherencia: revisar la spec actual y eliminar (o marcar como out-of-scope) cualquier mencion implicita a que una task encadena otra.

## Action Items

| Responsable | Tarea | Fecha |
|---|---|---|
| Roman | Actualizar spec.md a v0.5: seccion 1.7 + reglas + referencia cruzada desde 7.10 | 2026-05-17 |
| Roman | Auditoria de coherencia: pasar el spec actual y verificar que no haya menciones a `enqueueTask` por parte de tasks | 2026-05-18 |
| Mateo | Validador de schema de `defineTask` que rechace campos imperativos | 2026-05-22 |
| Camila | Plantilla publica del sprint declarativo con la analogia "las tareas no tienen telefonos" | 2026-05-24 |
