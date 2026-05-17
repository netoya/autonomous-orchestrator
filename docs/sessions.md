# Sessions: Reutilizacion de conversaciones Claude Code

**Audiencia:** DevOps, sysadmin, operadores del orchestrador

Esta documentacion explica como funciona el sistema de sesiones en runtime y como operarlo.

Para detalles de implementacion, ver el [spec de session-strategy](specs/session-strategy.md).

---

## Mecanica de la conversacion

### NO es texto plano concatenado

La conversacion con Claude Code **NO funciona concatenando texto plano**. Es una **lista estructurada de mensajes** (`{role, content}`) que se envian como JSON a la API de Anthropic:

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

Cada mensaje tiene un `role` (`user` o `assistant`) y `content`. Esto es lo que viaja por HTTP hacia la API.

### Como funciona `--resume`

**Sin `--resume` (sesion nueva cada vez):**

```
Cliente -> API: { system: [...], messages: [{role:user, content: P}] }
API -> Cliente: { content: R, session_id: NEW_UUID }
```

La API crea cache nueva del system prompt + tools (~11,500 tokens de cache_creation en el benchmark).

**Con `--resume` (reutilizando sesion existente):**

```
Cliente -> API: { messages: [{role:user, content: P2}], session_id: PREV_UUID }
API (internamente reconstruye): messages = [...previos..., {role:user, content:P2}]
API -> Cliente: { content: R2, session_id: PREV_UUID }
```

El cliente **NO envia los mensajes anteriores**. Solo envia:
- El mensaje nuevo (P2)
- El `session_id` de la sesion anterior

El server de Anthropic reconstruye la conversacion completa desde su cache interna asociada al UUID. Esto ahorra:
- **Cache creation**: solo se agregan ~148 tokens nuevos (el delta: respuesta previa + prompt nuevo), vs ~11,569 tokens al crear desde cero.
- **Bootstrapping de haiku-helper**: el CLI usa `claude-haiku-4-5` para tareas auxiliares en arranques de sesion. Con `--resume` esta fase se saltea, ahorrando ~$0.0005 por invocacion.

**Conclusion:** `--resume` funciona con una referencia opaca (UUID) a una conversacion guardada server-side. NO es "pegar texto anterior" — son mensajes estructurados administrados por Anthropic.

---

## Modos disponibles

El orchestrador soporta 2 modos de sesion. El modo se configura con env var `SESSION_STRATEGY` (default: `flow-agent-task`).

| Modo | Clave de estrategia | Comportamiento | Cuando usar |
|---|---|---|---|
| `flow-agent-task` | `${flow_id}:${agent_id}:${task_id}` | Persiste el `session_id` de cada task. Retries del MISMO task (mismo `task_id`) heredan la sesion via `--resume`. Tasks distintas NO comparten. | **Default. Modo recomendado.** Util para retries/recoveries del mismo task. Cada task es independiente pero puede reintentar con contexto. |
| `none` | N/A | Nunca persiste sesion. Cada invocacion arranca con sesion nueva. | Kill-switch si hay problemas en produccion. Tests que requieren aislamiento total. Debugging sin estado. |

**Nota importante:** los modos `flow-agent` (compartir sesion entre todas las tasks del mismo agente en un flow) y `flow-task` (compartir entre agentes de la misma task) fueron diferidos a fase 2 por riesgo de contaminacion de contexto. Se evaluaran con telemetria real.

---

## Configuracion runtime

### Env var: `SESSION_STRATEGY`

**Valores validos:** `flow-agent-task` | `none`

**Default:** `flow-agent-task`

**Validacion:** el dispatcher aborta en startup con error claro si el valor no es valido. NO falla silenciosamente.

```bash
export SESSION_STRATEGY=flow-agent-task  # default
export SESSION_STRATEGY=none             # desactivar
```

### Env var: `MAX_TURNS_PER_SESSION`

**Tipo:** entero positivo

**Default:** `50`

**Proposito:** limite de turnos por sesion para evitar crecimiento ilimitado del lado server. Si `turn_count >= MAX_TURNS_PER_SESSION` en el lookup, el dispatcher ignora la sesion existente y arranca nueva (loguea como `action=new-after-cap`).

```bash
export MAX_TURNS_PER_SESSION=50   # default
export MAX_TURNS_PER_SESSION=100  # aumentar cap para tasks largas
```

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

