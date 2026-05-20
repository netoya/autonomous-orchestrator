# ADR-007: Plan confirm/execute — CLI `flow confirm`, archivos por `flowId`, parent_flow_id

| | |
|---|---|
| **Status** | Accepted |
| **Fecha** | 2026-05-20 |
| **Version spec** | v0.8.1 |
| **Autores** | Angel Oliver, Claude Opus 4.7 (1M context) |
| **Supersedes** | — |
| **Relacionado** | ADR-005 (waiter roles), ADR-006 (lifecycle controls) |

---

## Contexto

Con ADR-005 (waiter loop nativo) el patrón **planner-mode** funciona: una task `planner-analyze` crea N waiters de clarificación, el operador responde, eventualmente Roman escribe `state/conversations/PLAN-FINAL.md` con `Status: PLAN_READY` y el flow se marca `completed`.

Pero **arrancar la ejecución real** del plan tiene 4 problemas operativos:

1. **Filename colisiona**. Roman escribe siempre el mismo archivo `PLAN-FINAL.md`. Dos flows de planner en paralelo se sobreescriben → el "confirm" del primero lee el plan del segundo.
2. **No hay CLI `flow confirm`**. El visor expone `POST /api/flows/confirm` (via `launchConfirm` que spawnea un coordinate manual con prompt "ejecuta el plan firme"). Pero si no usas el visor, tienes que armar el prompt a mano cada vez.
3. **No hay link entre flow planner y flow ejecutor**. El flow ejecutor no sabe de qué prepare vino. Auditoría rota: para ver "qué plan ejecutó este flow", hay que mirar el `.coord-prompts/` o `events.jsonl` con grep.
4. **Sin validación**. `launchConfirm` no chequea que `PLAN-FINAL.md` exista o que su status sea `PLAN_READY`. Posible: confirmar sobre un plan ambiguo o vacío.

### Opciones evaluadas

| Opción | Pros | Contras |
|---|---|---|
| **A: Status quo (operador hace prompt manual)** | Cero cambios. | 4 problemas anteriores. No escalable. |
| **B: Solo fix de filename (PLAN-FINAL-<flowId>.md)** | Resuelve race condition. ~10 min. | Sigue sin CLI, sin link, sin validación. Lo importante (UX del confirm) queda mal. |
| **C: Todo el paquete (este ADR)** | CLI confirm + filename por flowId + parent_flow_id + validación. UX clean. ~1h. | Migration 008 + cambio al prompt del planner-mode + cambio al visor. |

### Restricciones aplicables

- **Backward compat**: flows existentes con `PLAN-FINAL.md` global deben seguir confirmables. Implementación: el CLI `flow confirm` busca **primero** `PLAN-FINAL-<flowId>.md`, **fallback** a `PLAN-FINAL.md`.
- **Sin acoplar visor al CLI**: el visor sigue spawneando CLI (no llamando DAO directo), consistente con ADR-006.

---

## Decisión

**Adoptar opción C.** Cuatro cambios atómicos:

### 1. Filename del plan incluye `flowId`

El planner-mode (Roman como agente) escribe ahora:
- `state/conversations/PLAN-PROPOSAL-<flowId>.md` (durante rondas con waiter)
- `state/conversations/PLAN-FINAL-<flowId>.md` (al alcanzar PLAN_READY)

`docs/planner-mode.md` se actualiza con la nueva convención + ejemplo de path absoluto.

**Backward compat**: el CLI `flow confirm` y el visor `launchConfirm` aceptan tanto el nuevo path (`PLAN-FINAL-<flowId>.md`) como el legacy global (`PLAN-FINAL.md`). El planner-mode escribe el nuevo desde este ADR; los flows previos siguen siendo confirmables con el legacy.

### 2. CLI `orchestrator flow confirm <prepareFlowId> [--dry-run]`

Nuevo subcomando que:
1. Valida que `prepareFlowId` exista y esté `completed`.
2. Busca el archivo del plan: primero `PLAN-FINAL-<flowId>.md`, fallback `PLAN-FINAL.md`. Si no existe ninguno → exit 1 con error claro.
3. Verifica que el contenido tenga `Status: PLAN_READY` (regex case-insensitive, primeras 30 líneas). Si no → exit 1 "plan is not PLAN_READY".
4. Si `--dry-run`: imprime el path del plan + el prompt que se generaría + el coordinate command a ejecutar, sin lanzar.
5. Si no `--dry-run`: spawn `npx orchestrator coordinate "<prompt>"` con el prompt de ejecución (mismo template que `launchConfirm` del visor).
6. Inserta `flows.parent_flow_id = prepareFlowId` en el flow nuevo recién creado (ver punto 3).
7. Imprime al stdout `Plan confirmed. Execute flow: <newFlowId>` para que el operador pueda seguirlo.

