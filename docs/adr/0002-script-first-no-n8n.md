# ADR-002: Script-first sin n8n

| | |
|---|---|
| **Status** | Accepted |
| **Fecha** | 2026-05-16 |
| **Version spec** | v0.1 (ratificado v0.2) |
| **Autores** | Equipo SoftwareFactory completo |
| **Supersedes** | BRD seccion 6 (arquitectura) — propuesta n8n |

---

## Contexto

El BRD v1.0 proponia **n8n** como capa de orquestacion externa para coordinar agentes, gestionar flujos y manejar aprobaciones humanas. La decision fue evaluada en la reunion de pivot del 2026-05-16.

### Propuesta original (BRD)

**n8n como motor**:
- Workflows visuales via UI drag-and-drop.
- Integraciones pre-hechas con Slack, email, HTTP webhooks.
- Retry automatico, dead-letter queues, error handling.
- Manejo de estado en MongoDB o PostgreSQL.
- Despliegue via Docker Compose.

**Justificacion del BRD**: reducir tiempo de desarrollo evitando reinventar scheduling, retry, persistencia y UI.

### Problemas detectados

Durante la evaluacion tecnica (Roman + Mateo + Dante), se identificaron fricciones:

1. **Vendor lock-in visual**: los workflows en n8n son JSON propietario. Migrar a otro orquestador (Temporal, Airflow, custom) requiere reescribir todo.

2. **Debugging opaco**: errores en n8n se rastrean via UI web. No hay stack traces en filesystem ni logs estructurados en JSONL.

3. **Local-first comprometido**: n8n requiere MongoDB/PostgreSQL + Redis (si queremos queue mode). Esto rompe el principio 1 del spec (local-first, zero infra).

4. **Customizacion limitada**: waiters complejos (horizonte largo, polling adaptativo, goal-seeking) requieren code nodes de JavaScript inline o webhooks externos. Ambos son anti-patrones para auditoria.

5. **Testing**: n8n no tiene test harness nativo. Tendriamos que mockear workflows via API HTTP, lo cual es fragil.

6. **Version control**: workflows se exportan como JSON gigantes. Diffs en git son ilegibles.

7. **Costo cognitivo**: el equipo necesita aprender n8n (DSL visual + n8n-specific quirks) + mantener dos bases de codigo (workflows n8n + agentes TS).

### Alternativa evaluada: scripts puros

**Propuesta**:
- Motor escrito en Node + TypeScript.
- Waiters activos como scripts Bash (contrato env vars + exit codes).
- SQLite + JSONL como persistencia.
- PM2 como supervisor.
- CLI directa sobre filesystem.

**Ventajas**:
- Control total sobre scheduler, retry, dead-letter, leases.
- Debugging con herramientas UNIX standard (`sqlite3`, `jq`, `tail -f`).
- Version control: workflows son archivos `.ts` legibles.
- Testing: mocks Node standard, fixtures JSON.
- Zero infra: `npm install && npm run migrate && pm2 start`.

**Desventajas**:
- Reinventamos scheduler, retry, lease pattern, polling adaptativo.
- Sin UI visual (diferido a Fase 2).
- Integraciones custom (no reutilizamos n8n nodes).

---

## Decision

**Rechazamos n8n. Adoptamos arquitectura script-first:**

- **Motor**: Node + TypeScript + scripts Bash glue.
- **Persistencia**: SQLite (WAL mode) + `events.jsonl`.
- **Supervisor**: PM2 (1 proceso daemon dispatcher).
- **Interfaz**: CLI `orchestrator` (sin HTTP en MVP).

### Componentes核心

| Componente | Implementacion | Responsabilidad |
|-----------|----------------|-----------------|
| Dispatcher | `src/dispatcher.ts` (daemon Node) | 5 ticks, bifurca agent-runners y waiter-checkers |
| Agent Runner | `src/runner.ts` (proceso corto Node) | Invoca agente via `AgentRunner`, persiste output |
| Waiters pasivos | `src/waiters/*.ts` (specs Zod + callbacks) | Validan input humano |
| Waiters activos | `bin/waiters/active/*.sh` (scripts Bash) | Poll condiciones externas |
| CLI | `bin/orchestrator` (Node con shebang) | start/stop/flow create/waiter fulfill/logs |
| DB | SQLite 3.x (archivo `state/orchestrator.db`) | Fuente de verdad |
| Event log | `state/events.jsonl` (append-only) | Auditoria inmutable |

### Stack tecnico

| Capa | Tecnologia | Justificacion |
|------|-----------|---------------|
| Runtime | Node 20 LTS | Nativo en equipos dev, buen soporte TS |
| Lenguaje | TypeScript 5.x | Type safety, refactor seguro |
| DB | SQLite 3.x (WAL) | Zero-config, ACID, lecturas concurrentes |
| Supervisor | PM2 | Restart automatico, logs, clustering (futuro) |
| Scripts | Bash 5.x + jq | Waiters custom sin tocar TS |
| Schema validation | Zod | Runtime validation + type inference |
| Migraciones | Custom runner (forward-only) | Simplicidad > feature richness |

---

## Consecuencias

### Positivas

1. **Control total**: decidimos algoritmo de scheduling (WSJF), lease pattern, polling adaptativo, circuit breaker. No dependemos de quirks de n8n.

