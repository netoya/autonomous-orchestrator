# Reunion: Orquestador autonomo de SoftwareFactory
**Fecha:** 2026-05-16
**Equipo:** softwarefactory
**Ubicacion:** ~/.claude
**Convocada por:** Angel (angel.oliver@kunfupay.com)
**Participantes:** Camila (PM), Roman (Tech Lead), Valeria (Frontend), Mateo (Backend), Sofia (QA), Dante (DevOps), Lucas (UX)

## Contexto

Angel plantea como proyecto unico y prioritario: construir un orquestador que permita que el equipo SoftwareFactory opere de forma autonoma, replicando el flujo de una software factory tradicional (PM → UX → arquitectura → dev → QA → deploy). Se acepta orquestacion externa.

## Discusion

### Camila (Product Manager)
Viable. Redefinir "autonomia": el orquestador no decide QUE construir, automatiza COMO construirlo. Trigger humano siempre (ticket, bug, cambio de prioridad).

**MVP:** Flujo end-to-end de una historia de usuario simple. Input = issue. Output = feature en staging + reporte QA. Asigna por rol, valida gates de salida, genera artefactos trazables (PRD, mockups, ADR, test reports).

**Riesgos:** dependencias bloqueantes sin escalado, criterios ambiguos (garbage in/out), falta de memoria compartida.

**Metricas:** time-to-staging <4h, tasa de rechazo QA <20%, intervencion humana solo en decisiones estrategicas.

### Roman (Tech Lead)
Viable. Arquitectura en 4 capas: motor de workflow, estado centralizado (MongoDB), message bus (Redis/BullMQ o filesystem), scheduler + gates de aprobacion.

**Orquestacion externa:** propone **n8n** (visual, webhooks nativos, condicionales, self-hosted, persiste estado). Alternativa: daemon Node propio.

**Conexion con agentes:** n8n ejecuta `npx @claude/sdk task <agente>` via HTTP/Execute Command. Agentes escriben outputs en `.claude/memory/agents/<agente>/output.json`. n8n hace polling o file trigger.

**Handoff:** eventos + archivos. Cada agente persiste `.claude/memory/tasks/<task-id>.json`. Git commits como checkpoint por fase.

**Riesgos:** latencia acumulada (paralelizar QA/DevOps), race conditions (locks), error cascading (retry + rollback).

### Valeria (Frontend Developer)
Viable si recibe specs UI claras, contratos de API tipados, design tokens actualizados y criterios de aceptacion (a11y + performance).

**Dashboard:** necesario. Propone panel Next.js con estado de cada agente (idle/working/blocked), cola por rol, logs de handoffs, metricas de tiempo. Server Components + streaming.

**Loop automatizable:** componente → Playwright screenshots + axe a11y → si pasa, notifica a Sofia y deploya a staging.

### Mateo (Backend Developer)
Viable. Entidades: `Pipeline`, `Task` (con `idempotencyKey`), `Execution`, `Gate`, `Artifact`.

**API:** REST para comandos, WebSockets/SSE para streaming de logs, webhooks para notificar completions. gRPC si latencia es critica.

**Fallos:** idempotency key (hash input+context), retry exponential backoff, checkpoints por stage, dead letter queue, compensacion (rollback de N-1 si N falla).

**Persistencia:** MongoDB + Redis (locks distribuidos y colas). Mongo por flexibilidad de schema; Postgres si necesitamos ACID estricto.

### Sofia (QA Engineer)
Viable con estructura para que autonomia no sea caos. QA en tres capas:
- Output por agente (assertions del entregable).
- Gates entre fases (validaciones automaticas pre-handoff).
- E2E del flujo completo, con identificacion de fase de fallo + rollback o escalado.

**Gates no negociables:** cambios de arquitectura (Roman), deploy a produccion (Dante), bugs criticos en prod, cobertura <80% en features nuevos, regresion de tests existentes.

**Feedback loops:** cada bug genera test de regresion automatico; patrones recurrentes inyectan checklist pre-commit al agente responsable; retrospectiva semanal automatizada.

**Riesgos:** regresiones silenciosas, hallucinations, drift de specs, deuda tecnica invisible.

**Propuesta:** autonomia 90%, checkpoints humanos obligatorios cada X ciclos o ante flags criticos. Acceso a logs para auditoria continua.

### Dante (DevOps Engineer)
Viable. Daemon local (systemd) + container opcional para staging. Cuando madure → VPS con Docker Compose. Descarta serverless (latencia impredecible + cold starts costosos).

