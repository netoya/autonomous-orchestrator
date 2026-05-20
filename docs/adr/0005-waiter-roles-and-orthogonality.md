# ADR-005: Roles del waiter (pre-condición vs suspend/resume) son ortogonales a su modo (pasivo vs activo)

| | |
|---|---|
| **Status** | Accepted |
| **Fecha** | 2026-05-20 |
| **Version spec** | v0.8.1 |
| **Autores** | Angel Oliver, Claude Opus 4.7 (1M context) |
| **Supersedes** | — |

---

## Contexto

El spec define `waiter` como "primitivo de bloqueo/reanudación del flujo" (spec §3.3) y distingue dos **modos** de cumplimiento:

- **Pasivo** — espera input humano (CLI `waiter fulfill`, archivo en `state/inbox/`, FIFO).
- **Activo** — script Bash que poll una condición externa (DB query, file exists, HTTP health). El dispatcher lo ejecuta cada `pollIntervalMs` (Tick F).

Lo que el spec original **no explicita** es que el waiter cumple dos **roles** distintos en el ciclo de vida de una task, ortogonales al modo:

1. **Pre-condición (gate)**: el waiter existe **antes** de que la task arranque. Bloquea el `spawn` del agente. Cuando se cumple, la task entra en `ready` por primera vez.
2. **Suspend/Resume**: el waiter se crea **durante** el turno del agente. Bloquea el cierre como `done`. Cuando se cumple, el dispatcher re-invoca la misma task con `--resume sessionId` (gracias a `flow-agent-task` session strategy), y el agente continúa la conversación con todo el contexto previo.

Esta distinción importa porque hasta el 2026-05-20 **solo el rol de pre-condición funcionaba 100%**. El rol suspend/resume estaba habilitado parcialmente:

- El dispatcher tenía el handler `waiter.fulfilled` (`dispatcher.ts:331`) que re-pone la task a `ready` tras fulfill.
- El recovery al arranque (`dispatcher.ts:150-159`) transicionaba tasks con waiters pendientes a `waiting-waiter`.
- El gate de inicio (`dispatcher.ts:879-885`) chequeaba waiters pendientes **antes** de invocar al agente.

Pero **no había chequeo al cierre exitoso de la task** (`dispatcher.ts:1082-1090`): si el agente creaba un waiter durante su turno y terminaba con éxito, la task se marcaba `done` directamente; el waiter quedaba huérfano y la re-invocación nunca ocurría. Esto rompía el patrón "planner-mode iterativo" donde un agente:

1. Detecta ambigüedad → crea waiter pasivo con preguntas en `schema_json`.
2. Termina turno.
3. Operador responde via `fulfill` (CLI o visor).
4. El **mismo agente** se reanuda con `--resume`, lee el `value_json` del waiter cumplido, decide si necesita más clarificación o produce el plan firme.
5. Repite hasta convergencia.

Workaround usado pre-fix: **un flow nuevo por ronda**, pasando `previousFlowId + answers` por el prompt. Costoso (cada coordinate spawn es ~$0.10), pierde continuidad de sesión Claude (cada ronda arranca con `--resume` distinto), confunde el modelo mental del operador.

### Opciones evaluadas

| Opción | Pros | Contras |
|---|---|---|
| **A: Documentar el workaround "1 flow por ronda"** | Cero cambios al dispatcher. | Cada ronda gasta tokens del coordinator-seed extra. El agente principal pierde memoria entre rondas. Espec se vuelve más complejo (consumidores externos como el visor tienen que orquestar el ciclo). |
| **B: Activar el rol suspend/resume con un check al cierre de `runTask`** | 5 líneas de código. Aprovecha la maquinaria que ya estaba ahí (handler `waiter.fulfilled` + gate de inicio). Patrón nativo, simétrico con la pre-condición. | Cambia el contrato implícito "task con result.success → done": ahora puede ir a `waiting-waiter`. Tasks que crean waiters como "side effect" sin querer pausa quedarían huérfanas — pero ese caso no existe hoy (createWaiter es explícito). |
| **C: Marcar waiters creados mid-turn como auto-fulfilled** | Más simple aun. | Rompe la semántica del waiter — el operador NO respondió. Inútil para clarificaciones. |

### Principios aplicables

- **Principio 1.7 (Observador/observado, separación)**: el agente NO sabe quién va a fulfill su waiter, ni cuándo. Solo declara "necesito X, mi turno termina". El dispatcher (observador) re-invoca al cumplirse. La opción B mantiene este principio; A rompe parcialmente porque el agente del prepare-flow tiene que codificar la cadena `previousFlowId` en el prompt.
- **Principio 3 (Procesos cortos)**: la opción B mantiene el agente como procesos cortos (cada turno termina, el siguiente arranca limpio aunque con sesión persistida).

