# Guia: Escribir un Waiter

Tutorial completo para crear waiters custom (activos y pasivos) en el Autonomous Orchestrator.

## Cuando escribir un waiter custom vs reutilizar uno de la libreria

El orquestador provee una **libreria de waiters base** (ver spec Anexos G-K) que cubren casos comunes:

| Waiter | Caso de uso | Cuando reutilizar |
|---|---|---|
| `task-dependency.sh` | Esperar a que otras tasks esten `done` | Siempre (es el mecanismo de dependencias) |
| `flow-dependency.sh` | Esperar a que otro flow este `completed` | Cuando tu flow depende de un pipeline externo |
| `db-record-ready.sh` | Esperar a que query SQL devuelva >= N filas | Cuando validas estado en SQLite |
| `file-exists.sh` | Esperar a que archivo exista | Cuando esperas output de proceso externo |
| `http-health.sh` | Esperar a que endpoint responda con status esperado | Cuando chequeas servicio HTTP/API |

**Escribe un waiter custom cuando**:

- La condicion es especifica de tu dominio (ej. "esperar a que cliente pague invoice").
- Necesitas logica compleja de validacion (ej. parsear JSON, validar schema, combinar multiples checks).
- La condicion involucra un servicio externo con API especifica (ej. Stripe, GitHub, AWS).

**Reutiliza un waiter de la libreria cuando**:

- El caso de uso encaja perfectamente (ej. "esperar a que exista archivo X").
- Solo necesitas cambiar parametros, no logica (ej. cambiar la query SQL o el path del archivo).

## El contrato Bash

Todos los waiters activos custom son **scripts Bash** que cumplen un contrato unico:

### Entrada (env vars inyectadas por el dispatcher)

| Env var | Tipo | Descripcion |
|---|---|---|
| `WAITER_ID` | string (ULID) | ID del waiter en SQLite |
| `FLOW_ID` | string | ID del flow asociado |
| `TASK_ID` | string | ID de la task que disparo el waiter |
| `WAITER_PARAMS_JSON` | string (JSON) | Parametros especificos del waiter (valor de `conditionParams` del WaiterSpec) |
| `DB_PATH` | path | Ruta a `state/orchestrator.db` |
| `STATE_DIR` | path | Ruta a `state/` |

### Salida (exit code)

| Exit | Significado | Efecto en el dispatcher |
|---|---|---|
| `0` | Condicion cumplida | `status='fulfilled'`, `value_json = stdout`, emite `waiter.fulfilled` |
| `1` | Condicion no cumplida (aun) | Incrementa `check_count`, espera proximo tick |
| `2` | Error transitorio (ej. red caida) | Incrementa `consecutive_errors`, aplica backoff exponencial |
| `>=3` | Error fatal (ej. config invalida) | `status='invalid'`, escala a operador |

### Salida (stdout) cuando exit=0

El script debe imprimir un JSON con el estado observado al momento del fulfill:

```json
{
  "snapshot": { /* estado observado, formato libre */ },
  "observed_at": "2026-05-16T20:30:00Z"
}
```

El dispatcher valida que sea JSON parseable antes de dar el fulfill por bueno. Este JSON se persiste en `waiters.value_json` y se pasa al callback `onFulfilled` del WaiterSpec.

## Walk-through del template base

Template minimo para un waiter activo (Anexo L del spec):

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. Kill-switch defensivo
# Si existe .KILLSWITCH, salir limpiamente sin error
[ -f "${STATE_DIR}/.KILLSWITCH" ] && exit 0

# 2. Trap de errores inesperados
# Cualquier comando que falle lanza exit 2 (error transitorio)
trap 'echo "{\"error\":\"unexpected\",\"cmd\":\"${BASH_COMMAND}\"}" >&2; exit 2' ERR

# 3. Parsear parametros de entrada
# WAITER_PARAMS_JSON es un JSON con los parametros del waiter
# Usamos jq para extraerlos de forma segura
PARAM_X=$(echo "$WAITER_PARAMS_JSON" | jq -r '.paramX // empty')
PARAM_Y=$(echo "$WAITER_PARAMS_JSON" | jq -r '.paramY // 0')