---

## Como apagar el feature en caliente

### Kill-switch: `state/.SESSIONS_DISABLED`

Si el archivo `state/.SESSIONS_DISABLED` existe en el filesystem, el dispatcher fuerza `session_strategy=none` para todas las tasks, ignorando env y override. Esto permite desactivar sessions en runtime sin redeploy.

**Uso:**

```bash
# Desactivar sessions en caliente
touch /home/angel/projects/autonomous-orchestrator/state/.SESSIONS_DISABLED

# Reactivar (eliminar el archivo)
rm /home/angel/projects/autonomous-orchestrator/state/.SESSIONS_DISABLED
```

**Verificar en logs:**

Cuando el kill-switch esta activo, el dispatcher loguea `action=disabled` en cada task:

```
[dispatcher] session strategy=none key=N/A action=disabled
```

### Cuando usar el kill-switch

Usa el kill-switch si detectas en produccion:

1. **Sesiones que crecen sin control**: metricas muestran `turn_count` muy altos (>100) y costos crecientes de `cache_read`.
2. **Comportamiento erratico del agente**: el agente parece "confundido" por contexto antiguo de tasks previas (ej: asume archivos o estado que ya no existe).
3. **Errores de `--resume` frecuentes**: logs muestran muchos `action=fallback-after-expiry`, indicando que el server de Anthropic esta descartando sesiones rapidamente.
4. **Necesitas aislar un problema**: para verificar si un bug esta relacionado con session reuse, fuerza `none` temporalmente.

**Procedimiento:**

1. Activa kill-switch: `touch state/.SESSIONS_DISABLED`
2. Monitorea logs: verifica `action=disabled` en tasks nuevas
3. Observa metricas: compara costos y comportamiento
4. Desactiva cuando estes listo: `rm state/.SESSIONS_DISABLED`

---

## Como leer la telemetria

### Log format

El dispatcher loguea una linea por cada task ejecutada:

```
[dispatcher] session strategy=<flow-agent-task|none> key=<strategyKey> action=<action>
```

### Valores de `action` y su significado

| Action | Significado | Accion requerida |
|---|---|---|
| `new` | Primera invocacion de esta combinacion (flow, agent, task). No habia sesion previa. | Normal. Esperado en la 1ra ejecucion de cada task unica. |
| `resume` | Lookup hit. Se aplico `--resume` con sessionId previo. | Normal. Indica reuso exitoso de sesion (retry o recovery). |
| `new-after-cap` | `turn_count >= MAX_TURNS_PER_SESSION`. Forzada nueva sesion por cap. | Normal si tasks tienen muchos retries. Revisa si `MAX_TURNS_PER_SESSION` es muy bajo para tu caso de uso. |
| `fallback-after-expiry` | `--resume` fallido o sessionId devuelto distinto al pedido. Actualizada tabla con nuevo sessionId. | Normal si la sesion expiro server-side. Si es muy frecuente, investiga TTL real de Anthropic o aumenta `MAX_TURNS_PER_SESSION`. |
| `disabled` | Kill-switch activo (`state/.SESSIONS_DISABLED` existe). Forzada `strategy=none`. | Esperado SOLO si activaste el kill-switch manualmente. Si no, investiga quien creo el archivo. |

### Queries SQL utiles

**1. Distribucion de actions por strategy:**

```sql
SELECT 
  json_extract(input_json, '$.session_strategy') as strategy,
  json_extract(output_json, '$._meta.session_action') as action,
  COUNT(*) as count
FROM tasks 
WHERE status = 'done'
  AND json_valid(output_json) = 1
GROUP BY strategy, action
ORDER BY count DESC;
```

**2. Tasks con mas retries (candidatos a muchos turnos):**

```sql
SELECT 
  id,
  agent_id,
  retries,
  json_extract(output_json, '$._meta.session_action') as action
FROM tasks
WHERE status = 'done'
  AND retries > 3
  AND json_valid(output_json) = 1
ORDER BY retries DESC
LIMIT 20;
```

**3. Sesiones activas con turn_count alto:**

```sql
SELECT 
  strategy_key,
  agent_id,
  task_id,
  turn_count,
  datetime(last_used_at/1000, 'unixepoch') as last_used
FROM agent_sessions
WHERE turn_count >= 30
ORDER BY turn_count DESC;
```

