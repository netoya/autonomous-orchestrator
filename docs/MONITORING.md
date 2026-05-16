# MONITORING — SoftwareFactory Autonomous Orchestrator

Sistema de monitoreo, metricas Prometheus, alertas y dashboard de costos Claude.

## Indice

1. [Metricas Prometheus](#metricas-prometheus)
2. [Exposicion de metricas](#exposicion-de-metricas)
3. [Alertas obligatorias](#alertas-obligatorias)
4. [Dashboard de costos Claude](#dashboard-de-costos-claude)
5. [Grafana (opcional)](#grafana-opcional)

---

## Metricas Prometheus

El dispatcher expone metricas en formato Prometheus (referencia spec 7.10.10).

### Metricas disponibles

| Metrica | Tipo | Descripcion |
|---|---|---|
| `orchestrator_active_flows` | Gauge | Numero de flows activos (estado `running`) |
| `orchestrator_hibernated_flows` | Gauge | Numero de flows hibernados (estado `hibernated`) |
| `orchestrator_pending_waiters` | Gauge | Numero de waiters en estado `waiting` |
| `orchestrator_task_execution_seconds` | Histogram | Duracion de ejecucion de tasks (por `task_id`) |
| `orchestrator_task_execution_total` | Counter | Total de tasks ejecutadas (por `status`: `success`, `failed`) |
| `orchestrator_token_usage_total` | Counter | Total de tokens Claude consumidos (por `flow_id`) |
| `orchestrator_token_budget_remaining` | Gauge | Tokens restantes del budget (por `task_id`) |
| `orchestrator_db_query_duration_seconds` | Histogram | Duracion de queries SQLite (por `query_type`) |
| `orchestrator_db_connections` | Gauge | Numero de conexiones SQLite activas |
| `orchestrator_waiter_checks_total` | Counter | Total de checks de waiters activos (por `waiter_kind`) |
| `orchestrator_circuit_breaker_state` | Gauge | Estado del circuit breaker (0=closed, 1=open) |
| `orchestrator_restarts_total` | Counter | Total de reinicios del dispatcher |

### Etiquetas (labels)

Las metricas incluyen etiquetas para filtrado:

- `flow_id`: ID del flow.
- `task_id`: ID de la task.
- `status`: `success`, `failed`, `timeout`.
- `waiter_kind`: `gate`, `dependency`, `file-exists`, etc.
- `query_type`: `select`, `insert`, `update`, `delete`.

---

## Exposicion de metricas

### HTTP endpoint

Las metricas se exponen en:

```
http://localhost:9090/metrics
```

### Configuracion del puerto

El puerto se configura en `ecosystem.config.js`:

```javascript
env: {
  PROMETHEUS_PORT: 9090
}
```

### Scrape manual

Para inspeccionar metricas:

```bash
curl http://localhost:9090/metrics
```

Salida ejemplo:

```
# HELP orchestrator_active_flows Number of active flows
# TYPE orchestrator_active_flows gauge
orchestrator_active_flows 3

# HELP orchestrator_token_usage_total Total tokens consumed
# TYPE orchestrator_token_usage_total counter
orchestrator_token_usage_total{flow_id="deploy-v2.1.0"} 45230
orchestrator_token_usage_total{flow_id="code-review-pr123"} 12450
```

---

## Alertas obligatorias

### Configuracion de Prometheus

Crea un archivo `prometheus.yml` para scrape del orquestador:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'orchestrator'
    static_configs:
      - targets: ['localhost:9090']

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['localhost:9093']

rule_files:
  - 'alerts.yml'
```

### Reglas de alerta

Crea `alerts.yml` con las siguientes alertas obligatorias (referencia spec 7.10.10 + 3.6.7):

```yaml
groups:
  - name: orchestrator
    interval: 30s
    rules:

      # Dispatcher caido
      - alert: DispatcherDown
        expr: up{job="orchestrator"} == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Dispatcher is down"
          description: "The orchestrator dispatcher has been down for more than 2 minutes."

      # Restart loop
      - alert: DispatcherRestartLoop
        expr: rate(orchestrator_restarts_total[10m]) > 0.3
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Dispatcher restarting frequently"
          description: "Dispatcher has restarted more than 3 times in 10 minutes."

      # Waiters bloqueados
      - alert: WaitersStuck
        expr: orchestrator_pending_waiters > 10
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "Too many pending waiters"
          description: "More than 10 waiters have been pending for over 30 minutes."

      # Budget de tokens agotado
      - alert: TokenBudgetExhausted
        expr: orchestrator_token_budget_remaining{task_id=~".+"} < 1000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Token budget nearly exhausted"
          description: "Task {{ $labels.task_id }} has less than 1000 tokens remaining."

      # Circuit breaker abierto
      - alert: CircuitBreakerOpen
        expr: orchestrator_circuit_breaker_state == 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Circuit breaker is open"
          description: "Claude API circuit breaker has been open for 5 minutes. Tasks are being rejected."

      # SQLite lock contention
      - alert: SQLiteLockContention
        expr: rate(orchestrator_db_query_duration_seconds{query_type="insert"}[5m]) > 1.0
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "SQLite lock contention detected"
          description: "Insert queries are taking more than 1 second on average. Check SQLITE_BUSY errors."

      # Flows estancados
      - alert: FlowsStagnant
        expr: orchestrator_active_flows > 5 and rate(orchestrator_task_execution_total[30m]) == 0
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "Active flows not progressing"
          description: "There are active flows but no tasks have been executed in 30 minutes."
```

### Alertmanager

Configura Alertmanager para enviar alertas via email/Slack:

```yaml
# alertmanager.yml
global:
  smtp_smarthost: 'smtp.gmail.com:587'
  smtp_from: 'orchestrator@example.com'
  smtp_auth_username: 'orchestrator@example.com'
  smtp_auth_password: '<password>'

route:
  receiver: 'team-email'
  group_by: ['alertname']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

receivers:
  - name: 'team-email'
    email_configs:
      - to: 'angel.oliver@kunfupay.com'
```

---

## Dashboard de costos Claude

### Metricas de costo

Para calcular costos de tokens Claude (referencia spec 3.2.6):

```
Total tokens = orchestrator_token_usage_total
Costo estimado = Total tokens * precio_por_token
```

Precios actuales (2026):

- **Input tokens**: $15 / 1M tokens
- **Output tokens**: $75 / 1M tokens

### Query PromQL

```promql
# Costo total por flow (asumiendo 50/50 input/output)
sum by (flow_id) (
  orchestrator_token_usage_total * (15 * 0.5 + 75 * 0.5) / 1000000
)
```

### Dashboard manual

Script para generar reporte de costos:

```bash
#!/bin/bash
# scripts/cost-report.sh

curl -s http://localhost:9090/metrics | \
  grep orchestrator_token_usage_total | \
  awk '{
    split($0, a, "{");
    split(a[2], b, "}");
    label = b[1];
    value = $2;
    cost = value * 45 / 1000000;  # promedio 50/50 input/output
    printf "%s: %d tokens = $%.2f\n", label, value, cost;
  }'
```

Salida ejemplo:

```
flow_id="deploy-v2.1.0": 45230 tokens = $2.03
flow_id="code-review-pr123": 12450 tokens = $0.56
Total: $2.59
```

Agrega a cron semanal:

```cron
0 9 * * 1 /home/angel/projects/autonomous-orchestrator/scripts/cost-report.sh | mail -s "Weekly Claude cost report" angel.oliver@kunfupay.com
```

---

## Grafana (opcional)

Para visualizacion mas avanzada, integra Grafana con Prometheus.

### Instalacion

```bash
# Docker
docker run -d -p 3000:3000 grafana/grafana
```

### Datasource

1. Abrir Grafana en `http://localhost:3000` (user: `admin`, pass: `admin`).
2. Agregar datasource Prometheus: `http://localhost:9090`.

### Dashboard sugerido

Importa dashboard pre-configurado (ID: TODO(dante): crear dashboard publico en grafana.com).

O crea paneles custom:

- **Active flows** (Gauge): `orchestrator_active_flows`
- **Task execution rate** (Graph): `rate(orchestrator_task_execution_total[5m])`
- **Token usage by flow** (Bar chart): `sum by (flow_id) (orchestrator_token_usage_total)`
- **P95 task duration** (Heatmap): `histogram_quantile(0.95, orchestrator_task_execution_seconds_bucket)`

---

**Fin de MONITORING.md**. Para configuracion avanzada de alertas, contacta a Dante (DevOps).