### 3. Columna `flows.parent_flow_id` (Migration 008)

Nueva columna opcional `parent_flow_id TEXT REFERENCES flows(id) ON DELETE SET NULL`. Default NULL (los flows no vienen de un parent).

Se pobla en dos casos:
- `flow confirm <prepareFlowId>` → el nuevo flow ejecutor referencia el prepare.
- (Futuro v1.1) Auto-encadenamiento de flows via coordinator `createFlow` con flag explícito.

Permite queries de auditoría tipo:
```sql
SELECT f.id, f.name, parent.name AS came_from
FROM flows f
LEFT JOIN flows parent ON parent.id = f.parent_flow_id
WHERE f.id = ?;
```

### 4. Validación pre-confirm

`flow confirm` rechaza confirmar si:
- Prepare flow no existe.
- Prepare flow no está en estado `completed` (no se puede confirmar un planner que aún itera).
- El archivo del plan no existe (ni con flowId ni legacy).
- El plan no contiene `Status: PLAN_READY` (caso ambiguo: confirmar un plan en `BLOCKED-BY-WAITER` sería ejecutar sobre un plan incompleto).

Cada validación tiene mensaje de error específico para que el operador entienda qué arreglar.

### Detalles de implementación

#### Cambio en `planner-mode.md`

Sección "Convención de archivos" actualiza:

```diff
- - PLAN-PROPOSAL.md en state/conversations/ (caso ambiguedad)
- - PLAN-FINAL.md en state/conversations/ (caso resolved)
+ - state/conversations/PLAN-PROPOSAL-<flowId>.md (caso ambigüedad, una por flow)
+ - state/conversations/PLAN-FINAL-<flowId>.md (caso resolved, una por flow)
+
+ El planner DEBE incluir su flowId en el filename para evitar race conditions
+ entre flows paralelos. El flowId está disponible vía:
+ sqlite3 state/orchestrator.db 'SELECT flow_id FROM tasks WHERE stage=...'
```

#### Cambio en CLI

`src/cli/flow.ts` añade subcomando `confirm`:

```ts
if (subcommand === 'confirm') return flowConfirm(args.slice(1));

async function flowConfirm(args: string[]): Promise<void> {
  const prepareFlowId = args[0];
  const dryRun = args.includes('--dry-run');

  // 1. Validar prepare flow
  const flow = findFlowById(db, prepareFlowId);
  if (!flow) throw new Error(`Prepare flow ${prepareFlowId} not found`);
  if (flow.status !== 'completed') {
    throw new Error(`Prepare flow ${prepareFlowId} is in '${flow.status}', expected 'completed'`);
  }

  // 2. Buscar archivo (con flowId primero, fallback global)
  const newPath = `state/conversations/PLAN-FINAL-${prepareFlowId}.md`;
  const legacyPath = `state/conversations/PLAN-FINAL.md`;
  const planPath = existsSync(newPath) ? newPath : existsSync(legacyPath) ? legacyPath : null;
  if (!planPath) throw new Error(`No plan file found (looked in ${newPath} and ${legacyPath})`);

  // 3. Validar PLAN_READY
  const planContent = readFileSync(planPath, 'utf8').slice(0, 5000);
  if (!/Status:\s*PLAN_READY/i.test(planContent)) {
    throw new Error(`Plan ${planPath} is not in PLAN_READY status`);
  }

  // 4. Build prompt
  const prompt = `EJECUCION del plan firme generado por el flow de planner ${prepareFlowId}.

Lee ${planPath} — debe estar en Status: PLAN_READY.

Descompon el plan en tasks ejecutivas (impl/test/verify segun corresponda) y arranca el flow de implementacion.

Emite <<COORDINATOR_DONE>> cuando hayas creado las tasks.`;

  if (dryRun) {
    console.log(`[dry-run] Plan path: ${planPath}`);
    console.log(`[dry-run] Prompt:\n${prompt}`);
    console.log(`[dry-run] Would run: npx orchestrator coordinate "<prompt>"`);
    return;
  }

  // 5. Spawn coordinate
  // (Implementación: spawnSync del CLI o llamar internamente al subcomando coordinate)
  // 6. Parsear flowId + coordinatorTaskId del output
  // 7. UPDATE flows SET parent_flow_id = prepareFlowId WHERE id = newFlowId
  // 8. Imprimir resultado
}
```

#### Cambio en visor

`server/operations.ts:launchConfirm` se simplifica a un wrapper sobre el CLI nuevo:

```ts
export async function launchConfirm(opts: { prepareFlowId: string }) {
  // En lugar de spawn coordinate con prompt inline, ahora delegamos al CLI
  const { stdout, stderr, exitCode } = await spawnFlowConfirm(opts.prepareFlowId);
  if (exitCode !== 0) throw new Error(`confirm exit=${exitCode}: ${stderr}`);
  // CLI imprime "Plan confirmed. Execute flow: <id>"
  const match = stdout.match(/Execute flow:\s*([A-Z0-9]+)/);
  if (!match) throw new Error(`unexpected confirm output: ${stdout}`);
  return { executeFlowId: match[1] };
}
```

---

## Consecuencias

### Positivas

1. **Cierra el loop prepare → confirm → execute** con UX limpia tanto en CLI como en visor.
2. **Race condition eliminada**: cada prepare tiene su propio `PLAN-FINAL-<flowId>.md`.
3. **Auditoría completa**: dado un flow ejecutor, `parent_flow_id` lleva al prepare; dado un prepare, `task waiters` muestra el "diálogo" que produjo el plan. Trazabilidad end-to-end de "idea → plan → ejecución".
4. **Validación protege al operador** de confirmar planes inválidos.
5. **Backward compatible**: flows pre-ADR siguen confirmables con `PLAN-FINAL.md` global.
6. **CLI confirm permite uso sin visor** (scripts, CI, cron, etc.).

### Negativas

1. **Migration 008** añade columna nueva. Mitigación: NULLABLE, default NULL, no rompe lectura de filas existentes.
2. **Cambio al prompt del planner-mode**: futuras invocaciones del coordinator-seed deben respetar la convención de filename. Mitigación: doc actualizado, y el CLI `flow confirm` tolera ambos paths.
3. **Validación estricta puede ser molesta** en casos legítimos donde el plan esté en `BLOCKED-BY-WAITER` y el operador quiera "forzar" la ejecución. Mitigación: `--force` flag puede añadirse en v1.0 si surge necesidad real (KISS por ahora).

### Neutras

- `parent_flow_id` se podrá usar para visualizar árboles de flows en el visor (v1.1+). Out of scope de este ADR.

---

## Alternativas consideradas

| Alternativa | Por qué se rechazó |
|---|---|
| Sufijo timestamp en lugar de flowId | Menos legible. flowId es ULID, sortable cronológicamente igual. |
| Mover el plan a la DB (campo blob) | Pierde grep-ability y diff vs versión anterior. Los archivos markdown son cómodos de leer manualmente. |
| Auto-confirm tras N rondas sin waiter | Riesgo de ejecutar planes a medio cocer. El paso de confirmación humano es valioso. |
| Eliminar el legacy `PLAN-FINAL.md` global desde día 1 | Rompe flows pre-ADR (Roman pre-fix no sabía del nuevo path). Backward compat es barato. |

---

## Plan de implementación

| Step | Cambio | Estimado |
|---|---|---|
| 1 | Migration 008: añadir `flows.parent_flow_id` | 5 min |
| 2 | DAO: extender `createFlow` para aceptar `parent_flow_id` opcional + helper `setParentFlowId` | 5 min |
| 3 | Actualizar `docs/planner-mode.md` con convención de filename | 5 min |
| 4 | CLI: nuevo subcomando `flow confirm` en `src/cli/flow.ts` | 20 min |
| 5 | Visor: simplificar `launchConfirm` para usar CLI confirm | 10 min |
| 6 | Build + smoke (con flow del experimento previo, que tiene plan en path legacy) | 10 min |
| 7 | Commit + push ambos repos | 5 min |

**Total**: ~60 min.

---

## Test plan (smoke)

```bash
# Con flow ya completed del experimento (PLAN-FINAL.md global, legacy)
npx orchestrator flow confirm 01KS2SNHCF41ZGQT8BKJNNZWHH --dry-run
# expected: imprime path del plan + prompt + comando que ejecutaria

# Sin --dry-run
npx orchestrator flow confirm 01KS2SNHCF41ZGQT8BKJNNZWHH
# expected: "Plan confirmed. Execute flow: 01K..."
# (NO ejecutamos en realidad — gasta tokens — pero el dry-run valida el path)

# Validaciones
npx orchestrator flow confirm 01XXXXXXXX  # flow not found → exit 1
npx orchestrator flow confirm <running-flow>  # no completed → exit 1
```

---

## Referencias

- **ADR-005**: waiter roles — el planner-mode produce el plan que se confirma aquí.
- **ADR-006**: lifecycle controls — `task waiters` permite auditar el diálogo del prepare.
- **`docs/planner-mode.md`**: convención de filename, actualizado por este ADR.
- **Spec visor v1**: `visor-orchestrator/docs/specs/v1-write-operations.md` §3 ya documenta el endpoint POST /api/flows/confirm — su implementación se beneficia directamente del CLI confirm.

---

**Firmado**: Angel Oliver, Claude Opus 4.7 (1M context), 2026-05-20  
**Aprobado por**: Angel Oliver (operador-arquitecto, aprobación previa explícita)
