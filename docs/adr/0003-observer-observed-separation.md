# ADR-003: Separacion entre observador y objeto observado

| | |
|---|---|
| **Status** | Accepted |
| **Fecha** | 2026-05-16 |
| **Version spec** | v0.5 |
| **Autores** | Roman (Tech Lead), Camila (PM) |
| **Motivacion** | Violacion implicita del principio en propuestas v0.4 |

---

## Contexto

Durante el diseño de la coordinacion reactiva (v0.4), surgieron propuestas donde las tasks controlaban directamente su propia continuacion:

**Propuesta rechazada A** (de Valeria, frontend dev):
```typescript
defineTask({
  id: 'build-backend',
  stage: 'build',
  onSuccess: () => enqueueTask('deploy-backend'),  // ❌ violacion
});
```

**Propuesta rechazada B** (de Mateo, backend dev):
```typescript
defineTask({
  id: 'sync-data',
  stage: 'etl',
  onComplete: (ctx) => {
    if (ctx.output.recordCount > 1000) {
      ctx.spawnTask('validate-large-dataset');     // ❌ violacion
    }
  },
});
```

Ambos patrones parecen intuitivos (callbacks, encadenamiento imperativo), pero introducen:

### Problemas detectados

1. **Acoplamiento temporal**: `build-backend` necesita saber que `deploy-backend` existe y cuando debe ejecutarse. Si el flujo evoluciona (insertamos una tarea intermedia `test-backend`), hay que modificar `build-backend`.

2. **Dependencias circulares**: si `task-A` spawneea `task-B`, y `task-B` spawneea `task-C` que observa `task-A`, tenemos un ciclo implicito que solo se detecta en runtime.

3. **Dificultad de reanudacion**: si el sistema crashea despues de que `build-backend` termino pero antes de que el callback `onSuccess` se ejecuto, la continuacion se pierde. No hay registro persistido de la intencion.

4. **Estados inconsistentes**: una task en `done` que fallo al encolar su continuacion queda en estado zombie: "termino pero su efecto lateral no ocurrio".

5. **Testing fragil**: para testear `build-backend`, tenemos que mockear `enqueueTask` y verificar que se llamo con los argumentos correctos. Esto acopla el test con el mecanismo de continuacion.

### Principio arquitectonico subyacente

En arquitecturas tradicionales de pipelines, una tarea suele contener conocimiento explicito sobre:
- Que paso debe ejecutarse despues.
- Cuando debe ejecutarse.
- Bajo que condiciones debe desbloquearse el trabajo siguiente.

Este modelo funciona para pipelines estaticos y rigidos, pero falla cuando:
- Los flujos evolucionan en el tiempo.
- Necesitamos reanudacion tras crashes.
- Queremos hibernar flujos por meses.
- Las dependencias son dinamicas (coordinacion reactiva).

**La solucion**: separar explicitamente el rol de "emitir estado" del rol de "decidir continuidad".

---

## Decision

**Formalizamos el principio de separacion observador / objeto observado como propiedad arquitectonica del sistema.**

### Definicion

> Las tareas no controlan el futuro del flujo.  
> Los observadores coordinan la continuidad a partir de estados verificables.

### Separacion de roles

| Rol | Responsabilidad | Mecanismo |
|-----|-----------------|-----------|
| **Objeto observado** (task / flow / artifact) | Emitir estado o producir efectos | `ctx.complete(output)`, `ctx.fail(reason)`, `ctx.wait(waiterSpec)` |
| **Observador** (waiter) | Detectar condiciones y coordinar reactivaciones | Waiters activos (poll), waiters pasivos (input), triggers SQLite |
| **Scheduler** | Orquestar la ejecucion fisica segun el estado emergente | Dispatcher (5 ticks), selector WSJF, lease pattern |

**Analogia operativa** (Camila, para comunicacion al equipo):

> Las tareas no tienen telefonos. Terminan y se van.  
> Otras tareas estan atentas y arrancan cuando ven que ya pueden hacerlo.

