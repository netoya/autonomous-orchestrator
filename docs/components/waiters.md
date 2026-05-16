# Waiters — Primitivos de pausa/reanudacion

> **Spec**: seccion 3.3, 7  
> **Responsable**: Roman (concepto), Mateo (scheduler), Sofia (validacion)

---

## Concepto

Un **waiter** es un registro persistido + un mecanismo que **pausa un flujo hasta que una condicion se cumple**.

**Diferencia pasivos vs activos**:

| Dimension | Pasivos (input-driven) | Activos (poll-driven) |
|-----------|------------------------|----------------------|
| **Quien cumple** | Accion humana (CLI, inbox, FIFO) | Scheduler interno (bifurca script Bash) |
| **Condicion** | Input que cumple schema + authz | Estado observable (DB, archivo, HTTP, custom) |
| **Horizonte** | Siempre `short` (minutos a horas) | `short` o `long` (dias, semanas, meses) |
| **Frecuencia** | Una sola vez (input -> fulfilled) | Polling recurrente hasta cumplirse |

---

## Contrato Bash unificado (waiters activos)

**Ubicacion**: `bin/waiters/active/<kind>.sh`, chmod 750, versionados en git.

### Env vars inyectadas por el dispatcher

| Env var | Tipo | Descripcion |
|---------|------|-------------|
| `WAITER_ID` | ULID | id del waiter en SQLite |
| `FLOW_ID` | string | id del flow asociado |
| `TASK_ID` | string | id de la task que disparo el waiter |
| `WAITER_PARAMS_JSON` | JSON | parametros especificos (de `condition_params_json`) |
| `DB_PATH` | path | ruta a `state/orchestrator.db` |
| `STATE_DIR` | path | ruta a `state/` |

### Exit codes

| Exit | Significado | Efecto en el dispatcher |
|------|-------------|------------------------|
| `0` | condicion cumplida | `status='fulfilled'`, `value_json=stdout`, emite `waiter.fulfilled` |
| `1` | condicion no cumplida | incrementa `check_count`, espera proximo tick |
| `2` | error transitorio | incrementa `consecutive_errors`, backoff exponencial |
| `>=3` | error fatal | `status='invalid'`, escala a operador |

### Stdout cuando exit=0

```json
{
  "snapshot": { /* estado observado, libre */ },
  "observed_at": "2026-05-16T20:30:00Z"
}
```

JSON completo se persiste en `waiters.value_json`.

### Patron obligatorio

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. Kill-switch defensivo
[ -f "${STATE_DIR}/.KILLSWITCH" ] && exit 0

# 2. Trap de errores inesperados -> exit 2
trap 'echo "{\"error\":\"unexpected\",\"cmd\":\"${BASH_COMMAND}\"}" >&2; exit 2' ERR

# 3. Logica del waiter
# ... parsea WAITER_PARAMS_JSON con jq ...
# ... chequea condicion (query SQL, archivo, HTTP, etc.) ...

# 4. Salida final
if condition_met; then
  echo '{"snapshot":{},"observed_at":"'"$(date -u +%FT%TZ)"'"}'
  exit 0
fi
exit 1
```

---

## Catalogo de waiters base

| kind (etiqueta) | Script | Cuando se cumple |
|-----------------|--------|------------------|
| `task-dependency` | `bin/waiters/active/task-dependency.sh` | Todas las tasks de las que depende estan `done` |
| `flow-dependency` | `bin/waiters/active/flow-dependency.sh` | Flow referenciado esta `completed` con version aceptable |
| `db-record-ready` | `bin/waiters/active/db-record-ready.sh` | Query SQL devuelve >= N filas |
| `file-exists` | `bin/waiters/active/file-exists.sh` | Archivo existe y cumple constraints (size, hash) |
| `http-health` | `bin/waiters/active/http-health.sh` | Endpoint HTTP responde con status esperado |
| `goal-seeker` (EXPERIMENTAL) | `bin/waiters/active/goal-seeker.sh` | Validador emite `goal_met:true`, si no, lanza remedios + nuevo validador |
| `<custom>` | `bin/waiters/active/<tu-kind>.sh` | Lo decide el script |

**Spec**: Anexos G-M con scripts completos.

---

## Lease pattern (evitar concurrencia)

Waiters activos usan **lease atomico** para evitar que dos ticks procesen el mismo waiter concurrentemente.

### Toma de lease

```sql
UPDATE waiters
   SET lease_until  = strftime('%s','now')*1000 + :lease_ttl_ms,
       lease_holder = :hostname_pid
 WHERE id = :waiter_id
   AND status = 'waiting'
   AND (lease_until IS NULL OR lease_until < strftime('%s','now')*1000)
 RETURNING *;
```

Si el `RETURNING` no devuelve fila, otro proceso ya lo tomo → siguiente.

### Liberacion de lease

Al terminar el check (exito o error), el dispatcher libera:

```sql
UPDATE waiters
   SET lease_until = NULL, lease_holder = NULL
 WHERE id = :waiter_id;