# Validar que parametros requeridos existan
if [ -z "$PARAM_X" ]; then
  echo '{"error":"paramX is required"}' >&2
  exit 3  # Error fatal (config invalida)
fi

# 4. Logica del waiter
# Aqui va el check de la condicion
# Ejemplo: validar que archivo existe
if [ -f "$PARAM_X" ]; then
  # Condicion cumplida
  echo "{\"snapshot\":{\"file\":\"$PARAM_X\",\"size\":$(stat -c%s "$PARAM_X")},\"observed_at\":\"$(date -u +%FT%TZ)\"}"
  exit 0
fi

# Condicion no cumplida aun
exit 1
```

### Explicacion linea por linea

1. **Shebang + set strict**:
   - `#!/usr/bin/env bash`: ejecuta con bash del sistema.
   - `set -euo pipefail`: salir ante errores, variables undefined, o pipes que fallan.

2. **Kill-switch defensivo**:
   - Si el operador creo `.KILLSWITCH`, el waiter debe salir limpiamente (exit 0).
   - Esto permite drain sin dejar waiters zombies.

3. **Trap de errores**:
   - Captura errores inesperados (comandos que fallan, variables undefined).
   - Loguea a stderr con JSON estructurado.
   - Sale con exit 2 (transitorio) para que el dispatcher lo reintente.

4. **Parseo de parametros**:
   - Usa `jq` para extraer valores de `WAITER_PARAMS_JSON` de forma segura.
   - Nunca interpoles `$WAITER_PARAMS_JSON` directamente en queries SQL o shells (riesgo de injection).

5. **Validacion de parametros**:
   - Si un parametro requerido falta, sale con exit 3 (fatal).
   - El dispatcher marca el waiter como `invalid` y escala a operador.

6. **Logica del check**:
   - Aqui va el codigo que valida si la condicion se cumple.
   - Puede ser: query SQL, check de archivo, HTTP request, lectura de API externa, etc.

7. **Salida estructurada**:
   - Si la condicion se cumple, imprime JSON al stdout y sale con 0.
   - Si no se cumple, sale con 1 (el dispatcher lo reintentara).

## Checklist antes de mergear

Antes de abrir un PR con un waiter custom, valida que cumple **todos** estos criterios:

- [ ] Cumple el contrato Bash (env vars + exit codes + stdout JSON).
- [ ] Respeta kill-switch (linea `[ -f "${STATE_DIR}/.KILLSWITCH" ] && exit 0`).
- [ ] Trap de errores configurado (`trap ... ERR`).
- [ ] No interpola valores sin sanitizar en queries SQL (usa `sqlite3 -cmd ".parameter set"` o wrapper `bin/db-query.sh`).
- [ ] Script versionado en git (commiteado en `bin/waiters/active/<tu-kind>.sh`).
- [ ] Permisos 750 (`chmod 750 bin/waiters/active/<tu-kind>.sh`).
- [ ] Tests cubren al menos:
  - [ ] Condicion cumplida (exit 0 + JSON valido en stdout).
  - [ ] Condicion no cumplida (exit 1).
  - [ ] Error transitorio (exit 2 cuando falla algo externo, ej. red).
  - [ ] Respeta kill-switch (sale limpiamente si existe `.KILLSWITCH`).
- [ ] Documentado en `docs/GLOSSARY.md` (entrada nueva con descripcion + link a spec).
- [ ] Ejemplo de uso agregado a `docs/guides/writing-a-flow.md` (si es waiter reutilizable).

