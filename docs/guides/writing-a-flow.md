# Guia: Escribir un Flow

Tutorial completo para crear tu primer flow en el Autonomous Orchestrator. De cero a flow funcional en 30 minutos.

## 1. Que es un flow

Un **flow** es una pipeline declarativa que modela un proceso de negocio (ej. "desarrollo de feature end-to-end", "onboarding de cliente", "pipeline de CI/CD"). Un flow se compone de:

- **Sprints**: conjuntos de tasks relacionadas.
- **Tasks**: unidades minimas de trabajo asignadas a agentes.
- **Dependencias**: relaciones explicitas entre tasks (`dependsOn`, `dependsOnTag`).
- **Waiters**: puntos de bloqueo/reanudacion ante entrada humana o condiciones externas.

El orquestador ejecuta el flow respetando las dependencias, coordinando waiters, y delegando la ejecucion concreta de cada task a un agente IA.

## 2. Anatomia de un flow

Todo flow se define con dos funciones principales:

### `defineSprint`

Crea un sprint (conjunto de tasks relacionadas) con nombre y lista de tasks.

```typescript
import { defineSprint } from '../core/flow';

export const miSprint = defineSprint({
  name: 'mi-sprint',
  tasks: [
    // ... lista de tasks ...
  ],
});
```

### `defineTask`

Crea una task individual con propiedades declarativas.

```typescript
import { defineTask } from '../core/flow';

const tarea1 = defineTask({
  id: 'tarea-1',                                    // ID unico dentro del sprint
  agentId: 'softwarefactory_mateo',                 // Que agente ejecuta esta task
  prompt: 'Crea un endpoint REST para listar usuarios',
  dependsOn: [],                                    // IDs de tasks de las que depende
  tags: ['backend', 'api'],                         // Etiquetas para agrupacion y metricas
  businessValue: 8,                                 // 1-10, para WSJF (opcional)
  estimatedMinutes: 30,                             // Estimacion de esfuerzo (opcional)
  isMilestone: false,                               // Si es checkpoint del sprint
});
```

## 3. Declarar dependencias

Existen dos formas de declarar dependencias entre tasks:

### `dependsOn` (dependencia explicita por ID)

```typescript
defineTask({
  id: 'escribir-tests',
  agentId: 'softwarefactory_sofia',
  prompt: 'Escribe tests unitarios para el endpoint /users',
  dependsOn: ['crear-endpoint'],  // Esta task solo arranca cuando 'crear-endpoint' esta done
}),
```

### `dependsOnTag` (dependencia implicita por etiqueta)

```typescript
defineTask({
  id: 'deploy-staging',
  agentId: 'softwarefactory_dante',
  prompt: 'Despliega la aplicacion a staging',
  dependsOnTag: ['qa-passed'],    // Arranca cuando todas las tasks con tag 'qa-passed' estan done
}),
```

**Cuando usar cada una**:

- `dependsOn`: cuando la dependencia es 1:1 y conoces el ID exacto de la task previa.
- `dependsOnTag`: cuando la dependencia es 1:N (ej. "esperar a que todos los tests pasen") o cuando el conjunto de tasks previas puede variar.

**IMPORTANTE**: el orquestador valida en tiempo de carga que no existan ciclos (dependencias circulares). Si detecta un ciclo, rechaza el sprint con error.

## 4. Como usar `ctx.wait()` con waiters

Cuando una task necesita pausar el flujo hasta que una condicion se cumpla, usa `ctx.wait()` dentro del prompt del agente o como parte del codigo de la task.

### Ejemplo: waiter pasivo (aprobacion humana)

```typescript
defineTask({
  id: 'aprobar-arquitectura',
  agentId: 'softwarefactory_roman',
  prompt: `
    Revisa la propuesta de arquitectura en el artifact anterior.
    Luego espera aprobacion humana con:
    
    await ctx.wait({
      mode: 'passive',
      kind: 'approve-architecture',
      prompt: 'Aprobar cambios arquitectonicos propuestos por Roman?',
      schema: z.object({ approved: z.boolean(), comments: z.string().optional() }),
      timeoutMs: 86400000, // 24 horas
      onValid: async (input, waiterCtx) => {
        if (input.approved) return { type: 'resume' };
        return { type: 'reject', reason: input.comments || 'Rechazado' };
      },
    });
  `,
  dependsOn: ['disenar-arquitectura'],
}),
```

