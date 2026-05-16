# Documento de Requerimientos de Negocio (BRD)
## Orquestador Autonomo de SoftwareFactory

| | |
|---|---|
| ID del documento | BRD-SFAO-001 |
| Version | 1.0 |
| Fecha | 2026-05-16 |
| Estado | Borrador para aprobacion |
| Responsable | Angel Oliver (angel.oliver@kunfupay.com) |
| Product Manager | Camila |
| Tech Lead | Roman |
| Directorio de trabajo | `~/.claude` |
| Equipo | softwarefactory (7 agentes IA) |

---

## 1. Resumen ejecutivo

SoftwareFactory es un equipo de siete agentes IA especializados (Product Management, UX, Tech Lead, Frontend, Backend, QA, DevOps) que opera dentro del entorno Claude Code. Hoy colaboran a traves de interacciones puntuales disparadas por humano, en una conversacion a la vez.

Este proyecto entrega un **Orquestador Autonomo**: un motor de workflow mas una capa de orquestacion externa que permite a SoftwareFactory ejecutar el ciclo completo de una software factory (intake → diseno → arquitectura → desarrollo → QA → deploy) sin intervencion humana continua. El humano deja de ser operador y pasa a ser product owner y auditor de calidad.

El orquestador es el **unico proyecto prioritario** del equipo. Todas las demas iniciativas quedan pausadas o subordinadas.

---

## 2. Contexto de negocio

### 2.1 Problema

El modelo actual produce alta calidad pero no escala:

- Cada handoff entre agentes requiere prompt humano.
- Contexto, entregables y decisiones viven en historial de conversacion, no en estado durable.
- El throughput esta limitado a una tarea a la vez.
- Los gates de calidad son informales, no se pueden hacer cumplir.
- El equipo no opera cuando el operador esta offline.

### 2.2 Intencion estrategica

Transformar SoftwareFactory de un *equipo multiagente interactivo* a una *fabrica digital autosostenible* a la que se le pueda asignar una historia de usuario o un epic y devuelva un resultado deployado y validado por QA, con el humano como aprobador solo en puntos criticos.

### 2.3 Valor de negocio

- **10x throughput**: pipelines paralelos, sin cuello de botella humano para trabajo rutinario.
- **Operacion 24/7**: la fabrica produce mientras el operador esta offline.
- **Trazabilidad auditable**: cada artefacto y decision persistido, firmado y rastreable.
- **Transparencia de costos**: uso de tokens medido por pipeline, por agente, por etapa.
- **Reproducibilidad**: mismo input produce output y proceso comparables.

---

## 3. Alcance

### 3.1 Dentro de alcance

- Un motor de workflow que modela la pipeline de SoftwareFactory como un grafo dirigido de etapas de agentes.
- Una capa de orquestacion externa (Fase 1: n8n + scripts Node; Fase 2: Temporal.io).
- Estado persistente (Pipeline, Task, Execution, Gate, Artifact).
- Contrato tipado inter-agentes (ticket estructurado: Contexto / Entregable / Criterios de aceptacion / Protocolo de handoff).
- Un "panel de la fabrica" para observacion humana.
- Controles de seguridad no negociables: kill-switch, rate limit de tokens, backups diarios, gates humanos obligatorios en arquitectura, deploy a produccion y hotfixes criticos.
- Modelo de autonomia por niveles (L0 manual a L5 sandbox autonomo).

### 3.2 Fuera de alcance (Fase 1)

- Decidir *que* construir. El orquestador automatiza la ejecucion, no la estrategia de producto.
- Coordinacion entre equipos con otros prefijos.
- Operacion multi-tenant para clientes externos.
- Automodificacion del orquestador por parte de los agentes.

### 3.3 Supuestos

- El SDK / CLI de Claude Code sigue siendo el punto de entrada principal para invocar agentes.
- Deploy local es aceptable en Fase 1; migracion a la nube es decision de Fase 2.
- El operador (Angel) revisa gates de aprobacion dentro de 24 horas.

### 3.4 Restricciones

- El costo de tokens es la variable de costo dominante; tope diario es obligatorio.
- El orquestador debe correr en una maquina de desarrollador en Fase 1 (sin infra enterprise).
- Todo estado persistido debe quedar en infraestructura controlada por el operador.

---

## 4. Stakeholders

