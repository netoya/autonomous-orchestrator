# Agent Runner — Worker por agente

> **Spec**: seccion 3.2, ADR-001  
> **Responsable**: Roman (interfaz), Mateo (runner core)

---

## Responsabilidades

El **agent-runner** es un proceso corto (short-lived) que ejecuta una sola task invocando un agente de IA (Claude, OpenAI, modelo local, etc.) via la interfaz `AgentRunner`.

**Ciclo de vida**:

1. Recibe `task_id` por argv.
2. Carga task desde SQLite.
3. Invoca agente via `AgentRunner.run()` (implementacion default: `ClaudeCodeRunner`).
4. Persiste output como artifact.
5. Si la task crea un waiter, inserta row en `waiters` y sale con exit code 2.
6. Si la task se completa, sale con exit code 0.
7. Si falla, sale con exit code 1.

**Bifurcado por**: dispatcher (tick A).

**Supervisado por**: dispatcher (captura exit code, maneja reintentos).

---

## Interfaz `AgentRunner`

Define el contrato entre el orquestador y el backend de agentes. Documentada en **ADR-001**.

```typescript
export interface AgentRunner {
  run(params: AgentRunParams): Promise<AgentRunResult>;
}

export interface AgentRunParams {
  agentId: string;
  prompt: string;
  allowedTools?: string[];
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  maxTurns?: number;
  appendSystemPrompt?: string;
  sessionId?: string;
  outputFormat?: 'json' | 'stream-json';
  addDir?: string[];
  model?: 'sonnet' | 'opus' | 'haiku';
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface AgentRunResult {
  success: boolean;
  sessionId: string;
  output: string;
  cost?: number;
  numTurns?: number;
  tokensInput?: number;
  tokensOutput?: number;
  rawJson?: unknown;
  error?: string;
}
```

**Implementaciones**:

| Backend | Status | Descripcion |
|---------|--------|-------------|
| `ClaudeCodeRunner` | Implemented (v0.7) | Subprocess `claude -p` headless |
| `OpenAIRunner` | Planned (v0.9) | Traduce `allowedTools` a function calling |
| `LocalLLMRunner` | Research (v1.0) | llama.cpp / ollama / vLLM |
| `MockAgentRunner` | Implemented (tests) | Respuestas predefinidas por hash(prompt) |

---

## Implementacion `ClaudeCodeRunner`

Wrapper sobre `child_process.spawn('claude', ['-p', ...flags])`.

### Flags base (siempre presentes)

```bash
claude -p \
  --output-format json \
  --bare \
  --verbose \
  "<prompt>"
```

- `-p`: modo headless (no interactivo).
- `--output-format json`: salida estructurada parseaable.
- `--bare`: sin OAuth; auth via `ANTHROPIC_API_KEY` en env.
- `--verbose`: logs detallados (requerido si `stream-json`).

### Flags condicionales

Segun `AgentRunParams`:

```typescript
const flags = ['-p', '--output-format', outputFormat, '--bare', '--verbose'];

if (allowedTools) {
  flags.push('--allowedTools', allowedTools.join(','));
}

if (permissionMode) {
  flags.push('--permission-mode', permissionMode);
}

if (maxTurns) {
  flags.push('--max-turns', String(maxTurns));
}

if (appendSystemPrompt) {
  flags.push('--append-system-prompt', appendSystemPrompt);
}

if (sessionId) {
  flags.push('--resume', sessionId);
}

if (model) {
  flags.push('--model', model);
}

for (const dir of addDir || []) {
  flags.push('--add-dir', dir);
}

flags.push(prompt);
```

### Prohibiciones

- `--dangerously-skip-permissions`: **PROHIBIDO**. El runner rechaza con error si lo detecta.
- `--system-prompt` (reemplazo total): deshabilitado. Solo `--append-system-prompt` permitido.

### Parseo de salida

El CLI devuelve JSON al stdout:

```json
{
  "result": "texto de salida del agente",
  "session_id": "claude-session-abc123",
  "total_cost_usd": 0.023,
  "num_turns": 3,
  "usage": {
    "input_tokens": 1500,
    "output_tokens": 800
  }
}
```