Comparable a semaforos vs coordinadores de trafico.

---

## Reglas operativas derivadas

### 1. Prohibicion de llamadas encadenadas

Una task **no puede** invocar `enqueueTask()` ni equivalentes para programar su propia continuacion.

Solo puede emitir estado final via:
- `ctx.complete(output)`
- `ctx.fail(reason)`
- `ctx.wait(waiterSpec)`

**Racional**: la continuacion es responsabilidad del scheduler, no de la task.

### 2. Waiters como unica fuente de continuidad

Toda dependencia task→task se modela como waiter con condicion verificable:
- `condition_kind='task-dependency'` (espera a que otra task este `done`).
- `condition_kind='flow-dependency'` (espera a que otro flow este `completed`).
- `condition_kind='tag-resolved'` (espera a que todas las tasks con cierto tag esten `done`).

**No hay callbacks** entre tasks. La coordinacion es declarativa, no imperativa.

### 3. Idempotencia de decisiones de continuacion

Un waiter que evalua dos veces el mismo estado debe decidir lo mismo.

**Prohibido**:
```typescript
let counter = 0;
waiter.onCheck = () => {
  counter++;
  return counter > 5;  // ❌ no idempotente
};
```

**Permitido**:
```typescript
waiter.onCheck = (ctx) => {
  const attempts = ctx.getWaiterAttempts(waiterId);
  return attempts > 5;  // ✅ estado verificable del sistema
};
```

**Racional**: permite replay desde `events`, recovery tras crashes, debugging determinista.

### 4. Separacion de responsabilidades en codigo

Tasks ejecutan logica de negocio. Waiters deciden coordinacion. Scheduler orquesta ejecucion fisica.

**Smell**: una funcion que cumple dos de estos roles debe partirse.

**Ejemplo de violacion**:
```typescript
function buildAndDeploy(ctx) {
  // logica de build (negocio)
  const artifact = compilar();
  ctx.artifacts.write('build', artifact);
  
  // coordinacion (scheduler)
  if (artifact.size > 100_000) {
    ctx.enqueueTask('validate-large-build');  // ❌ smell
  }
}
```

**Refactor correcto**:
```typescript
// Task: solo negocio
function build(ctx) {
  const artifact = compilar();
  ctx.artifacts.write('build', artifact);
  ctx.complete({ artifactSize: artifact.size });
}

// Waiter: coordinacion
defineTask({
  id: 'validate-large-build',
  dependsOn: ['build'],
  waitFor: [{
    mode: 'active',
    kind: 'artifact-threshold',
    conditionParams: {
      artifactType: 'build',
      property: 'size',
      operator: '>',
      threshold: 100_000,
    },
  }],
});
```

---

## Aplicacion en la API de declaracion

La API de `defineTask` y `defineSprint` valida estaticamente este principio.

### Campos prohibidos

Rechazados con error de schema Zod al cargar el sprint:

```typescript
const TaskDefSchema = z.object({
  // ... campos validos ...
}).strict().refine(
  (data) => !('onSuccess' in data || 'onFailure' in data ||
              'nextTask' in data || 'callbackTo' in data || 'then' in data),
  { message: 'Campos imperativos prohibidos (principio 1.7.2)' }
);
```

### Campos permitidos (declarativos)

```typescript
defineTask({
  id: 'implement-frontend',
  stage: 'build',
  agentId: 'softwarefactory_valeria',
  dependsOn: ['define-api-contract'],           // ✅ dependencia explicita por ID
  dependsOnTag: ['backend-ready'],              // ✅ dependencia por tag
  waitFor: [approveArchitectureWaiter],         // ✅ waiter explicito
  tags: ['frontend', 'milestone'],              // ✅ etiquetas para observadores
  isMilestone: true,                            // ✅ metadato para scheduler
});
```

**Efecto**: el compilador TypeScript rechaza codigo que intente usar campos imperativos. Los errores se detectan en desarrollo, no en runtime.

