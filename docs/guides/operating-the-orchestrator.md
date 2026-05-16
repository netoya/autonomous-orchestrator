# Guia: Operar el Orquestador

Guia operativa para el rol de **Operador** del Autonomous Orchestrator. El operador no es una persona especifica, es un rol que puede rotar. Esta guia documenta las operaciones criticas del dia a dia.

## El rol del operador

El operador NO es el que escribe codigo ni define producto. El operador:

- **Dispara flows** cuando hay trabajo nuevo.
- **Aprueba/rechaza waiters pasivos** en gates criticos (arquitectura, deploy a produccion, hotfixes).
- **Monitorea el backlog vivo** y decide que flows hibernados extender/cancelar/despertar.
- **Revisa costos** y ajusta budget si es necesario.
- **Gestiona incidentes** (kill-switch, recovery ante crash, rollback).
- **Audita eventos** en `events.jsonl` para trazabilidad.

El operador NO necesita saber TypeScript ni Bash. Todas las operaciones se hacen via CLI.

## Como disparar un flow completo

### Comando basico

```bash
npx orchestrator run sprint --full <sprint-name>
```

Ejemplo:

```bash
npx orchestrator run sprint --full hello-world
```

Esto:

1. Carga el sprint `hello-world` desde `src/flows/hello-world.flow.ts`.
2. Valida el grafo de dependencias (DAG).
3. Crea todas las tasks en estado `queued` o `ready` (segun dependencias).
4. El dispatcher empieza a procesarlas en orden topologico.

### Ver estado del flow

```bash
npx orchestrator flow show <flow-id>
```

Output:

```
Flow: hello-world (abc123)
Status: running
Progress: 4/7 tasks done
Elapsed: 23 min

Tasks:
  [done] escribir-req (10 min)
  [done] disenar-ux (15 min)
  [waiting-waiter] revisar-arquitectura (waiter: xyz789)
  [queued] implementar-backend (waiting for: revisar-arquitectura)
  [queued] escribir-tests (waiting for: implementar-backend)
  [queued] validar-cobertura (waiting for: escribir-tests)
  [queued] deploy-staging (waiting for: validar-cobertura)

Waiters pending: 1
  - xyz789 (approve-architecture) — expires in 22h
```

### Ejecutar hasta un milestone

Si quieres ejecutar solo hasta un checkpoint especifico (ej. para validar manualmente antes de seguir):

```bash
npx orchestrator run sprint <sprint-id> --until-milestone <milestone-name>
```

Ejemplo:

```bash
npx orchestrator run sprint spr_abc123 --until-milestone validar-cobertura
```

El orquestador ejecuta todas las tasks hasta la marcada con `isMilestone: true` y `tags: ['validar-cobertura']`, luego pausa.

## Como aprobar/rechazar waiters pasivos

### Ver waiters pendientes

```bash
npx orchestrator waiter list --pending
```

Output:

```
ID          Kind                    Flow            Prompt                                    Expires in
xyz789      approve-architecture    hello-world     Aprobar arquitectura Express.js?          22h
abc456      approve-prod-deploy     feature-123     Aprobar deploy a produccion de feature X? 18h
```

### Ver detalle de un waiter

```bash
npx orchestrator waiter show xyz789
```

Output:

```
Waiter: xyz789
Kind: approve-architecture
Flow: hello-world (flow_abc123)
Task: revisar-arquitectura (task_def456)
Status: waiting
Created: 2026-05-16 10:30:00 UTC
Expires: 2026-05-17 10:30:00 UTC (22h remaining)

Prompt:
  Aprobar cambios arquitectonicos propuestos por Roman?

Schema:
  {
    "approved": boolean (required),
    "comments": string (optional)
  }

Authz:
  Requiere operador: yes
  Roles permitidos: [operator, tech-lead]

Context:
  - Artifact: architecture-proposal.md (hash: sha256:abc...)
  - Link: state/outbox/artifact_xyz.md
```

### Aprobar un waiter

```bash
npx orchestrator waiter fulfill xyz789 --json '{"approved":true,"comments":"LGTM"}'
```

El orquestador:

1. Valida el JSON contra el schema.
2. Valida que el respondedor cumple `authz` (si esta configurado).
3. Ejecuta el callback `onValid`.
4. Si retorna `{ type: 'resume' }`, marca el waiter como `fulfilled` y reanuda la task.
5. Emite evento `waiter.fulfilled` en `events.jsonl`.

### Rechazar un waiter

```bash
npx orchestrator waiter reject xyz789 --reason "La arquitectura tiene riesgo de performance"
```

El orquestador:

1. Marca el waiter como `rejected`.
2. Ejecuta el callback `onValid` con decision de rechazo.
3. La task asociada transiciona a `failed` o escala segun logica del flow.
4. Emite evento `waiter.rejected` en `events.jsonl`.