**4. Frecuencia de fallback por expiry:**

```sql
SELECT 
  DATE(created_at/1000, 'unixepoch') as date,
  COUNT(*) as fallback_count
FROM tasks
WHERE json_valid(output_json) = 1
  AND json_extract(output_json, '$._meta.session_action') = 'fallback-after-expiry'
GROUP BY date
ORDER BY date DESC;
```

---

## Resultados del benchmark

El benchmark empirico (`scripts/benchmark-resume.sh`) midio 3 invocaciones del CLI de Claude Code:

1. **Invocacion #1 (semilla):** `claude -p "como se llama este proyecto?"`
2. **Invocacion #2 (resume):** `claude -p "cuantos .ts hay en src/?" --resume <sessionId-de-#1>`
3. **Invocacion #3 (control, sin resume):** `claude -p "cuantos .ts hay en src/"` (sesion nueva)

### Datos crudos

| Invocacion | session_id | input_tokens | cache_read | cache_create | output_tokens | cost USD | duration ms | modelo(s) usado |
|---|---|---|---|---|---|---|---|---|
| #1 (semilla) | `6647b3fe-...-a113418` | 7 | 59,524 | 0 | 158 | $0.0343 | 4,702 | haiku + opus |
| #2 (resume) | `6647b3fe-...-a113418` (mismo) | 7 | 63,608 | **148** | 158 | $0.0367 | 16,926 | opus (sin haiku) |
| #3 (sin resume) | `2cec7f0b-...-fd3d053` (nuevo) | 7 | 49,051 | **11,569** | 172 | $0.1017 | 7,204 | haiku + opus |

