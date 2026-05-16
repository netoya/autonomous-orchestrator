# Changelog

Todos los cambios notables a este proyecto seran documentados en este archivo.

El formato esta basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.0.0/),
y este proyecto adhiere a [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Por venir

- Implementacion del dispatcher (tick A/B/C/D/E)
- Implementacion del agent-runner con ClaudeCodeRunner
- Libreria de waiters activos base (task-dependency, db-record-ready, file-exists, http-health)
- CLI completa con subcomandos de orchestrator
- Migraciones SQL (000_init hasta 005_backlog)
- Flow de ejemplo hello-world.flow.ts
- Test harness con mockClaude
- Dashboard basico (Fase 2)

## [0.0.1] - 2026-05-16

### Agregado

- **Documentacion exhaustiva del proyecto** (primera entrega completa):
  - `README.md` — overview del proyecto, quickstart, estructura, conceptos clave, roadmap, equipo
  - `CONTRIBUTING.md` — filosofia, setup local, reglas de PR, convenciones, Definition of Done
  - `CHANGELOG.md` — este archivo
  - `docs/GLOSSARY.md` — glosario alfabetico de terminos del proyecto
  - `docs/guides/writing-a-flow.md` — tutorial completo para escribir flows
  - `docs/guides/writing-a-waiter.md` — tutorial completo para escribir waiters custom
  - `docs/guides/operating-the-orchestrator.md` — guia operativa para el rol de operador
  - `docs/reference/cli.md` — referencia exhaustiva de todos los subcomandos del CLI

- **Spec tecnica v0.8.1** (~2200 lineas):
  - Tier 1 cerrado (8/8 gaps): ADR-001, TaskContext, flow-coordinator, DSL, protocolo SQL waiter-antes-de-task, migraciones, PRAGMAs, PM2
  - Auditoria cruzada (cada owner reviso lo de otro) + pasada de cohesion cross-section por Roman
  - Resuelve 17 criticos + 4 contradicciones latentes

- **BRD v1.0** (bilingue: espanol e ingles):
  - Alcance, stakeholders, requerimientos funcionales/no funcionales
  - Vision de solucion (arquitectura Fase 1 y Fase 2)
  - Modelo de autonomia (L0-L5)
  - Workflow canonical de SoftwareFactory
  - Roadmap de 4 fases
  - Metricas de exito

### Decisiones de diseno

- **Script-first**: reemplazo de n8n por motor puro (Node + Bash + SQLite + PM2)
- **Waiters como primitivos**: toda entrada humana o condicion externa se modela como waiter (pasivo o activo)
- **Principio observador/observado (1.7)**: las tasks no controlan el futuro del flujo; solo emiten estado
- **Local-first**: cero infra remota en MVP; todo corre en la maquina del operador
- **Filesystem como API**: SQLite + JSONL como fuente de verdad

### Notas

- Codigo fuente del motor aun no implementado (fase 0 = solo documentacion)
- 39 gaps Tier 2-5 abiertos pero no bloqueantes para MVP
- Primera decision de equipo: **documentacion exhaustiva** como entrega inicial

---

## Versiones del spec

Historial de evoluciones de la spec tecnica (referencia):

- **v0.8.1** (2026-05-16): segunda pasada sobre los provisionales del Tier 1. Auditoria cruzada + cohesion cross-section por Roman. 17 criticos resueltos + 4 contradicciones.
- **v0.8** (2026-05-16): cierra los 7 Tier 1 restantes con definiciones provisionales. Nueva seccion 3.6 Provisional Foundations. Tier 1 cerrado 8/8.
- **v0.7** (2026-05-16): cierra ADR-001. Define interfaz AgentRunner con implementacion default ClaudeCodeRunner. Mapeo niveles autonomia → permission modes.
- **v0.6.1** (2026-05-16): agrega Anexo M con goal-seeker.sh (EXPERIMENTAL).
- **v0.6** (2026-05-16): todos los waiters activos son scripts Bash. Elimina libreria TypeScript de waiters. Contrato unico: env vars + exit codes + stdout JSON.
- **v0.5** (2026-05-16): formaliza principio de separacion observador/observado (seccion 1.7). Prohibicion de campos imperativos.
- **v0.4** (2026-05-16): introduce coordinacion reactiva de trabajo. Waiters intra-sprint, work stealing con WSJF, detector de ciclos.
- **v0.3** (2026-05-16): introduce backlog vivo. Dimension horizon (short/long), estado hibernated, polling adaptativo.
- **v0.2** (2026-05-16): introduce waiters activos (poll-driven) ademas de pasivos. Schema extendido, scheduler interno, lease pattern.
- **v0.1** (2026-05-16): spec inicial script-first (sin n8n). Solo waiters pasivos.

---

## [0.0.0] - 2026-05-15

### Agregado

- Creacion del repositorio
- Estructura de directorios inicial (`docs/`, `bin/`, `src/`, `state/`)
- BRD v1.0 draft (espanol e ingles)

---

[Unreleased]: https://github.com/tu-org/autonomous-orchestrator/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/tu-org/autonomous-orchestrator/releases/tag/v0.0.1
[0.0.0]: https://github.com/tu-org/autonomous-orchestrator/releases/tag/v0.0.0
