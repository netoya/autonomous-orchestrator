# Reunion: Agregar goal-seeker como Anexo M del spec (experimental)
**Fecha:** 2026-05-16
**Equipo:** softwarefactory
**Convocada por:** Angel
**Participantes:** Roman (Tech Lead), Mateo (Backend), Sofia (QA)

## Contexto

En la reunion previa concluimos que el patron goal-seeking (validador -> remedios -> validador') se puede modelar HOY en v0.6 con `flow-coordinator` + waiter activo Bash + `task_dependencies`, sin agregar features nuevas. Angel propone formalizarlo como **Anexo M experimental** para evitar que cada equipo lo reinvente.

## Discusion

### Roman (Tech Lead)

De acuerdo con formalizarlo, pero **solo como referencia experimental**.

**Que NO incluir en v0.6.1**:
- Nada en el schema SQL. `goal_id`, `iteration`, `remedy_hash` viven en `tags_json` / `metadata_json`.
- No crear `task_type` nuevos. El validador y el remediador son tasks Bash o agentes normales.
- No tocar la definicion de `flow-coordinator`. El `goal-seeker.sh` orquesta; el coordinador solo materializa tasks.

**Mitigacion de early adoption**:
- Header del anexo: **"EXPERIMENTAL - No usar en produccion sin aprobacion del Tech Lead"**.
- Spec pasa a **v0.6.1**, no v0.7. Es adicion no breaking.
- Necesitamos **2-3 casos reales** antes de promoverlo a `kind='goal-seeking'` formal.

**Garantias criticas adicionales**:
- **Timeout global** del goal-seeking (default 30 min). No iteramos infinito aunque haya progreso.
- **Logging estructurado obligatorio** en cada iteracion: `iteration`, `goal_met`, `remedy_applied`, hashes, en artifact centralizado. Sin trazabilidad esto es imposible de debuggear.

### Mateo (Backend)

**Schema del artifact (validado, con dos ajustes)**:

```json
{
  "goal_met": false,
  "iteration": 2,
  "goal_id": "implement-login-oauth",
  "timestamp": "2026-05-16T20:45:00Z",
  "missing": [
    { "id": "fix-token-validation",
      "agent_id": "softwarefactory_mateo",
      "tags": ["fix", "goal:implement-login-oauth"],
      "input": { /* ... */ } }
  ],
  "next_validator": {
    "id": "validate-login-oauth-iter-3",
    "agent_id": "softwarefactory_sofia",
    "dependsOn": ["fix-token-validation"]
  },
  "next_waiter": {
    "kind": "goal-seeker",
    "scriptPath": "bin/waiters/active/goal-seeker.sh",
    "params": { "goal_id": "implement-login-oauth", "iteration": 3, "max_iterations": 5 }
  }
}
```

Cambio: agregar `timestamp` ISO8601 al root para auditoria.

**Hash de remedios repetidos**: hash del **set ordenado** de `(missing[].id + missing[].agent_id)`. Si dos iteraciones consecutivas emiten el mismo hash, abortar con `remedies-identical-detected: possible-infinite-loop`.

**Race condition (waiter falla mid-flight)**: el waiter debe ser **idempotente**. Antes de spawnear las tasks remediadoras, verifica si `missing[].id` ya existe en DB con `status IN ('queued','ready','running','done')`. Si existe, skip. Si el waiter falla a mitad, re-ejecutarlo es seguro porque vuelve a verificar y solo crea las que faltan.

### Sofia (QA)

**Test cases minimos para promover de experimental a formal (5)**:

1. **Loop finito**: forzar escenario donde el goal nunca se cumple; verificar corte en `max_iterations` sin crash.
2. **Deteccion de colusion (remedio repetido)**: mismo set propuesto 2+ veces consecutivas → escalar.
3. **Escalado en iter 3**: goal parcialmente cumplido pero estancado → verificar escalado a humano.
4. **Hash collision semantica**: dos remedios sintacticamente distintos pero semanticamente identicos → detectar.
5. **Rollback en fallo**: si un remedio rompe el sistema, poder revertir.

**Metricas de auditoria obligatorias**:
- Iteraciones totales ejecutadas.
- Tasks generadas por iteracion.
- Tiempo total del loop.
- `%` de loops donde `goal_met=true` al final.
- `%` de loops escalados a humano.
- **Historial de hashes de remedios** para post-mortem.

**Garantia critica adicional**: **timeout por iteracion individual** (default 5 min) independiente del contador global. Si una iteracion se cuelga, `max_iterations` no sirve.

## Convergencias

- Anexo M va con header **EXPERIMENTAL**.
- Spec pasa a **v0.6.1** (no v0.7).
- **No se agregan columnas SQL**. `goal_id`, `iteration`, `remedy_hash` viven en `tags_json` y/o `metadata_json` de tasks/artifacts.
- 5 test cases minimos definidos.
- Hash de remedios identicos sobre set ordenado de `(id + agent_id)`.
- Idempotencia via re-check de existencia de tasks antes de spawnear.

## Garantias consolidadas (las 8)

| # | Garantia | Default | Quien la propuso |
|---|---|---|---|
| 1 | `max_iterations` | 5 | Roman (sesion previa) |
| 2 | Escalado a humano en iteracion 3 sin exito | obligatorio | Sofia (sesion previa) |
| 3 | Hash de remedios identicos consecutivos | abort si match | Roman / Mateo |
| 4 | Roles separados validador / remediador | obligatorio | Sofia |
| 5 | Validador no toca el criterio de exito | obligatorio (idempotency_key) | Roman / Sofia |
| 6 | **Timeout global del goal-seeking** | 30 min | Roman |
| 7 | **Timeout por iteracion individual** | 5 min | Sofia |
| 8 | **Idempotencia del waiter al spawnear tasks** | obligatorio | Mateo |

## Decisiones

1. Agregar **Anexo M — `goal-seeker.sh` (EXPERIMENTAL)** al spec con header de advertencia.
2. Spec pasa a **v0.6.1**.
3. **NO se modifica schema SQL**. Todo el estado del goal vive en `tags_json` y `metadata_json`.
4. **NO se introduce `kind='goal-seeking'` formal**. Hoy es `kind='goal-seeker'` como cualquier waiter activo custom.
5. Anexo M debe incluir: script Bash completo, schema del artifact, pseudocodigo del validador, tabla de las 8 garantias, 5 test cases minimos, criterios de promocion a formal.
6. Roman aprueba 2-3 casos reales antes de promoverlo en una version futura.
7. Mencion breve en seccion 3.3.3 dentro del catalogo de waiters base, marcando explicitamente "EXPERIMENTAL".

## Action Items

| Responsable | Tarea | Fecha |
|---|---|---|
| Roman | Actualizar spec.md a v0.6.1 con Anexo M + mencion en 3.3.3 | 2026-05-17 |
| Mateo | Implementar `bin/waiters/active/goal-seeker.sh` siguiendo el anexo | 2026-05-25 |
| Sofia | Test suite `bats` con los 5 test cases minimos | 2026-05-28 |
| Roman | Despues de 2-3 casos reales, evaluar promocion a `kind='goal-seeking'` formal | 2026-06-30 |