2. **Debugging con herramientas UNIX**: `sqlite3 state/orchestrator.db "SELECT * FROM tasks WHERE status='failed'"`, `tail -f state/events.jsonl | jq`, `pm2 logs dispatcher --lines 100`.

3. **Version control legible**: workflows son archivos `.ts` con sintaxis conocida. Diffs en git son claros. PR reviews son codigo, no JSON opaco.

4. **Testing robusto**: mocks Node standard. Fixtures JSON en `src/test/fixtures/`. Harness custom que valida eventos generados vs esperados.

5. **Zero infra en MVP**: `git clone && npm install && npm run migrate && pm2 start`. Sin Docker Compose, sin MongoDB, sin Redis.

6. **Customizacion sin limites**: goal-seeking, backlog vivo, coordinacion reactiva, hibernacion de flows → todo implementable sin hack.

7. **Portabilidad futura**: si queremos migrar a Temporal (Fase 3), el modelo de waiters + tasks ya es compatible. Solo cambiamos el dispatcher.

### Negativas

1. **Reinventamos scheduler**: n8n daba retry automatico, dead-letter queues, cron scheduling gratis. Nosotros debemos implementar:
   - Lease pattern con SQLite (race condition handling).
   - Polling adaptativo (backoff exponencial, horizon short/long).
   - Circuit breaker (429 del proveedor).
   - Detector de deadlocks (topological sort cada 60 s).
   - Recovery de waiters huerfanos al startup.

   **Estimacion**: +2 semanas de desarrollo (Mateo + Roman). **Aceptado** porque gana control y evita vendor lock-in.

2. **Sin UI visual**: n8n tenia workflow editor drag-and-drop. Nosotros tenemos CLI + archivos TS. Camila y Angel pierden visibilidad grafica. **Mitigacion**: dashboard read-only en Fase 2 (React + API HTTP sobre SQLite).

3. **Integraciones custom**: n8n tenia nodes pre-hechos para Slack, email, webhooks. Nosotros debemos escribirlas. **Mitigacion**: las integraciones criticas (Slack notif, email approval) son waiters custom (< 100 lineas Bash cada uno). No bloqueante.

4. **Curva de aprendizaje**: el equipo debe entender el contrato de waiters Bash (env vars + exit codes), el modelo de lease, el ciclo de vida de flows. **Mitigacion**: esta documentacion + ejemplos en anexos del spec.

5. **Performance ceiling**: SQLite WAL soporta ~10k writes/s en NVMe. Si superamos 100 flows concurrentes con burst de eventos, podemos saturar. **Mitigacion**: Fase 3 evalua Temporal + PostgreSQL. MVP no llega a ese volumen.

6. **Sin dead-letter queue nativo**: n8n movia errores fatales a un queue separado. Nosotros marcamos `tasks.status='failed'` y escalamos. **Mitigacion**: operador puede crear flow de recovery manual via CLI. Suficiente para MVP.

---

## Alternativas consideradas y rechazadas

| Alternativa | Por que se rechazo |
|-------------|-------------------|
| **Temporal** | Excelente para produccion (durable execution, replay), pero overkill para MVP. Requiere cluster (3+ nodos), gRPC, complejidad operacional. Diferido a Fase 3. |
| **Airflow** | Diseñado para ETL batch (DAGs diarios). No soporta waiters de larga duracion (horizonte largo). Requiere PostgreSQL + Redis + Celery. Peso excesivo. |
| **Prefect** | Mas liviano que Airflow, pero mismo problema: orientado a batch. Sin primitivo de "esperar input humano asincrono indefinido". |
| **AWS Step Functions** | Rompe principio 1 (local-first). Vendor lock-in AWS. Costo variable por transicion. Rechazado. |
| **Custom con MongoDB** | MongoDB da change streams (reactivo). Pero requiere replica set (3+ nodos) para produccion. SQLite es suficiente para MVP. |

---

## Plan de migracion futura (post-MVP)

Si en Fase 3 migramos a **Temporal**:

| Concepto actual | Mapeo a Temporal |
|-----------------|------------------|
| `flow` | Workflow |
| `task` | Activity |
| `waiter pasivo` | Signal |
| `waiter activo` | Child Workflow con polling |
| `events.jsonl` | Event history (nativo) |
| `tasks.status` | Workflow state |
| `dispatcher` | Worker pool |

La API de `defineTask` / `defineSprint` se mantiene identica. Solo cambia el motor subyacente. Esto es posible porque nuestra abstraccion (waiters como primitivos) es conceptualmente compatible con Temporal.

---

## Referencias

- **Spec seccion 0**: Cambio de direccion
- **Spec seccion 1**: Principios de diseno
- **Spec seccion 3.1**: Dispatcher
- **Spec seccion 3.3**: Waiters
- **Spec seccion 3.6.5**: Migraciones SQL
- **Spec seccion 4**: Persistencia (SQLite + JSONL)
- **BRD seccion 6**: Arquitectura (propuesta n8n original)
- **Acta pivot**: `meetings/2026-05-16-pivot-scripts-waiters.md`

---

**Firmado**: Equipo SoftwareFactory completo, 2026-05-16  
**Ratificado**: v0.2 del spec tras introducir waiters activos
