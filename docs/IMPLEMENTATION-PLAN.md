# Plan de Implementacion — MVP y Roadmap

> **Version**: 0.8.1  
> **Autor**: Roman (Tech Lead), Camila (PM)  
> **Base**: [Spec v0.8.1](spec.md), [Plan MVP seccion 8](spec.md#8-plan-de-implementacion-del-mvp)

---

## Estado actual: Fase 0 — Documentacion + Spec

**Fecha**: 2026-05-16  
**Completado**: 100%

### Entregables

- [x] **Spec v0.8.1**: ~2200 lineas, 8/8 gaps Tier 1 cerrados.
- [x] **ADRs**: 3 decisiones arquitectonicas fundamentales documentadas.
- [x] **ARCHITECTURE.md**: resumen ejecutivo, diagrama de capas, 5 ticks.
- [x] **Componentes**: dispatcher, agent-runner, waiters, flow-coordinator.
- [x] **Data model**: schema SQL completo con ER.
- [x] **Plan de implementacion**: este documento.

### Criterio de cierre

Toda la documentacion tecnica/arquitectonica creada y revisada por Roman + equipo.

---

## Fase 1: MVP — "Demo Hello World"

**Objetivo**: flujo end-to-end ejecutable con un agente, un waiter pasivo, y persistencia funcional.

**Fecha estimada**: 2026-05-30  
**Responsables**: equipo completo

### Hitos y owners

| # | Hito | Owner | Fecha | Status |
|---|------|-------|-------|--------|
| 1 | Spec v0.8.1 firmada | Roman | 2026-05-17 | ✅ Done |
| 2 | Interfaz `AgentRunner` + `ClaudeCodeRunner` | Roman + Mateo | 2026-05-18 | Pendiente |
| 3 | Schema SQL + migraciones + DAO | Mateo | 2026-05-19 | Pendiente |
| 4 | Skeleton del daemon dispatcher + ecosystem PM2 | Dante | 2026-05-20 | Pendiente |
| 5 | Tick A (selector tasks) + bifurcacion agent-runner | Mateo | 2026-05-21 | Pendiente |
| 6 | Test harness con mocks Claude | Sofia | 2026-05-22 | Pendiente |
| 7 | Tick C (watcher de waiters pasivos) | Mateo | 2026-05-23 | Pendiente |
| 8 | CLI `orchestrator` (start/stop/status/flow list) | Mateo | 2026-05-24 | Pendiente |
| 9 | Primer waiter pasivo (`approve-architecture`) | Roman | 2026-05-26 | Pendiente |
| 10 | Flujo "Hello World" end-to-end | Equipo completo | 2026-05-30 | Pendiente |

### Flujo "Hello World" (criterio de cierre del MVP)

**Definicion**:

```typescript
// src/flows/hello-world.flow.ts
defineSprint({
  id: 'hello-world',
  name: 'Hello World — primer flujo funcional',
  version: '0.1.0',
  autonomy: 'supervised',
  tasks: [
    defineTask({
      id: 'greet-operator',
      stage: 'execution',
      agentId: 'softwarefactory_mateo',
      input: { name: 'Angel' },
      priority: 10,
    }),
    defineTask({
      id: 'request-approval',
      stage: 'review',
      agentId: 'n/a',  // waiter pasivo, sin agente
      dependsOn: ['greet-operator'],
      waitFor: [{
        mode: 'passive',
        kind: 'approve-architecture',
        prompt: 'Aprobar saludo?',
        schema: z.object({ decision: z.enum(['approved','rejected']) }),
        timeoutMs: 10 * 60 * 1000,  // 10 min
      }],
    }),
  ],
});
```

**Pasos del test**:

1. Operador corre:
   ```bash
   orchestrator flow create hello-world
   ```

2. Dispatcher ejecuta `greet-operator` (tick A + agent-runner).

3. Task termina, emite `task.finished`, crea waiter `approve-architecture`.

4. Operador responde:
   ```bash
   orchestrator waiter fulfill <id> --json '{"decision":"approved"}'
   ```

5. Waiter se cumple, task `request-approval` pasa a `done`, flow se completa.

6. Verificacion:
   ```bash
   orchestrator flow show hello-world
   # Status: completed
   # Tasks: 2/2 done
   
   tail -n 10 state/events.jsonl | jq
   # Eventos: flow.created, task.started, task.finished, waiter.created, waiter.fulfilled, flow.completed
   ```

**Criterio de exito**: todos los pasos ejecutan sin error, eventos generados coinciden con esperados.

---

## Fase 2: Consolidacion — Dashboard + Waiters activos + Backlog vivo

**Fecha estimada**: 2026-07-15  
**Objetivo**: completar funcionalidades core del spec v0.8.1.

### Hitos principales

| # | Hito | Owner | Gap Tier | Status |
|---|------|-------|----------|--------|
| 11 | Tick B + D (scheduler waiters activos) | Mateo | Tier 2 | Planned |
| 12 | Scripts Bash de waiters base (task-dep, db-record, file, http) | Roman | Tier 2 | Planned |
| 13 | Tick E (consumer eventos → activacion tasks) | Mateo | Tier 2 | Planned |
| 14 | Detector de deadlocks runtime | Mateo | Tier 2 | Planned |
| 15 | Dashboard read-only (React + API HTTP) | Valeria | Tier 2 | Planned |
| 16 | Backlog vivo: tabla `backlog_entries` + revision trimestral | Camila + Mateo | Tier 2 | Planned |
| 17 | Flow-coordinator: `orchestrator coordinator spawn` | Roman + Mateo | Tier 2 | Planned |
| 18 | Circuit breaker + semaforo concurrencia agent runs | Mateo | Tier 2 | Planned |
| 19 | Auth con sops+age para `ANTHROPIC_API_KEY` | Dante | Tier 2 | Planned |
| 20 | Sandbox Docker para L3-L5 | Dante | Tier 2 | Planned |

### Dashboard MVP

**Stack**: React + TanStack Query + API HTTP local sobre SQLite.

**Pantallas**:
1. **Home**: resumen de flows activos, tasks en cola, waiters pendientes.
2. **Flow detail**: grafo de tasks, estado por task, logs.
3. **Waiter inbox**: lista de waiters esperando input humano.
4. **Backlog**: entradas latentes, categoria, next_review_at.

**NO incluye** (diferido a Fase 3):
- Workflow editor drag-and-drop.
- Modificacion de flows en curso.
- Administracion de agentes.

---

## Fase 3: Escala — Temporal + Multi-tenant + Vault

**Fecha estimada**: 2026-12-01  
**Objetivo**: preparar para produccion multi-usuario.

### Hitos principales

| # | Hito | Owner | Gap Tier | Status |
|---|------|-------|----------|--------|
| 21 | Migracion a Temporal (opcional, evaluacion) | Roman + Dante | Tier 3 | Research |
| 22 | PostgreSQL como backend alternativo a SQLite | Mateo | Tier 3 | Research |
| 23 | Multi-tenancy: `tenant_id` en todas las tablas | Mateo | Tier 3 | Planned |
| 24 | Vault integration (HashiCorp / AWS Secrets Manager) | Dante | Tier 3 | Planned |
| 25 | Autenticacion OIDC para operadores | Dante | Tier 3 | Planned |
| 26 | Observabilidad: Prometheus + Grafana | Dante | Tier 3 | Planned |
| 27 | Alertas automaticas (PagerDuty / Slack) | Dante | Tier 3 | Planned |
| 28 | Particionamiento de `events` por mes | Mateo | Tier 3 | Planned |

### Decision: Temporal vs custom dispatcher

**Evaluacion pendiente**:

- Si en Fase 2 vemos que SQLite + dispatcher custom escala bien (< 100 flows, < 1000 tasks/dia), mantener.
- Si superamos esos volumenes o necesitamos durable execution (replay tras crash), migrar a Temporal.

**Trade-offs**:

| Aspecto | Custom dispatcher | Temporal |
|---------|-------------------|----------|
| Complejidad operacional | Baja (1 proceso PM2) | Alta (cluster 3+ nodos, gRPC) |
| Durabilidad | SQLite WAL (buena) | Durable execution (excelente) |
| Replay tras crash | Recovery manual de waiters huerfanos | Replay automatico desde event history |
| Escalabilidad | < 100 flows concurrentes | Miles de flows |
| Costo infraestructura | $0 (local) | $500-2000/mes (managed Temporal Cloud) |

**Decision**: diferir a Fase 3. MVP con dispatcher custom.

---

## Estado de los 47 gaps por Tier (auditoria v0.8.1)

### Tier 1 — Bloqueantes del MVP (CERRADO 8/8)

| # | Gap | Cerrado en | Test minimo |
|---|-----|------------|-------------|
| 1 | ADR-001 (invocacion Claude) | v0.7 | Spec Anexo N.5 |
| 2 | `TaskContext` | v0.8, 3.6.1 | Spec 3.6.1 |
| 3 | `flow-coordinator` API | v0.8, 3.6.2 | Spec 3.6.2 |
| 4 | DSL `defineTask`/`defineSprint` | v0.8, 3.6.3 | Spec 3.6.3 |
| 5 | Protocolo SQL waiter-antes-de-task | v0.8, 3.6.4 | Spec 3.6.4 |
| 6 | Migraciones SQL | v0.8, 3.6.5 | Spec 3.6.5 |
| 7 | PRAGMAs SQLite | v0.8, 3.6.6 | Spec 3.6.6 |
| 8 | PM2 `ecosystem.config.js` | v0.8, 3.6.7 | Spec 3.6.7 |

### Tier 2 — Importantes (post-MVP, 17 gaps)

| # | Gap | Owner | Prioridad | Target |
|---|-----|-------|-----------|--------|
| 9 | Scheduler waiters activos (tick B+D) | Mateo | Alta | Fase 2 |
| 10 | Scripts Bash waiters base | Roman | Alta | Fase 2 |
| 11 | Consumer eventos (tick E) | Mateo | Alta | Fase 2 |
| 12 | Detector deadlocks runtime | Mateo | Media | Fase 2 |
| 13 | Dashboard read-only | Valeria | Media | Fase 2 |
| 14 | Backlog vivo (`backlog_entries`) | Camila+Mateo | Media | Fase 2 |
| 15 | Flow-coordinator spawn | Roman+Mateo | Alta | Fase 2 |
| 16 | Circuit breaker agent runs | Mateo | Media | Fase 2 |
| 17 | Auth sops+age | Dante | Alta | Fase 2 |
| 18 | Sandbox Docker L3-L5 | Dante | Alta | Fase 2 |
| 19-25 | (otros Tier 2) | varios | Baja-Media | Fase 2 |

### Tier 3 — Nice to have (22 gaps)

Diferidos a Fase 3. No bloqueantes para produccion limitada (< 10 usuarios, < 50 flows).

---

## Criterios de aceptacion por fase

### Fase 1 (MVP)

- [x] Spec firmada, documentacion completa.
- [ ] Flujo "Hello World" ejecuta end-to-end.
- [ ] 1 waiter pasivo funcional (`approve-architecture`).
- [ ] Persistencia SQLite con migraciones.
- [ ] Dispatcher arranca via PM2, sobrevive a restart.
- [ ] CLI `orchestrator` con subcomandos basicos.
- [ ] Test suite con mocks Claude (>80% coverage de core).

### Fase 2 (Consolidacion)

- [ ] Waiters activos: 5 scripts base (task-dep, db, file, http, flow-dep).
- [ ] Coordinacion reactiva: work stealing WSJF funcional.
- [ ] Detector de deadlocks: topological sort pre-ejecucion + runtime.
- [ ] Dashboard: 4 pantallas basicas (home, flow detail, waiter inbox, backlog).
- [ ] Backlog vivo: 1 caso real (ej. feature pausada por costo) hibernada y despertada automaticamente.
- [ ] Flow-coordinator: 1 sprint spawneado dinamicamente.
- [ ] Auth: secrets encriptados con sops+age.

### Fase 3 (Escala)

- [ ] Decision tomada: Temporal si/no (con justificacion documentada).
- [ ] Multi-tenancy: 2+ usuarios operando flows independientes.
- [ ] Observabilidad: metricas Prometheus expuestas, dashboard Grafana basico.
- [ ] Alertas: deadlock detectado → page a Roman.
- [ ] Performance: 100+ flows concurrentes, 500+ tasks/dia, sin saturacion.

---

## Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigacion |
|--------|--------------|---------|------------|
| **SQLite no escala** | Media | Alto | Fase 3: migrar a PostgreSQL + Temporal si superamos volumenes |
| **Cambios breaking en CLI Claude** | Baja | Alto | Interfaz `AgentRunner` abstrae; si CLI depreca, swapear a SDK |
| **Backlog vivo acumula entradas sin revisar** | Alta | Medio | Revision trimestral obligatoria, alertas si >200 latentes |
| **Prompt injection compromete agente** | Media | Critico | Tests obligatorios (Sofia), `appendSystemPrompt` siempre, sandbox L3+ |
| **Dispatcher crashea en produccion** | Media | Alto | PM2 autorestart, recovery de waiters huerfanos, monitoring Grafana |
| **Dependencias circulares no detectadas** | Baja | Medio | Topological sort pre-ejecucion + detector runtime cada 60s |
| **Costo tokens se dispara** | Media | Alto | Budget por flow, circuit breaker, semaforo concurrencia |

---

## Metricas de exito del MVP

| Metrica | Target | Como medirla |
|---------|--------|--------------|
| **Flujos completados sin intervencion manual** | >80% | `SELECT COUNT(*) FROM flows WHERE status='completed' AND error IS NULL` |
| **Waiters resueltos en <24h (SLA del BRD)** | >90% | `SELECT AVG(fulfilled_at - created_at) FROM waiters WHERE fulfilled_at IS NOT NULL` |
| **Uptime del dispatcher** | >99% | PM2 logs + monitoring |
| **Cobertura de tests** | >80% | `npm run coverage` |
| **Tiempo promedio de resolucion de bugs Tier 1** | <48h | Tracker de issues |
| **Satisfaccion del equipo (encuesta)** | >4/5 | Survey post-MVP |

---

## Siguiente paso inmediato

**Hito #2**: Implementar interfaz `AgentRunner` + `ClaudeCodeRunner`.

**Owner**: Roman (interfaz) + Mateo (implementacion).

**Fecha**: 2026-05-18.

**Criterio de exito**:

```typescript
const runner = new ClaudeCodeRunner();
const result = await runner.run({
  agentId: 'softwarefactory_mateo',
  prompt: 'Responde con "hello world"',
  permissionMode: 'plan',
  maxTurns: 1,
});

assert(result.success === true);
assert(result.output.includes('hello world'));
```

---

## Referencias

- **Spec seccion 8**: Plan de implementacion del MVP
- **Spec seccion 3.6.8**: Estado del Tier 1
- **BRD**: Requerimientos funcionales y SLAs
- **ARCHITECTURE.md**: Vision general
