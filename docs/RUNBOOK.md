# RUNBOOK — SoftwareFactory Autonomous Orchestrator

Documentacion operativa exhaustiva para arrancar, operar, monitorear, hacer mantenimiento y recuperar el orquestador autonomo.

## Indice

1. [Prerequisitos del sistema](#prerequisitos-del-sistema)
2. [Bootstrap inicial](#bootstrap-inicial)
3. [Operacion diaria](#operacion-diaria)
4. [Procedimientos de mantenimiento](#procedimientos-de-mantenimiento)
5. [Procedimientos de incidente](#procedimientos-de-incidente)
6. [Healthchecks y monitoreo](#healthchecks-y-monitoreo)
7. [Logs y observabilidad](#logs-y-observabilidad)
8. [Backups y recovery](#backups-y-recovery)
9. [Update del orquestador](#update-del-orquestador)
10. [Apendice: Troubleshooting comun](#apendice-troubleshooting-comun)

---

## Prerequisitos del sistema

El orquestador requiere las siguientes dependencias instaladas en el sistema host:

### Software obligatorio

- **bash** >= 5.0 (shell para scripts de waiters)
- **jq** (procesamiento JSON en waiters Bash)
- **sqlite3** (CLI para inspeccionar base de datos)
- **curl** (llamadas HTTP en waiters)
- **GNU coreutils** (date, sort, awk, grep, etc.)
- **claude CLI** (Claude Code CLI para ejecutar agentes)
- **Node.js** >= 20.0 (runtime del dispatcher y coordinador)
- **npm** o **pnpm** (gestor de dependencias Node)
- **PM2** (supervisor de procesos)
- **sops** + **age** (encriptacion de secretos)

### Instalacion por sistema

#### Ubuntu / Debian

```bash
# Dependencias del sistema
sudo apt-get update
sudo apt-get install -y bash jq sqlite3 curl coreutils

# Node.js 20 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# PM2
sudo npm install -g pm2

# sops
wget https://github.com/getsops/sops/releases/download/v3.8.1/sops-v3.8.1.linux.amd64
sudo mv sops-v3.8.1.linux.amd64 /usr/local/bin/sops
sudo chmod +x /usr/local/bin/sops

# age
sudo apt-get install -y age

# Claude Code CLI
# TODO(dante): agregar instrucciones oficiales de instalacion claude CLI
```

#### macOS (Homebrew)

```bash
# Dependencias del sistema
brew install bash jq sqlite curl coreutils

# Node.js 20
brew install node@20
brew link node@20

# PM2
npm install -g pm2

# sops + age
brew install sops age

# Claude Code CLI
# TODO(dante): agregar instrucciones oficiales de instalacion claude CLI
```

### Verificacion de dependencias

Corre el script de verificacion:

```bash
./bin/check-dependencies.sh
```

Salida esperada:

```
✓ bash 5.0+
✓ jq
✓ sqlite3
✓ curl
✓ GNU coreutils
✓ claude CLI
✓ Node.js 20+
✓ PM2
✓ sops
✓ age

All dependencies satisfied.
```

Si falta alguna dependencia, el script te dira cual instalar.

---

## Bootstrap inicial

Procedimiento completo para arrancar el orquestador desde cero.

### 1. Clone del repositorio

```bash
cd ~/projects
git clone <repository-url> autonomous-orchestrator
cd autonomous-orchestrator
```

### 2. Instalacion de dependencias Node

```bash
npm install
```

O con pnpm:

```bash
pnpm install
```

### 3. Migraciones de base de datos

El orquestador usa un sistema de migraciones SQL forward-only (referencia spec 3.6.5).

Corre el comando de migracion:

```bash
npm run migrate
```

Esto ejecuta todos los archivos `.sql` en `src/migrations/` en orden numerico. Cada migracion se registra en la tabla `schema_migrations` con su hash SHA-256.

**IMPORTANTE**: nunca edites un `.sql` ya aplicado. Si detectas un error, crea una nueva migracion forward que lo corrija.

Errores posibles:

- **MigrationTamperedError**: un archivo `.sql` ya aplicado fue editado. Restaura el original o crea migracion forward.
- **MigrationLockTimeout**: otro proceso esta migrando. Espera 30 segundos y reintenta.

### 4. Configuracion de secretos

El orquestador usa **sops + age** para encriptar secretos (referencia spec 3.2.7).

#### 4.1. Generar clave age (solo primera vez)

```bash
age-keygen -o state/secrets/keys/orchestrator.txt
```

Guarda el contenido de `state/secrets/keys/orchestrator.txt` en un gestor de passwords (1Password, Bitwarden, etc.). **Nunca** commitees este archivo.

#### 4.2. Configurar variable de entorno

Agrega a tu `.bashrc` o `.zshrc`:

```bash
export SOPS_AGE_KEY_FILE="$HOME/projects/autonomous-orchestrator/state/secrets/keys/orchestrator.txt"
```

Recarga:

```bash
source ~/.bashrc  # o ~/.zshrc
```

#### 4.3. Crear archivo de secretos

Crea `state/secrets/anthropic.env` (plano, temporalmente):

```bash
ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxxx
```

Encriptalo con sops:

```bash
sops -e state/secrets/anthropic.env > state/secrets/anthropic.env.enc
rm state/secrets/anthropic.env
```

El archivo `.enc` SI se commitea. El `.env` plano NO (esta en `.gitignore`).

#### 4.4. Desencriptar secretos en runtime

El dispatcher desencripta automaticamente al arrancar:

```bash
sops -d state/secrets/anthropic.env.enc > state/secrets/anthropic.env
source state/secrets/anthropic.env
```

### 5. Build del proyecto

```bash
npm run build
```

Esto compila TypeScript a JavaScript en `dist/`.

### 6. Setup PM2

El orquestador corre como daemon via PM2.

Arranca el dispatcher:

```bash
pm2 start ecosystem.config.js
```

Verifica estado:

```bash
pm2 status
```

Salida esperada:

```
┌─────┬──────────────────────────────┬─────────┬───────┬────────┬─────┐
│ id  │ name                         │ mode    │ ↺     │ status │ cpu │
├─────┼──────────────────────────────┼─────────┼───────┼────────┼─────┤
│ 0   │ softwarefactory-orchestrator │ fork    │ 0     │ online │ 0%  │
└─────┴──────────────────────────────┴─────────┴───────┴────────┴─────┘
```

### 7. Setup logrotate

PM2 viene con modulo de rotacion de logs:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 30
pm2 set pm2-logrotate:compress true
```

Esto rotara logs cada 100MB, manteniendo 30 archivos comprimidos.

### 8. Verificacion final

```bash
orchestrator status
```

Salida esperada:

```
Orchestrator status: RUNNING
Uptime: 2m 34s
Active flows: 0
Pending waiters: 0
Hibernated flows: 0
Last heartbeat: 2s ago
```

Si ves `RUNNING`, el bootstrap fue exitoso.

---

## Operacion diaria

Flujo de trabajo tipico del operador (Angel).

### Al inicio de sesion

1. **Verificar estado del dispatcher**:

   ```bash
   pm2 status
   ```

2. **Verificar estado del orquestador**:

   ```bash
   orchestrator status
   ```

3. **Listar backlog pendiente**:

   ```bash
   orchestrator backlog list --pending
   ```

   Esto muestra flows en estado `hibernated` esperando entrada externa (backlog vivo, referencia spec 3.3).

### Disparar un sprint

Un sprint es un conjunto de tasks coordinadas. Para ejecutar:

```bash
orchestrator run sprint <sprint_id> --full
```

Modos de invocacion (referencia spec 3.4.5):

- `--full`: ejecuta todas las tasks del sprint hasta que se complete o bloquee.
- `--until-milestone <task_id>`: ejecuta hasta alcanzar una task especifica.
- `--single-task <task_id>`: ejecuta solo una task y se detiene.

Ejemplo:

```bash
orchestrator run sprint deploy-v2.1.0 --full
```

### Aprobar gates pendientes

Los gates son waiters pasivos que bloquean flujo hasta aprobacion humana (referencia spec 3.2.4).

1. **Listar waiters pendientes**:

   ```bash
   orchestrator waiter list --pending
   ```

   Salida ejemplo:

   ```
   ID: wt-001
   Kind: gate
   Task: deploy-production
   Status: waiting
   Since: 2026-05-16 14:30:00
   Condition: PM approval for production deploy
   ```

2. **Aprobar un gate**:

   ```bash
   orchestrator waiter fulfill wt-001 --approve
   ```

   O rechazar:

   ```bash
   orchestrator waiter fulfill wt-001 --reject --reason "Missing QA sign-off"
   ```

3. **El flow se reanuda automaticamente** tras la aprobacion. El dispatcher detecta el cambio de estado del waiter y reactiva la task bloqueada.

### Monitorear ejecucion de tasks

Para ver logs en vivo de una task:

```bash
tail -f state/logs/agent-run-<execution_id>.stderr
```

O todos los logs del dispatcher:

```bash
pm2 logs softwarefactory-orchestrator
```

### Listar artifacts generados

Los artifacts son outputs de tasks (archivos, reportes, etc.):

```bash
orchestrator artifacts list --task <task_id>
```

Estan almacenados en `state/artifacts/<task_id>/`.

---

## Procedimientos de mantenimiento

### Backup diario via cron

El orquestador debe backearse diariamente. Configura un cronjob:

```bash
crontab -e
```

Agrega:

```cron
0 2 * * * /home/angel/projects/autonomous-orchestrator/scripts/backup-daily.sh
```

El script `backup-daily.sh` debe:

1. Hacer backup de SQLite:

   ```bash
   sqlite3 state/orchestrator.db ".backup state/backups/$(date +\%F).db"
   ```

2. Copiar `state/inbox`, `state/outbox`, `state/artifacts`, `state/conversations`, `events.jsonl`:

   ```bash
   tar -czf state/backups/$(date +%F)-state.tar.gz \
     state/inbox \
     state/outbox \
     state/artifacts \
     state/conversations \
     events.jsonl
   ```

3. Sincronizar a almacenamiento externo (S3, rsync, etc.):

   ```bash
   # TODO(dante): agregar comando de sync segun infraestructura disponible
   ```

### Retencion de backups

- **Hot backups**: ultimos 30 dias en `state/backups/`.
- **Archived backups**: 31-90 dias en almacenamiento externo.
- **Purge**: despues de 90 dias.

Script de limpieza:

```bash
find state/backups/ -name "*.db" -mtime +30 -delete
find state/backups/ -name "*.tar.gz" -mtime +30 -delete
```

Agregar a cron:

```cron
0 3 * * 0 /home/angel/projects/autonomous-orchestrator/scripts/cleanup-old-backups.sh
```

### Rotacion de logs

PM2 ya rota logs (configurado en bootstrap). Para rotar manualmente:

```bash
pm2 flush
```

### Archivado de waiter_checks antiguos

Los `waiter_checks` acumulan historico de polling. Archivar registros > 90 dias (referencia spec 7.7):

```bash
sqlite3 state/orchestrator.db <<EOF
DELETE FROM waiter_checks WHERE checked_at < datetime('now', '-90 days');
VACUUM;
EOF
```

Agregar a cron mensual:

```cron
0 4 1 * * /home/angel/projects/autonomous-orchestrator/scripts/archive-waiter-checks.sh
```

### Optimizacion de SQLite

Cada semana, optimiza la base de datos:

```bash
sqlite3 state/orchestrator.db "VACUUM; ANALYZE;"
```

Agregar a cron:

```cron
0 5 * * 0 /home/angel/projects/autonomous-orchestrator/scripts/optimize-sqlite.sh
```

---

## Procedimientos de incidente

### Dispatcher caido

**Sintoma**: `pm2 status` muestra `errored` o `stopped`.

**Diagnostico**:

1. Ver logs:

   ```bash
   pm2 logs softwarefactory-orchestrator --lines 100
   ```

2. Revisar errores recientes en stderr:

   ```bash
   tail -n 100 state/logs/dispatcher.err.log
   ```

**Resolucion**:

1. Si es error temporal (OOM, timeout), restart:

   ```bash
   pm2 restart softwarefactory-orchestrator
   ```

2. Si es error persistente (bug), hacer **drain** primero:

   ```bash
   touch ./state/.KILLSWITCH
   pm2 logs softwarefactory-orchestrator | grep "All waiters drained"
   pm2 stop softwarefactory-orchestrator
   ```

3. Investigar causa raiz en logs, arreglar codigo.

4. Rebuild + restart:

   ```bash
   npm run build
   rm ./state/.KILLSWITCH
   pm2 start ecosystem.config.js
   ```

### Deadlock detectado

**Sintoma**: flows bloqueados indefinidamente sin avanzar.

**Diagnostico**:

```bash
orchestrator deadlock check
```

Esto analiza el grafo de `task_dependencies` en busca de ciclos (referencia spec 3.4.8).

**Resolucion**:

1. Identificar tasks en ciclo:

   ```bash
   orchestrator deadlock show
   ```

2. Revisar declaracion de dependencias en el flow DSL (`src/flows/<flow_name>.ts`).

3. Romper ciclo eliminando dependencia invalida:

   ```bash
   orchestrator task unblock <task_id> --force
   ```

4. Reportar bug en la definicion del flow.

### Token budget excedido

**Sintoma**: tasks fallan con error `BudgetExceededError`.

**Diagnostico**:

```bash
orchestrator budget show
```

Muestra consumo actual de tokens Claude por task/flow.

**Resolucion**:

1. Si el budget configurado es demasiado bajo, ajustalo en `src/config/budgets.ts`:

   ```typescript
   export const budgets = {
     default: { tokens: 50000, hard_limit: 100000 },
     'code-review': { tokens: 20000, hard_limit: 40000 },
   };
   ```

2. Rebuild:

   ```bash
   npm run build
   pm2 restart softwarefactory-orchestrator
   ```

3. Si el budget es correcto pero la task consume demasiado, investigar prompt excesivo o bucle infinito en el agente.

### Base de datos corrupta

**Sintoma**: errores SQLite `database disk image is malformed`.

**Diagnostico**:

```bash
sqlite3 state/orchestrator.db "PRAGMA integrity_check;"
```

**Resolucion**:

1. Detener dispatcher:

   ```bash
   touch ./state/.KILLSWITCH
   pm2 stop softwarefactory-orchestrator
   ```

2. Restaurar desde ultimo backup:

   ```bash
   cp state/backups/$(ls -t state/backups/*.db | head -1) state/orchestrator.db
   ```

3. Restart:

   ```bash
   rm ./state/.KILLSWITCH
   pm2 start ecosystem.config.js
   ```

4. **PERDIDA DE DATOS**: todas las tasks ejecutadas entre el backup y el incidente se pierden. Revisar `events.jsonl` para reconstruir estado manualmente si es critico.

---

## Healthchecks y monitoreo

### Heartbeat del dispatcher

El dispatcher actualiza `state/.heartbeat` cada tick (referencia spec 3.6.7).

Script de monitoreo externo:

```bash
#!/bin/bash
# monitoring/check-heartbeat.sh

HEARTBEAT_FILE="./state/.heartbeat"
MAX_AGE_SECONDS=60

if [[ ! -f "$HEARTBEAT_FILE" ]]; then
  echo "ERROR: Heartbeat file missing"
  exit 1
fi

AGE=$(( $(date +%s) - $(stat -c %Y "$HEARTBEAT_FILE") ))

if [[ $AGE -gt $MAX_AGE_SECONDS ]]; then
  echo "ERROR: Heartbeat stale (${AGE}s old)"
  exit 1
fi

echo "OK: Heartbeat fresh (${AGE}s old)"
exit 0
```

Agregar a cron cada 5 minutos:

```cron
*/5 * * * * /home/angel/projects/autonomous-orchestrator/monitoring/check-heartbeat.sh || echo "Dispatcher unhealthy" | mail -s "ALERT: Orchestrator down" angel@example.com
```

### Restart loop detection

Si el dispatcher reinicia mas de 3 veces en 10 minutos, hay un problema serio.

Script de deteccion:

```bash
#!/bin/bash
# monitoring/check-restarts.sh

RESTART_COUNT=$(pm2 jlist | jq '.[] | select(.name == "softwarefactory-orchestrator") | .pm2_env.restart_time')

if [[ $RESTART_COUNT -gt 3 ]]; then
  echo "ERROR: Dispatcher restarted $RESTART_COUNT times"
  exit 1
fi

echo "OK: Restart count normal ($RESTART_COUNT)"
exit 0
```

Agregar a cron cada 10 minutos:

```cron
*/10 * * * * /home/angel/projects/autonomous-orchestrator/monitoring/check-restarts.sh
```

### Metricas Prometheus

El dispatcher expone metricas en formato Prometheus en `http://localhost:9090/metrics` (referencia spec 7.10.10).

Metricas disponibles:

- `orchestrator_active_flows`
- `orchestrator_pending_waiters`
- `orchestrator_task_execution_seconds`
- `orchestrator_token_usage_total`
- `orchestrator_db_query_duration_seconds`

Configura Prometheus para scrape:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'orchestrator'
    static_configs:
      - targets: ['localhost:9090']
```

---

## Logs y observabilidad

### Donde viven los logs

| Componente | Path | Contenido |
|---|---|---|
| Dispatcher stdout | `state/logs/dispatcher.out.log` | Logs informativos del dispatcher |
| Dispatcher stderr | `state/logs/dispatcher.err.log` | Errores y warnings del dispatcher |
| Agent runs | `state/logs/agent-run-<execution_id>.stderr` | Logs de ejecucion de agentes Claude |
| Conversations | `state/conversations/<execution_id>.jsonl` | Transcripcion completa de conversaciones con Claude |
| Events | `events.jsonl` | Registro append-only de todos los eventos del sistema |

### Como filtrar logs por flow/task

Todos los logs estructurados incluyen `flow_id` y `task_id`.

Ejemplo: filtrar logs del dispatcher por flow:

```bash
grep '"flow_id":"deploy-v2.1.0"' state/logs/dispatcher.out.log | jq .
```

Filtrar eventos por task:

```bash
grep '"task_id":"build-frontend"' events.jsonl | jq .
```

### Niveles de log

El dispatcher usa niveles estandar:

- `DEBUG`: informacion detallada para debugging.
- `INFO`: eventos normales de operacion.
- `WARN`: situaciones anormales pero recuperables.
- `ERROR`: errores que requieren intervencion.

Configurar nivel en `ecosystem.config.js`:

```javascript
env: {
  LOG_LEVEL: 'INFO'
}
```

---

## Backups y recovery

### Que se backupea

- **SQLite**: `state/orchestrator.db` (incluye WAL/SHM si existen).
- **Inbox/Outbox**: `state/inbox/`, `state/outbox/`.
- **Artifacts**: `state/artifacts/`.
- **Conversations**: `state/conversations/`.
- **Events**: `events.jsonl`.

### Comando de backup manual

```bash
# Backup de SQLite
sqlite3 state/orchestrator.db ".backup state/backups/manual-$(date +%F-%H%M%S).db"

# Backup de state completo
tar -czf state/backups/manual-$(date +%F-%H%M%S)-state.tar.gz \
  state/inbox \
  state/outbox \
  state/artifacts \
  state/conversations \
  events.jsonl
```

### Retencion

- **Hot**: ultimos 30 dias en `state/backups/`.
- **Archived**: 31-90 dias en S3/rsync.
- **Purge**: > 90 dias.

### Recovery desde backup

1. Detener dispatcher:

   ```bash
   touch ./state/.KILLSWITCH
   pm2 stop softwarefactory-orchestrator
   ```

2. Restaurar SQLite:

   ```bash
   cp state/backups/2026-05-15.db state/orchestrator.db
   ```

3. Restaurar state:

   ```bash
   tar -xzf state/backups/2026-05-15-state.tar.gz
   ```

4. Restart:

   ```bash
   rm ./state/.KILLSWITCH
   pm2 start ecosystem.config.js
   ```

5. Verificar estado:

   ```bash
   orchestrator status
   orchestrator backlog list
   ```

---

## Update del orquestador

Procedimiento **con drain** para actualizar el codigo del orquestador sin perder estado de waiters (referencia spec 3.6.7).

### Pasos exactos

1. **Activar KILLSWITCH**:

   ```bash
   touch ./state/.KILLSWITCH
   ```

2. **Esperar drain de waiters**:

   El dispatcher detecta el KILLSWITCH y drena waiters activos. Monitorea logs:

   ```bash
   pm2 logs softwarefactory-orchestrator | grep KILLSWITCH
   ```

   Espera hasta ver:

   ```
   KILLSWITCH detected, draining waiters...
   All waiters drained, exiting gracefully.
   ```

3. **Detener dispatcher**:

   ```bash
   pm2 stop softwarefactory-orchestrator
   ```

4. **Pull del codigo nuevo**:

   ```bash
   git pull origin main
   ```

5. **Instalar dependencias**:

   ```bash
   npm install
   ```

6. **Build**:

   ```bash
   npm run build
   ```

7. **Migrar schema (si aplica)**:

   ```bash
   npm run migrate
   ```

8. **Desactivar KILLSWITCH**:

   ```bash
   rm ./state/.KILLSWITCH
   ```

9. **Restart dispatcher**:

   ```bash
   pm2 start ecosystem.config.js
   ```

10. **Verificar estado**:

    ```bash
    pm2 status
    orchestrator status
    ```

### Rollback en caso de fallo

Si el update falla:

1. **Detener**:

   ```bash
   pm2 stop softwarefactory-orchestrator
   ```

2. **Rollback del codigo**:

   ```bash
   git reset --hard HEAD~1
   npm install
   npm run build
   ```

3. **Restart**:

   ```bash
   rm ./state/.KILLSWITCH
   pm2 start ecosystem.config.js
   ```

---

## Apendice: Troubleshooting comun

### "claude command not found"

**Causa**: Claude Code CLI no instalado.

**Solucion**: instala el CLI siguiendo las instrucciones oficiales de Anthropic.

### "ANTHROPIC_API_KEY missing"

**Causa**: archivo de secretos no desencriptado o variable de entorno no cargada.

**Solucion**:

1. Verifica que existe `state/secrets/anthropic.env.enc`:

   ```bash
   ls -lh state/secrets/anthropic.env.enc
   ```

2. Desencripta:

   ```bash
   sops -d state/secrets/anthropic.env.enc > state/secrets/anthropic.env
   ```

3. Carga en entorno:

   ```bash
   source state/secrets/anthropic.env
   ```

4. Verifica:

   ```bash
   echo $ANTHROPIC_API_KEY
   ```

### "SQLITE_BUSY" frecuente

**Causa**: contention de locks en SQLite por multiples procesos accediendo simultaneamente.

**Solucion**:

1. Verifica PRAGMAs en `src/db/connection.ts` (referencia spec 3.6.6):

   ```typescript
   PRAGMA busy_timeout = 5000;
   PRAGMA journal_mode = WAL;
   ```

2. Si persiste, reduce paralelismo de tasks en `ecosystem.config.js`:

   ```javascript
   env: {
     MAX_CONCURRENT_TASKS: 2  // reducir de 5 a 2
   }
   ```

### "MigrationTamperedError"

**Causa**: un archivo `.sql` ya aplicado fue editado. El hash SHA-256 no coincide con el registrado en `schema_migrations`.

**Solucion**:

1. Restaura el original desde git:

   ```bash
   git checkout HEAD -- src/migrations/<numero>-<nombre>.sql
   ```

2. Si el cambio es necesario, crea una nueva migracion forward:

   ```bash
   cp src/migrations/<ultimo>.sql src/migrations/<nuevo-numero>-fix-<issue>.sql
   # Edita el nuevo archivo
   npm run migrate
   ```

### "MigrationLockTimeout"

**Causa**: otro proceso esta ejecutando migraciones. El archivo `state/.migration.lock` existe.

**Solucion**:

1. Espera 30 segundos y reintenta.

2. Si el lock esta stale (proceso murio sin liberarlo):

   ```bash
   rm state/.migration.lock
   npm run migrate
   ```

### Waiters huerfanos

**Causa**: el dispatcher fue killado abruptamente (kill -9) mientras habia waiters activos.

**Solucion**: el dispatcher recupera waiters huerfanos automaticamente al arrancar (referencia spec 3.6.4 refinamiento v0.8.1).

Verifica en logs:

```bash
pm2 logs softwarefactory-orchestrator | grep "orphaned waiters"
```

Deberia ver:

```
INFO: Recovered 3 orphaned waiters at startup
```

---

**Fin del RUNBOOK**. Para dudas operativas no cubiertas aqui, consulta el spec completo en `docs/spec.md` o escalalo a Roman (Tech Lead).
