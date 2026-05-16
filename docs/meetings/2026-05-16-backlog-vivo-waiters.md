# Reunion: Backlog vivo mediante waiters de largo plazo
**Fecha:** 2026-05-16
**Equipo:** softwarefactory
**Convocada por:** Angel
**Participantes:** Camila (PM), Roman (Tech Lead), Mateo (Backend)

## Contexto

Angel propone una extension conceptual del modelo de waiters activos:

> Un flow puede crear un waiter respaldado por un script que monitorea una condicion del entorno (presupuesto, costos, tecnologia, finalizacion de otro modulo, personal, regulacion, metricas de negocio) y se ejecuta indefinidamente hasta detectar una transicion valida. El backlog se vuelve VIVO: iniciativas pausadas semanas, meses o anos hasta que el contexto cambie y se reactiven solas.

Ejemplos planteados:
- `cost-threshold-monitor`: integracion con proveedor pausada hasta que su precio baje.
- Modulo que depende de la finalizacion de otro modulo (dependencia inter-flow).

Esto rompe varios supuestos de la spec v0.2:
- TTL definido (default 24h).
- Polling fijo en milisegundos.
- Flow corre en memoria mientras espera.

## Discusion

### Camila (Product Manager)
**Cambio conceptual**: backlog tradicional (Jira/Linear) es estatico y revisado manualmente. **Backlog vivo** convierte iniciativas pausadas en agentes latentes que monitorean su propio contexto de activacion. Pasamos de "recordar revisar si bajo Twilio" a "el sistema avisa cuando Twilio bajo 30%".

Top waiters de largo plazo valiosos para PM:
- **Regulatorio**: reactiva facturacion electronica cuando se publica norma definitiva.
- **Dependencia tecnica**: activa migracion a React 19 cuando Next.js da soporte estable.
- **Mercado**: lanza feature de crypto-pagos cuando adopcion en target supera 15%.
- **Capacidad del equipo**: reinicia refactor grande cuando rotacion baja y equipo se estabiliza.
- **Metricas de producto**: reactiva rediseno de onboarding si conversion cae bajo umbral critico.

**Impacto en priorizacion**: las iniciativas en waiter SALEN del backlog mental activo. Visualizadas en tablero separado ("Latentes") con estado del monitor visible. Libera capacidad cognitiva.

**Riesgo "cementerio vivo"**: mitigacion = TTL obligatorio (18 meses default), revision trimestral humana de waiters latentes, cancelacion de los que perdieron sentido de negocio.

**Relacion con sprint planning**: complementa, no reemplaza. Cuando un waiter se cumple, su flow entra al backlog normal; el humano decide cuando priorizarlo.

### Roman (Tech Lead)
Cambios estructurales necesarios:

- **TTL**: `NULL` = sin timeout, o numero en dias. Eliminar default de "24h" para waiters de largo horizonte.
- **Polling escalonado**: nueva columna `poll_interval_strategy` con valores `aggressive` (cada minuto, actual), `daily`, `weekly`, `custom` (cron expression).
- **Persistencia**: un flow no puede estar `running` 12 meses. Nuevo estado **`hibernated`** donde el flow esta serializado en DB, sin ocupar workers. Solo el waiter vive en el scheduler.

**Concepto nuevo**: diferenciar
- **Active Waiter**: TTL < 48h, polling frecuente, task en `waiting`.
- **Latent Task**: TTL > 48h o `NULL`, polling espaciado, task `hibernated`, contexto serializado.

Cuando el waiter detecta la condicion, la latent task pasa por `waiting -> ready -> running`.

**Versionado de scripts**: un waiter creado hoy con script v1 podria ejecutarse en 2027 con orquestador v5. Solucion: persistir `waiter_script_version`, mantener retro-compatibilidad o guardar el script entero serializado. Politica minima: 24 meses de soporte.

**Separacion de modulos**: **si separar**. El backlog vivo necesita scheduler propio (menor frecuencia), storage optimizado para lecturas infrecuentes, monitoring distinto (no alertar si un waiter lleva 3 meses activo).

**Top 3 riesgos**:
1. **Deriva de contexto**: env vars, APIs externas, credenciales pueden cambiar en 18 meses; el script puede fallar por razones ajenas a la condicion de negocio.
2. **Acumulacion silenciosa**: sin limites claros podemos tener 10000 waiters latentes que nadie recuerda → dashboard de "waiters huerfanos" + alerts.
3. **Consistencia de datos**: el contexto guardado hace 1 ano puede referenciar entidades eliminadas (clientes, productos). Validacion obligatoria de contexto antes de despertar el flow.

### Mateo (Backend)
Cambios al schema de `waiters`:

```sql
ALTER TABLE waiters ADD COLUMN horizon TEXT NOT NULL DEFAULT 'short'
  CHECK(horizon IN ('short','long'));
ALTER TABLE waiters ADD COLUMN poll_schedule_json TEXT;
-- ejemplo: {"type":"adaptive","intervals":[60000,3600000,86400000,604800000],"escalateAfter":[100,500,2000]}
ALTER TABLE waiters ADD COLUMN max_lifetime_days INTEGER;
ALTER TABLE waiters ADD COLUMN context_snapshot_hash TEXT;
ALTER TABLE waiters ADD COLUMN next_check_at INTEGER;  -- timestamp absoluto, evita recomputar
ALTER TABLE waiters ADD COLUMN script_version TEXT;
```

**Snapshot del contexto del flow**: artifact inmutable tipo `context_snapshot` con variables del flow, estado del orquestador, version del runtime. Al reactivar, validamos hash chain. Si la version cambio, corremos migracion versionada.

**Tabla separada `backlog_entries`**:

```sql
CREATE TABLE backlog_entries (
  id                     TEXT PRIMARY KEY,
  flow_definition_id     TEXT NOT NULL,           -- nombre del flow + version
  flow_id                TEXT,                     -- NULL si todavia no se creo el flow
  waiter_id              TEXT NOT NULL,
  title                  TEXT NOT NULL,
  rationale              TEXT NOT NULL,            -- por que esta latente
  context_snapshot_hash  TEXT,
  horizon                TEXT NOT NULL DEFAULT 'long',
  created_at             INTEGER NOT NULL,
  expires_at             INTEGER,                  -- NULL = sin expiracion
  reviewed_at            INTEGER,                  -- ultima revision humana
  next_review_at         INTEGER,                  -- proxima revision sugerida (trimestral)
  status                 TEXT NOT NULL DEFAULT 'latent'
                          CHECK(status IN ('latent','activated','cancelled','expired'))
);
CREATE INDEX backlog_horizon_idx ON backlog_entries(horizon, status);
CREATE INDEX backlog_review_idx  ON backlog_entries(next_review_at);
```

Las entradas no son ejecuciones activas, son **intenciones latentes**.

**Crecimiento de `waiter_checks`**: particionamiento por fecha + TTL automatico. Checks > 90 dias se archivan en cold storage o se borran. Conservamos ultimos N checks por waiter (configurable, default 50).

**Cron adaptativo**: politica en `poll_schedule_json`. Despues de 100 intentos sin cambio, escalamos de diario a semanal. Implementacion con `next_check_at` recalculado dinamicamente segun historial.

## Convergencias

- **Nuevo estado de flow: `hibernated`**. El flow se serializa, no ocupa workers, solo su waiter vive.
- **Nuevo concepto: latent task**, diferenciada por `horizon='long'`.
- **Tabla nueva `backlog_entries`**: el backlog vivo es su propio modelo, no es solo "una task con waiter".
- **Polling adaptativo** por estrategia, no por intervalo fijo (minuto -> hora -> dia -> semana).
- **TTL puede ser NULL**, pero hay default duro de 18 meses si no se especifica (politica de Camila).
- **Snapshot del contexto** obligatorio para horizonte largo (Mateo); validacion antes de reactivar (Roman).
- **Revision humana trimestral** obligatoria sobre `backlog_entries` con `next_review_at` vencido.
- **Versionado de scripts** con 24 meses de retro-compatibilidad.
- **Modulo separado** del orquestador principal (Roman): el backlog vivo tiene scheduler propio de baja frecuencia.

## Decisiones

1. Adoptar **backlog vivo** como caracteristica de primera clase. Spec pasa a v0.3.
2. Introducir estado `hibernated` para flows y tipo `latent` para tasks (`horizon='long'`).
3. Crear tabla nueva `backlog_entries` separada de `flows`.
4. Polling adaptativo via `poll_schedule_json` con estrategia y escalado por intentos.
5. TTL default 18 meses cuando no se especifica; NULL solo si el flow lo declara explicitamente con justificacion.
6. Snapshot inmutable del contexto al hibernar; validacion al reactivar.
7. Revision trimestral obligatoria: el dispatcher genera reporte automatico con `backlog_entries` cuyo `next_review_at` esta vencido. Camila firma.
8. Submodulo logico `backlog-engine` dentro del orquestador, con scheduler propio de baja frecuencia (ciclo cada 5 min en lugar de 5 s).
9. Politica de versionado: cada script de waiter persiste su version; soporte minimo 24 meses.

## Action Items

| Responsable | Tarea | Fecha |
|---|---|---|
| Roman | Actualizar spec.md a v0.3 con backlog vivo | 2026-05-17 |
| Mateo | Migracion SQL: columnas de horizonte + tabla `backlog_entries` | 2026-05-21 |
| Mateo | Cron adaptativo y archivado de `waiter_checks` > 90 dias | 2026-05-24 |
| Roman | Estado `hibernated` + protocolo de serializacion/validacion del contexto | 2026-05-26 |
| Camila | Politica de revision trimestral y plantilla de reporte | 2026-05-23 |
| Sofia (out) | Tests E2E de despertar un flow tras 30 dias hibernado (con clock injection) | 2026-05-30 |