| Rol | Nombre | Responsabilidad |
|---|---|---|
| Sponsor / Operador | Angel | Aprobador final, define prioridad |
| Product Manager | Camila | Define requerimientos, metricas de exito |
| Tech Lead | Roman | Decisiones arquitectonicas, riesgo tecnico |
| Frontend | Valeria | Dashboard, UI del operador |
| Backend | Mateo | Modelo de datos, API del orquestador, persistencia |
| QA | Sofia | Gates de calidad, estrategia de regresion, auditoria |
| DevOps | Dante | Runtime, observabilidad, controles de seguridad |
| UX | Lucas | UX del operador, contrato inter-agentes |

---

## 5. Requerimientos

### 5.1 Requerimientos funcionales

| ID | Requerimiento | Prioridad |
|---|---|---|
| FR-01 | El orquestador debe aceptar una historia de usuario o ticket como input y producir un artefacto deployado en staging como output. | Must |
| FR-02 | El orquestador debe rutear tareas al agente apropiado segun rol y etapa. | Must |
| FR-03 | Cada etapa debe validar criterios de aceptacion explicitos antes de hacer handoff. | Must |
| FR-04 | El orquestador debe persistir cada artefacto (PRD, mockups, ADRs, diffs, reportes de tests) con hash y metadata. | Must |
| FR-05 | El orquestador debe exponer una API REST para comandos (crear task, aprobar gate, retry, abort). | Must |
| FR-06 | El orquestador debe transmitir logs en tiempo real via WebSocket/SSE. | Must |
| FR-07 | El orquestador debe soportar retries con backoff exponencial y dead-letter queue. | Must |
| FR-08 | El orquestador debe hacer cumplir gates humanos obligatorios en cambios arquitectonicos, deploy a produccion y hotfixes criticos. | Must |
| FR-09 | El orquestador debe proveer un kill-switch que detiene todas las pipelines activas en menos de 60 segundos. | Must |
| FR-10 | El orquestador debe hacer cumplir un presupuesto diario de tokens configurable por pipeline. | Must |
| FR-11 | El panel de la fabrica debe mostrar estado de cada agente (idle/working/blocked), cola por rol, logs de handoff y metricas de tiempo. | Must |
| FR-12 | Cada pipeline completado debe generar un reporte de auditoria rastreable. | Must |
| FR-13 | El orquestador debe soportar pipelines paralelas (multiples historias en curso). | Should |
| FR-14 | El orquestador debe producir una retrospectiva semanal automatizada con metricas por agente. | Should |
| FR-15 | El orquestador debe exponer webhooks para integraciones externas (Slack, GitHub, Jira). | Could |

### 5.2 Requerimientos no funcionales

| ID | Requerimiento | Objetivo |
|---|---|---|
| NFR-01 | Time-to-staging para una historia de usuario simple | < 4 horas |
| NFR-02 | Tasa de rechazo de QA al output de agentes | < 20% |
| NFR-03 | Durabilidad del estado de la pipeline | 100% (sin perdida ante crash) |
| NFR-04 | Disponibilidad del orquestador en ejecucion local | 99% en horario operativo |
| NFR-05 | Tiempo de recuperacion ante falla de una etapa | < 5 minutos (auto-retry) |
| NFR-06 | Costo de infraestructura en Fase 1 | $0 local, < USD 20/mes en VPS |
| NFR-07 | Latencia media de aprobacion humana en gates | < 24 horas |
| NFR-08 | Validacion de schema en todos los mensajes inter-agentes | 100% |

---

## 6. Vision de la solucion

### 6.1 Arquitectura (Fase 1 — MVP)

Cuatro capas:

1. **Motor de workflow**: define la pipeline (Camila → Lucas → Roman → Valeria || Mateo → Sofia → Dante).
2. **Estado**: MongoDB para pipelines, tasks, executions, gates y artefactos. Redis para locks distribuidos y colas.
3. **Message bus**: eventos disparados al escribir archivos en `.claude/memory/tasks/<task-id>.json`; n8n dispara la siguiente etapa.
4. **Orquestacion externa**: n8n self-hosted, hablando con Claude Code via `npx @claude/sdk task <agente>`.

### 6.2 Arquitectura (Fase 2 — Consolidacion)

- Migrar el motor de workflow a **Temporal.io** para workflows multiagente durables y de larga duracion.
- Dashboard en Next.js con Server Components + SSE.
- Stack de observabilidad: Loki, Prometheus, Grafana.
- Migracion opcional a VPS con Docker Compose.