El agente ejecuta su logica hasta `ctx.wait()`, momento en el que la task transiciona a `waiting-waiter`. El operador humano responde via:

```bash
npx orchestrator waiter fulfill <waiter-id> --json '{"approved":true,"comments":"Se ve bien"}'
```

Cuando el waiter se cumple, la task reanuda desde el punto donde quedo.

### Ejemplo: waiter activo (polling de condicion externa)

```typescript
defineTask({
  id: 'esperar-db-lista',
  agentId: 'softwarefactory_mateo',
  prompt: `
    Antes de migrar datos, espera a que la tabla 'users' exista:
    
    await ctx.wait({
      mode: 'active',
      kind: 'db-record-ready',
      scriptPath: 'bin/waiters/active/db-record-ready.sh',
      prompt: 'Esperando a que tabla users exista en DB',
      conditionParams: {
        query: 'SELECT COUNT(*) as c FROM sqlite_master WHERE type="table" AND name="users"',
        minCount: 1,
      },
      pollIntervalMs: 5000,       // Checkear cada 5 segundos
      pollMaxAttempts: 120,       // Max 10 minutos (120 checks * 5s)
      timeoutMs: 600000,          // TTL absoluto 10 min
      onFulfilled: async (result, waiterCtx) => {
        console.log('Tabla users detectada:', result.snapshot);
        return { type: 'resume' };
      },
    });
  `,
  dependsOn: ['crear-schema'],
}),
```

El scheduler del orquestador ejecuta el script `db-record-ready.sh` cada 5 segundos. Cuando la query devuelve >= 1 fila, el waiter se cumple y la task reanuda.

## 5. Como usar `ctx.agent.run()` vs `ctx.agent.runDetailed()`

Dentro del prompt de una task, puedes invocar a otro agente programaticamente (ej. para delegar subtareas).

### `ctx.agent.run()` (simple)

Retorna solo el output text del agente.

```typescript
const codigo = await ctx.agent.run(
  'softwarefactory_mateo',
  'Genera el codigo del endpoint /users GET en Express.js'
);

// codigo es un string con el resultado
await ctx.artifacts.write('endpoint-code', { code: codigo });
```

**Cuando usarlo**: casos donde solo te interesa el resultado, no metadata (costo, turnos, session_id).

### `ctx.agent.runDetailed()` (completo)

Retorna objeto `AgentRunResult` con metadata completa.

```typescript
const result = await ctx.agent.runDetailed(
  'softwarefactory_mateo',
  'Genera el codigo del endpoint /users GET',
  {
    permissionMode: 'acceptEdits',
    maxTurns: 10,
    timeoutMs: 300000, // 5 min
  }
);

if (!result.success) {
  ctx.log.error('El agente fallo', { error: result.error });
  await ctx.fail('Mateo no pudo generar el codigo');
  return;
}

ctx.log.info('Agente completado', {
  cost: result.cost,
  turns: result.numTurns,
  session: result.sessionId,
});

await ctx.artifacts.write('endpoint-code', { code: result.output });
```

**Cuando usarlo**: cuando necesitas controlar errores, medir costos, o retomar sesiones (`--resume`).

**IMPORTANTE**: el `flow-coordinator` siempre usa `runDetailed()` internamente para poder marcar sub-tasks como `failed` si el agente falla.

## 6. Como NO declarar un flow (antipatrones)

### Antipatron 1: declarar continuacion imperativa

```typescript
// MAL — viola principio 1.7
defineTask({
  id: 'tarea-1',
  onSuccess: () => enqueueTask('tarea-2'),  // PROHIBIDO
  nextTask: 'tarea-2',                      // PROHIBIDO
}),
```