```

### TTL del lease

Default `lease_ttl_ms = 60000` (60 s). Si el script no termina en 60 s (killed por timeout), el lease expira automaticamente y otro tick puede tomarlo.

---

## Polling adaptativo

Para waiters con `horizon='long'`, el polling puede ajustarse dinamicamente segun el numero de checks ya realizados.

### Schema de `poll_schedule_json`

```json
{
  "type": "adaptive",
  "intervals": [86400000, 604800000, 2592000000],
  "escalateAfter": [30, 100]
}
```

**Significado**: primeros 30 checks cada dia (86400000 ms), siguientes 100 checks cada semana (604800000 ms), resto cada mes (2592000000 ms).

### Presets

| Preset | Intervalo | Uso tipico |
|--------|-----------|------------|
| `aggressive` | 60 s | Tasks intra-sprint urgentes |
| `hourly` | 1 h | Sincronizaciones cortas |
| `daily` | 1 dia | Backlog latente activo |
| `weekly` | 1 semana | Iniciativas pausadas |
| `monthly` | 30 dias | Dependencias de largo plazo |
| `adaptive-long` | dia→semana→mes | Default para `horizon='long'` |

---

## Backlog vivo (horizon='long')

Waiters con `horizon='long'` habilitan el **backlog vivo**: iniciativas que hoy no son viables quedan latentes con un script que monitorea su condicion de activacion.

### Ciclo de vida

```
declarada (backlog_entries.status='latent', flow.status='hibernated')
   |
   | scheduler tick (baja frecuencia)
   v
poll del waiter activo (segun poll_schedule_json)
   |
   | condicion cumplida
   |---> waiter.fulfilled
   |       -> backlog_entries.status='activated'
   |       -> validar context_snapshot_hash
   |       -> flow.status='queued'
   |
   | condicion no cumplida
   |   -> recalcular next_check_at
   |
   | revision trimestral vencida
   |   -> generar reporte para Camila
   |
   | max_lifetime_days excedido
   v
expired -> escala a Camila
```

### Tabla `backlog_entries`

```sql
CREATE TABLE backlog_entries (
  id                    TEXT PRIMARY KEY,
  flow_definition_id    TEXT NOT NULL,
  flow_id               TEXT,
  waiter_id             TEXT NOT NULL REFERENCES waiters(id),
  title                 TEXT NOT NULL,
  rationale             TEXT NOT NULL,
  category              TEXT NOT NULL,  -- regulatory, cost, tech-dependency, etc.
  context_snapshot_hash TEXT,
  horizon               TEXT NOT NULL DEFAULT 'long',
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER,
  reviewed_at           INTEGER,
  next_review_at        INTEGER NOT NULL,
  status                TEXT NOT NULL DEFAULT 'latent',
  decision_log_json     TEXT NOT NULL DEFAULT '[]'
);
```

### Revision humana trimestral

**Politica obligatoria** (firmada por Camila):

- Cada `next_review_at` default es +90 dias.
- El dispatcher genera reporte diario `state/reports/backlog-review-<YYYY-MM-DD>.md`.
- Comando: `orchestrator backlog review` abre asistente interactivo.
- Decisiones: **extender**, **cancelar**, **forzar despertar**, **archivar**.

---

## Cuando escribir uno custom vs reutilizar

**Reutiliza** los scripts base si:
- La condicion es "esperar tarea X", "esperar archivo Y", "esperar HTTP status Z".
- Los parametros `WAITER_PARAMS_JSON` son suficientes.

**Escribe custom** si:
- La logica es compleja (ej. combinacion AND de multiples fuentes).
- Necesitas transformar datos antes de decidir (ej. parsear CSV, calcular promedio).
- La fuente es propietaria (ej. API interna sin wrapper).

**Template**: Spec Anexo L.

---

## Seguridad

### Shell injection

**Regla critica**: NUNCA interpolar valores de `WAITER_PARAMS_JSON` directamente en queries SQL ni en shells.

**Incorrecto** (vulnerable):

```bash
task_id=$(jq -r '.task_id' <<<"$WAITER_PARAMS_JSON")
sqlite3 "$DB_PATH" "SELECT * FROM tasks WHERE id='$task_id'"  # ❌ injection
```

**Correcto**:

```bash
task_id=$(jq -r '.task_id' <<<"$WAITER_PARAMS_JSON")
sqlite3 -bail "$DB_PATH" \
  -cmd ".parameter set :tid '${task_id//\'/}'" \
  "SELECT * FROM tasks WHERE id=:tid"
```

O usar heredocs sin expansion.

### Permisos

- `bin/waiters/active/*.sh` → `chmod 750`.
- Owner = usuario que corre PM2.
- No world-writable.
- Git pre-commit hook valida permisos.

---

## Dependencias del SO requeridas

Validadas por `bin/check-dependencies.sh` en setup:

- `bash >= 5.0`
- `jq`
- `sqlite3` CLI
- `curl`
- GNU coreutils (`date`, `grep`, `awk`, `sed`)

---

## Referencias

- **Spec seccion 3.3**: Waiter (concepto)
- **Spec seccion 3.3.3**: Contrato Bash
- **Spec seccion 3.3.5**: Evaluacion scheduler interno
- **Spec seccion 7**: Backlog vivo
- **Spec Anexos G-M**: Scripts de waiters base
- **ARCHITECTURE.md**: Flujo de datos con waiters
