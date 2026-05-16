# DEPLOYMENT — SoftwareFactory Autonomous Orchestrator

Guia de deployment del orquestador en diferentes entornos.

## Indice

1. [Deployment local (default)](#deployment-local-default)
2. [Deployment en VPS (Fase 2)](#deployment-en-vps-fase-2)
3. [Variables de entorno requeridas](#variables-de-entorno-requeridas)
4. [Healthcheck post-deploy](#healthcheck-post-deploy)

---

## Deployment local (default)

El orquestador corre por default en la maquina local del operador (Angel).

### Prerequisitos

Ver `docs/RUNBOOK.md` seccion "Prerequisitos del sistema".

### Pasos

1. **Clone y setup inicial**:

   ```bash
   git clone <repo-url> autonomous-orchestrator
   cd autonomous-orchestrator
   npm install
   npm run migrate
   ```

2. **Configurar secretos**:

   Ver `docs/RUNBOOK.md` seccion "Configuracion de secretos".

3. **Build**:

   ```bash
   npm run build
   ```

4. **Arrancar con PM2**:

   ```bash
   pm2 start ecosystem.config.js
   ```

5. **Verificar**:

   ```bash
   pm2 status
   orchestrator status
   ```

### Persistencia

PM2 guarda la configuracion de procesos. Para que el dispatcher arranque al boot:

```bash
pm2 startup
pm2 save
```

---

## Deployment en VPS (Fase 2)

En Fase 2, el orquestador se deploya en un VPS remoto (DigitalOcean, AWS EC2, etc.).

### Arquitectura target

```
[VPS Ubuntu 22.04]
  ├── nginx (reverse proxy para metricas Prometheus)
  ├── PM2 (supervisor del dispatcher)
  ├── SQLite (base de datos)
  └── Docker (sandbox para agentes L2+)
```

### Prerequisitos del VPS

- **OS**: Ubuntu 22.04 LTS
- **RAM**: minimo 4GB
- **Disk**: minimo 50GB SSD
- **Network**: puerto 22 (SSH), 9090 (Prometheus, solo internal)

### Pasos

1. **Conectar al VPS**:

   ```bash
   ssh root@<vps-ip>
   ```

2. **Crear usuario dedicado**:

   ```bash
   adduser orchestrator
   usermod -aG sudo orchestrator
   su - orchestrator
   ```

3. **Instalar dependencias**:

   ```bash
   # Node.js, PM2, sqlite3, jq, etc.
   # Ver RUNBOOK.md seccion "Instalacion por sistema"
   ```

4. **Instalar Docker**:

   ```bash
   curl -fsSL https://get.docker.com -o get-docker.sh
   sh get-docker.sh
   usermod -aG docker orchestrator
   ```

5. **Clone del repositorio**:

   ```bash
   cd ~
   git clone <repo-url> autonomous-orchestrator
   cd autonomous-orchestrator
   ```

6. **Setup secretos**:

   - Copiar `state/secrets/keys/orchestrator.txt` desde maquina local via SCP:

     ```bash
     # Desde maquina local
     scp state/secrets/keys/orchestrator.txt orchestrator@<vps-ip>:~/autonomous-orchestrator/state/secrets/keys/
     ```

   - Configurar `SOPS_AGE_KEY_FILE`:

     ```bash
     echo 'export SOPS_AGE_KEY_FILE="$HOME/autonomous-orchestrator/state/secrets/keys/orchestrator.txt"' >> ~/.bashrc
     source ~/.bashrc
     ```

7. **Instalar deps + build**:

   ```bash
   npm install
   npm run build
   npm run migrate
   ```

8. **Arrancar con PM2**:

   ```bash
   pm2 start ecosystem.config.js
   pm2 startup
   pm2 save
   ```

9. **Configurar nginx para metricas** (opcional):

   ```nginx
   # /etc/nginx/sites-available/orchestrator-metrics

   server {
     listen 80;
     server_name metrics.orchestrator.internal;

     location /metrics {
       proxy_pass http://localhost:9090/metrics;
       allow 10.0.0.0/8;  # solo red interna
       deny all;
     }
   }
   ```

   Habilitar:

   ```bash
   sudo ln -s /etc/nginx/sites-available/orchestrator-metrics /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl reload nginx
   ```

10. **Configurar backups remotos**:

    Usar rsync o S3:

    ```bash
    # Cron diario
    0 2 * * * rsync -avz ~/autonomous-orchestrator/state/backups/ user@backup-server:/backups/orchestrator/
    ```

### Consideraciones de seguridad en VPS

- **Firewall**: solo puerto 22 (SSH) abierto publicamente. Metricas Prometheus solo en red interna.
- **SSH**: deshabilitar password login, solo key-based.
- **Fail2ban**: proteccion contra brute-force SSH.
- **Actualizaciones**: `unattended-upgrades` habilitado para security patches.

---

## Variables de entorno requeridas

El dispatcher requiere las siguientes variables de entorno:

| Variable | Descripcion | Valor default | Obligatoria |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Clave de API de Claude | - | Si |
| `NODE_ENV` | Entorno (`development`, `production`) | `development` | No |
| `LOG_LEVEL` | Nivel de log (`DEBUG`, `INFO`, `WARN`, `ERROR`) | `INFO` | No |
| `MAX_CONCURRENT_TASKS` | Maximo de tasks en paralelo | `5` | No |
| `SQLITE_BUSY_TIMEOUT` | Timeout de lock SQLite (ms) | `5000` | No |
| `PROMETHEUS_PORT` | Puerto para metricas Prometheus | `9090` | No |
| `SOPS_AGE_KEY_FILE` | Path a clave age privada | - | Si (para desencriptar secretos) |

### Configuracion en ecosystem.config.js

```javascript
module.exports = {
  apps: [{
    name: 'softwarefactory-orchestrator',
    script: './dist/dispatcher.js',
    env: {
      NODE_ENV: 'production',
      LOG_LEVEL: 'INFO',
      MAX_CONCURRENT_TASKS: 5,
      SQLITE_BUSY_TIMEOUT: 5000,
      PROMETHEUS_PORT: 9090,
    },
  }],
};
```

El `ANTHROPIC_API_KEY` se carga desde `state/secrets/anthropic.env` al arrancar el dispatcher.

---

## Healthcheck post-deploy

Despues de cada deploy, ejecuta el siguiente healthcheck:

### 1. Verificar estado de PM2

```bash
pm2 status
```

Esperado: `online` en columna `status`.

### 2. Verificar estado del orquestador

```bash
orchestrator status
```

Esperado:

```
Orchestrator status: RUNNING
Uptime: <tiempo>
Active flows: 0
Pending waiters: 0
```

### 3. Verificar heartbeat

```bash
stat state/.heartbeat
```

Esperado: archivo actualizado hace menos de 60 segundos.

### 4. Verificar logs

```bash
pm2 logs softwarefactory-orchestrator --lines 20
```

Esperado: sin errores (`ERROR` level).

### 5. Verificar conectividad Claude

```bash
orchestrator test claude-connection
```

Esperado:

```
OK: Claude API reachable
OK: API key valid
```

### 6. Ejecutar smoke test

```bash
orchestrator run sprint smoke-test --full
```

El smoke test ejecuta una task simple (ej: `echo "Hello world"`) para verificar que el pipeline completo funciona.

Esperado:

```
Sprint smoke-test completed successfully
Tasks executed: 1
Duration: 3s
```

### 7. Verificar metricas Prometheus

```bash
curl http://localhost:9090/metrics | grep orchestrator_
```

Esperado: metricas expuestas correctamente.

---

## Rollback

Si el deploy falla, rollback al commit anterior:

```bash
touch ./state/.KILLSWITCH
pm2 logs softwarefactory-orchestrator | grep "All waiters drained"
pm2 stop softwarefactory-orchestrator

git reset --hard HEAD~1
npm install
npm run build

rm ./state/.KILLSWITCH
pm2 start ecosystem.config.js
```

Verifica healthcheck post-rollback.

---

**Fin de DEPLOYMENT.md**. Para deployment en otros entornos (Kubernetes, Docker Compose), contacta a Dante (DevOps).
