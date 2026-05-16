# Reunion: Todos los waiters activos como scripts Bash
**Fecha:** 2026-05-16
**Equipo:** softwarefactory
**Convocada por:** Angel
**Participantes:** Roman (Tech Lead), Mateo (Backend), Dante (DevOps)

## Contexto

Mensaje literal de Angel:

> por mas que tengamos waiters internos y externos, todos estos deben ir como scripts en bash. podriamos agregar los tipos base que ya tenemos como anexos. esto mas que nada sirve para que cualquiera pueda adaptar esos waiters base segun su necesidad.

En spec v0.5, los waiters activos tenian dos formas: clases TypeScript en `src/waiters/active/` (DBRecord, FileExists, HTTPHealth, Composite, etc.) + `CustomScriptWaiter` para bash custom. Angel propone unificar: **TODOS los waiters activos son scripts Bash**. Los tipos base se publican como anexos del spec para que cualquiera los adapte.

## Discusion

### Roman (Tech Lead)

**De acuerdo con eliminar clases TS de waiters activos.**

A favor:
- **Adaptabilidad total**: cualquiera edita un `.sh` sin tocar el runtime.
- **Sin compilacion**: cambio el script, reinicio el flow, listo.
- **Portabilidad**: no atamos al stack Node.
- **Claridad**: codigo del waiter en un solo lugar, no entre clase + config.

En contra:
- **Tipado perdido**: `condition_params` pasa de interface a string JSON; errores en runtime.
- **Testing mas duro**: bats + fixtures + mocks vs unit tests TS.
- **Composicion fragil**: `CompositeWaiter` en bash es mas dificil.

**Trade-off neto**: ganamos flexibilidad y democratizacion de la adaptacion, perdemos garantias estaticas. Vale la pena para waiters custom.

**Contrato unificado (reutilizar el de `CustomScriptWaiter`)**:
- Entrada (env vars): `WAITER_ID`, `FLOW_ID`, `TASK_ID`, `CONDITION_PARAMS_JSON` (Roman) / `WAITER_PARAMS` (Mateo nombra distinto — alinear).
- Salida: `stdout` JSON con `{snapshot:{...}}`; exit `0`=cumplida, `1`=no cumplida, `2`=error fatal.

**Excepcion importante**: los **waiters PASIVOS no se convierten a bash**. Su naturaleza es ser puerta de entrada para input externo (CLI/inbox/FIFO), no un check. La logica de espera vive en el dispatcher, no en un script.

**Errores transitorios**: patron `set -euo pipefail` + `trap ... ERR`. Retry con backoff dentro del script si tiene sentido.

**Ubicacion**: `bin/waiters/active/<kind>.sh`, kebab-case, versionados en git.

### Mateo (Backend)

**Schema**:
- `script_path` pasa a `NOT NULL` para waiters activos.
- `condition_kind` ya no es source of truth tecnico (el script es la definicion); proposicion de Mateo: eliminarlo. (Resolucion en convergencias).
- `condition_params_json` se queda; se inyecta como env var.

**Invocacion desde dispatcher Node**:
```ts
import { spawn } from 'child_process';

function executeWaiter(waiter: Waiter): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(waiter.script_path, [], {
      env: {
        ...process.env,
        WAITER_ID: waiter.id,
        FLOW_ID: waiter.flow_id,
        TASK_ID: waiter.task_id,
        WAITER_PARAMS: waiter.condition_params_json,
        DB_PATH: process.env.DB_PATH,
        STATE_DIR: process.env.STATE_DIR,
      },
      timeout: WAITER_EXEC_TIMEOUT_MS,
    });
    proc.on('exit', code => resolve(code ?? 2));
    proc.on('error', reject);
  });
}
```

**SQLite desde bash**: `sqlite3` CLI con WAL. Los leases siguen funcionando: `BEGIN IMMEDIATE` desde bash hace el mismo lock que desde Node.

**Riesgos**:
- **`jq` obligatorio** para parsear params.
- **Shell injection**: si `WAITER_PARAMS` proviene del operador o del flow, NUNCA interpolar directo en queries. Pasar via bind variables o `.parameter set`.

**Esboza `task-dependency.sh`**:
```bash
#!/usr/bin/env bash
set -euo pipefail
TASK_ID=$(jq -r '.task_id' <<<"$WAITER_PARAMS")
PENDING=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM task_dependencies td JOIN tasks t ON td.depends_on_task_id=t.id WHERE td.task_id='$TASK_ID' AND t.status<>'done'")
[[ "$PENDING" -eq 0 ]] && { echo "{\"snapshot\":{\"task_id\":\"$TASK_ID\",\"pending\":0}}"; exit 0; } || exit 1
```

### Dante (DevOps)

**Dependencias del SO** (verificadas en setup):
- `bash >= 5.0`
- `jq`
- `sqlite3` CLI
- `curl`
- coreutils basicos (`grep`, `awk`, `sed`)

