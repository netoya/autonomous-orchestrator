---
fecha: 2026-05-16
equipo: softwarefactory
proyecto: cobragest-nextjs
tipo: sprint-planning
---

# Reunion: Prioridades del Sprint
**Fecha:** 2026-05-16
**Asistentes:** Camila (softwarefactory_camila, PM) · Roman (softwarefactory_roman, Tech Lead)
**Duracion estimada:** 45 min
**Moderadora:** Camila

---

## Agenda

1. Revisar estado del modulo PTPs
2. Definir prioridades para el proximo sprint
3. Identificar blockers tecnicos
4. Confirmar definition of done por item

---

## Contexto del Proyecto

CobraGest Next.js — sistema de gestion de cobranza para Casa Credito.
Stack: Next.js / Node.js / MongoDB. FoxPro como fuente de verdad contable.

> NOTA: Las prioridades listadas a continuacion son propuestas de ejemplo inferidas
> del estado actual del codigo y la memoria de Roman. Deben ser validadas con Angel
> (PO) antes de comprometerse en el sprint.

---

## Discusion

### Camila (PM)

"Basandome en el estado del modulo de cobranza y los pendientes que tiene Roman
documentados, propongo centrar el sprint en cerrar el ciclo de vida de PTPs y
blindar la evaluacion automatica. El early adopter necesita ver que las promesas
de pago se reflejan correctamente sin intervencion manual."

### Roman (Tech Lead)

"Coincido con Camila en PTPs como P0. El use case EvaluarPTPsUseCase ya existe y
funciona, pero no tiene un cron que lo dispare. Ese es el gap mas critico. Segundo
punto: la capa de presentacion en ptps/presentation/api esta vacia — los endpoints
de consulta filtrada no existen todavia. Tercero, el motivo en cancelacion manual
esta pendiente desde el 28-abr."

---

## Decisiones

1. **PTPs cron de evaluacion** es P0 del sprint. Roman lidera implementacion.
2. **Endpoints de presentacion ptps** (GET filtrado por agente/estado/fecha) es P1.
   Mateo implementa siguiendo el contrato del PTPRepository existente.
3. **Motivo obligatorio en cancelacion manual** (PUT /api/cobranza/ptps/[id]).
   Pequeno scope, puede ir en el mismo PR que los endpoints.
4. **Cron de snapshot de cartera** (fin de mes) se incluye si queda capacidad;
   de lo contrario pasa al sprint siguiente. Roman confirmo que el stack existe
   pero el job nunca corrio.

---

## Action Items

| # | Responsable | Tarea | Estimacion | Fecha limite |
|---|---|---|---|---|
| 1 | Roman | Implementar cron EvaluarPTPsUseCase (node-cron o Vercel cron) | M | 2026-05-21 |
| 2 | Mateo | GET /api/cobranza/ptps con filtros agenteId, estado, fechaDesde/Hasta | S | 2026-05-20 |
| 3 | Mateo | Agregar campo `motivo` obligatorio a PUT cancelacion PTP | S | 2026-05-20 |
| 4 | Sofia | Plan de tests para EvaluarPTPsUseCase (happy path + dryRun + timezone Paraguay) | S | 2026-05-21 |
| 5 | Roman | Confirmar con Angel si cron snapshot cartera entra en este sprint | — | 2026-05-17 |

---

## Proxima Reunion

**Fecha propuesta:** 2026-05-19 (lunes) — daily de mitad de sprint
**Asistentes:** Roman, Mateo, Sofia
**Objetivo:** verificar avance action items 1-4

---

*Acta generada por softwarefactory_camila + softwarefactory_roman via /meet*
*Persistida en: ~/.claude/teams/softwarefactory/projects/data/meetings/2026-05-16-prioridades-sprint.md*
