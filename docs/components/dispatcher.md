# Dispatcher — Daemon principal del orquestador

> **Spec**: seccion 3.1, 5  
> **Responsable**: Mateo (implementacion core), Dante (supervivencia PM2)

---

## Responsabilidades

El **dispatcher** es el daemon central del orquestador. Es el unico proceso de larga duracion (long-lived) del sistema. Todas sus responsabilidades se ejecutan en ciclos (ticks) independientes:

1. **Selector de tasks** (tick A): elige tasks `ready`, aplica WSJF, bifurca `agent-runner`.
2. **Scheduler de waiters activos** (tick B): polling de waiters con `horizon='long'`.
3. **Watcher de waiters pasivos** (tick C): lee `state/inbox/` y `state/fifo/`.
4. **Activacion de waiters urgentes** (tick D): waiters cuyo `next_check_at` vencio.
5. **Consumer de eventos** (tick E): lee tabla `events`, busca dependientes, marca tasks `ready`.
6. **Detector de deadlocks** (ciclo cada 60 s): topological sort sobre `task_dependencies`.
7. **Kill-switch check** (en cada tick): si `state/.KILLSWITCH` existe, para de bifurcar procesos.

---

## Los 5 ticks: detalle operativo

### Tick A: Selector de tasks (500 ms)

**Objetivo**: tomar tasks `ready` y asignarlas a workers disponibles.

**Algoritmo**:

```typescript
async function tickA() {
  if (killswitchExists()) return;
  
  const slotsLibres = MAX_WORKERS - countRunningWorkers();
  if (slotsLibres === 0) return;
  
  const tasks = await db.query(`
    SELECT id, agent_id, input_json, priority, business_value, estimated_minutes
      FROM tasks
     WHERE status = 'ready'
     ORDER BY
       CASE
         WHEN business_value IS NOT NULL AND estimated_minutes IS NOT NULL
           THEN (business_value * priority) / CAST(MAX(estimated_minutes,1) AS REAL)
         ELSE priority
       END DESC,
       created_at ASC
     LIMIT :slots
  `, { slots: slotsLibres });
  
  for (const task of tasks) {
    await spawnAgentRunner(task);
  }
}
```

**Side-effects**:
- Actualiza `tasks.status='running'`.
- Inserta fila en `executions` con `started_at=now`.
- Emite evento `task.started` en `events.jsonl`.

**Selector WSJF** (Weighted Shortest Job First):
```
prioridad = (business_value * priority) / max(estimated_minutes, 1)
```

Si `business_value` o `estimated_minutes` son NULL, fallback a `priority DESC, created_at ASC`.

**Limit de concurrencia**: `MAX_WORKERS` (default 3, configurable via env var).

### Tick B: Scheduler de waiters activos (5000 ms)

**Objetivo**: pollear waiters con `horizon='long'` (polling adaptativo de baja frecuencia).

**Algoritmo**:

```typescript
async function tickB() {
  if (killswitchExists()) return;
  
  const waiters = await db.query(`
    SELECT id, script_path, condition_params_json, poll_interval_ms
      FROM waiters
     WHERE mode = 'active'
       AND horizon = 'long'
       AND status = 'waiting'
       AND (last_check_at IS NULL OR last_check_at + poll_interval_ms <= :now)
     ORDER BY next_check_at ASC
     LIMIT :max
  `, { now: Date.now(), max: MAX_ACTIVE_WAITERS });
  
  for (const waiter of waiters) {
    await spawnWaiterChecker(waiter);
  }
}
```

**Side-effects**:
- Intenta tomar lease atomico (UPDATE ... WHERE lease_until IS NULL OR lease_until < now).
- Si falla lease, saltea (otro proceso ya lo tomo).
- Si exito, bifurca script Bash con env vars (`WAITER_ID`, `WAITER_PARAMS_JSON`, etc.).
- Inserta fila en `waiter_checks` con resultado.

**Polling adaptativo**: `poll_schedule_json` define intervalos crecientes:
```json
{
  "type": "adaptive",
  "intervals": [86400000, 604800000, 2592000000],
  "escalateAfter": [30, 100]
}
```
Primeros 30 checks cada dia, siguientes 100 cada semana, resto cada mes.

### Tick C: Watcher de waiters pasivos (500 ms)

**Objetivo**: detectar input humano en `state/inbox/` y `state/fifo/`.

**Algoritmo**:

```typescript
async function tickC() {
  if (killswitchExists()) return;
  
  // Inbox files
  const files = fs.readdirSync('state/inbox/').filter(f => f.endsWith('.input'));
  for (const file of files) {
    const waiterId = file.replace('.input', '');
    const input = JSON.parse(fs.readFileSync(`state/inbox/${file}`, 'utf8'));
    await processWaiterInput(waiterId, input);
    fs.renameSync(`state/inbox/${file}`, `state/inbox/.processed/${file}`);
  }
  
  // FIFOs (polling via non-blocking read)
  const fifos = fs.readdirSync('state/fifo/');
  for (const fifo of fifos) {
    const waiterId = fifo;
    const fd = fs.openSync(`state/fifo/${fifo}`, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const buffer = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (bytesRead > 0) {
      const input = JSON.parse(buffer.slice(0, bytesRead).toString());
      await processWaiterInput(waiterId, input);
    }
    fs.closeSync(fd);
  }
}
```

**Side-effects**:
- Valida input contra `waiters.schema_json` (Zod).
- Valida authz contra `waiters.authz_json`.
- Ejecuta callback `onValid()` del waiter.
- Actualiza `waiters.status='fulfilled'`, `value_json=input`.
- Marca task asociada como `queued`.
- Emite evento `waiter.fulfilled`.

**Manejo de errores**:
- Si schema invalido: incrementa `waiters.attempts`. Si `attempts >= 3`, marca `status='invalid'` y escala.
- Si authz falla: rechaza inmediato, no incrementa attempts.

### Tick D: Activacion de waiters urgentes (500 ms)

**Objetivo**: bifurcar checkers para waiters cuyo `next_check_at` ya vencio o esta por vencer (<1s).

**Algoritmo**:

```typescript
async function tickD() {
  if (killswitchExists()) return;
  
  const waiters = await db.query(`
    SELECT id, script_path, condition_params_json
      FROM waiters
     WHERE mode = 'active'
       AND status = 'waiting'
       AND next_check_at <= :now + 1000
     ORDER BY next_check_at ASC
     LIMIT :max
  `, { now: Date.now(), max: MAX_ACTIVE_WAITERS });
  
  for (const waiter of waiters) {
    await spawnWaiterChecker(waiter);
  }
}
```

**Diferencia con tick B**: tick B es para `horizon='long'` (baja frecuencia). Tick D es para `horizon='short'` o waiters con `next_check_at` urgente.

**Side-effects**: identicos a tick B.

### Tick E: Consumer de eventos (250 ms)

**Objetivo**: leer tabla `events` interna, buscar dependientes de tasks terminadas, marcarlos `ready`.

**Algoritmo**:

```typescript
async function tickE() {
  if (killswitchExists()) return;
  
  const events = await db.query(`
    SELECT id, kind, payload_json
      FROM events
     WHERE consumed = 0
     ORDER BY id ASC
     LIMIT 100
  `);
  
  for (const event of events) {
    if (event.kind === 'task.finished') {
      const { task_id } = JSON.parse(event.payload_json);
      
      // Buscar dependientes
      const dependientes = await db.query(`
        SELECT td.task_id, t.status
          FROM task_dependencies td
          JOIN tasks t ON t.id = td.task_id
         WHERE td.depends_on_task_id = :task_id
           AND t.status = 'queued'
      `, { task_id });
      
      for (const dep of dependientes) {
        // Verificar si TODAS las deps estan done
        const pending = await db.query(`
          SELECT COUNT(*) AS cnt
            FROM task_dependencies td2
            JOIN tasks t2 ON t2.id = td2.depends_on_task_id
           WHERE td2.task_id = :dep_id
             AND t2.status <> 'done'
        `, { dep_id: dep.task_id });
        
        if (pending[0].cnt === 0) {
          await db.query(`UPDATE tasks SET status='ready' WHERE id=:id`, { id: dep.task_id });
        }
      }
    }
    
    // Marcar evento como consumido
    await db.query(`UPDATE events SET consumed=1 WHERE id=:id`, { id: event.id });
    
    // Emitir a events.jsonl
    await appendToJSONL('state/events.jsonl', event);
  }
}
```

**Side-effects**:
- Actualiza `tasks.status='ready'` cuando todas las dependencias se cumplen.
- Marca `events.consumed=1`.
- Escribe eventos a `events.jsonl` (auditoria append-only).

**Trigger SQLite** que alimenta esta tabla:

```sql
CREATE TRIGGER tasks_done_trigger
AFTER UPDATE OF status ON tasks
WHEN NEW.status = 'done' AND OLD.status <> 'done'
BEGIN
  INSERT INTO events(ts, kind, payload_json)
  VALUES (
    strftime('%s','now')*1000,
    'task.finished',
    json_object('task_id', NEW.id, 'flow_id', NEW.flow_id, 'stage', NEW.stage, 'agent_id', NEW.agent_id, 'tags', NEW.tags_json)
  );
END;
```