**Orquestacion externa:** propone **Temporal.io** (workflows con estado persistente, retries, visibilidad, flujos largos). Alternativa ligera: systemd timers + Node script + SQLite para MVP. Descarta n8n (no disenado para flujos conversacionales) y Airflow (overkill).

**Observabilidad:** Loki (logs) + Prometheus (metricas) + Grafana (dashboards). Alertas via webhook a Slack/Discord. KPIs: tokens/min, latencia por agente, error rate, cola pendiente.

**Seguridad:** secretos con systemd credentials o sops; circuit breaker con max tokens/min; kill-switch (`systemctl stop` + flag de pausa); backups diarios del estado.

**Costos:** tokens Claude es el gasto principal → limite diario configurable. Infra local: 0. VPS futuro: $10-20/mes.

### Lucas (UX Designer)
Viable como problema de diseno de sistema.

**UX del operador humano:** CLI conversacional para disparar proyectos, dashboard en tiempo real (quien tiene la pelota, que esta bloqueado, que espera input), inputs puntuales solo en ambiguedad/conflicto.

**Lenguaje inter-agentes:** ticket estructurado con `Context`, `Deliverable`, `Acceptance criteria`, `Handoff protocol`. Cada agente firma su parte antes de pasar.

**Panel de la fabrica:** pipeline visual (columnas por rol con cards), blocker radar (alerta cuando algo lleva >N min sin avanzar), commit timeline (stream de entregables en tiempo real).

## Tensiones y decisiones

### Tension 1: n8n (Roman) vs Temporal (Dante)
- **n8n** gana en visualidad, time-to-MVP y costo. Pierde en robustez para flujos conversacionales largos.
- **Temporal** gana en correctitud, retries, durabilidad. Pierde en curva de aprendizaje y peso operativo.
- **Resolucion:** Fase 1 (MVP) con n8n + scripts Node. Fase 2 migrar a Temporal cuando la fabrica supere 5 proyectos concurrentes o 1 deploy diario.

### Tension 2: autonomia total vs checkpoints humanos
- **Sofia y Camila** alinean: autonomia 90%, gates humanos en arquitectura, deploy a prod, hotfix critico, drift de specs.
- **Resolucion:** "Autonomy levels" por tipo de tarea (L0 manual, L3 autonomo con auditoria, L5 totalmente autonomo solo en sandbox).

### Tension 3: stack de persistencia
- Convergencia en **MongoDB + Redis** (Mateo, Roman) para Fase 1.
- SQLite local valido para POC inicial.

## Decisiones

1. Construir el orquestador autonomo como proyecto unico prioritario de SoftwareFactory.
2. Fase 1 (MVP, 4-6 semanas): n8n + Node scripts + filesystem + MongoDB + SQLite local, ejecutando flujo de UNA historia de usuario end-to-end.
3. Fase 2 (consolidacion, 6-10 semanas): migracion a Temporal, dashboard Next.js, panel de fabrica, observabilidad con Loki/Prometheus/Grafana.
4. Modelo de autonomia por niveles (L0-L5), con gates humanos obligatorios en arquitectura, deploy a produccion y hotfixes.
5. Cada agente entrega via ticket estructurado (Context / Deliverable / Acceptance Criteria / Handoff Protocol).
6. Kill-switch, rate limit de tokens y backup diario son requisitos no negociables desde el dia uno.
7. Generar un BRD oficial del proyecto, su traduccion al espanol y materiales de comunicacion multilingues.

## Action Items

| Responsable | Tarea | Fecha limite |
|---|---|---|
| Roman | Disenar arquitectura tecnica detallada del orquestador (ADR-001) | 2026-05-22 |
| Mateo | Definir schema de datos completo (Pipeline/Task/Execution/Gate/Artifact) | 2026-05-22 |
| Dante | Setup POC infra: n8n + MongoDB + observabilidad minima | 2026-05-25 |
| Camila | Escribir la primera historia de usuario "Hello World" del orquestador | 2026-05-20 |
| Lucas | Wireframe del panel de fabrica + spec del ticket inter-agentes | 2026-05-24 |
| Valeria | Implementar dashboard MVP con estado de agentes (Next.js + SSE) | 2026-05-30 |
| Sofia | Definir Definition of Done y gates no negociables del orquestador | 2026-05-22 |
| Angel | Validar el BRD generado y firmar version final | 2026-05-19 |

## Proxima reunion

Review tecnico del POC al 2026-05-25 (Roman, Mateo, Dante). Demo del flujo Hello World al 2026-05-30 con todo el equipo.
