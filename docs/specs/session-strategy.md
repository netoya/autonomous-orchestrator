# Session Strategy

## Objetivo

Reducir el costo operacional y mejorar la coherencia entre invocaciones del mismo agente mediante la reutilizacion de sesiones del Claude Code CLI. El benchmark empirico (`scripts/benchmark-resume.sh`) demostro un ahorro del **47.8% en costo USD** al usar `--resume` para una secuencia de 2 invocaciones, comparado contra sesiones nuevas en cada invocacion. Este ahorro proviene de dos fuentes: (1) evitar cache_creation de ~11k tokens en cada nueva sesion, y (2) eliminar el costo de bootstrapping del haiku-helper que el CLI usa internamente en arranques de sesion. Mas alla del costo, el beneficio principal es **mantener coherencia entre retries de un mismo task**: el agente puede continuar desde donde quedo, sin olvidar el contexto acumulado.

## Modelo conceptual

### Que es una "conversacion" del CLI de Claude Code

La conversacion NO es texto plano concatenado. Es una **lista estructurada de mensajes** (`{role, content}`) que viajan en JSON hacia la API de Anthropic. Cada mensaje tiene un rol (`user` o `assistant`) y contenido. Ejemplo:

```json
{
  "system": [
    {"type": "text", "text": "<system prompt del CLI>", "cache_control": {"type": "ephemeral"}},
    {"type": "text", "text": "<tool definitions>", "cache_control": {"type": "ephemeral"}}
  ],
  "messages": [
    {"role": "user", "content": "Prompt 1: como se llama este proyecto?"},
    {"role": "assistant", "content": "El nombre es autonomous-orchestrator..."},
    {"role": "user", "content": "Prompt 2: cuantos .ts hay en src/?"}
  ],
  "tools": [...]
}
```

### Como funciona `--resume`

**Sin `--resume` (sesion nueva):**
```
Cliente -> API: { system: [...], messages: [{role:user, content: P}] }
API -> Cliente: { content: R, session_id: NEW_UUID }
```

**Con `--resume` (misma sesion):**
```
Cliente -> API: { messages: [{role:user, content: P2}], session_id: PREV_UUID }
API (internamente reconstruye): messages = [...previos..., {role:user, content:P2}]
API -> Cliente: { content: R2, session_id: PREV_UUID }
```

El cliente NO envia los mensajes anteriores. Solo envia el mensaje nuevo mas el `session_id`. El server de Anthropic mantiene la historia completa de la conversacion asociada a ese UUID y la reutiliza. Esto ahorra:
- **Cache creation**: el server ya tiene cacheado el system prompt + tools + mensajes previos. Solo agrega el delta nuevo (~148 tokens en el benchmark).
- **Bootstrapping de haiku-helper**: el CLI usa `claude-haiku-4-5` para tareas auxiliares en arranques de sesion. Con `--resume` esta fase se saltea, ahorrando ~$0.0005 por invocacion.

## Modos

### `flow-agent-task` (default)

**Clave de estrategia:** `${flow_id}:${agent_id}:${task_id}`

**Comportamiento:**
- Persiste el `session_id` retornado por el agente al finalizar su ejecucion.
- La siguiente invocacion DEL MISMO TASK (mismo `task_id`) hereda el `session_id` via `--resume`.
- Tasks distintas del mismo agente en el mismo flow NO comparten sesion.

**Cuando usar:**
- Retries/recoveries del mismo task (el dispatcher reintenta task fallido con el mismo `task_id`).
- Flujos donde cada task es independiente pero puede necesitar multiples intentos.

**Riesgos:**
- Crecimiento de la sesion del lado server si un task tiene muchos retries largos. Mitigado por `MAX_TURNS_PER_SESSION`.
- Si la retry se crea como task nueva con NUEVO `task_id` (ej: manual via CLI `waiter fulfill`), NO hereda. Ver caveat mas abajo.

### `none`

**Clave de estrategia:** N/A (no persiste nada)

**Comportamiento:**
- Cada invocacion arranca una sesion completamente nueva.
- Comportamiento identico al actual (antes de esta feature).

**Cuando usar:**
- Como kill-switch si se detectan problemas en produccion con sessions.
- Tests que requieren aislamiento total entre invocaciones.
- Debugging de comportamiento sin estado.