Script `bin/check-dependencies.sh` ejecutado en postinstall. Falla con mensaje claro si falta algo.

**Permisos**:
- `bin/waiters/active/*.sh` → `chmod 750` (owner + group exec, no world).
- Owner = usuario que corre PM2.
- No world-writable.
- Git pre-commit hook valida permisos antes de allow commit.

**Logging**: PM2 captura stdout/stderr automaticamente. No requiere redireccion explicita salvo logs separados por waiter (opcional). Para auditoria detallada, escribir el `snapshot` en `state/logs/waiters/<waiter_id>/<check_ts>.json`.

**Kill-switch**: defensa en profundidad: cada script chequea al inicio `[ -f "$STATE_DIR/.KILLSWITCH" ] && exit 0`. Aunque el dispatcher tambien lo valida antes de spawn.

**Cross-platform**: asumimos GNU coreutils. macOS: documentar `brew install coreutils` o aliases con prefijo `g`. Evitar flags GNU-only (`date -d` → usar formato portable o `gdate`).

## Convergencias y resoluciones

### R1: ¿Eliminar `condition_kind` del schema? (Mateo: si / Roman: no explicito)
- **Resolucion**: **mantener `condition_kind` como etiqueta legible**, no como source of truth tecnico. Sirve para logs, metricas, dashboards y agrupacion. La definicion real vive en `script_path`. No es validado contra una enum cerrada; el flow lo declara libremente. Lo unico obligatorio es que coincida con un comportamiento que el script implementa.

### R2: nombre de env var (Roman: `CONDITION_PARAMS_JSON` / Mateo: `WAITER_PARAMS`)
- **Resolucion**: alinear a **`WAITER_PARAMS_JSON`**. Mas corto que Roman, mas explicito que Mateo. Es el nombre canonico en el contrato Bash.

### R3: waiters pasivos
- **Resolucion**: los pasivos **NO se convierten a bash**. Quedan como estan (CLI/inbox/FIFO gestionados por el dispatcher). El cambio de v0.6 solo afecta a waiters activos.

### R4: anexos del spec
- **Resolucion**: agregamos **5 anexos nuevos** al spec con los scripts base completos, listos para copiar y adaptar:
  - `task-dependency.sh`
  - `flow-dependency.sh`
  - `db-record-ready.sh`
  - `file-exists.sh`
  - `http-health.sh`
- Adicionalmente, un anexo metodologico con el **contrato y el template** para escribir uno custom.

## Decisiones

1. **Todos los waiters activos son scripts Bash**. Se eliminan las clases TypeScript `DBRecordWaiter`, `FileExistsWaiter`, `HTTPHealthWaiter`, `CompositeWaiter` del codigo del motor.
2. Los waiters **pasivos no se tocan** (CLI/inbox/FIFO siguen igual).
3. Schema:
   - `script_path NOT NULL` para waiters activos.
   - `condition_kind` se mantiene como etiqueta no validada.
   - Env vars canonicas: `WAITER_ID`, `FLOW_ID`, `TASK_ID`, `WAITER_PARAMS_JSON`, `DB_PATH`, `STATE_DIR`.
4. **Exit codes**: `0`=condicion cumplida, `1`=no cumplida, `2`=error fatal.
5. **Salida stdout** (cuando exit=0): JSON con campo `snapshot` que se persiste en `value_json`.
6. Patron obligatorio en cada script: `set -euo pipefail`, chequeo de kill-switch al inicio, traps de error.
7. **Dependencias requeridas** del SO: `bash 5+`, `jq`, `sqlite3`, `curl`, coreutils. Validadas por `bin/check-dependencies.sh` en setup.
8. **Permisos**: `chmod 750`, owner = usuario que corre PM2, no world-writable. Pre-commit hook valida.
9. **Ubicacion**: `bin/waiters/active/<kind>.sh`, kebab-case, versionados en git.
10. **Anexos al spec** con los 5 scripts base + 1 template para custom waiters.
11. Spec pasa a v0.6.

## Action Items

| Responsable | Tarea | Fecha |
|---|---|---|
| Roman | Actualizar spec.md a v0.6 con contrato Bash y anexos | 2026-05-17 |
| Roman | Eliminar de la spec las referencias a clases TS de waiters activos | 2026-05-17 |
| Mateo | Implementar los 5 scripts base (`task-dependency`, `flow-dependency`, `db-record-ready`, `file-exists`, `http-health`) | 2026-05-24 |
| Mateo | Adaptar el invoker del dispatcher (`spawn` con env vars unificadas) | 2026-05-21 |
| Dante | `bin/check-dependencies.sh` + pre-commit hook de permisos | 2026-05-22 |
| Sofia (out) | Test harness con `bats` para los 5 scripts base | 2026-05-28 |
