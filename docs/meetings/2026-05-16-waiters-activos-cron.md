# Reunion: Modelo activo de waiters (cron-driven)
**Fecha:** 2026-05-16
**Equipo:** softwarefactory
**Convocada por:** Angel
**Participantes:** Roman (Tech Lead), Mateo (Backend), Dante (DevOps)

## Contexto

Refinamiento sobre la spec.md v0.1. Angel define un nuevo modelo de waiter:

> Si se detecta un bloqueo en el flujo, se debe crear un script independiente que se ejecute mediante un cron. Este script debe validar la condicion especifica del bloqueo (entrada de usuario, registro en DB, archivo, etc.). El script se ejecuta de forma recurrente hasta que la condicion se cumpla. Una vez cumplida, marca el flow como 'fulfilled', permitiendo reanudar el pipeline.

Cambio conceptual:
- ANTES (spec v0.1): waiter PASIVO. Espera que llegue input por CLI/inbox/FIFO.
- AHORA: waiter ACTIVO. Script que poll-ea la condicion hasta cumplirse.

## Discusion

### Roman (Tech Lead)
Los dos modelos no son excluyentes; conviven. La spec v0.1 cubre bien el caso pasivo (input humano). El caso activo es un segundo `kind` de waiter.

Tipos resultantes:
- **Pasivo**: `approve-architecture`, `free-text` — necesitan input CLI/inbox/FIFO.
- **Activo**: `db-record-ready`, `file-exists`, `http-health-check`, `composite` — pollean condicion.

Anatomia del script activo: recibe `waiter_id` por argv; lee `condition_config` desde SQLite; toma lease (DB lock o `locked_by` con PID+timestamp); ejecuta check; si cumple, marca `fulfilled`; si no, libera lease y sale. Exit 0 = condicion cumplida, exit 1 = aun no.

**Cron del sistema vs scheduler interno → scheduler interno**. Ya tenemos PM2 + dispatcher con polling de 500 ms; agregar "active waiters" es trivial. Cron del SO seria fragil (sin visibilidad, edicion programatica del crontab).

**Generacion del script**: libreria de waiters reutilizables en `src/waiters/active/` (`DBRecordWaiter`, `FileExistsWaiter`, `HTTPHealthWaiter`, `UserInputWaiter`). El flow declara cual usar + config. Caso custom: permitir script externo que cumpla la interface.

**Zombies**: TTL obligatorio (`expires_at`), max attempts con backoff exponencial (1s, 2s, 4s, ..., 60s), timeout duro de ejecucion (`WAITER_EXEC_TIMEOUT_MS=30000`). Si el proceso cuelga, lo matamos.

### Mateo (Backend)
Cambios en el schema de `waiters`:
- `script_path TEXT` — ruta absoluta al script (opcional si es de la libreria).
- `condition_kind TEXT` — `db|file|http|input|composite`.
- `condition_params_json TEXT` — query, path, URL, headers, etc.
- `cron_expression TEXT` (opcional, NULL si usa scheduler interno).
- `last_check_at INTEGER`.
- `check_count INTEGER DEFAULT 0`.
- `lease_until INTEGER` (NULL = libre).
- `lease_holder TEXT` (hostname/PID).

Lease pattern:

```sql
UPDATE waiters
SET lease_until = strftime('%s','now') + 120,
    lease_holder = :hostname_pid
WHERE id = :waiter_id
  AND (lease_until IS NULL OR lease_until < strftime('%s','now'))
RETURNING *;
```

Si el UPDATE no retorna fila → lease ocupado, salir.

Pseudocodigo del script:

```ts
const row = takeLease(waiterId);
if (!row) process.exit(0);

const met = await checkCondition(row.condition_kind, JSON.parse(row.condition_params_json));

if (met) {
  db.prepare(`UPDATE waiters SET status='fulfilled', lease_until=NULL WHERE id=?`).run(waiterId);
} else {
  db.prepare(`UPDATE waiters SET check_count=check_count+1, last_check_at=strftime('%s','now'), lease_until=NULL WHERE id=?`).run(waiterId);
}
```

Auditoria: **tabla separada** `waiter_checks` (en vez de contaminar `events.jsonl` con checks fallidos cada minuto). `events.jsonl` recibe solo eventos relevantes (`waiter.fulfilled`, `waiter.timeout`).

### Dante (DevOps)
**Scheduler interno** gestionado por PM2 — descarta cron del SO (variabilidad entre distros, sin visibilidad, kill-switch hackeable).

Registro dinamico: el dispatcher mantiene un `waiter_registry` en memoria que sincroniza desde SQLite cada 30-60 s. Cualquier waiter nuevo entra al scheduler sin tocar archivos.

Kill-switch nativo: al inicio de cada ciclo, `fs.existsSync('.KILLSWITCH')`. Si existe, saltea el ciclo entero — cero ejecuciones nuevas.

Logs: PM2 + `pm2-logrotate`, max 10 MB por archivo, retencion 7 dias. Logs estructurados JSON con `waiterId` para filtrar por flujo.

Timeout obligatorio: `Promise.race([pollFn(), timeout(30000)])`. Si cuelga, log + `last_attempt_failed=true` + sigue ciclo.

## Convergencias

- **Scheduler**: interno al dispatcher (no cron del SO). Unanime.
- **Modelos conviven**: pasivo (v0.1) + activo (v0.2). Distinguidos por `kind`.
- **Libreria reutilizable** de waiters activos: DB, file, http, input, composite. Soporte a script custom para casos especiales.
- **Lease pattern** SQL (Mateo) para evitar concurrencia.
- **Tabla `waiter_checks`** separada de `events.jsonl` para no inflar el log de auditoria.
- **TTL + max attempts + backoff exponencial + timeout duro** para evitar zombies. Limites configurables por env vars.

## Decisiones

1. Adoptar el modelo activo como `kind` adicional, sin descartar el pasivo. Spec pasa a v0.2.
2. Scheduler interno del dispatcher (no cron del SO).
3. Polling base cada 60 s (configurable por waiter), con backoff exponencial en re-chequeos cercanos.
4. Lease pattern en SQLite con `lease_until` y `lease_holder`.
5. Tabla nueva `waiter_checks` para auditoria de polls; solo eventos finales van a `events.jsonl`.
6. Librearia `src/waiters/active/` con `DBRecordWaiter`, `FileExistsWaiter`, `HTTPHealthWaiter`, `UserInputWaiter`, `CompositeWaiter`. Soporte a `CustomScriptWaiter` apuntando a `script_path`.
7. Timeout duro de ejecucion: 30 s (`WAITER_EXEC_TIMEOUT_MS`). Configurable.
8. Limite global de waiters activos concurrentes: `MAX_ACTIVE_WAITERS=10` (configurable).

## Action Items

| Responsable | Tarea | Fecha |
|---|---|---|
| Roman | Actualizar spec.md a v0.2 con modelo activo | 2026-05-17 |
| Mateo | Migracion SQL: nuevas columnas en `waiters` + tabla `waiter_checks` | 2026-05-19 |
| Mateo | Implementacion del lease pattern (DAO + tests) | 2026-05-20 |
| Roman | Definir interface `ActiveWaiter` + 4 implementaciones base | 2026-05-21 |
| Dante | `pm2-logrotate` config + dashboard de waiters activos | 2026-05-23 |
| Sofia (out-of-meeting) | Test suite para los 4 waiters base + zombies/timeout | 2026-05-25 |
