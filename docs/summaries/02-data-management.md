# Resumen: Manejo de Datos del Orquestador Autonomo

## Stack de persistencia

- **MongoDB**: entidades principales (Pipeline, Task, Execution, Gate, Artifact).
- **Redis**: locks distribuidos, colas de trabajo, rate limit de tokens.
- **Filesystem** (`.claude/memory/`): artefactos crudos (PRDs, ADRs, mockups, diffs).
- **Git**: snapshot de cada estado promovido a fase superior.
- **SQLite** (POC inicial, opcional): para arrancar sin infra.

## Esquema de entidades

### Pipeline
```json
{
  "_id": "ULID",
  "name": "feature-login-oauth",
  "version": "1.0.0",
  "stages": ["intake","design","architecture","build","qa","deploy"],
  "autonomyLevel": "L3",
  "tokenBudget": { "daily": 500000, "spent": 0 },
  "createdAt": "ISO",
  "status": "running|completed|failed|paused"
}
```

### Task
```json
{
  "_id": "ULID",
  "pipelineId": "ULID",
  "stage": "architecture",
  "assignedAgent": "softwarefactory_roman",
  "status": "queued|running|done|failed|blocked",
  "input": { "ticket": "..." },
  "output": { "artifactIds": ["..."] },
  "parentTaskId": "ULID|null",
  "retries": 0,
  "idempotencyKey": "sha256(input+context)",
  "createdAt": "ISO",
  "updatedAt": "ISO"
}
```

### Execution
```json
{
  "_id": "ULID",
  "taskId": "ULID",
  "agentId": "softwarefactory_roman",
  "startedAt": "ISO",
  "finishedAt": "ISO",
  "status": "success|failed|timeout",
  "tokensUsed": { "input": 0, "output": 0 },
  "logs": [{"ts":"...","level":"...","msg":"..."}],
  "artifactIds": ["..."]
}
```

### Gate
```json
{
  "_id": "ULID",
  "taskId": "ULID",
  "type": "architecture|prod-deploy|hotfix|coverage",
  "approver": "human|agent",
  "decision": "pending|approved|rejected",
  "comments": "...",
  "timestamp": "ISO"
}
```

### Artifact
```json
{
  "_id": "ULID",
  "executionId": "ULID",
  "type": "prd|adr|mockup|code|test-report|diff",
  "path": ".claude/memory/artifacts/...",
  "hash": "sha256",
  "metadata": { "size": 0, "mime": "..." }
}
```

## Politicas

- **Inmutabilidad** de artefactos: una vez escrito, no se reescribe; nuevas versiones generan nuevo artifact + ref al anterior.
- **Idempotencia**: tasks con misma `idempotencyKey` no se ejecutan dos veces; se devuelve el output anterior.
- **Retencion**: artefactos por 90 dias en hot storage; archivado en S3-compatible a partir de ahi.
- **PII**: el orquestador NO persiste datos personales de usuarios finales en logs.
- **Backups**: snapshot diario de Mongo + tar de `.claude/memory/`.
- **Encriptacion**: secretos via `sops` o systemd-creds; nunca en plain text.

## Auditoria

- Cada pipeline produce un **audit bundle**: zip con todos los artefactos, logs, decisiones de gate y metricas de tokens.
- Hash del bundle se firma con clave del operador y se commitea a un repo separado de auditoria.
- Reportes mensuales agregados: costo por feature, % autonomia real, top agentes generadores de bugs.