---

## Excepcion controlada: `flow-coordinator`

Existe **un unico rol** con permiso explicito para crear sub-tasks a partir de una en curso: el agente `flow-coordinator`.

**Justificacion**: el coordinator es un meta-agente cuya responsabilidad declarada es planificar y spawnear tasks. No es un side-effect oculto; es su proposito explicito.

### Restricciones sobre el coordinator

1. **Identificacion por rol**: no es string matching contra `agentId === 'flow-coordinator'`. Se identifica via campo `agents.role='coordinator'` en la DB.

2. **Solo crea tasks, no waiters**: el coordinator emite un plan de tasks. Los waiters se crean implicitamente cuando cada task spawneada ejecuta `ctx.wait()` durante su run.

3. **Validaciones obligatorias**:
   - Referencias: todo `dependsOn` apunta a un `id` que existe en el plan o en `tasks` activas del mismo flow.
   - Ciclos: topological sort sobre el plan → rechazo inmediato si hay loop.
   - Fan-out limit: `MAX_SPAWN_FANOUT=50` por invocacion.
   - Idempotencia: si ya existe una task con el mismo `id` en el flow, se omite con warning.

4. **Trazabilidad**: cada task creada emite evento `task.spawned-by-coordinator` en `events.jsonl`:
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

5. **Las tasks spawneadas respetan todos los demas principios**: dependencias declarativas, sin campos imperativos, waiters como continuidad.

**Resultado**: el coordinator es la unica fuente controlada de spawn dinamico. Todo lo demas sigue el modelo declarativo.

---

## Consecuencias

### Beneficios arquitectonicos

1. **Elimina acoplamiento entre etapas del pipeline**: `build-backend` no necesita conocer `deploy-backend`. Solo sabe que termino y emitio estado.

2. **Evita que una task necesite conocer el flujo completo**: cada task es self-contained. Su logica no cambia si el flujo evoluciona.

3. **Permite reactivacion asincronica y tardia**: un waiter puede activar una task 3 meses despues de que su precondicion se cumplio. No hay timeouts implicitos.

4. **Facilita hibernacion y wake-up de flows**: el contexto del flow se serializa sin callbacks en memoria. Al despertar, los waiters validan condiciones y reactivan.

5. **Reduce riesgo de race conditions**: no hay callbacks concurrentes que escriban en estado compartido. Solo el dispatcher escribe en `tasks.status`.

6. **Habilita coordinacion reactiva basada en condiciones reales del sistema**: el trabajo despierta cuando las dependencias estan `done`, no cuando una task anterior "decidio" que deberian estarlo.

### Impacto en el codigo

**Antes (v0.4, propuesta rechazada)**:
```typescript
defineTask({
  id: 'build',
  onSuccess: () => enqueueTask('test'),
  onFailure: () => notifySlack('build failed'),
});
```

**Despues (v0.5, aceptado)**:
```typescript
// Task solo declara lo que hace
defineTask({
  id: 'build',
  stage: 'build',
  agentId: 'mateo',
});

// Waiter observa y coordina
defineTask({
  id: 'test',
  stage: 'qa',
  agentId: 'sofia',
  dependsOn: ['build'],  // espera a que build este done
});

// Notificacion es otro waiter (monitor de fallos)
defineTask({
  id: 'notify-build-failure',
  stage: 'ops',
  agentId: 'dante',
  waitFor: [{
    mode: 'active',
    kind: 'task-failure-monitor',
    conditionParams: { taskId: 'build' },
  }],
});
```

**Resultado**: mas verbose pero mas robusto. El flujo es declarativo, auditable, reproducible.

---

## Implicancias operativas

### Para developers (Valeria, Mateo)

- Al escribir una task, solo pensar en "que hace esta task", no en "que sigue despues".
- Usar `ctx.complete(output)` para emitir resultado. El scheduler decidira que hacer.
- Si necesitan coordinacion condicional ("si X entonces Y"), modelarlo como waiter activo con `condition_kind` custom.