**Por que es malo**: acopla la task con el flujo futuro. Si cambias el orden del pipeline, rompes la task.

**Como hacerlo bien**:

```typescript
defineTask({ id: 'tarea-1', /* ... */ }),
defineTask({ id: 'tarea-2', dependsOn: ['tarea-1'] }),  // Dependencia declarativa
```

### Antipatron 2: estado mutable compartido entre tasks

```typescript
// MAL — estado compartido en memoria
let contador = 0;

defineTask({
  id: 'tarea-1',
  prompt: `Incrementa contador: ${++contador}`,  // NO HACER
}),
```

**Por que es malo**: si el flow se hiberna o reinicia, el estado se pierde. Las tasks no son funciones puras.

**Como hacerlo bien**: usa artifacts o DB para persistir estado.

```typescript
defineTask({
  id: 'tarea-1',
  prompt: `
    Lee el contador del artifact anterior.
    Incrementalo.
    Guardalo en nuevo artifact:
    
    await ctx.artifacts.write('contador', { value: oldValue + 1 });
  `,
}),
```

### Antipatron 3: invocar `enqueueTask()` desde una task

```typescript
// MAL — spawn dinamico sin permisos
defineTask({
  id: 'tarea-1',
  prompt: `
    // NO HACER (salvo que seas flow-coordinator)
    await enqueueTask({ id: 'tarea-nueva', /* ... */ });
  `,
}),
```

**Por que es malo**: solo el `flow-coordinator` tiene permiso para crear tasks dinamicamente. Si otra task lo hace, viola el principio 1.7 y rompe la trazabilidad.

**Como hacerlo bien**: si necesitas spawn dinamico, delega al `flow-coordinator` o refactoriza el flow para declarar todas las tasks upfront.

### Antipatron 4: dependencias circulares

```typescript
// MAL — ciclo en el grafo
defineTask({ id: 'A', dependsOn: ['B'] }),
defineTask({ id: 'B', dependsOn: ['C'] }),
defineTask({ id: 'C', dependsOn: ['A'] }),  // Ciclo A→B→C→A
```

**Por que es malo**: el validador rechaza el sprint con error `Cycle detected`. El flow nunca arrancaria.

**Como hacerlo bien**: asegura que el grafo de dependencias sea aciclico (DAG). Valida antes de commitear:

```bash
npx orchestrator sprint plan --validate src/flows/mi-flow.flow.ts
```

## 7. Ejemplo completo: `hello-world.flow.ts`

Flow minimo que demuestra todos los conceptos.

