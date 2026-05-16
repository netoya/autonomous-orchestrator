# Reunion: Cierre temporal de gaps Tier 1
**Fecha:** 2026-05-16
**Equipo:** softwarefactory
**Convocada por:** Angel
**Participantes:** Roman (Tech Lead), Mateo (Backend), Dante (DevOps), Sofia (QA)

## Contexto

En el audit anterior detectamos 47 gaps clasificados en 5 tiers. Cerramos el ADR-001 (gap #1) en v0.7. Quedan **7 Tier 1** bloqueando el MVP. Angel pide cerrarlos **provisionalmente** (suficiente para empezar a codear, refinable despues), no perfeccionar cada uno.

Convencion: cada decision se marca **"provisional v0.8"** para no comprometer la arquitectura final.

## Discusion

### Roman (Tech Lead) — cierra #2, #3, #4, #5

#### Gap #2 — `TaskContext` (provisional v0.8)

```typescript
interface TaskContext {
  // Identidad
  flowId: string;
  taskId: string;
  parentTaskId?: string;
  iteration?: number;

  // Control de flujo declarativo
  wait(spec: WaiterSpec): Promise<WaiterResult>;
  complete(output: Record<string, any>): Promise<void>;
  fail(reason: string, retryable?: boolean): Promise<void>;

  // Logging estructurado
  log: {
    info(msg: string, meta?: object): void;
    warn(msg: string, meta?: object): void;
    error(msg: string, meta?: object): void;
  };

  // Artifacts write-only desde el flow
  artifacts: {
    write(type: string, data: any): Promise<{ path: string; hash: string }>;
  };

  // Activacion de dependientes ya declarados
  activatePendingDependents(taskIds: string[]): Promise<void>;

  // Spawn SOLO si el flow es flow-coordinator
  spawnSubtasks?(plan: SubtaskPlan): Promise<string[]>;

  // Helper de invocacion al AgentRunner
  agent: {
    run(agentId: string, prompt: string): Promise<string>;
  };
}
```

**Decision clave**: `spawnSubtasks` es opcional. Runtime valida que `agentId === 'flow-coordinator'`; si otro flow lo llama, lanza `Error('spawn reservado para coordinator')`.

#### Gap #3 — `flow-coordinator` API (provisional v0.8)

**CLI**:
```bash
orchestrator coordinator spawn --from-artifact <path> --parent-task-id <id>
```

**Schema del artifact**:
```json
{
  "tasks": [
    {
      "id": "string",
      "stage": "planning|execution|review",
      "agentId": "string",
      "input": {},
      "dependsOn": ["task-id"],
      "tags": ["string"]
    }
  ]
}
```

**Validaciones obligatorias antes de crear**:
1. Referencias: todo `dependsOn` apunta a un `id` que existe en el plan.
2. Ciclos: topological sort → rechazo inmediato.
3. Fan-out limit: `MAX_SPAWN_FANOUT=50` por invocacion.
4. Idempotencia: si ya existe task con mismo `id` en el flow, skipea con warning.

**Trazabilidad**: cada task creada emite evento `task.spawned-by-coordinator` con `taskId`, `parentTaskId`, `coordinatorVersion`, `artifactHash`.

#### Gap #4 — DSL `defineTask` / `defineSprint` (provisional v0.8)

```typescript
function defineTask(spec: {
  id: string;
  stage: 'planning' | 'execution' | 'review';
  agentId: string;
  input?: Record<string, any>;
  dependsOn?: string[];
  dependsOnTag?: string;
  tags?: string[];
  isMilestone?: boolean;
  priority?: number;
  businessValue?: number;
  estimatedMinutes?: number;
  waitFor?: WaiterSpec[];
}): TaskDef;

function defineSprint(spec: {
  id: string;
  name: string;
  version: string;
  autonomy: 'full' | 'supervised' | 'manual';
  tasks: TaskDef[];
}): Sprint;
```

**Validador Zod estricto**:
```typescript
const TaskDefSchema = z.object({ /* shape */ }).strict().refine(
  (data) => !('onSuccess' in data || 'onFailure' in data ||
              'nextTask' in data || 'callbackTo' in data || 'then' in data),
  { message: 'Campos imperativos prohibidos (principio 1.7.2)' }
);
```

**Carga del sprint**: dos formas.
- **Default**: archivo TS que exporta `default = defineSprint({...})`. `loadSprint(filePath)` lo ejecuta y devuelve el objeto.
- **Fallback**: JSON estatico parseado contra `SprintSchema`.

Mateo implementa la opcion TS primero.

#### Gap #5 — Protocolo SQL waiter-antes-de-task (provisional v0.8)

**Orden EXACTO**, una sola transaccion:

```sql
BEGIN TRANSACTION;

-- 1. Registrar waiter PRIMERO
INSERT INTO waiters (id, task_id, mode, kind, script_path, status, ...)
VALUES ('w-abc', 't-123', 'active', 'task-dependency', '...', 'waiting', ...);

-- 2. Insertar task con referencia al waiter
INSERT INTO tasks (id, flow_id, stage, agent_id, status, ...)
VALUES ('t-123', 'f-1', 'build', 'softwarefactory_mateo', 'waiting-waiter', ...);

-- 3. Event log
INSERT INTO events (ts, kind, payload_json)
VALUES (strftime('%s','now')*1000, 'task.waiting-on', json_object('task_id','t-123','waiter_id','w-abc'));

COMMIT;
```

**Falla parcial**: una sola transaccion. Si algo falla, `ROLLBACK` completo y la task NO arranca.

**Limpieza de huerfanos**: cron job cada hora elimina `waiters` con `status='waiting'` que no tienen `task` asociada (no deberia pasar con la transaccion, pero defensivo).

### Mateo (Backend) — cierra #6, #7

#### Gap #6 — Migraciones SQL (provisional v0.8)

**Estructura**:
```
src/db/migrations/
  001-initial-schema.sql
  002-add-waiters.sql
  003-add-backlog-entries.sql
  004-add-task-dependencies-events-trigger.sql
  005-add-agent-conversations.sql
```

**Tabla de control**:
```sql
CREATE TABLE schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL
);
```

**Runner** (`npm run migrate`):
1. Lee `src/db/migrations/`, ordena por nombre.
2. `SELECT name FROM schema_migrations` para saber aplicadas.
3. Para cada pendiente: calcula sha256, ejecuta en transaccion, inserta en `schema_migrations`.

**Forward-only**. Sin `down`. Si hay que retroceder, se escribe una nueva migracion que deshace. Mucho mas simple para el MVP.

**Triggers** (como `tasks_done_trigger`) van como `CREATE TRIGGER` dentro del archivo `.sql` que corresponda. El runner ejecuta todo el archivo secuencialmente.

#### Gap #7 — PRAGMAs SQLite (provisional v0.8)

Ejecutados al abrir cada conexion desde el dispatcher:

```sql
PRAGMA journal_mode = WAL;          -- obligatorio para leases concurrentes
PRAGMA busy_timeout = 5000;         -- 5s antes de devolver SQLITE_BUSY
PRAGMA foreign_keys = ON;           -- integridad referencial
PRAGMA synchronous = NORMAL;        -- balance durability/perf (FULL es overkill)
PRAGMA temp_store = MEMORY;         -- temporales en RAM
PRAGMA cache_size = -64000;         -- ~64 MB de cache
```

**No** se setea `mmap_size` por ahora. Default. Se tunea si vemos I/O como bottleneck.

### Dante (DevOps) — cierra #8

#### Gap #8 — PM2 `ecosystem.config.js` (provisional v0.8)

```javascript
module.exports = {
  apps: [
    {
      name: 'softwarefactory-orchestrator',
      script: 'dist/dispatcher.js',
      instances: 1,
      exec_mode: 'fork',                       // SQLite WAL no soporta multi-writer cross-proceso
      autorestart: true,
      watch: false,                            // cambios requieren restart manual con drain
      max_memory_restart: '512M',
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      kill_timeout: 30000,                     // 30s para drenar waiters activos

      env: {
        NODE_ENV: 'production',
        DB_PATH: './state/orchestrator.db',
        STATE_DIR: './state',
        MAX_WORKERS: 3,
        MAX_ACTIVE_WAITERS: 10,
        MAX_CONCURRENT_AGENT_RUNS: 10,
      },

      error_file: './state/logs/dispatcher.err.log',
      out_file: './state/logs/dispatcher.out.log',
      log_type: 'json',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
```

### Sofia (QA) — tests minimos de aceptacion (uno por gap)

| # | Test minimo |
|---|---|
| 2 | Instanciar `TaskContext` mock, llamar `ctx.wait(spec)`, verificar que retorna Promise que resuelve cuando el waiter emite el evento. |
| 3 | `orchestrator coordinator spawn --from-artifact <plan-valido.json> --parent-task-id X`: verifica que crea N tasks, evento `task.spawned-by-coordinator` aparece en `events` por cada una. |
| 4 | `defineTask({...con onSuccess: foo})` lanza error Zod con mensaje "Campos imperativos prohibidos (1.7.2)". |
| 5 | Insertar waiter+task+event en transaccion: si el INSERT de task falla, no queda waiter huerfano (rollback OK). |
| 6 | `npm run migrate` en DB vacia: tabla `schema_migrations` existe con N filas igual al numero de archivos. |
| 7 | Abrir conexion, ejecutar `PRAGMA journal_mode` y verificar que retorna `wal`. |
| 8 | Validar que `ecosystem.config.js` parsea como JS, contiene 1 app con `name` y `script` definidos, `instances === 1`. |

## Decisiones

1. Spec pasa a **v0.8** con seccion nueva **"3.6 Provisional Foundations (v0.8)"** que agrupa los 7 cierres.
2. Todos los cierres marcados como **"provisional v0.8"**; se refinan post-MVP segun aprendizaje.
3. Los 7 tests minimos de aceptacion son **bloqueantes**: hasta que pasen, ese gap NO se considera cerrado.
4. Se cierra el Tier 1 completo (8/8). Los 39 gaps restantes (Tier 2-5) NO bloquean el MVP.

## Action Items

| Responsable | Tarea | Fecha |
|---|---|---|
| Roman | Actualizar spec.md a v0.8 con seccion 3.6 Provisional Foundations | 2026-05-17 |
| Mateo | Implementar `001-initial-schema.sql` y migration runner | 2026-05-19 |
| Mateo | Implementar `TaskContext` (clase real, no mock) | 2026-05-21 |
| Mateo | Implementar `defineTask`/`defineSprint` + validador Zod | 2026-05-22 |
| Mateo | Aplicar PRAGMAs en el init del DAO | 2026-05-19 |
| Dante | Commit del `ecosystem.config.js` en raiz del proyecto | 2026-05-18 |
| Roman | Spec del CLI `orchestrator coordinator spawn` | 2026-05-22 |
| Sofia | Implementar los 7 tests minimos de aceptacion | 2026-05-27 |