### 6.3 Modelo de datos (alto nivel)

- `Pipeline { _id, name, version, stages[] }`
- `Task { _id, pipelineId, status, assignedAgent, input, output, parentTaskId, retries, idempotencyKey }`
- `Execution { _id, taskId, agentId, startedAt, finishedAt, status, logs[], artifacts[] }`
- `Gate { _id, taskId, type, approver, decision, timestamp }`
- `Artifact { _id, executionId, type, path, hash, metadata }`

### 6.4 Modelo de autonomia

| Nivel | Descripcion | Ejemplo |
|---|---|---|
| L0 | Manual | El humano escribe el PRD |
| L1 | Asistido | El agente propone, el humano aprueba cada paso |
| L2 | Supervisado | El agente ejecuta, el humano revisa cada handoff |
| L3 | Autonomo con auditoria | El agente ejecuta, el humano audita asincrono |
| L4 | Totalmente autonomo con gates | El agente ejecuta; el humano aprueba solo gates criticos |
| L5 | Sandbox autonomo | Totalmente autonomo en entorno aislado |

Default Fase 1: **L3**. Los gates humanos obligatorios aplican independientemente del nivel.

---

## 7. Workflow

```
Intake (Camila)
   → Diseno (Lucas)
      → Arquitectura (Roman) [gate: aprobacion humana]
         → Frontend (Valeria) || Backend (Mateo)   [paralelo]
            → QA (Sofia)  [gate: cobertura minima 80%]
               → Deploy a staging (Dante)
                  → Auditoria + retrospectiva (auto)
                     → Gate opcional: deploy a produccion (humano)
```

---

## 8. Riesgos

| Riesgo | Probabilidad | Impacto | Mitigacion |
|---|---|---|---|
| Latencia se acumula entre etapas | Alta | Media | Paralelizar QA y DevOps; precomputar artefactos |
| Race conditions entre agentes | Media | Alto | Locks en Redis; idempotency keys |
| Fallas en cascada | Media | Alto | Retry con backoff; rollback a N-1; dead-letter queue |
| Regresiones silenciosas en modo autonomo | Media | Alto | Tests de regresion obligatorios por cada bug; auditoria semanal |
| Codigo halucinado que pasa tests | Media | Alto | QA multi-capa; analisis estatico; agente revisor secundario |
| Disparo de costos por tokens | Media | Alto | Tope diario de presupuesto; circuit breaker en tokens/minuto |
| Drift de specs | Media | Media | Checkpoints humanos periodicos; diffing de hash de specs |
| El operador se vuelve cuello de botella | Baja | Media | Cola asincronica de aprobaciones; SLA de 24h en gates |

---

## 9. Metricas de exito

- **Time-to-staging** de una historia "Hello World": < 4 horas.
- **Tasa de rechazo de QA**: < 20% en primera pasada.
- **Tasa de intervencion humana**: < 1 por pipeline (sin contar gates obligatorios).
- **Costo por feature entregado**: medido y con tendencia a la baja mes a mes.
- **Reproducibilidad de pipeline**: mismo input → output equivalente en >= 90% de casos.

---

## 10. Roadmap

| Fase | Duracion | Resultado |
|---|---|---|
| Fase 0 — BRD y POC | 1-2 semanas | Este BRD firmado; POC de n8n + MongoDB corriendo |
| Fase 1 — MVP | 4-6 semanas | Historia Hello World fluye end-to-end |
| Fase 2 — Consolidacion | 6-10 semanas | Migracion a Temporal, dashboard, observabilidad |
| Fase 3 — Escala | 12+ semanas | Pipelines paralelas, multi-proyecto, loops de aprendizaje |

---

## 11. Preguntas abiertas

1. ¿El orquestador hostea su propio gateway LLM o llama directo a Anthropic?
2. ¿Como versionamos el contrato inter-agentes sin romper pipelines en curso?
3. ¿Que politica aplicamos cuando un agente esta en desacuerdo con el entregable de otro?
4. ¿Adoptamos un agente "supervisor" que observa el meta-nivel de la pipeline, o ese rol queda humano?

---

## 12. Aprobacion

| Rol | Nombre | Firma | Fecha |
|---|---|---|---|
| Sponsor | Angel Oliver | _________ | _________ |
| PM | Camila | _________ | _________ |
| Tech Lead | Roman | _________ | _________ |