### Entrada alternativa via archivo (inbox)

Si prefieres no usar CLI (ej. script automatizado, integracion externa):

```bash
echo '{"approved":true,"comments":"LGTM"}' > state/inbox/xyz789.input
```

El dispatcher detecta el archivo cada 500 ms (tick C), lo valida, lo procesa, y lo mueve a `state/inbox/.processed/xyz789.input`.

## Como revisar el backlog vivo

El backlog vivo son flows hibernados (waiters de horizonte `long` que aun no se cumplieron).

### Listar entradas del backlog

```bash
npx orchestrator backlog list
```

Output:

```
ID          Category        Status      Flow               Waiter Kind         Created       Last check    Next check
blg_001     feature-wait    latent      new-client-onb     db-record-ready     2026-04-01    2026-05-15    2026-05-22
blg_002     integrations    latent      stripe-webhook     http-health         2026-03-10    2026-05-16    2026-05-17
blg_003     compliance      activated   gdpr-export        file-exists         2026-02-20    2026-05-16    2026-05-16
```

### Ver detalle de una entrada

```bash
npx orchestrator backlog show blg_001
```

Output:

```
Backlog Entry: blg_001
Category: feature-wait
Status: latent
Flow: new-client-onboarding (flow_xyz)
Waiter: wait_abc123 (db-record-ready)

Rationale:
  Esperar a que cliente compre plan enterprise antes de habilitar feature X.

Condition:
  Query: SELECT COUNT(*) FROM subscriptions WHERE tier='enterprise' AND client_id=:client_id
  Min count: 1

History:
  Created: 2026-04-01 10:00 UTC
  Checks: 1234
  Last check: 2026-05-15 08:00 UTC (not met)
  Next check: 2026-05-22 08:00 UTC (adaptive poll: 7 days)
  Consecutive errors: 0

Context snapshot:
  Hash: sha256:def...
  Link: state/outbox/context_blg_001.json
  Size: 3.2 KB
```

### Extender vida de una entrada

Si una entrada esta proxima a expirar pero aun la necesitas:

```bash
npx orchestrator backlog extend blg_001 --days 90
```

Esto incrementa `max_lifetime_days` en 90 dias. Emite evento `backlog.extended` en JSONL.

### Cancelar una entrada

Si ya no es relevante (ej. el cliente cancelo el contrato):

```bash
npx orchestrator backlog cancel blg_001 --reason "Cliente cancelo contrato"
```

El flow asociado transiciona a `cancelled`. Emite evento `backlog.cancelled`.

### Forzar despertar (skip de condicion)

Si necesitas despertar un flow hibernado SIN esperar a que la condicion se cumpla (ej. para debugging o test manual):

```bash
npx orchestrator backlog wake blg_001
```

**Advertencia**: esto bypasea la validacion de la condicion. Usa solo cuando sepas que el flow puede continuar sin que se cumpla.

### Revision trimestral asistida

Cada 3 meses, el operador debe revisar el backlog completo y decidir que entradas extender/cancelar. Herramienta interactiva:

```bash
npx orchestrator backlog review
```

El CLI te muestra cada entrada, te pregunta: `[E]xtender / [C]ancelar / [S]altar / [Q]uit?`, y registra tus decisiones.

## Como pausar todo (kill-switch)

Si necesitas detener todas las pipelines activas (ej. incidente critico, deploy urgente, mantenimiento):

```bash
npx orchestrator stop
```

Esto:

1. Crea `state/.KILLSWITCH`.
2. El dispatcher detecta el archivo en el proximo tick (< 500 ms).
3. Drena waiters activos en curso (espera a que terminen checks, max 30 s).
4. Cierra limpio la DB (flush pendientes a WAL).
5. Emite evento `killswitch.tripped` en JSONL.
6. Para el proceso PM2.

**Tiempo de stop**: < 60 s (garantizado por spec).

### Restart tras kill-switch

```bash
# Opcional: revisar logs antes de reiniciar
tail -f state/logs/dispatcher.out.log

# Remover kill-switch
rm state/.KILLSWITCH

# Reiniciar
npx orchestrator start
```

El dispatcher recupera waiters huerfanos (ver spec 3.6.4) y reanuda flows pausados.

## Como ver costos

### Ver resumen de costos

```bash
npx orchestrator budget show
```

Output:

```
Budget Status
=============

Daily limit: 50,000 tokens
Used today:  12,345 tokens (24.7%)
Remaining:   37,655 tokens

Last 7 days:
  2026-05-16: 12,345 / 50,000 (24.7%)
  2026-05-15: 45,678 / 50,000 (91.4%) — near limit
  2026-05-14: 23,456 / 50,000 (46.9%)
  ...

Top consumers (today):
  flow_abc123 (hello-world):       5,678 tokens (46%)
  flow_def456 (feature-onboarding): 4,321 tokens (35%)
  flow_ghi789 (backlog-check):      2,346 tokens (19%)

Agents (today):
  softwarefactory_mateo:  4,567 tokens
  softwarefactory_sofia:  3,456 tokens
  softwarefactory_camila: 2,345 tokens
  ...
```

### Ajustar budget diario

```bash
npx orchestrator budget set --daily 100000
```

Esto actualiza el limite diario de tokens. Emite evento `budget.updated` en JSONL.

**IMPORTANTE**: el orquestador rechaza nuevas invocaciones de agentes si el budget diario se excedio. Tasks quedan en `queued` hasta el dia siguiente (reset a las 00:00 UTC).

### Alertas de budget

Si el uso supera 80% del limite diario, el orquestador emite evento `budget.warning` en JSONL. Puedes configurar un watcher que envie notificacion (Slack, email, etc.).

## Que NO hacer

### 1. NO edites SQLite directamente

La DB tiene integridad referencial, triggers, leases. Si editas a mano (ej. `UPDATE tasks SET status='done'`), puedes:

- Romper invariantes (ej. waiter fulfilled pero task aun waiting).
- Corromper leases (multiples dispatchers procesan la misma task).
- Perder trazabilidad (el evento no llega a JSONL).

**Como hacerlo bien**: usa el CLI. Si necesitas operacion que no existe, abre un issue para que Roman/Mateo la implementen.

### 2. NO borres `events.jsonl`

Es el log de auditoria append-only. Si lo borras, pierdes trazabilidad de todas las decisiones, aprobaciones, y transiciones del sistema.

**Como hacerlo bien**: si el archivo crece mucho, rotalo con timestamp:

```bash
mv state/events.jsonl state/events.$(date +%Y%m%d).jsonl
touch state/events.jsonl
```

Luego comprime los archivos viejos (`gzip state/events.20260515.jsonl`).

### 3. NO ejecutes multiples dispatchers

SQLite WAL soporta multiples lectores pero UN SOLO escritor. Si corres dos dispatchers, tendras race conditions en leases, corrupcion de estado, y deadlocks.

**Como hacerlo bien**: PM2 esta configurado con `instances: 1`. No cambies eso. Si necesitas escalar, migra a Temporal.io (Fase 2).

### 4. NO apruebes waiters sin revisar el artifact

Los waiters de arquitectura, prod deploy, y hotfixes REQUIEREN que revises el artifact asociado antes de aprobar. Si apruebas a ciegas, el orquestador puede deployar codigo roto o inseguro.

**Como hacerlo bien**:

```bash
# Ver detalle del waiter
npx orchestrator waiter show xyz789

# Leer el artifact referenciado
cat state/outbox/artifact_xyz.md

# Aprobar solo si revisaste
npx orchestrator waiter fulfill xyz789 --json '{"approved":true}'
```

### 5. NO uses `backlog wake` en produccion sin razon

`backlog wake` bypasea la condicion del waiter. Si despiertas un flow que esperaba "cliente pague invoice", y el cliente NO pago, el flow puede fallar o producir estado inconsistente.

**Como hacerlo bien**: usa `wake` solo para debugging en entorno local. En produccion, espera a que la condicion se cumpla o cancela el flow si ya no es relevante.

## Operaciones avanzadas (opcional)

### Ver logs de una task especifica

```bash
npx orchestrator logs task_abc123
```

Filtra `events.jsonl` por `task_id` y muestra solo eventos relevantes (started, log.info, log.error, finished, failed).

### Ver logs de un flow completo

```bash
npx orchestrator logs flow_xyz789
```

Filtra por `flow_id`.

### Ver subgrafo de dependencias de una task

```bash
npx orchestrator task deps task_abc123
```

Output (ASCII tree):

```
task_abc123 (implementar-backend)
  depends on:
    task_def456 (revisar-arquitectura) [done]
      depends on:
        task_ghi789 (disenar-ux) [done]
  depended by:
    task_jkl012 (escribir-tests) [queued]
    task_mno345 (deploy-staging) [queued]
```

### Forzar detector de ciclos

Si sospechas que hay deadlock (tasks mutuamente bloqueadas):

```bash
npx orchestrator deadlock check
```

El orquestador corre el detector de ciclos en el grafo de dependencias y emite warning si encuentra alguno.

## Recursos

- [Spec completa (v0.8.1)](../spec.md)
- [Glosario](../GLOSSARY.md)
- [Referencia CLI completa](../reference/cli.md)
- [RUNBOOK (troubleshooting)](../../RUNBOOK.md)
- [Guia: escribir un flow](writing-a-flow.md)