---

## Ciclo de deteccion de deadlocks (60 s)

**Objetivo**: detectar ciclos en `task_dependencies` activas.

**Algoritmo**:

```typescript
async function detectDeadlocks() {
  const dependencies = await db.query(`
    SELECT task_id, depends_on_task_id
      FROM task_dependencies td
      JOIN tasks t ON t.id = td.task_id
     WHERE t.status IN ('queued','ready','waiting-waiter')
  `);
  
  const graph = buildGraph(dependencies);
  const cycles = detectCycles(graph);  // DFS
  
  if (cycles.length > 0) {
    for (const cycle of cycles) {
      for (const taskId of cycle) {
        await db.query(`
          UPDATE tasks
             SET status='failed', error='deadlock detected'
           WHERE id=:id
        `, { id: taskId });
      }
      await notifyRoman(`Deadlock detectado: ${cycle.join(' -> ')}`);
    }
  }
}
```

**Side-effects**:
- Marca tasks involucradas como `failed` con razon `deadlock`.
- Emite alerta a Roman (Tech Lead).
- Loguea en `events.jsonl` con `kind='deadlock.detected'`.

**Prevencion en tiempo de creacion**: antes de crear un sprint, se corre `topological_sort()` sobre todas las dependencias declaradas. Si hay ciclo, el sprint se rechaza con error explicito.

**Deteccion runtime**: defensiva, cubre dependencias dinamicas generadas por `flow-coordinator`.

---

## Kill-switch check

**Objetivo**: permitir graceful shutdown sin matar procesos en vuelo.

**Mecanismo**:

```typescript
function killswitchExists() {
  return fs.existsSync('state/.KILLSWITCH');
}
```

Chequeado al inicio de **cada tick**. Si existe:
- El dispatcher deja de bifurcar nuevos procesos.
- Espera a que workers en vuelo terminen (timeout `kill_timeout=30s`).
- Cierra conexiones SQLite.
- Exit code 0.

**Activacion manual**:

```bash
touch state/.KILLSWITCH
```

**Desactivacion** (tras restart):

```bash
rm state/.KILLSWITCH
pm2 start ecosystem.config.js
```

**Diferencia con SIGTERM**: SIGTERM es enviado por PM2 o el operador. Kill-switch es un flag en disco que permite drain controlado antes del exit.

---

## Startup del dispatcher

**Secuencia**:

1. **Migraciones**: si `MIGRATE_ON_STARTUP=true`, corre `npm run migrate` automaticamente.
2. **PRAGMAs SQLite**: ejecuta `PRAGMA journal_mode=WAL`, `foreign_keys=ON`, etc.
3. **Recovery de waiters huerfanos**:
   ```sql
   SELECT * FROM waiters
    WHERE mode='active'
      AND status='waiting'
      AND (last_checked IS NULL OR last_checked < strftime('%s','now')*1000 - 60000)
   ```
   Para cada resultado, re-spawnea el checker.
4. **Emite `process.send('ready')` a PM2**: indica que el init termino exitosamente.
5. **Arranca los 5 ticks** + detector de deadlocks.

**Timeouts**:
- PM2 espera `listen_timeout=10000` (10 s) para recibir `ready`. Si no llega, reinicia.
- `min_uptime=30000` (30 s): si el dispatcher crashea antes de 30 s, PM2 lo cuenta como fallo de startup.

---

## Graceful shutdown

**Secuencia**:

1. **Detecta signal**: SIGTERM enviado por PM2 o `touch state/.KILLSWITCH`.
2. **Para de bifurcar**: cada tick chequea kill-switch y retorna sin spawn.
3. **Espera workers**: timeout `kill_timeout=30000` (30 s).
4. **Cierra DB**: `db.close()` con flush de WAL.
5. **Flush logs**: asegura que `events.jsonl` este sincronizado.
6. **Exit 0**: proceso termina limpiamente.

**Manejo de workers en vuelo**:
- Si un `agent-runner` sigue corriendo tras `kill_timeout`, PM2 lo mata con SIGKILL.
- El agent-runner debe terminar su task actual (no puede cancelarse mid-execution).
- Si una task estaba `running` y el proceso fue killed, al re-arrancar el dispatcher, la task queda en `running` pero sin worker. El dispatcher la detecta y la marca como `failed` con razon `worker-killed`.

---