**Total con resume (#1 + #2):** $0.0710

**Total sin resume (#1 + #3):** $0.1360

**Ahorro:** **47.8% en costo USD**

### Hallazgos clave

1. **Ahorro del 47% proviene de 2 fuentes:**
   - **Cache creation reducida:** #2 solo creo 148 tokens de cache nueva (delta de conversacion), vs 11,569 tokens de #3 (system prompt + tools + prompt entero).
   - **Bootstrapping de haiku-helper evitado:** #1 y #3 usaron `claude-haiku-4-5` ($0.0005) para tareas auxiliares en arranque de sesion. #2 solo uso opus — no necesito bootstrapping porque la sesion ya estaba "calentita".

2. **Cache read es enorme (~50-64k tokens) pero NO cuesta extra:** el contexto base del CLI (system prompt + tool definitions) es ~50k tokens y ya esta precacheado globalmente por Anthropic. Se lee gratis en las 3 invocaciones.

3. **session_id se preserva con `--resume`:** #2 devolvio el mismo UUID de #1, confirmando que el server mantuvo la sesion. #3 genero UUID nuevo.

4. **Duration no es indicador fiable:** #2 tardo mas (16.9s) que #3 (7.2s), probablemente por variabilidad de red/server. El ahorro esta en costo, no en latencia.

### Implicaciones operacionales

- El ahorro es **real y medible**, no teorico. Feature viable.
- El ahorro sera **mayor en tasks largas** con muchos turnos internos (ej: agente que analiza multiples archivos con razonamiento extenso), porque el bootstrapping de haiku se ahorra cada vez.
- **No asumir que `--resume` = "mas rapido"**. El beneficio principal es costo, no latencia.

---

## Limitaciones conocidas

### 1. TTL server-side desconocido

**Descripcion:** Anthropic no documenta publicamente cuanto tiempo mantiene una sesion sin uso. Puede ser 24h, 7 dias, o basado en volumen de sesiones activas.

**Mitigacion implementada:** fallback automatico. Si el `--resume` falla:
- Porque el server devuelve error explicito ("session not found"), o
- Porque el sessionId devuelto es distinto al pedido,

el dispatcher detecta esto, arranca nueva sesion sin `--resume`, y actualiza la tabla `agent_sessions` con el nuevo `session_id`. El log mostrara `action=fallback-after-expiry`.

**Como validar empiricamente el TTL:**

```bash
# Paso 1: crear una sesion y anotar su session_id
claude -p "hola" --output-format json | jq -r .session_id > /tmp/test-session-id

# Paso 2: esperar N horas (ej: 24h)
sleep 86400

# Paso 3: intentar --resume con esa sesion
claude -p "estas ahi?" --resume $(cat /tmp/test-session-id) --output-format json

# Verificar si devuelve error o sessionId distinto
```

Dante dejara esto documentado cuando tenga datos empiricos.

### 2. Turn-cap por configuracion

**Descripcion:** las sesiones crecen indefinidamente del lado server con cada `--resume`. Eventualmente pueden:
- Exceder el context window del modelo (200k en haiku, 1M en opus-4-7-1m).
- Causar costos crecientes de `cache_read` a medida que la historia acumulada crece.

**Mitigacion implementada:** env var `MAX_TURNS_PER_SESSION` (default 50). Si `turn_count >= MAX` en el lookup, el dispatcher ignora la sesion existente y arranca nueva. Loguea como `action=new-after-cap`.

**Como ajustar el cap:**

- Si tasks largas necesitan mas contexto, aumenta: `export MAX_TURNS_PER_SESSION=100`
- Si ves costos crecientes de cache_read, reduce: `export MAX_TURNS_PER_SESSION=30`
- Monitorea con la query SQL de "sesiones activas con turn_count alto" (ver seccion de telemetria).

### 3. Single-dispatcher assumption

**Descripcion:** el schema SQL y el pattern de upsert asumen que un solo proceso dispatcher esta corriendo. Si en el futuro se corren 2 dispatchers concurrentes (ej: para paralelizar flows), pueden haber race conditions en el upsert (dos dispatchers intentan actualizar la misma fila de `agent_sessions` simultaneamente).

**Mitigacion actual:** documentado en la migracion SQL como nota de advertencia. El orchestrador actual es single-process por diseno.

**Si en el futuro necesitas multi-dispatcher:**

- Usar locks a nivel de fila con `BEGIN IMMEDIATE` en SQLite, o
- Migrar a Postgres con serializable transactions, o
- Usar un mecanismo de coordinacion tipo distributed lock (Redis, etcd).

**Accion:** aceptado como caveat conocido. No bloquea fase 1.

---

## Cuando reportar un bug

Si detectas comportamiento anormal relacionado con sessions, captura esta informacion antes de reportar:

### 1. Logs del dispatcher

Captura las lineas `[dispatcher] session strategy=...` de las tasks afectadas:

```bash
grep "session strategy" logs/dispatcher.log | tail -50
```

Busca especialmente:
- Muchos `action=fallback-after-expiry` consecutivos (indica problema con TTL server-side)
- `action=disabled` sin que hayas activado el kill-switch (archivo espurio?)
- `action=new-after-cap` frecuente con `MAX_TURNS_PER_SESSION` alto (posible bug en turn_count)

### 2. Estado de la tabla agent_sessions

Consulta las sesiones relacionadas con el flow/task afectado:

```sql
SELECT * FROM agent_sessions 
WHERE flow_id = '<flow_id_afectado>' 
   OR task_id = '<task_id_afectado>';
```

Anota especialmente:
- `turn_count` (¿es muy alto? ¿muy bajo?)
- `last_used_at` (¿hace cuanto se uso?)
- `strategy` (¿coincide con lo esperado?)

### 3. output_json de la task

Consulta el output_json completo de la task que fallo:

```sql
SELECT id, agent_id, status, output_json 
FROM tasks 
WHERE id = '<task_id_afectado>';
```

Busca el campo `_meta.session_action` dentro del JSON. Si no existe, es un bug (deberia estar siempre presente en tasks con sessions habilitadas).

### 4. Resultado del CLI (si disponible)

Si la ejecucion del agente devolvio JSON, captura el `session_id` y `usage` del resultado:

```json
{
  "session_id": "...",
  "usage": {
    "cache_creation_input_tokens": ...,
    "cache_read_input_tokens": ...,
    ...
  }
}
```

Comparalo contra lo esperado (ej: cache_creation muy alta cuando deberia ser baja con resume).

### 5. Configuracion actual

Reporta las env vars activas:

```bash
echo "SESSION_STRATEGY=$SESSION_STRATEGY"
echo "MAX_TURNS_PER_SESSION=$MAX_TURNS_PER_SESSION"
ls -la state/.SESSIONS_DISABLED 2>&1
```

---

**Fin de la documentacion operativa. Para detalles de implementacion, ver [specs/session-strategy.md](specs/session-strategy.md).**