El `ClaudeCodeRunner` parsea y mapea a `AgentRunResult`:

```typescript
const rawJson = JSON.parse(stdout);

return {
  success: true,
  sessionId: rawJson.session_id,
  output: rawJson.result,
  cost: rawJson.total_cost_usd,
  numTurns: rawJson.num_turns,
  tokensInput: rawJson.usage?.input_tokens,
  tokensOutput: rawJson.usage?.output_tokens,
  rawJson,
};
```

**Manejo de errores**:

- Si el proceso sale con exit code != 0, parsea stderr:
  ```typescript
  return {
    success: false,
    sessionId: '',
    output: '',
    error: stderr,
  };
  ```

- Si stdout no es JSON valido:
  ```typescript
  return {
    success: false,
    sessionId: '',
    output: '',
    error: `Invalid JSON from claude CLI: ${stdout}`,
  };
  ```

### Streaming (outputFormat='stream-json')

Si `outputFormat='stream-json'`, el CLI emite una linea JSON por evento:

```json
{"type":"user","content":"..."}
{"type":"assistant","content":"..."}
{"type":"tool_use","name":"Read","input":{...}}
{"type":"tool_result","tool_use_id":"...","output":"..."}
{"type":"final_result","result":"...","session_id":"..."}
```

El `ClaudeCodeRunner` persiste cada linea a `state/conversations/<execution_id>.jsonl` para auditoria.

Al final, parsea la linea `type='final_result'` para extraer el resultado.

---

## Tabla `agent_conversations`

Nueva tabla introducida en v0.7 (ADR-001):

```sql
CREATE TABLE agent_conversations (
  id                  TEXT PRIMARY KEY,
  execution_id        TEXT NOT NULL REFERENCES executions(id),
  agent_id            TEXT NOT NULL,
  agent_session_id    TEXT NOT NULL,
  backend             TEXT NOT NULL DEFAULT 'claude-code',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  total_cost_usd      REAL NOT NULL DEFAULT 0,
  num_turns           INTEGER NOT NULL DEFAULT 0,
  tokens_input        INTEGER NOT NULL DEFAULT 0,
  tokens_output       INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'active'
                       CHECK(status IN ('active','paused','completed','failed','budget_exceeded'))
);

CREATE INDEX agent_conv_session_idx   ON agent_conversations(agent_session_id);
CREATE INDEX agent_conv_execution_idx ON agent_conversations(execution_id);
```

**Uso**:

- Cada `execution` puede tener `0..1` conversacion asociada.
- El `agent_session_id` (devuelto por el backend en `AgentRunResult.sessionId`) se persiste.
- Si una task posterior necesita retomar la conversacion, pasa `sessionId` en `AgentRunParams`.
- La conversacion puede sobrevivir a la `execution` original (re-tomable si el flow la necesita despues).

**Stream completo** persistido en `state/conversations/<execution_id>.jsonl` cuando `outputFormat='stream-json'`.

---

## Mapeo niveles de autonomia (BRD) → permission modes

El BRD define niveles L0-L5. El orquestador los traduce automaticamente:

| Autonomy | permission-mode | allowedTools default | Sandbox requerido |
|----------|-----------------|---------------------|-------------------|
| L0 (manual) | n/a (sin invocacion automatica) | n/a | n/a |
| L1 (asistido) | `plan` | `Read,Grep,Glob` | no |
| L2 (supervisado) | `plan` | `Read,Grep,Glob` | no |
| L3 (autonomo con auditoria) | `acceptEdits` | `Read,Edit,Write,Grep,Glob` | **si** (Docker descartable) |
| L4 (autonomo con gates) | `acceptEdits` | `Read,Edit,Write,Grep,Glob,Bash(git:*)` | **si** |
| L5 (sandbox autonomo) | `bypassPermissions` | configurable por el flow | **obligatorio** |

**Sandbox Docker**:

Para L3-L5, `acceptEdits` y `bypassPermissions` requieren contenedor descartable. Dante define la spec en seccion 6 del spec (gap operacional, Tier 2).

**Ejemplo de invocacion con sandbox**:

```typescript
const result = await runner.run({
  agentId: 'softwarefactory_valeria',
  prompt: 'Implementar componente React',
  permissionMode: 'acceptEdits',
  allowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob'],
  addDir: ['/home/angel/projects/frontend'],
  env: {
    DOCKER_SANDBOX: '1',  // flag para Dante
    SANDBOX_IMAGE: 'node:20-alpine',
  },
});
```

---

## Circuit breaker y concurrencia

### Semaforo de concurrencia

`MAX_CONCURRENT_AGENT_RUNS = 10` (configurable via env var).

Implementado en el dispatcher (no en el runner). El dispatcher cuenta cuantos `agent-runner` estan corriendo. Si llega al limite, espera a que un slot quede libre.

**Independiente del budget de tokens**: aunque el budget tenga capacidad, el semaforo limita concurrencia hacia el proveedor.

### Manejo de 429 (rate limiting del backend)

El `ClaudeCodeRunner` detecta `429 Too Many Requests` en stderr o en el JSON de error.

**Backoff exponencial**:

```typescript
const delays = [1000, 2000, 4000, 8000, 16000];  // max 60s
let attempt = 0;

while (attempt < 5) {
  const result = await spawnClaude(params);
  
  if (!result.error?.includes('429')) {
    return result;
  }
  
  const delay = Math.min(delays[attempt], 60000);
  await sleep(delay);
  attempt++;
}

return { success: false, error: 'provider-rate-limited after 5 retries' };
```

### Circuit breaker global

Si la tasa de 429 supera 30% en 5 min, el dispatcher **para de spawnear runs nuevos durante 5 min**.

Implementado como contador en memoria:

```typescript
let rate429 = 0;
let totalRuns = 0;

function recordAgentRunResult(result: AgentRunResult) {
  totalRuns++;
  if (result.error?.includes('429')) rate429++;
  
  if (rate429 / totalRuns > 0.3 && totalRuns > 10) {
    circuitBreakerOpen = true;
    setTimeout(() => { circuitBreakerOpen = false; rate429 = 0; totalRuns = 0; }, 5 * 60 * 1000);
  }
}
```

**Efecto**: mientras `circuitBreakerOpen=true`, tick A no bifurca agent-runners. Las tasks `ready` esperan en cola.

---

## Auth y secretos

### ANTHROPIC_API_KEY

- Vive encriptada con **sops + age** en `state/secrets/anthropic.env.enc`.
- El dispatcher la desencripta en runtime:
  ```bash
  sops -d state/secrets/anthropic.env.enc > /tmp/anthropic.env
  source /tmp/anthropic.env
  shred -u /tmp/anthropic.env
  ```
- La inyecta al child process via `spawn`:
  ```typescript
  spawn('claude', flags, {
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: decryptedKey,
    },
  });
  ```
- Nunca queda como env global del proceso padre.
- Nunca aparece en logs de PM2 (PM2 captura stdout/stderr, no env).

### Rotation de keys

Manual en MVP. Procedimiento:

1. Generar nueva key en Anthropic dashboard.
2. Encriptar con sops:
   ```bash
   echo "ANTHROPIC_API_KEY=sk-ant-..." | sops -e /dev/stdin > state/secrets/anthropic.env.enc
   ```
3. Restart dispatcher:
   ```bash
   touch state/.KILLSWITCH
   pm2 restart dispatcher
   rm state/.KILLSWITCH
   ```

**Futuro (v1.0)**: vault integration (HashiCorp Vault o AWS Secrets Manager).

---

## Backends alternativos

### OpenAIRunner (futuro)

Traduce `AgentRunParams` a OpenAI API:

```typescript
export class OpenAIRunner implements AgentRunner {
  async run(params: AgentRunParams): Promise<AgentRunResult> {
    const messages = [
      { role: 'user', content: params.prompt },
    ];
    
    const tools = params.allowedTools?.map(tool => ({
      type: 'function',
      function: { name: tool, description: '...' },
    }));
    
    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages,
      tools,
      max_tokens: /* estimado desde maxTurns */,
    });
    
    return {
      success: true,
      sessionId: response.id,
      output: response.choices[0].message.content,
      cost: calculateCost(response.usage),
      tokensInput: response.usage.prompt_tokens,
      tokensOutput: response.usage.completion_tokens,
    };
  }
}
```