### Para QA (Sofia)

- Tests de tasks son unit tests puros: input → output. Sin mocks de continuacion.
- Tests de flujos validan eventos generados, no callbacks ejecutados.

### Para PM (Camila)

- Los flujos son grafos declarativos, no secuencias imperativas.
- Cambiar el orden de tasks no requiere modificar las tasks existentes, solo sus dependencias.
- Agregar un gate de aprobacion es insertar un waiter, no modificar la task upstream.

### Para DevOps (Dante)

- El dispatcher no ejecuta callbacks custom; solo lee estado y aplica reglas.
- Debugging: seguir eventos en `events.jsonl`, no stack traces de callbacks.

---

## Referencias

- **Spec seccion 1.7**: Separacion entre observador y objeto observado
- **Spec seccion 1.7.1**: Reglas operativas derivadas
- **Spec seccion 1.7.2**: Aplicacion en la API de declaracion
- **Spec seccion 1.7.3**: Excepcion controlada (flow-coordinator)
- **Spec seccion 3.6.2**: API del flow-coordinator
- **Spec seccion 3.6.3**: DSL defineTask / defineSprint
- **Spec seccion 7.10**: Coordinacion reactiva de trabajo
- **Acta principio observador**: `meetings/2026-05-16-principio-observador-observado.md`

---

## Ejemplos de aplicacion

### Ejemplo 1: Dependencia simple

**Antes (imperativo, rechazado)**:
```typescript
defineTask({
  id: 'task-a',
  run: async (ctx) => {
    const result = await doWork();
    ctx.enqueueTask('task-b', { input: result });  // ❌
  },
});
```

**Despues (declarativo, aceptado)**:
```typescript
defineTask({ id: 'task-a', run: async (ctx) => {
  const result = await doWork();
  ctx.complete({ result });
}});

defineTask({ id: 'task-b', dependsOn: ['task-a'] });
```

### Ejemplo 2: Aprobacion condicional

**Antes**:
```typescript
defineTask({
  id: 'deploy',
  run: async (ctx) => {
    if (ctx.env === 'prod') {
      await requestApproval();  // ❌ side effect de coordinacion
    }
    deploy();
  },
});
```

**Despues**:
```typescript
defineTask({ id: 'deploy', run: deploy });

// Waiter solo se activa en prod
defineTask({
  id: 'approve-prod-deploy',
  dependsOn: ['deploy'],
  waitFor: [{
    mode: 'passive',
    kind: 'approve-prod-deploy',
    prompt: 'Aprobar deploy a produccion?',
    schema: z.object({ decision: z.enum(['approved','rejected']) }),
    timeoutMs: 24 * 3600 * 1000,
  }],
  skip: () => process.env.ENV !== 'prod',
});
```

### Ejemplo 3: Backlog vivo

**Antes**: feature descartada manualmente porque el costo es alto.

**Despues**: feature hibernada con waiter de `horizon='long'` que monitorea el costo. Se reactiva sola cuando baja del umbral.

```typescript
defineTask({
  id: 'integrate-provider-x',
  waitFor: [{
    mode: 'active',
    kind: 'cost-threshold-monitor',
    horizon: 'long',
    conditionParams: {
      source: 'https://api.providerx.com/pricing',
      threshold: 80,
    },
    pollSchedule: { type: 'adaptive', intervals: [86400000, 604800000] },
    backlog: {
      title: 'Integracion Provider X (pausada por costo)',
      rationale: 'Costo actual $120/mo. Umbral $80/mo.',
      category: 'cost',
    },
  }],
});
```

El waiter observa el precio. La task no sabe que esta hibernada. Cuando el precio baja, el waiter la activa.

---

**Firmado**: Roman (Tech Lead), Camila (PM), 2026-05-16  
**Ratificado**: v0.5 tras detectar violaciones en propuestas v0.4
