# Flujogramas del Orquestador Autonomo

## 1. Flujo principal end-to-end

```mermaid
flowchart TD
    A[Ticket entra al sistema] --> B[Camila refina historia]
    B --> C{Criterios claros?}
    C -- No --> Z1[Devolver al operador con preguntas]
    C -- Si --> D[Lucas diseña wireframe + tokens]
    D --> E[Roman emite ADR + tareas]
    E --> F{Cambio arquitectonico?}
    F -- Si --> G[Gate humano obligatorio]
    F -- No --> H[Continuar]
    G -- Aprobado --> H
    G -- Rechazado --> B
    H --> I1[Valeria implementa Frontend]
    H --> I2[Mateo implementa Backend]
    I1 --> J[Sofia ejecuta QA]
    I2 --> J
    J --> K{Cobertura >= 80% y sin regresion?}
    K -- No --> L[Devolver a Valeria/Mateo con bugs]
    L --> I1
    L --> I2
    K -- Si --> M[Dante deploya a staging]
    M --> N[Generar reporte de auditoria]
    N --> O{Promover a produccion?}
    O -- Si --> P[Gate humano obligatorio]
    P -- Aprobado --> Q[Deploy a produccion]
    P -- Rechazado --> R[Quedarse en staging]
    O -- No --> R
    Q --> S[Pipeline completada]
    R --> S
```

## 2. Flujo de manejo de fallas

```mermaid
flowchart TD
    A[Ejecucion de etapa falla] --> B{Tipo de error?}
    B -- Transitorio --> C[Retry con backoff exponencial]
    C --> D{Intentos < 3?}
    D -- Si --> E[Reintentar]
    D -- No --> F[Dead-letter queue]
    B -- Permanente --> F
    F --> G[Notificar al operador]
    G --> H{Operador interviene?}
    H -- Manual fix --> I[Resume desde etapa fallida]
    H -- Rollback --> J[Compensar etapas N-1]
    H -- Abortar --> K[Cerrar pipeline como failed]
```

## 3. Flujo de gates

```mermaid
flowchart TD
    A[Etapa solicita gate] --> B{Tipo de gate?}
    B -- Cobertura QA --> C[Validacion automatica]
    C -- Aprobado --> X[Continuar]
    C -- Rechazado --> Y[Bloquear]
    B -- Arquitectura --> D[Encolar para humano]
    B -- Deploy prod --> D
    B -- Hotfix critico --> D
    D --> E[Notificar al operador]
    E --> F{Decision del operador?}
    F -- Aprobado --> X
    F -- Rechazado --> Y
    F -- Timeout 24h --> G[Escalar + pausar pipeline]
```

## 4. Flujo de presupuesto de tokens

```mermaid
flowchart TD
    A[Agente va a ejecutar] --> B[Circuit breaker verifica budget]
    B --> C{Tokens restantes >= esperado?}
    C -- Si --> D[Ejecutar]
    C -- No --> E[Pausar pipeline]
    D --> F[Registrar tokens reales usados]
    F --> G{Budget diario excedido?}
    G -- Si --> H[Notificar + congelar pipelines]
    G -- No --> I[Continuar]
    E --> J[Notificar al operador]
    J --> K{Operador aprueba aumento?}
    K -- Si --> D
    K -- No --> L[Cerrar pipeline con causa: budget]
```

## 5. Arquitectura de componentes

```mermaid
flowchart LR
    OP[Operador humano] -- CLI / Dashboard --> ORCH[Orquestador]
    ORCH -- REST + SSE --> DASH[Dashboard Next.js]
    ORCH -- Workflow --> N8N[n8n]
    N8N -- Execute Command --> CC[Claude Code SDK]
    CC -- Invoca --> AG[Agentes Claude]
    AG -- Escribe artefactos --> FS[.claude/memory]
    AG -- Persiste tasks --> MONGO[MongoDB]
    ORCH -- Locks/queues --> REDIS[Redis]
    ORCH -- Logs --> LOKI[Loki]
    ORCH -- Metricas --> PROM[Prometheus]
    LOKI --> GRAF[Grafana]
    PROM --> GRAF
    GRAF -- Alertas --> OP
```

## 6. Ciclo de vida de una task

```mermaid
stateDiagram-v2
    [*] --> queued
    queued --> running: scheduler asigna
    running --> blocked: gate pendiente
    blocked --> running: gate aprobado
    blocked --> failed: gate rechazado
    running --> done: handoff exitoso
    running --> failed: retries agotados
    failed --> queued: operador hace retry
    done --> [*]
    failed --> [*]
```
