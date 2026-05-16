# Resumen: Workflow del Orquestador Autonomo

## Vision en una frase
Una historia de usuario entra; un feature deployado y validado por QA sale, sin intervencion humana continua.

## Etapas del pipeline

```
[INGRESO]   Camila convierte ticket -> Historia con criterios de aceptacion
    |
[DISENO]    Lucas produce wireframe + design tokens + spec de componentes
    |
[GATE 1]    Aprobacion humana opcional sobre alcance + diseno
    |
[ARQUITEC]  Roman emite ADR + division de tareas + estimacion + riesgos
    |
[GATE 2]    Aprobacion humana obligatoria si hay cambio arquitectonico
    |
[BUILD]     Valeria (frontend)  ||  Mateo (backend)    -- en paralelo
    |
[QA]        Sofia ejecuta tests, valida cobertura >= 80%, regresion
    |
[GATE 3]    Bloqueo automatico si cobertura insuficiente o regresion
    |
[DEPLOY]    Dante deploya a staging, valida health checks
    |
[AUDITORIA] Reporte automatico + retrospectiva agregada
    |
[GATE 4]    Aprobacion humana obligatoria para promover a produccion
```

## Reglas de transicion

- Cada etapa publica un **ticket estructurado** (Contexto / Entregable / Criterios / Handoff) en `.claude/memory/tasks/<task-id>.json`.
- La siguiente etapa solo arranca si el ticket valida contra schema.
- Reintentos automaticos con backoff exponencial (max 3) ante fallo transitorio.
- Fallo persistente → dead-letter queue + notificacion al operador.

## Paralelismo

- Valeria y Mateo trabajan en paralelo una vez Roman cierra arquitectura.
- Sofia puede empezar a escribir tests en cuanto exista contrato de API (no espera a que termine implementacion).
- Dante prepara ambiente en paralelo a build cuando hay cambios de infra.

## SLAs

| Etapa | Objetivo | Maximo |
|---|---|---|
| Ingreso | 5 min | 15 min |
| Diseno | 20 min | 1 h |
| Arquitectura | 30 min | 2 h |
| Build (paralelo) | 1 h | 2 h |
| QA | 30 min | 1 h |
| Deploy staging | 10 min | 30 min |
| **Total end-to-end** | **< 3 h** | **< 4 h** |

## Eventos clave que dispara el orquestador

- `pipeline.created`
- `stage.started`
- `stage.completed`
- `gate.pending`
- `gate.approved` / `gate.rejected`
- `pipeline.completed`
- `pipeline.failed`
- `pipeline.budget_exceeded`