---

## Decisión

**Adoptar opción B**: el dispatcher chequea `listPassiveWaitersForTask(taskId)` después de un `result.success=true` del agente. Si hay waiters pendientes creados en el turno, la task transiciona a `waiting-waiter` en lugar de `done`. La maquinaria existente del handler `waiter.fulfilled` se encarga del resto.

**Resultado**: los waiters cumplen dos roles ortogonales al modo:

```
                   modo: PASIVO              modo: ACTIVO
                   (humano fulfill)          (dispatcher poll)
                   ────────────────────────  ────────────────────────
rol: PRE-COND      "espera aprobación de     "espera a que tabla X
(gate al spawn)    arquitectura antes de     tenga ≥N filas antes
                   implementar"              de migrar datos"

rol: SUSPEND/      "agente planner crea     "agente lanza npx build,
RESUME             waiter con preguntas;     crea exec-waiter; dispatcher
(durante run)      operador responde;        ejecuta; agente lee resultado
                   agente continúa"          y sigue"
```

Estos 4 cuadrantes son combinables dentro de un mismo flow, sin interferir entre sí, y compatibles con paralelismo (`MAX_WORKERS=3`) y con `task_dependencies`.

### Detalles de implementación

**Cambio aplicado** en `dispatcher.ts:1082+` (commit `32f1094`, 2026-05-20):

```ts
if (result.success) {
  // ... validateTaskArtifacts, enrichOutput ...

  // FIX #4: si el agente CREO waiters pasivos durante su turno,
  // la task no debe marcarse como done — debe pasar a waiting-waiter.
  const pendingAfterRun = listPassiveWaitersForTask(this.db, taskId);
  if (pendingAfterRun.length > 0) {
    updateTaskStatus(this.db, taskId, 'waiting-waiter', timestamp);
    finishExecution(this.db, executionId, timestamp, 'completed', ...);
    // dispatcher re-invocará al fulfill
  } else {
    markTaskAsDone(this.db, taskId, enrichedOutput, timestamp);
    // ...
  }
}
```

**Maquinaria preexistente que se aprovecha**:

| Componente | Ubicación | Rol |
|---|---|---|
| Handler `waiter.fulfilled` | `dispatcher.ts:331-345` | Detecta fulfill via JSONL event y vuelve la task a `ready` |
| `markTaskAsReadyAfterFulfill` | `dispatcher.ts:701-730` | Verifica `status==='waiting-waiter'` + sin waiters pendientes + deps OK |
| Recovery al arranque | `dispatcher.ts:150-159` | Transición `ready` → `waiting-waiter` si hay waiters pendientes (post-crash) |
| Gate al inicio de runTask | `dispatcher.ts:879-885` | Transición `ready` → `waiting-waiter` si hay waiters pendientes (pre-spawn) |
| Session strategy `flow-agent-task` | `dispatcher.ts:60+`, `claude-code-runner.ts:75-78` | Persiste `session_id` por `(flow_id, agent_id, task_id)` y lo pasa como `--resume` en la siguiente invocación |

### Validación

Flow `01KS2SNHCF41ZGQT8BKJNNZWHH` (2026-05-20), prompt "ayudame a mejorar el proyecto" sobre `Kunfupay-Geolinks`:

- **1 flow, 1 task `planner-analyze`**, agente `softwarefactory_roman`.
- **`turn_count=4`** en `agent_sessions` (4 invocaciones encadenadas con mismo `session_id`).
- Turn 1: crea waiter `clarification-r1` (área/tipo/prioridad/horizonte) → `waiting-waiter`.
- [operador fulfill r1: ux-ui + mejora-incremental + media + este-mes]
- Turn 2: lee r1, crea `clarification-r2` (superficie/foco/módulo/profundidad) → `waiting-waiter`.
- [fulfill r2: ambas + accesibilidad + transversal + parches]
- Turn 3: lee r1+r2, crea `clarification-r3` (estándar/medición/entregable) → `waiting-waiter`.
- [fulfill r3: wcag-2.1-A + axe+lighthouse + report+PRs]
- Turn 4: lee r1+r2+r3, escribe `PLAN-FINAL.md` (11293 bytes) → `done` (sin waiters pendientes esta vez).

Sin el fix, el experimento previo del mismo día requirió **4 flows distintos** + ~5 spawns extra del coordinator-seed.

---

## Consecuencias

### Positivas