## Como debugarlo cuando se cuelga

### Sintoma: dispatcher no procesa tasks nuevas

**Diagnostico**:

1. Verificar que el proceso esta vivo:
   ```bash
   pm2 list
   ```
   Si `status=stopped`, revisar `pm2 logs dispatcher --lines 100`.

2. Verificar kill-switch:
   ```bash
   ls state/.KILLSWITCH
   ```
   Si existe, removerlo.

3. Verificar leases bloqueados:
   ```sql
   SELECT id, lease_holder, lease_until
     FROM waiters
    WHERE lease_until > strftime('%s','now')*1000
      AND status='waiting';
   ```
   Si hay leases vencidos pero no liberados, es un bug. Liberarlos manualmente:
   ```sql
   UPDATE waiters SET lease_until=NULL, lease_holder=NULL WHERE id='...';
   ```

4. Verificar tasks huerfanas en `running`:
   ```sql
   SELECT id, agent_id, created_at
     FROM tasks
    WHERE status='running'
      AND created_at < strftime('%s','now')*1000 - 600000;  -- mas de 10 min
   ```
   Si hay tasks stuck, marcarlas como `failed`:
   ```sql
   UPDATE tasks SET status='failed', error='timeout' WHERE id='...';
   ```

5. Verificar tabla `events` saturada:
   ```sql
   SELECT COUNT(*) FROM events WHERE consumed=0;
   ```
   Si hay >10k eventos sin consumir, hay un problema en tick E. Revisar logs del dispatcher.

### Sintoma: dispatcher crashea repetidamente

**Diagnostico**:

1. Revisar `pm2 logs dispatcher --err --lines 200`.
2. Buscar stack trace de Node.
3. Causas comunes:
   - SQLITE_BUSY por timeout corto: aumentar `PRAGMA busy_timeout=10000`.
   - Out of memory: revisar `max_memory_restart` en PM2.
   - Uncaught exception en un tick: agregar `try/catch` defensivo.

### Sintoma: waiters no se cumplen nunca

**Diagnostico**:

1. Verificar que el script Bash es ejecutable:
   ```bash
   ls -la bin/waiters/active/<script>.sh
   ```
   Debe tener `chmod 750`.

2. Ejecutar el script manualmente:
   ```bash
   export WAITER_ID="..."
   export WAITER_PARAMS_JSON='{"..."}'
   export DB_PATH="state/orchestrator.db"
   export STATE_DIR="state"
   bin/waiters/active/<script>.sh
   echo $?  # debe ser 0 si condicion cumplida, 1 si no
   ```

3. Revisar `waiter_checks`:
   ```sql
   SELECT * FROM waiter_checks WHERE waiter_id='...' ORDER BY checked_at DESC LIMIT 10;
   ```
   Ver si hay errores (`error IS NOT NULL`).

4. Verificar `next_check_at`:
   ```sql
   SELECT id, next_check_at, poll_interval_ms FROM waiters WHERE id='...';
   ```
   Si `next_check_at` esta muy lejos en el futuro, el waiter no se chequeara pronto. Ajustar manualmente si es necesario:
   ```sql
   UPDATE waiters SET next_check_at=strftime('%s','now')*1000 WHERE id='...';
   ```

---

## Metricas Prometheus (futuro)

| Metrica | Tipo | Significado |
|---------|------|-------------|
| `dispatcher_tasks_throughput` | gauge | tasks completadas / hora |
| `dispatcher_slots_idle_seconds` | histogram | tiempo que un slot estuvo libre sin task `ready` |
| `dispatcher_tasks_blocked_count` | gauge (label: status) | tasks por estado |
| `dispatcher_deadlock_detected_total` | counter | ciclos detectados en runtime |
| `dispatcher_waiter_resolution_latency` | histogram | tiempo entre `task.finished` y `ready` del dependiente |
| `dispatcher_fanout` | histogram | dependientes por task |

**Alertas**:
- `dispatcher_deadlock_detected_total > 0` → page inmediato a Roman.
- `dispatcher_fanout p99 > 30` → warning.
- `task lleva > 2 h en queued con todas las dependencias en done` → slot starvation, page a Roman.

---

## Referencias

- **Spec seccion 3.1**: Dispatcher
- **Spec seccion 5**: Modelo de ejecucion
- **Spec seccion 7.10.5**: Work stealing (WSJF)
- **Spec seccion 7.10.6**: Deteccion de ciclos
- **Spec seccion 3.6.7**: PM2 ecosystem.config.js
- **ARCHITECTURE.md**: Diagrama de capas, tabla de procesos