Referencia completa: [spec 3.3.3 final](../spec.md#333-contrato-bash-unificado-para-waiters-activos)

## 3 ejemplos completos

### Ejemplo 1: `db-check.sh` con bind de parametros

Waiter que espera a que query SQL devuelva >= N filas. Usa bind de parametros para evitar SQL injection.

```bash
#!/usr/bin/env bash
set -euo pipefail

[ -f "${STATE_DIR}/.KILLSWITCH" ] && exit 0
trap 'echo "{\"error\":\"unexpected\",\"cmd\":\"${BASH_COMMAND}\"}" >&2; exit 2' ERR

# Parsear parametros
QUERY=$(echo "$WAITER_PARAMS_JSON" | jq -r '.query // empty')
MIN_COUNT=$(echo "$WAITER_PARAMS_JSON" | jq -r '.minCount // 1')

if [ -z "$QUERY" ]; then
  echo '{"error":"query is required"}' >&2
  exit 3
fi

# Ejecutar query con wrapper que inyecta PRAGMAs
COUNT=$(bin/db-query.sh "$DB_PATH" "$QUERY" | jq -r '.[0].c // 0')

if [ "$COUNT" -ge "$MIN_COUNT" ]; then
  echo "{\"snapshot\":{\"count\":$COUNT},\"observed_at\":\"$(date -u +%FT%TZ)\"}"
  exit 0
fi

exit 1
```

**Uso desde un flow**:

```typescript
await ctx.wait({
  mode: 'active',
  kind: 'db-check',
  scriptPath: 'bin/waiters/active/db-check.sh',
  prompt: 'Esperando a que tabla users tenga >= 10 filas',
  conditionParams: {
    query: 'SELECT COUNT(*) as c FROM users',
    minCount: 10,
  },
  pollIntervalMs: 5000,
  pollMaxAttempts: 120,
  timeoutMs: 600000,
  onFulfilled: async (result) => {
    console.log(`DB tiene ${result.snapshot.count} filas`);
    return { type: 'resume' };
  },
});
```

### Ejemplo 2: `http-check.sh` con jsonpath

Waiter que espera a que endpoint HTTP responda con status 200 y un valor especifico en el JSON.

```bash
#!/usr/bin/env bash
set -euo pipefail

[ -f "${STATE_DIR}/.KILLSWITCH" ] && exit 0
trap 'echo "{\"error\":\"unexpected\",\"cmd\":\"${BASH_COMMAND}\"}" >&2; exit 2' ERR

# Parsear parametros
URL=$(echo "$WAITER_PARAMS_JSON" | jq -r '.url // empty')
EXPECTED_STATUS=$(echo "$WAITER_PARAMS_JSON" | jq -r '.expectedStatus // 200')
JSON_PATH=$(echo "$WAITER_PARAMS_JSON" | jq -r '.jsonPath // empty')
EXPECTED_VALUE=$(echo "$WAITER_PARAMS_JSON" | jq -r '.expectedValue // empty')

if [ -z "$URL" ]; then
  echo '{"error":"url is required"}' >&2
  exit 3
fi

# Hacer request HTTP con timeout
HTTP_CODE=$(curl -s -o /tmp/waiter-response.json -w "%{http_code}" --max-time 5 "$URL" || echo "000")

if [ "$HTTP_CODE" != "$EXPECTED_STATUS" ]; then
  exit 1  # No cumplido aun
fi

# Si se especifico jsonPath, validar valor
if [ -n "$JSON_PATH" ]; then
  ACTUAL_VALUE=$(jq -r "$JSON_PATH" /tmp/waiter-response.json)
  if [ "$ACTUAL_VALUE" != "$EXPECTED_VALUE" ]; then
    exit 1
  fi
fi

# Condicion cumplida
RESPONSE=$(cat /tmp/waiter-response.json)
echo "{\"snapshot\":{\"status\":$HTTP_CODE,\"response\":$RESPONSE},\"observed_at\":\"$(date -u +%FT%TZ)\"}"
exit 0
```

**Uso desde un flow**:

```typescript
await ctx.wait({
  mode: 'active',
  kind: 'http-check',
  scriptPath: 'bin/waiters/active/http-check.sh',
  prompt: 'Esperando a que API /status responda healthy',
  conditionParams: {
    url: 'http://localhost:3000/status',
    expectedStatus: 200,
    jsonPath: '.status',
    expectedValue: 'healthy',
  },
  pollIntervalMs: 10000,
  pollMaxAttempts: 60,
  timeoutMs: 600000,
  onFulfilled: async (result) => ({ type: 'resume' }),
});
```

### Ejemplo 3: custom (esperar a cron externo)

Waiter que espera a que un archivo de signal aparezca en disco (usado para sincronizar con cron externo).

```bash
#!/usr/bin/env bash
set -euo pipefail

[ -f "${STATE_DIR}/.KILLSWITCH" ] && exit 0
trap 'echo "{\"error\":\"unexpected\",\"cmd\":\"${BASH_COMMAND}\"}" >&2; exit 2' ERR

# Parsear parametros
SIGNAL_FILE=$(echo "$WAITER_PARAMS_JSON" | jq -r '.signalFile // empty')
DELETE_AFTER=$(echo "$WAITER_PARAMS_JSON" | jq -r '.deleteAfter // false')

if [ -z "$SIGNAL_FILE" ]; then
  echo '{"error":"signalFile is required"}' >&2
  exit 3
fi

# Validar que archivo existe
if [ ! -f "$SIGNAL_FILE" ]; then
  exit 1  # No cumplido aun
fi

# Leer contenido (puede tener metadata)
CONTENT=$(cat "$SIGNAL_FILE")

# Si deleteAfter=true, borrar el archivo tras leerlo
if [ "$DELETE_AFTER" = "true" ]; then
  rm -f "$SIGNAL_FILE"
fi

# Condicion cumplida
echo "{\"snapshot\":{\"file\":\"$SIGNAL_FILE\",\"content\":$CONTENT},\"observed_at\":\"$(date -u +%FT%TZ)\"}"
exit 0
```

**Uso desde un flow**:

```typescript
await ctx.wait({
  mode: 'active',
  kind: 'cron-signal',
  scriptPath: 'bin/waiters/active/cron-signal.sh',
  prompt: 'Esperando a que cron externo termine backup diario',
  conditionParams: {
    signalFile: '/var/run/backup.done',
    deleteAfter: true,  // Borra el archivo tras consumirlo
  },
  pollIntervalMs: 30000,  // Check cada 30 seg
  pollMaxAttempts: 2880,  // Max 24h (2880 * 30s)
  timeoutMs: 86400000,    // TTL 24h
  onFulfilled: async (result) => {
    console.log('Backup completado:', result.snapshot.content);
    return { type: 'resume' };
  },
});
```

## Como usar el wrapper `bin/db-query.sh`

Los waiters que necesitan acceder a SQLite NO deben invocar `sqlite3` directo, porque no inyectarian los PRAGMAs obligatorios (`foreign_keys=ON`, `busy_timeout=5000`, etc.). Usa el wrapper:

```bash
# bin/db-query.sh
#!/usr/bin/env bash
set -euo pipefail

DB_PATH="$1"
QUERY="$2"

sqlite3 "$DB_PATH" <<EOF
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -64000;

.mode json
$QUERY
EOF
```

**Uso desde un waiter**:

```bash
RESULT=$(bin/db-query.sh "$DB_PATH" "SELECT COUNT(*) as c FROM tasks WHERE status='done'")
COUNT=$(echo "$RESULT" | jq -r '.[0].c')
```

Esto asegura que todas las queries respetan los PRAGMAs obligatorios.

## Diferencias entre waiters activos y pasivos

| Dimension | Activo | Pasivo |
|---|---|---|
| **Quien cumple** | Scheduler (polling) | Humano (input) |
| **Script/codigo** | Script Bash custom | Logica TS en callback `onValid` |
| **Cuando usar** | Condiciones observables (DB, archivos, HTTP) | Aprobaciones, input humano con validacion compleja |
| **Polling** | Si, configurable (`pollIntervalMs`) | No |
| **Timeout** | `timeoutMs` absoluto | `timeoutMs` absoluto |
| **Estado DB** | Tabla `waiters` + `waiter_checks` | Tabla `waiters` |

**Regla general**: si la condicion es observable programaticamente, usa waiter activo. Si requiere juicio humano, usa waiter pasivo.

## Recursos

- [Spec completa (v0.8.1)](../spec.md)
- [Spec 3.3.3 — Contrato Bash](../spec.md#333-contrato-bash-unificado-para-waiters-activos)
- [Spec Anexo L — Template waiter custom](../spec.md#22-anexo-l-template-para-waiters-custom)
- [Glosario](../GLOSSARY.md)
- [Guia: escribir un flow](writing-a-flow.md)
- [CONTRIBUTING.md](../../CONTRIBUTING.md)