**Riesgos:**
- Ninguno (es el modo legacy). Mayor costo operacional por falta de reuso.

---

**Nota sobre modos diferidos (`flow-agent` y `flow-task`):**

El spec original proponia tambien:
- `flow-agent`: todas las tasks del mismo agente en un flow comparten sesion (clave `${flow_id}:${agent_id}`).
- `flow-task`: multiples agentes en la misma task comparten sesion (clave `${flow_id}:${task_id}`).

**Decision de Roman:** diferir estos modos a fase 2. El reuso agresivo de sesiones (`flow-agent`) puede llevar a contaminacion de contexto si dos tasks del mismo agente tocan modulos distintos. El modo `flow-task` es academico mientras 1 task = 1 agente. Primero validar con datos reales de telemetria el comportamiento de `flow-agent-task` en flows de produccion antes de introducir complejidad adicional.

## Configuracion

### Env var `SESSION_STRATEGY`

**Valores validos:** `flow-agent-task | none`

**Default:** `flow-agent-task`

**Validacion:** fail-fast en startup del dispatcher. Si el valor no es uno de los permitidos, el dispatcher debe abortar con error claro antes de procesar cualquier task.

### Env var `MAX_TURNS_PER_SESSION`

**Tipo:** entero positivo

**Default:** `50`

**Proposito:** limite de turnos por sesion para evitar crecimiento ilimitado del lado server. Si `turn_count >= MAX_TURNS_PER_SESSION` en el lookup, el dispatcher ignora la fila existente y arranca nueva sesion (logear como `action=new-after-cap`).

### Override por flow: `input_json.session_strategy`

El coordinator-seed puede pasar `session_strategy` en el `input_json` de la task que crea. Este valor se propaga a sub-tasks creadas por ese coordinator (identico a como se propaga `cwd` y `add_dir`).

**Ejemplo:**
```typescript
await createCoordinatorTask(db, {
  flow_id: flowId,
  agent_id: 'softwarefactory_roman',
  slug: 'fix-bug-retry',
  input_json: {
    cwd: '/home/angel/projects/cobragest',
    session_strategy: 'none'  // forzar sin sesion para este coordinator
  }
});
```

### Kill-switch: `state/.SESSIONS_DISABLED`

Si el archivo `state/.SESSIONS_DISABLED` existe en el filesystem, el dispatcher fuerza `session_strategy=none` para todas las tasks, ignorando env y override. Esto permite desactivar sessions en runtime sin redeploy.

**Uso:**
```bash
touch state/.SESSIONS_DISABLED   # desactivar
rm state/.SESSIONS_DISABLED      # reactivar
```

El dispatcher debe loguear `action=disabled` cuando el kill-switch esta activo.

## Reglas

### Coordinator-seed: nunca comparte sesion

El coordinator-seed siempre usa una clave de estrategia que incluye su propio `task_id`. En efecto, nunca hay match previo con otras tasks, por lo que siempre arranca con sesion limpia. Esto es correcto: el coordinator hace meta-decisiones y no debe estar contaminado por el contexto de tasks previas.

### Retry/recovery con mismo `agent_id` y mismo `task_id`: hereda sesion

Si el dispatcher reintenta un task fallido (mismo `task_id`, mismo `agent_id`), la clave de estrategia (`${flow_id}:${agent_id}:${task_id}`) sera identica. El lookup devolvera el `session_id` persistido en la primera ejecucion, y el agente continuara desde donde quedo.

**Importante:** la sesion se guarda incluso si el task fallo. Esto es intencional: queremos que la retry vea el estado del sistema tal como lo dejo la ejecucion anterior, incluyendo errores o trabajo parcial.

### Caveat: retry creada como task nueva con nuevo `task_id` NO hereda

Si manualmente se crea una retry con un `task_id` distinto (ej: `fix-ux-iter3-auto-skip-retry` como nueva task en lugar de reintentar la original `fix-ux-iter3-auto-skip`), la clave de estrategia sera distinta y NO heredara la sesion.

**Workaround para usuarios avanzados:** si se quiere herencia en ese escenario, copiar explicitamente el `task_id` original o implementar un mecanismo de "parent_task_id" en el futuro. Esto queda fuera del scope de fase 1.

### `--resume` fallido: deteccion y actualizacion de sesion