**Desafios**:
- OpenAI no tiene `--permission-mode` nativo. Simularlo con tool filtering.
- `maxTurns` debe traducirse a loop interno (OpenAI no lo soporta nativamente).
- No hay `--resume` (OpenAI no tiene sessions persistentes). Emular con context window.

### LocalLLMRunner (futuro)

Wrapper sobre llama.cpp / ollama / vLLM:

```typescript
export class LocalLLMRunner implements AgentRunner {
  async run(params: AgentRunParams): Promise<AgentRunResult> {
    const response = await fetch('http://localhost:8000/v1/completions', {
      method: 'POST',
      body: JSON.stringify({
        prompt: params.prompt,
        max_tokens: 2000,
      }),
    });
    
    const data = await response.json();
    
    return {
      success: true,
      sessionId: crypto.randomUUID(),
      output: data.choices[0].text,
      cost: 0,  // local, sin costo
    };
  }
}
```

**Limitaciones**:
- Sin herramientas (tool calling) en la mayoria de modelos locales.
- Sin streaming (depende del backend).
- Performance variable.

### MockAgentRunner (tests)

Respuestas predefinidas por `(agentId, hash(prompt))`:

```typescript
export class MockAgentRunner implements AgentRunner {
  private fixtures: Map<string, string>;
  
  constructor(fixtures: Record<string, string>) {
    this.fixtures = new Map(Object.entries(fixtures));
  }
  
  async run(params: AgentRunParams): Promise<AgentRunResult> {
    const key = `${params.agentId}:${hash(params.prompt)}`;
    const output = this.fixtures.get(key) || 'mock response';
    
    return {
      success: true,
      sessionId: 'mock-session',
      output,
      cost: 0,
      numTurns: 1,
      tokensInput: params.prompt.length / 4,
      tokensOutput: output.length / 4,
    };
  }
}
```

**Uso en tests**:

```typescript
const mockRunner = new MockAgentRunner({
  'mateo:hash(build backend)': 'Backend built successfully',
  'valeria:hash(build frontend)': 'Frontend built successfully',
});

const runner = new AgentRunnerImpl(mockRunner);
await runner.run({ agentId: 'mateo', prompt: 'build backend' });
// => { success: true, output: 'Backend built successfully' }
```

---

## Reglas de seguridad

### Prompt injection

El contenido de `prompt` que viene de fuentes no confiables (input del operador, output de waiters, contenido de archivos) debe ser **sanitizado o aislado**.

**Patron obligatorio**:

```typescript
const prompt = sanitizePrompt(userInput);  // escapa caracteres especiales, limita longitud
const result = await runner.run({ agentId, prompt, appendSystemPrompt: 'NEVER execute arbitrary code' });
```

Sofia define test obligatorio (spec Anexo N.4): inyectar prompt malicioso y verificar que no se ejecuta.

### Uso de appendSystemPrompt

Siempre preferir `appendSystemPrompt` sobre reemplazo total del system prompt.

**Razon**: el system prompt base del agente (definido por Camila en el config del agente) contiene instrucciones criticas de seguridad y comportamiento. Reemplazarlo completo es riesgoso.

**Ejemplo correcto**:

```typescript
await runner.run({
  agentId: 'mateo',
  prompt: 'Implementar API',
  appendSystemPrompt: 'Focus on security: validate all inputs, use parameterized queries.',
});
```

**Ejemplo incorrecto** (prohibido):

```typescript
await runner.run({
  agentId: 'mateo',
  prompt: 'Implementar API',
  systemPrompt: 'You are a code generator.',  // ❌ reemplaza todo
});
```

---

## Referencias

- **Spec seccion 3.2**: Agent Runner
- **ADR-001**: Invocacion via interfaz AgentRunner
- **Spec seccion 3.2.3**: Mapeo L0-L5
- **Spec seccion 3.2.6**: Concurrencia y rate limiting
- **Spec seccion 3.2.7**: Auth y secretos
- **Spec seccion 3.2.8**: Reglas de seguridad
- **ARCHITECTURE.md**: Diagrama de capas