1. **Habilita el patrón planner-mode nativo**: un agente puede iterar con el operador sin perder sesión Claude. Esto desbloquea casos de uso como "prepare/confirm" del spec del visor (`docs/specs/v1-write-operations.md` en `visor-orchestrator`).
2. **Reduce costo por ronda de clarificación**: ya no hace falta un coordinator-seed nuevo por ronda. Solo 1 spawn del agente principal con `--resume`.
3. **Simplifica el contrato de consumidores externos**: el visor (o cualquier herramienta) ya no necesita orquestar la cadena `previousFlowId + answers`. Crea el flow una vez, llama `fulfill` N veces, y el dispatcher hace el resto.
4. **Simetría conceptual**: el waiter pasa a tener 4 cuadrantes claramente definidos (modo × rol), no 2 modos vagos.
5. **Compatible con paralelismo**: tasks paralelas pueden tener cada una sus propios waiters de cualquier cuadrante, sin interferir.

### Negativas

1. **Cambia el contrato implícito "result.success → done"**. Tasks que creen waiters como efecto secundario no intencionado (no documentado hoy, pero podría aparecer en código futuro) quedarían huérfanas en `waiting-waiter`. **Mitigación**: el `createWaiter` siempre es explícito y emitido por el agente; no hay path "accidental". Si en el futuro aparece un caso así, se puede añadir un flag al waiter (`auto_fulfill: true`) o un timeout corto que lo cancele.
2. **Sin cap de turnos por task**: en teoría un agente podría crear waiters en bucle indefinido. **Mitigación**: el `max-turns` del CLI Claude (default 60) limita cuántas iteraciones de razonamiento por turno; el `turn_count` en `agent_sessions` permite implementar un soft-cap a futuro (ej. v1.1).
3. **Re-spawning consume costo**: cada re-invocación gasta un costo base de inicialización del CLI Claude. **Mitigación**: aceptable porque `--resume` preserva el contexto y evita repetir el prompt del system + tools.

### Neutras

- Los waiters **activos** (kind=exec-command, db-record-ready, etc.) ya funcionaban con el rol suspend/resume vía Tick F + `dispatcher.ts:728`. Este ADR no los toca; solo explicita el modelo conceptual.

---

## Alternativas consideradas

| Alternativa | Por qué se rechazó |
|---|---|
| Documentar el workaround "1 flow por ronda" | Costoso (spawns redundantes), pierde continuidad de sesión, complica consumidores externos. |
| Marcar waiters creados mid-turn como auto-fulfilled | Rompe la semántica del waiter (operador no respondió). Inútil para clarificaciones humanas. |
| Añadir un nuevo estado `task.status='suspended'` distinto a `waiting-waiter` | Duplica concepto. `waiting-waiter` ya cubre ambos roles ortogonalmente; el rol viene dado por cuándo se creó el waiter, no por un estado distinto. |

---

## Compatibilidad con `task_dependencies`

`task_dependencies` (relación entre tasks: A depende de B) y `waiters` (entre task y mundo externo) son **primitivas distintas y composables**. Una task `C` puede tener simultáneamente:

- `depends_on: [A, B]` — espera a que ambas terminen `done`.
- waiter pasivo pre-condición — espera input humano antes de arrancar.
- waiter activo de polling como gate de seguridad.

El dispatcher resuelve en este orden:

1. Si `status='queued'` + alguna dep no está `done` → permanece `queued`.
2. Si todas las deps OK → `ready`.
3. Al `runTask`, si hay waiters pendientes → `waiting-waiter`.
4. Si fulfill durante turno → `waiting-waiter` (este ADR).
5. Sin waiters pendientes Y `result.success` → `done`.

---

## Referencias

- **Spec sección 3.3** (Waiters): definición de modos pasivo/activo.
- **Spec sección 3.6.4** (Recovery): waiters huérfanos.
- **Commit `32f1094`**: implementación del fix.
- **Flow validador `01KS2SNHCF41ZGQT8BKJNNZWHH`** (2026-05-20): experimento end-to-end con `turn_count=4`.
- **ADR-001**: `AgentRunner` interface — el `claude-code-runner.ts` que ejecuta el `--resume`.
- **`docs/planner-mode.md`**: feature spec del rol suspend/resume aplicado a planner-mode.
- **Spec consumidor externo**: `visor-orchestrator/docs/specs/v1-write-operations.md` §3 (prepare/confirm) — se beneficia directamente del rol suspend/resume.

---

**Firmado**: Angel Oliver, Claude Opus 4.7 (1M context), 2026-05-20  
**Aprobado por**: Angel Oliver (operador-arquitecto)