Si el `--resume <sessionId>` falla porque la sesion expiro del lado server, pueden pasar dos cosas:

1. **Error explicito:** el CLI devuelve `is_error: true` con mensaje "session not found" o similar. El dispatcher detecta esto, arranca nueva sesion sin `--resume`, y al finalizar actualiza la tabla con el nuevo `session_id`.

2. **Session ID distinto en respuesta:** el CLI puede crear silenciosamente una nueva sesion y devolver un `session_id` distinto al pedido. El dispatcher debe detectar `result.sessionId !== requestedSessionId` y actualizar la fila con el nuevo valor.

En ambos casos, loguear como `action=fallback-after-expiry`.

### Rotacion por turn-cap

Si `turn_count >= MAX_TURNS_PER_SESSION` en el lookup, el dispatcher ignora la fila y arranca nueva sesion. Loguear como `action=new-after-cap`. El upsert posterior sobreescribira la fila con `turn_count=1` y el nuevo `session_id`.

### Sesion se persiste incluso si task fallo

Si la ejecucion del agente devuelve `is_error: true` pero incluye un `session_id` valido en la respuesta, el dispatcher hace upsert igual. Esto permite que retries hereden el contexto del fallo.

## Schema SQL

Migracion completa lista para aplicar:

```sql
-- Migracion: 00XX-agent-sessions.sql
-- Asume single-dispatcher. Si en el futuro corren 2 dispatchers concurrentes,
-- el upsert puede tener race conditions (SQLite con WAL no serializa writes entre procesos).

CREATE TABLE IF NOT EXISTS agent_sessions (
  strategy_key TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  flow_id      TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL,
  task_id      TEXT,             -- nullable para futuros modos como flow-agent
  strategy     TEXT NOT NULL,    -- 'flow-agent-task' | 'none'
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  turn_count   INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS agent_sessions_flow_idx ON agent_sessions(flow_id);
CREATE INDEX IF NOT EXISTS agent_sessions_task_idx ON agent_sessions(task_id) WHERE task_id IS NOT NULL;

-- NOTA: no incluye expires_at (diferido por YAGNI).
-- Si en el futuro se necesita TTL adicional al turn-cap, agregar:
--   expires_at INTEGER  -- timestamp ms, nullable
```

**Detalles:**
- `strategy_key`: PK calculada segun el modo (`${flow_id}:${agent_id}:${task_id}` para `flow-agent-task`).
- `task_id`: nullable para futuros modos como `flow-agent` donde no aplica.
- `strategy`: guardado en la fila para auditoria. Si cambia el modo del flow, las sesiones viejas siguen siendo interpretables.
- `turn_count`: incrementa en cada upsert. Usado para rotacion por cap.
- `ON DELETE CASCADE` desde `flow_id`: cuando se elimina un flow, las sesiones se limpian automaticamente. Importante para pruebas.

**Pattern de upsert recomendado:**
```sql
INSERT INTO agent_sessions (strategy_key, session_id, flow_id, agent_id, task_id, strategy, created_at, last_used_at, turn_count)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
ON CONFLICT(strategy_key) DO UPDATE SET
  session_id   = excluded.session_id,
  last_used_at = excluded.last_used_at,
  turn_count   = turn_count + 1;
```

## Cambios de codigo

Todos los paths son absolutos desde la raiz del repo (`/home/angel/projects/autonomous-orchestrator`).

### `src/db/migrations/00XX-agent-sessions.sql`
**Responsable:** Mateo

Crear la migracion con el schema SQL completo de arriba. Testear rollback tambien (DROP TABLE agent_sessions).

### `src/db/dao/agent-sessions.ts`
**Responsable:** Mateo

Crear DAO con dos funciones:

```typescript
export function lookupSession(
  db: Database,
  strategyKey: string,
  maxTurns: number
): { session_id: string } | null {
  // SELECT session_id, turn_count FROM agent_sessions WHERE strategy_key = ?
  // Si turn_count >= maxTurns -> return null (forzar nueva)
  // Si no existe fila -> return null
  // Si existe y turn_count < maxTurns -> return { session_id }
}

export function upsertSession(
  db: Database,
  params: {
    strategy_key: string;
    session_id: string;
    flow_id: string;
    agent_id: string;
    task_id: string | null;
    strategy: 'flow-agent-task' | 'none';
  }
): void {
  // INSERT ... ON CONFLICT DO UPDATE (ver pattern de arriba)
  // created_at y last_used_at = Date.now()
}
```

