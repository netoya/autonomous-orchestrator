# SoftwareFactory Autonomous Orchestrator

[![Version](https://img.shields.io/badge/version-0.0.1-blue.svg)](CHANGELOG.md)
[![Build](https://img.shields.io/badge/build-passing-green.svg)](#)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Motor de workflow autonomo para equipos de agentes IA. Script-first, local-first, observable.

## Que es

El **Autonomous Orchestrator** es un motor de ejecucion que permite a equipos de agentes IA (como SoftwareFactory) ejecutar pipelines completas de desarrollo de software sin intervencion humana continua. En lugar de disparar cada etapa manualmente, defines un flujo declarativo, lo ejecutas, y el orquestador coordina las dependencias, espera las aprobaciones necesarias y reanuda el trabajo cuando las condiciones se cumplen.

**Analogia clave**: *"Las tareas no tienen telefonos. Terminan y se van. Otras tareas estan atentas y arrancan cuando ven que ya pueden hacerlo."* (principio 1.7 — separacion observador/observado). Comparable a semaforos vs coordinadores de trafico.

## Estado actual

- **Spec**: v0.8.1 (provisional, ~2200 lineas) — [docs/spec.md](docs/spec.md)
- **MVP**: en construccion. Tier 1 cerrado (8/8 gaps), Tier 2-5 abiertos (39 gaps no bloqueantes).
- **Primera entrega**: documentacion exhaustiva (este README + 7 archivos mas).

## Quickstart

```bash
# Clonar o navegar al directorio del proyecto
cd /home/angel/projects/autonomous-orchestrator/

# Instalar dependencias (cuando package.json exista)
npm install

# Setup inicial (validar dependencias del SO, aplicar migraciones)
npm run setup

# Iniciar el orquestador
npm run start

# Ver estado
npx orchestrator status

# Ejecutar un flow de ejemplo
npx orchestrator flow create hello-world --input '{"message":"hola mundo"}'
```

Para instrucciones detalladas de bootstrap y troubleshooting, consulta [RUNBOOK.md](RUNBOOK.md).

## Estructura del repo

| Carpeta / Archivo | Descripcion |
|---|---|
| `docs/` | Documentacion del proyecto (spec, BRD, guias, referencias) |
| `docs/spec.md` | Especificacion tecnica canonica (v0.8.1, ~2200 lineas) |
| `docs/brd/` | Business Requirements Document (bilingue) |
| `docs/guides/` | Tutoriales (escribir flows, waiters, operar el orquestador) |
| `docs/reference/` | Referencias exhaustivas (CLI, API, glosario) |
| `docs/GLOSSARY.md` | Glosario alfabetico de todos los terminos del proyecto |
| `bin/` | Ejecutables del motor (CLI, dispatcher, agent-runner, waiters) |
| `src/` | Codigo fuente TypeScript (core, db, flows, tests) |
| `state/` | Estado runtime (SQLite, JSONL, inbox, outbox) — gitignored |
| `ecosystem.config.js` | Configuracion de PM2 para el dispatcher |
| `package.json` | Dependencias y scripts npm |
| `tsconfig.json` | Configuracion TypeScript |
| `CONTRIBUTING.md` | Guia de contribucion (filosofia, setup, convenciones, PR) |
| `CHANGELOG.md` | Historial de cambios (formato Keep a Changelog) |
| `LICENSE` | Licencia MIT |

## Conceptos clave

### Waiters

Un **waiter** es el primitivo de bloqueo/reanudacion del flujo. Cuando una task necesita entrada humana (ej. aprobar una arquitectura) o esperar una condicion externa (ej. que una DB tenga N filas), declara un waiter. El orquestador pausa el flujo y lo reanuda cuando la condicion se cumple.

Existen dos tipos:

- **Pasivos** (input-driven): esperan entrada humana via CLI, archivo en inbox/ o FIFO.
- **Activos** (poll-driven): el scheduler chequea una condicion periodicamente (query SQL, archivo en disco, endpoint HTTP, etc.).

Mas detalles: [spec.md seccion 3.3](docs/spec.md#33-waiter) | [guia de waiters](docs/guides/writing-a-waiter.md) | [glosario](docs/GLOSSARY.md#waiter)

### Backlog vivo (Living backlog)

Cuando un waiter activo tiene horizonte `long` (dias, semanas, meses), el flujo asociado entra en estado `hibernated`. El contexto se serializa, el flow se retira de memoria activa, y el waiter sigue haciendo polls adaptativos hasta que la condicion se cumple. Eso permite pipelines que esperan meses a que se cumpla una pre-condicion externa (ej. "cuando el usuario compre licencia enterprise").

Mas detalles: [spec.md seccion 7](docs/spec.md#7-backlog-vivo) | [glosario](docs/GLOSSARY.md#backlog-vivo)

### Flow-coordinator

Es el **unico** agente con permiso explicito para crear sub-tasks dinamicamente. Es la excepcion controlada al principio observador/observado (seccion 1.7 del spec). El coordinator recibe un plan de alto nivel, lo descompone en tasks, declara dependencias, y delega la ejecucion al dispatcher. Cada emision de sub-task queda registrada en `events` para trazabilidad.

Mas detalles: [spec.md seccion 3.6.2](docs/spec.md#362-api-del-flow-coordinator) | [glosario](docs/GLOSSARY.md#coordinator)

### Principio observador/observado (1.7)

**La regla de oro**: una task NO controla el futuro del flujo. Solo emite estado final (`done`, `failed`, `waiting`). Los waiters observan esas transiciones y deciden si corresponde reactivar, desbloquear o encadenar nuevo trabajo.

**Beneficio**: elimina acoplamiento temporal entre etapas, evita race conditions, facilita hibernacion y reanudacion asincronica.

**Campos prohibidos** en la API de `defineTask`: `onSuccess`, `onFailure`, `nextTask`, `callbackTo`, `then` (rechazados con error de schema).

Mas detalles: [spec.md seccion 1.7](docs/spec.md#17-separacion-entre-observador-y-objeto-observado) | [glosario](docs/GLOSSARY.md#observer--observed)

## Roadmap de fases

| Fase | Duracion | Resultado | Estado |
|---|---|---|---|
| **Fase 0 — BRD y POC** | 1-2 semanas | BRD firmado, spec v0.8.1, documentacion exhaustiva | **En curso** |
| **Fase 1 — MVP** | 4-6 semanas | Historia "Hello World" fluye end-to-end con waiters, agentes, gates | Pendiente |
| **Fase 2 — Consolidacion** | 6-10 semanas | Dashboard, observabilidad, migracion a Temporal.io (opcional) | Pendiente |
| **Fase 3 — Escala** | 12+ semanas | Pipelines paralelas, multi-proyecto, loops de aprendizaje | Pendiente |

Mas detalles: [BRD seccion 10](docs/brd/BRD-es.md#10-roadmap)

## Equipo SoftwareFactory

El orquestador esta disenado y construido por un equipo de 7 agentes IA especializados:

| Agente | Rol | Responsabilidad en este proyecto |
|---|---|---|
| **Camila** | Product Manager | Define roadmap, escribe requerimientos, gestiona stakeholders, valida features contra criterios de aceptacion |
| **Roman** | Tech Lead | Decisiones arquitectonicas, validacion de viabilidad tecnica, cohesion cross-section, sign-off de cambios al motor |
| **Lucas** | UX Designer | Diseno de experiencia del operador, contratos inter-agentes, flujos de interaccion con waiters pasivos |
| **Valeria** | Frontend Developer | Dashboard (Fase 2), CLI interactiva, UI de aprobacion de waiters |
| **Mateo** | Backend Developer | Modelo de datos, API del orquestador, persistencia SQLite, migraciones, contrato Bash de waiters |
| **Sofia** | QA Engineer | Gates de calidad, estrategia de regresion, test harness, validacion de criterios de aceptacion, auditoria |
| **Dante** | DevOps Engineer | PM2, observabilidad, controles de seguridad, kill-switch, backups, runtime 24/7 |

Mas detalles: [BRD seccion 4](docs/brd/BRD-es.md#4-stakeholders)

## Como contribuir

Lee [CONTRIBUTING.md](CONTRIBUTING.md) antes de abrir un PR. Principios no negociables:

1. El principio 1.7 (separacion observador/observado) NO ES NEGOCIABLE.
2. Tests obligatorios para todo cambio al motor.
3. Sign-off de Roman para cambios que afecten arquitectura.
4. Sign-off de Sofia para cambios que afecten gates de calidad.
5. Sin emojis salvo solicitud explicita del usuario.

## Licencia

MIT. Ver [LICENSE](LICENSE).

## Recursos

- [Spec tecnica completa (v0.8.1)](docs/spec.md)
- [BRD (espanol)](docs/brd/BRD-es.md)
- [Glosario](docs/GLOSSARY.md)
- [Guia: escribir un flow](docs/guides/writing-a-flow.md)
- [Guia: escribir un waiter](docs/guides/writing-a-waiter.md)
- [Guia: operar el orquestador](docs/guides/operating-the-orchestrator.md)
- [Referencia CLI completa](docs/reference/cli.md)
- [Changelog](CHANGELOG.md)
