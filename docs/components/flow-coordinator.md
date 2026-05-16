# Flow Coordinator — Excepcion controlada para spawn dinamico

> **Spec**: seccion 3.6.2, 1.7.3  
> **Responsable**: Roman (arquitectura), Camila (politicas)

---

## Por que es la unica excepcion al principio 1.7

El **principio de separacion observador/objeto observado** (ADR-003, spec seccion 1.7) prohibe que una task controle directamente su propia continuacion.

**Ejemplo prohibido**:

```typescript
defineTask({
  id: 'build',
  onSuccess: () => enqueueTask('deploy'),  // ❌ violacion
});
```

El **flow-coordinator** es la **unica excepcion controlada** a este principio. Su responsabilidad declarada ES planificar y spawnear tasks. No es un side-effect oculto; es su proposito explicito.

### Restricciones que garantizan seguridad

1. **Identificacion por rol** (no por string matching):
   - Campo `agents.role='coordinator'` en la DB.
   - Cualquier agente con `role='coordinator'` tiene acceso a `ctx.spawnSubtasks()`.
   - El string `'flow-coordinator'` es el agentId por convencion legible.

2. **Solo crea tasks, no waiters**:
   - El coordinator emite un plan de tasks.
   - Los waiters se crean implicitamente cuando cada task spawneada ejecuta `ctx.wait()`.

3. **Validaciones obligatorias**:
   - Referencias: todo `dependsOn` apunta a un `id` existente.
   - Ciclos: topological sort sobre el plan → rechazo si hay loop.
   - Fan-out limit: `MAX_SPAWN_FANOUT=50` por invocacion.
   - Idempotencia: si ya existe task con mismo `id`, se omite con warning.

4. **Trazabilidad**:
   - Cada task spawneada emite evento `task.spawned-by-coordinator`.
   - El `artifact_hash` del plan queda registrado.

5. **Las tasks spawneadas respetan todos los demas principios**:
   - Dependencias declarativas, sin campos imperativos, waiters como continuidad.

---

## CLI

```bash
orchestrator coordinator spawn --from-artifact <path.json> --parent-task-id <id>
```

**Ejemplo**:

```bash
orchestrator coordinator spawn \
  --from-artifact state/outbox/plan-abc123.json \
  --parent-task-id task-plan-review
```

---

## Schema del artifact que consume

El coordinator lee un archivo JSON con este schema:

```json
{
  "tasks": [
    {
      "id": "string",
      "stage": "planning | execution | review",
      "agentId": "string",
      "input": { "...": "..." },
      "dependsOn": ["task-id"],
      "tags": ["string"],
      "priority": 5,
      "businessValue": 8,
      "estimatedMinutes": 60,
      "isMilestone": false
    }
  ]
}
```

**Validacion Zod estricta**:

```typescript
const SubtaskPlanSchema = z.object({
  tasks: z.array(z.object({
    id: z.string(),
    stage: z.enum(['planning', 'execution', 'review']),
    agentId: z.string(),
    input: z.record(z.any()).optional(),
    dependsOn: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    priority: z.number().optional(),
    businessValue: z.number().optional(),
    estimatedMinutes: z.number().optional(),
    isMilestone: z.boolean().optional(),
  })),
});
```

**Campos prohibidos** (igual que en `defineTask`):
- `onSuccess`, `onFailure`, `nextTask`, `callbackTo`, `then`.

---

## Validaciones obligatorias

Antes de crear cada task, el coordinator ejecuta:

### 1. Referencias

Todo `dependsOn` apunta a un `id` que existe en el plan o en `tasks` activas del mismo flow.

```typescript
for (const task of plan.tasks) {
  for (const depId of task.dependsOn || []) {
    const exists = plan.tasks.some(t => t.id === depId) ||
                   await db.exists('tasks', { id: depId, flow_id: flowId });
    if (!exists) {
      throw new Error(`Task ${task.id} depends on unknown ${depId}`);
    }
  }
}
```

### 2. Ciclos

Topological sort sobre el plan completo. Si hay ciclo, rechazo inmediato:

```typescript
const graph = buildGraph(plan.tasks);
const sorted = topologicalSort(graph);
if (sorted.error) {
  throw new Error(`Ciclo detectado: ${sorted.cycle.join(' -> ')}`);
}
```

### 3. Fan-out limit

`MAX_SPAWN_FANOUT=50` (configurable via env var).

```typescript
if (plan.tasks.length > MAX_SPAWN_FANOUT) {
  throw new Error(`Plan excede MAX_SPAWN_FANOUT (${plan.tasks.length} > ${MAX_SPAWN_FANOUT})`);
}
```

Si un flow legitimo necesita > 50 tasks, se hacen multiples invocaciones secuenciales.

### 4. Idempotencia

Si ya existe una task con el mismo `id` en el flow, se omite con warning:

```typescript
for (const task of plan.tasks) {
  const exists = await db.exists('tasks', { id: task.id, flow_id: flowId });
  if (exists) {
    await emitEvent({
      kind: 'coordinator.duplicate_skipped',
      payload: { task_id: task.id, artifact_hash, reason: 'already-exists' },
    });
    continue;  // omite el INSERT
  }
  await db.insert('tasks', { ...task, flow_id: flowId });
}
```

---

## Trazabilidad obligatoria

Cada task creada emite evento en `events`:

```json
{
  "kind": "task.spawned-by-coordinator",
  "payload": {
    "task_id": "...",
    "parent_task_id": "...",
    "coordinator_version": "0.8",
    "artifact_hash": "sha256:..."
  }
}
```

**Auditoria**: permite rastrear que tasks fueron spawneadas por cual invocacion del coordinator.

---

## Manejo de dependencias sobre tasks ya `done`

Si una task referenciada en `dependsOn` esta en `done` al momento del INSERT, la nueva task se crea directamente con `status='ready'`.

**Razon**: idempotencia. Mismo input → mismo estado inicial. No se rechaza.

**Implementacion**:

```typescript
for (const task of plan.tasks) {
  const deps = task.dependsOn || [];
  const allDone = await db.query(`
    SELECT COUNT(*) AS pending
      FROM tasks
     WHERE id IN (${deps.map(() => '?').join(',')})
       AND status <> 'done'
  `, deps);
  
  const status = allDone[0].pending === 0 ? 'ready' : 'queued';
  await db.insert('tasks', { ...task, status });
}
```

---

## `waitFor` en el artifact

El coordinator **NO crea waiters directamente**. Solo tasks.

Los waiters se crean implicitamente cuando la task ejecuta `ctx.wait()` durante su run.

**Incorrecto** (rechazado):

```json
{
  "tasks": [
    {
      "id": "task-a",
      "waitFor": [{ "mode": "passive", "kind": "approve" }]  // ❌ NO soportado
    }
  ]
}
```

**Correcto**:

La task `task-a`, al ejecutarse, llama `ctx.wait(approveSpec)`. El waiter se materializa en ese momento.

---

## CLI vs API programatica

Ambos comparten el mismo modulo `src/coordinator/spawn.ts`. El CLI es un thin wrapper sobre la API.

**API**:

```typescript
export async function spawnSubtasks(
  flowId: string,
  parentTaskId: string,
  artifactPath: string,
): Promise<{ created: string[]; skipped: string[] }> {
  const plan = loadAndValidatePlan(artifactPath);
  validateReferences(plan, flowId);
  detectCycles(plan);
  enforceFanout(plan);
  
  const created: string[] = [];
  const skipped: string[] = [];
  
  for (const task of plan.tasks) {
    if (await db.exists('tasks', { id: task.id, flow_id: flowId })) {
      skipped.push(task.id);
      continue;
    }
    await db.insert('tasks', { ...task, flow_id: flowId, parent_task_id: parentTaskId });
    await emitEvent('task.spawned-by-coordinator', { task_id: task.id, parent_task_id: parentTaskId });
    created.push(task.id);
  }
  
  return { created, skipped };
}
```

**CLI**:

```typescript
const result = await spawnSubtasks(flowId, parentTaskId, artifactPath);
console.log(`Created: ${result.created.length}, Skipped: ${result.skipped.length}`);
```

---

## Limites

| Limite | Valor | Configurable | Razon |
|--------|-------|--------------|-------|
| `MAX_SPAWN_FANOUT` | 50 | env var | Prevenir explosiones de tasks accidentales |
| `MAX_GRAPH_DEPTH` | 100 | constante | Profundidad maxima del grafo (prevenir recursion infinita) |
| `MAX_FANOUT_PER_TASK` | 20 | constante | Dependientes directos de una sola task |

**Enforcement**:
- `MAX_SPAWN_FANOUT`: validado antes del INSERT.
- `MAX_GRAPH_DEPTH`: validado en topological sort.
- `MAX_FANOUT_PER_TASK`: validado al crear `task_dependencies`.

---

## Ejemplo de uso

### Artifact `plan-login-feature.json`

```json
{
  "tasks": [
    {
      "id": "define-api-contract",
      "stage": "planning",
      "agentId": "softwarefactory_mateo",
      "input": { "feature": "login" },
      "tags": ["api-contract"],
      "priority": 8,
      "businessValue": 9,
      "estimatedMinutes": 30
    },
    {
      "id": "implement-backend",
      "stage": "execution",
      "agentId": "softwarefactory_mateo",
      "dependsOn": ["define-api-contract"],
      "tags": ["backend"],
      "priority": 7,
      "businessValue": 9,
      "estimatedMinutes": 90
    },
    {
      "id": "implement-frontend",
      "stage": "execution",
      "agentId": "softwarefactory_valeria",
      "dependsOn": ["implement-backend"],
      "tags": ["frontend"],
      "priority": 7,
      "businessValue": 9,
      "estimatedMinutes": 90,
      "isMilestone": true
    }
  ]
}
```

### Invocacion

```bash
orchestrator coordinator spawn \
  --from-artifact state/outbox/plan-login-feature.json \
  --parent-task-id task-planning-review
```

### Resultado

- 3 tasks creadas en `tasks` tabla.
- 2 dependencias en `task_dependencies`.
- `define-api-contract` con `status='ready'` (sin deps).
- `implement-backend` y `implement-frontend` con `status='queued'` (esperan deps).
- 3 eventos `task.spawned-by-coordinator` en `events`.

---

## Referencias

- **Spec seccion 3.6.2**: API del flow-coordinator
- **Spec seccion 1.7.3**: Excepcion controlada
- **ADR-003**: Separacion observador/objeto observado
- **Spec seccion 7.10**: Coordinacion reactiva