### `src/dispatcher.ts`
**Responsable:** Roman

**Cambios en startup (funcion de inicializacion del dispatcher):**
```typescript
const sessionStrategy = process.env.SESSION_STRATEGY || 'flow-agent-task';
if (!['flow-agent-task', 'none'].includes(sessionStrategy)) {
  throw new Error(`Invalid SESSION_STRATEGY: ${sessionStrategy}. Valid values: flow-agent-task, none`);
}
const maxTurnsPerSession = parseInt(process.env.MAX_TURNS_PER_SESSION || '50', 10);
```

**Cambios en `runTask` (pseudocodigo):**
```typescript
async function runTask(db: Database, task: Task, runner: AgentRunner) {
  // 1. Checar kill-switch
  const killSwitchPath = path.join(__dirname, '../state/.SESSIONS_DISABLED');
  const sessionsDisabled = fs.existsSync(killSwitchPath);

  // 2. Determinar estrategia efectiva
  const effectiveStrategy = sessionsDisabled
    ? 'none'
    : (task.input_json.session_strategy || sessionStrategy);

  // 3. Calcular strategy_key y lookup
  let resumeSessionId: string | undefined;
  let sessionAction: 'new' | 'resume' | 'new-after-cap' | 'disabled' = 'new';

  if (effectiveStrategy !== 'none' && !sessionsDisabled) {
    const strategyKey = `${task.flow_id}:${task.agent_id}:${task.id}`;
    const existing = lookupSession(db, strategyKey, maxTurnsPerSession);

    if (existing && existing.turn_count < maxTurnsPerSession) {
      resumeSessionId = existing.session_id;
      sessionAction = 'resume';
    } else if (existing && existing.turn_count >= maxTurnsPerSession) {
      sessionAction = 'new-after-cap';
      // No pasar resumeSessionId, arrancar limpio
    }
  } else if (sessionsDisabled) {
    sessionAction = 'disabled';
  }

  // Log de telemetria
  console.log(`[dispatcher] session strategy=${effectiveStrategy} key=${strategyKey} action=${sessionAction}`);

  // 4. Ejecutar agente con --resume si aplica
  const runParams: AgentRunParams = {
    ...task.input_json,
    resumeSessionId
  };
  const result = await runner.run(runParams);

  // 5. Upsert session si result.sessionId existe y modo != none
  if (result.sessionId && effectiveStrategy !== 'none' && !sessionsDisabled) {
    const strategyKey = `${task.flow_id}:${task.agent_id}:${task.id}`;

    // Detectar fallback por expiry
    if (resumeSessionId && result.sessionId !== resumeSessionId) {
      console.log(`[dispatcher] session fallback-after-expiry: requested=${resumeSessionId} got=${result.sessionId}`);
      sessionAction = 'fallback-after-expiry';
    }

    upsertSession(db, {
      strategy_key: strategyKey,
      session_id: result.sessionId,
      flow_id: task.flow_id,
      agent_id: task.agent_id,
      task_id: task.id,
      strategy: effectiveStrategy
    });
  }

  // 6. Guardar session_action en output_json para telemetria
  task.output_json.session_action = sessionAction;
}
```

### `src/coordinator/tools.ts` y `src/cli/cli-tools.ts`
**Responsable:** Mateo

Agregar campo `session_strategy?: 'flow-agent-task' | 'none'` a `CreateCoordinatorTaskParams` y propagar al `input_json` de la task creada. Herencia desde seed igual que `cwd` y `add_dir`.

**Ejemplo en `createCoordinatorTask`:**
```typescript
export async function createCoordinatorTask(db: Database, params: CreateCoordinatorTaskParams) {
  const inputJson = {
    cwd: params.cwd,
    add_dir: params.add_dir,
    session_strategy: params.session_strategy,  // nuevo
    ...params.input_json
  };
  // ... resto del codigo
}
```

### `src/test/dispatcher/sessions.test.ts`
**Responsable:** Sofia

Archivo nuevo con 7 tests:

1. **`flow-agent-task: retry hereda session`**
   - Corre task A, captura sessionId devuelto.
   - Marca task A como fallido.
   - Dispatcher reintenta task A (mismo task_id).
   - Verificar que `MockAgentRunner` recibio `resumeSessionId` en la 2da invocacion.

2. **`flow-agent-task: tarea distinta NO hereda`**
   - Corre task A, captura sessionId.
   - Corre task B (mismo agent, mismo flow, distinto task_id).
   - Verificar que B NO recibio `resumeSessionId`.

3. **`none: nunca hereda session`**
   - Configura `SESSION_STRATEGY=none`.
   - Corre task A, retry de A.
   - Verificar que 2da invocacion NO recibio `resumeSessionId`.

4. **`fallback-after-expiry: actualiza tabla si sessionId distinto`**
   - Mock devuelve sessionId X en 1ra invocacion.
   - Mock devuelve sessionId Y (distinto) en 2da invocacion aunque se pidio X.
   - Verificar que la tabla se actualizo con Y.
   - Verificar que log contiene `fallback-after-expiry`.

5. **`coordinator-seed: nunca recibe session`**
   - Corre coordinator-seed task.
   - Aunque haya fila previa con mismo agent_id en el flow, el coordinator usa su propio task_id unico.
   - Verificar que NO recibio `resumeSessionId` (no hay match previo).

6. **`kill-switch: fuerza none cuando .SESSIONS_DISABLED existe`**
   - Crea archivo `state/.SESSIONS_DISABLED`.
   - Corre task A, retry de A.
   - Verificar que 2da invocacion NO recibio `resumeSessionId`.
   - Verificar log contiene `action=disabled`.

7. **`turn-cap: nueva sesion despues de superar MAX_TURNS_PER_SESSION`**
   - Configura `MAX_TURNS_PER_SESSION=3`.
   - Corre task A tres veces (simular retries).
   - 4ta invocacion: verificar que NO recibio `resumeSessionId`.
   - Verificar log contiene `action=new-after-cap`.

**Prerequisito:** extender `MockAgentRunner` para capturar los `AgentRunParams` recibidos en cada llamada.

### `scripts/benchmark-resume.sh`
**Responsable:** Dante

**Ya existe, no tocar.** Usado como prerequisito bloqueante antes de merge.

### `docs/sessions.md`
**Responsable:** Dante

Crear documentacion de usuario con:
- Tabla comparativa del benchmark (copiar de la salida del script).
- Diagrama de mensajes (sin/con resume) copiado de este spec.
- Explicacion de por que se ahorra el 47% (cache_creation + bootstrapping haiku).
- Modos disponibles: `flow-agent-task` y `none`.
- Como configurar: env vars, override, kill-switch.
- Caveat de retry-con-nuevo-task_id.
- Limites conocidos: server-side TTL desconocido (Anthropic no documenta), turn-cap por config.
- Nota de single-dispatcher assumption.

## Telemetria / logs

Formato exacto de las lineas de log del dispatcher por cada task ejecutada:

```
[dispatcher] session strategy=<flow-agent-task|none> key=<strategyKey> action=<action>
```

**Valores de `action`:**
- `new`: primera invocacion de esta combinacion de (flow, agent, task), no hay fila previa.
- `resume`: lookup hit, `--resume` aplicado con sessionId previo.
- `new-after-cap`: `turn_count >= MAX_TURNS_PER_SESSION`, forzando nueva sesion.
- `fallback-after-expiry`: `--resume` fallido o sessionId devuelto distinto al pedido, actualizada tabla con nuevo sessionId.
- `disabled`: kill-switch activo (`state/.SESSIONS_DISABLED` existe), forzando `strategy=none`.

**Adicionalmente:**
- Si `action=fallback-after-expiry`, loguear linea separada con requested y got sessionId.
- Persistir `session_action` en `tasks.output_json` para queries de telemetria:
  ```sql
  SELECT json_extract(output_json, '$.session_action') AS action, COUNT(*)
  FROM tasks
  GROUP BY action;
  ```

## Definition of Done

Checklist concreta y verificable antes de merge:

- [ ] **Benchmark pasado:** `scripts/benchmark-resume.sh` muestra ahorro >= 30% en costo USD (ya cumplido: 47.8%).
- [ ] **Migracion testeada:** `00XX-agent-sessions.sql` aplicada en DB de prueba, rollback verificado.
- [ ] **DAO implementado:** `src/db/dao/agent-sessions.ts` con `lookupSession` y `upsertSession`.
- [ ] **Dispatcher modificado:** validacion env, lookup pre-run, upsert post-run, kill-switch, logs de telemetria.
- [ ] **Propagacion de config:** `session_strategy` propagada desde coordinator-seed a sub-tasks.
- [ ] **7 tests verdes:** `src/test/dispatcher/sessions.test.ts` ejecutado con exito.
- [ ] **MockAgentRunner extendido:** captura `AgentRunParams` para tests.
- [ ] **Doc creada:** `docs/sessions.md` con modos, kill-switch, caveat, tabla del benchmark.
- [ ] **Code review de Roman:** aprobado antes de merge.
- [ ] **Smoke test manual de Angel:** re-correr flow ludo-ux-loop con sessions ON, comparar tiempos/comportamiento contra baseline sin sessions.

## Riesgos abiertos

### Crecimiento server-side de sesiones

**Descripcion:** la conversacion crece indefinidamente del lado server de Anthropic con cada `--resume`. Eventualmente puede exceder context window del modelo (200k haiku, 1M opus-4-7-1m) o causar costos crecientes de `cache_read`.

**Mitigacion:** `MAX_TURNS_PER_SESSION` fuerza rotacion despues de N turnos (default 50). Configurable por flow si se necesita ajustar. En fase 2 se puede agregar `expires_at` si se identifica un patron de expiry server-side.

### TTL real del server desconocido

**Descripcion:** Anthropic no documenta publicamente cuanto tiempo mantiene una sesion sin uso. Puede ser 24h, 7 dias, o basado en volumen.

**Mitigacion:** fallback automatico detecta cuando `--resume` falla (error explicito o sessionId distinto en respuesta) y arranca nueva sesion. Dante medira empiricamente el TTL en el futuro dejando una sesion inactiva y probando `--resume` a las 24h, 48h, 7d.

**Accion:** documentado en `docs/sessions.md` como "limite conocido". No bloquea fase 1.

### Single-dispatcher assumption

**Descripcion:** el schema SQL y el pattern de upsert asumen que un solo proceso dispatcher esta corriendo. Si en el futuro se corren 2 dispatchers concurrentes (ej: para paralelizar flows), pueden haber race conditions en el upsert (dos dispatchers intentan actualizar la misma fila).

**Mitigacion:** documentado en la migracion SQL como nota de advertencia. Si se necesita multi-dispatcher en el futuro, se debera:
- Usar locks a nivel de fila con `BEGIN IMMEDIATE` en SQLite.
- O migrar a Postgres con serializable transactions.
- O usar un mecanismo de coordinacion tipo distributed lock.

**Accion:** aceptado como caveat documentado. No bloquea fase 1 (orchestrator es single-process por diseno actual).

## Plan de implementacion

Orden de tareas, dependencias y estimaciones:

| # | Tarea | Responsable | Dependencia | Estimacion (horas) | Estado |
|---|---|---|---|---|---|
| 1 | Benchmark de `--resume` | Dante | — | 1h | ✅ Hecho (47.8% ahorro) |
| 2 | Migracion SQL + DAO | Mateo | #1 OK | 2h | Pendiente |
| 3 | Modificar `dispatcher.ts` | Roman | #2 | 2h | Pendiente |
| 4 | Propagacion de `session_strategy` | Mateo | — | 1h | Pendiente (paralelo a #3) |
| 5 | Extender `MockAgentRunner` | Sofia | — | 0.5h | Pendiente |
| 6 | 7 tests en `sessions.test.ts` | Sofia | #5 | 2h | Pendiente |
| 7 | Doc `docs/sessions.md` | Dante | #1 | 1h | Pendiente |
| 8 | Code review | Roman | #2,#3,#4,#6 | 0.5h | Pendiente |
| 9 | Smoke test manual | Angel | #8 aprobado | 1h | Pendiente |

**Total estimado:** ~10h de trabajo distribuido.

**Critico:** tarea #1 ya esta completada y PASO (47.8% ahorro). Feature es viable y el resto de la implementacion puede proceder.

---

**Fin del spec.**