```typescript
import { defineSprint, defineTask } from '../core/flow';
import { z } from 'zod';

export const helloWorldFlow = defineSprint({
  name: 'hello-world',
  tasks: [
    // Task 1: Camila escribe el requerimiento
    defineTask({
      id: 'escribir-req',
      agentId: 'softwarefactory_camila',
      prompt: 'Escribe un requerimiento para una feature "Hello World API" con criterios de aceptacion claros',
      dependsOn: [],
      tags: ['intake'],
      businessValue: 5,
      estimatedMinutes: 10,
    }),

    // Task 2: Lucas diseña el flujo UX (depende de req)
    defineTask({
      id: 'disenar-ux',
      agentId: 'softwarefactory_lucas',
      prompt: 'Diseña el flujo de interaccion del endpoint GET /hello?name=X. Crea mockup del JSON response.',
      dependsOn: ['escribir-req'],
      tags: ['ux'],
      businessValue: 3,
      estimatedMinutes: 15,
    }),

    // Task 3: Roman revisa arquitectura (depende de UX)
    defineTask({
      id: 'revisar-arquitectura',
      agentId: 'softwarefactory_roman',
      prompt: `
        Revisa la propuesta de Lucas. Define stack tecnico (Express.js).
        Luego espera aprobacion:
        
        await ctx.wait({
          mode: 'passive',
          kind: 'approve-architecture',
          prompt: 'Aprobar arquitectura Express.js para Hello World?',
          schema: z.object({ approved: z.boolean() }),
          timeoutMs: 86400000,
          onValid: async (input) => input.approved ? { type: 'resume' } : { type: 'reject', reason: 'No aprobado' },
        });
      `,
      dependsOn: ['disenar-ux'],
      tags: ['architecture'],
      businessValue: 10,
      estimatedMinutes: 20,
    }),

    // Task 4: Mateo implementa el backend (depende de arquitectura aprobada)
    defineTask({
      id: 'implementar-backend',
      agentId: 'softwarefactory_mateo',
      prompt: 'Crea endpoint GET /hello?name=X en Express.js que retorna {"message":"Hello, X"}',
      dependsOn: ['revisar-arquitectura'],
      tags: ['backend', 'implementation'],
      businessValue: 8,
      estimatedMinutes: 30,
    }),

    // Task 5: Sofia escribe tests (depende de backend)
    defineTask({
      id: 'escribir-tests',
      agentId: 'softwarefactory_sofia',
      prompt: 'Escribe tests unitarios para GET /hello con Jest. Cobertura >= 80%.',
      dependsOn: ['implementar-backend'],
      tags: ['qa', 'tests'],
      businessValue: 9,
      estimatedMinutes: 25,
    }),

    // Task 6: Sofia valida cobertura (waiter activo que espera a que tests pasen)
    defineTask({
      id: 'validar-cobertura',
      agentId: 'softwarefactory_sofia',
      prompt: `
        Ejecuta npm test y valida cobertura.
        Espera a que archivo coverage/coverage-summary.json exista:
        
        await ctx.wait({
          mode: 'active',
          kind: 'file-exists',
          scriptPath: 'bin/waiters/active/file-exists.sh',
          prompt: 'Esperando reporte de cobertura',
          conditionParams: { path: './coverage/coverage-summary.json' },
          pollIntervalMs: 10000,
          pollMaxAttempts: 30,
          timeoutMs: 300000,
          onFulfilled: async (result) => ({ type: 'resume' }),
        });
        
        // Luego valida que cobertura >= 80%
        const coverage = JSON.parse(await fs.readFile('./coverage/coverage-summary.json'));
        if (coverage.total.lines.pct < 80) {
          await ctx.fail('Cobertura insuficiente');
        }
      `,
      dependsOn: ['escribir-tests'],
      tags: ['qa', 'qa-passed', 'milestone'],
      isMilestone: true,
      businessValue: 10,
      estimatedMinutes: 10,
    }),

    // Task 7: Dante despliega a staging (depende de QA pasado)
    defineTask({
      id: 'deploy-staging',
      agentId: 'softwarefactory_dante',
      prompt: 'Despliega la aplicacion a staging. Valida que GET /hello responda 200.',
      dependsOnTag: ['qa-passed'],
      tags: ['deploy'],
      businessValue: 7,
      estimatedMinutes: 15,
    }),
  ],
});
```

### Como ejecutar este flow

```bash
# Validar antes de ejecutar (verifica DAG, schema)
npx orchestrator sprint plan --validate src/flows/hello-world.flow.ts

# Ejecutar completo
npx orchestrator flow create hello-world

# Ver estado
npx orchestrator flow show <flow-id>

# Ejecutar solo hasta milestone "validar-cobertura"
npx orchestrator run sprint <sprint-id> --until-milestone validar-cobertura
```

## 8. Validacion via CLI

Antes de commitear un flow, valida que:

1. No tenga ciclos (dependencias circulares).
2. El schema Zod de cada task sea valido.
3. Todos los `agentId` referenciados existan.
4. Los `dependsOn` y `dependsOnTag` apunten a tasks que existen.

```bash
npx orchestrator sprint plan --validate <archivo.flow.ts>
```

Si el validador falla, corrige los errores antes de abrir el PR.

## Recursos

- [Spec completa (v0.8.1)](../spec.md)
- [Glosario](../GLOSSARY.md)
- [Guia: escribir un waiter](writing-a-waiter.md)
- [Referencia CLI](../reference/cli.md)
- [CONTRIBUTING.md](../../CONTRIBUTING.md)
