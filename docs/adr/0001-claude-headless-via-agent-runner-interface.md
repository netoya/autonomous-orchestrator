# ADR-001: Invocacion de agentes via interfaz `AgentRunner` con `ClaudeCodeRunner` headless

| | |
|---|---|
| **Status** | Accepted |
| **Fecha** | 2026-05-16 |
| **Version spec** | v0.7 |
| **Autores** | Roman (Tech Lead), equipo SoftwareFactory |
| **Supersedes** | BRD seccion 4.3 (propuesta SDK Claude anthropic-sdk-typescript) |

---

## Contexto

El orquestador necesita invocar agentes de IA (Claude, OpenAI, modelos locales) para ejecutar tareas. La decision arquitectonica sobre **como** se invoca al agente impacta:

1. **Testabilidad**: necesitamos poder mockear al agente en CI sin consumir tokens.
2. **Vendor lock-in**: si acoplamos directamente con la API de Anthropic, cambiar de proveedor requiere refactor masivo.
3. **Costo operacional**: cada invocacion consume tokens; necesitamos control de concurrencia y circuit breaker.
4. **Seguridad**: inyectar prompts desde fuentes no confiables (input del operador, output de waiters) es riesgoso.
5. **Coherencia con principios**: el spec establece "procesos cortos" y "local-first".

### Opciones evaluadas

| Opcion | Pros | Contras |
|--------|------|---------|
| **A: SDK anthropic-sdk-typescript** | Official, soporte completo, streaming, function calling | Acopla con Anthropic, no permite swapear backend facilmente, requiere manejo custom de permisos |
| **B: API HTTP directa** | Control total, sin deps | Reinventa todo, no soporta herramientas custom, no hay CLI oficial |
| **C: CLI `claude` headless via subprocess** | Reutiliza CLI oficial, soporta permisos nativos, sandbox gratis, swappable via interfaz | Dependencia del CLI instalado, costo per invocacion identico, stdout parsing |
| **D: OpenAI SDK + function calling** | Alternativa si queremos otro proveedor | No es Claude, necesita traduccion de herramientas |

### Principios aplicables del spec

- **Principio 1 (Local-first)**: preferir herramientas que no requieran infra remota adicional.
- **Principio 3 (Procesos cortos)**: cada script hace una cosa y muere.
- **ADR-002 (Script-first)**: preferir scripts + CLI sobre librerias custom.

---

## Decision

**Adoptamos opcion C: interfaz `AgentRunner` con implementacion default `ClaudeCodeRunner` sobre `claude -p` headless.**

### Interfaz `AgentRunner`

Define un contrato abstracto entre el orquestador y el backend de agentes:

```typescript
export interface AgentRunner {
  run(params: AgentRunParams): Promise<AgentRunResult>;
}

export interface AgentRunParams {
  agentId: string;                      // ej: 'softwarefactory_mateo'
  prompt: string;
  allowedTools?: string[];              // whitelist de herramientas
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  maxTurns?: number;                    // default 5
  appendSystemPrompt?: string;          // se SUMA al system prompt
  sessionId?: string;                   // si esta, retoma con --resume
  outputFormat?: 'json' | 'stream-json';
  addDir?: string[];
  model?: 'sonnet' | 'opus' | 'haiku';
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;                   // default 600_000 (10 min)
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

### Implementacion `ClaudeCodeRunner`

Wrapper sobre `child_process.spawn('claude', ['-p', ...flags])`. Ejecuta el CLI en modo headless:

**Flags base (siempre presentes)**:
- `-p` (modo headless)
- `--output-format json` (o `stream-json`)
- `--bare` (sin OAuth; auth via `ANTHROPIC_API_KEY` inyectado al child)
- `--verbose` (requerido si `stream-json`)

**Flags condicionales**:
- `--allowedTools "<csv>"`
- `--permission-mode <mode>`
- `--max-turns <N>`
- `--append-system-prompt "<texto>"`
- `--resume <sessionId>`
- `--add-dir <path>` (uno por cada item de `addDir`)
- `--model <sonnet|opus|haiku>`

**Prohibiciones**:
- `--dangerously-skip-permissions` esta **PROHIBIDO**. El orquestador rechaza con error cualquier invocacion que intente usarlo.
- `--system-prompt` (reemplazo total) esta deshabilitado; solo `--append-system-prompt` permitido.

**Parseo de salida**:
El CLI devuelve JSON con estructura:
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

El `ClaudeCodeRunner` mapea esto a `AgentRunResult`.

**Persistencia de conversaciones**:
- Cada ejecucion inserta una fila en `agent_conversations` con el `session_id`.
- Si `outputFormat='stream-json'`, ademas se persiste cada linea a `state/conversations/<execution_id>.jsonl`.
- Permite debugging y auditoria completa.

---

## Consecuencias

### Positivas

1. **Testabilidad**: podemos implementar `MockAgentRunner` para tests sin consumir tokens. El mock devuelve respuestas predefinidas segun `(agentId, hash(prompt))`.

2. **Swappable backend**: si en el futuro queremos usar OpenAI, implementamos `OpenAIRunner` que traduce `allowedTools` a function calling y `maxTurns` a loop interno. El motor solo conoce la interfaz.

3. **Sandbox gratis**: el CLI `claude` maneja sandboxing (Docker) de forma nativa cuando se usa `bypassPermissions`. No tenemos que reinventarlo.

4. **Permisos nativos**: los niveles L0-L5 se mapean directamente a `--permission-mode`. No necesitamos reimplementar whitelist de herramientas.

5. **Circuit breaker independiente**: podemos limitar concurrencia (`MAX_CONCURRENT_AGENT_RUNS=10`) sin afectar el budget de tokens. Son dos controles ortogonales.

6. **Coherencia con principio 3**: cada invocacion es un proceso corto (`agent-runner`) que bifurca otro proceso corto (`claude -p`) y muere.

### Negativas

1. **Dependencia del CLI Claude**: requiere `claude` instalado en el host. Si Anthropic depreca el CLI, tenemos que migrar. Mitigacion: la interfaz `AgentRunner` nos permite swapear a SDK o API directa sin tocar el motor.

2. **Costo per invocacion identico**: usar CLI vs SDK no reduce costos de API. Solo cambia la ergonomia. El costo sigue siendo `$input_tokens + $output_tokens`.

3. **Stdout parsing fragil**: dependemos del formato JSON del CLI. Si cambia, nuestro parseo se rompe. Mitigacion: versionamos el CLI (`claude --version`) y validamos compatibilidad al startup.

4. **Prompt injection a vigilar**: el contenido de `prompt` que viene de fuentes no confiables (input del operador, output de waiters, contenido de archivos) debe ser **sanitizado o aislado** antes de pasarse. Sofia define test obligatorio (ver Anexo N.4 del spec). El `appendSystemPrompt` siempre se usa preferiblemente sobre reemplazo total.

5. **Latencia de subprocess spawn**: `child_process.spawn` tiene overhead (~50-100ms en Linux). Aceptable para el MVP (tasks de minutos), inaceptable si queremos latencias <1s. Para esos casos futuros, evaluaremos SDK directo.

---

## Mapeo niveles de autonomia (BRD) → permission modes

El BRD define niveles L0-L5. El orquestador los traduce:

| Autonomy | permission-mode | allowedTools default | Sandbox requerido |
|----------|-----------------|---------------------|-------------------|
| L0 (manual) | n/a (sin invocacion automatica) | n/a | n/a |
| L1 (asistido) | `plan` | `Read,Grep,Glob` | no |
| L2 (supervisado) | `plan` | `Read,Grep,Glob` | no |
| L3 (autonomo con auditoria) | `acceptEdits` | `Read,Edit,Write,Grep,Glob` | **si** (Docker descartable) |
| L4 (autonomo con gates) | `acceptEdits` | `Read,Edit,Write,Grep,Glob,Bash(git:*)` | **si** |
| L5 (sandbox autonomo) | `bypassPermissions` | configurable por el flow | **obligatorio** |

Para L3-L5, el sandbox Docker descartable es responsabilidad de Dante (gap operacional, Tier 2).

---

## Referencias

- **Spec seccion 3.2**: Agent Runner
- **Spec seccion 3.2.1**: Interfaz `AgentRunner`
- **Spec seccion 3.2.2**: Implementacion `ClaudeCodeRunner`
- **Spec seccion 3.2.3**: Mapeo L0-L5
- **Spec Anexo N**: Wrapper Bash + tests obligatorios
- **BRD seccion 4.3**: Propuesta original (SDK TS)
- **ADR-002**: Script-first (sin n8n)

---

## Futuras implementaciones

| Backend | Interfaz | Traduccion necesaria | Status |
|---------|----------|----------------------|--------|
| `ClaudeCodeRunner` | `AgentRunner` | ninguna (nativa) | **Implemented (v0.7)** |
| `OpenAIRunner` | `AgentRunner` | `allowedTools` → function calling, `maxTurns` → loop | Planned (v0.9) |
| `LocalLLMRunner` | `AgentRunner` | herramientas custom, sin streaming | Research (v1.0) |
| `MockAgentRunner` | `AgentRunner` | hash(prompt) → fixture JSON | Implemented (tests) |

---

## Notas de implementacion

### Concurrencia y rate limiting

- `MAX_CONCURRENT_AGENT_RUNS = 10` (semaforo en dispatcher).
- Manejo de `429` del backend: backoff exponencial (1s, 2s, 4s, 8s, max 60s), max 5 reintentos.
- Circuit breaker: si tasa de 429 supera 30% en 5 min, dispatcher para de spawnear runs nuevos durante 5 min.

### Auth y secretos

- Auth via `--bare` + `ANTHROPIC_API_KEY`.
- La key vive encriptada con **sops + age** en `state/secrets/anthropic.env.enc`.
- El dispatcher la desencripta en runtime y la inyecta al child process via `spawn({ env: { ...process.env, ANTHROPIC_API_KEY: key } })`.
- Nunca queda como env global del proceso padre.
- Nunca aparece en logs de PM2.

### Tabla `agent_conversations`

Nueva tabla introducida en v0.7:

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
);
```

Cada `execution` puede tener `0..1` conversacion asociada. El `agent_session_id` se usa para `--resume` en turnos siguientes.

---

## Nota de implementacion — OAuth heredado (2026-05-16)

Durante la implementacion del MVP esqueleto, Angel decidio NO usar `--bare` + `ANTHROPIC_API_KEY` como propone la spec 3.2.2, sino heredar la autenticacion OAuth del keychain del usuario via `claude -p` sin flags adicionales.

**Razon**: el equipo ya tiene Claude autenticado via OAuth en sus maquinas. Usar `--bare` + API key forzaria gestionar secretos adicionales con sops + age, lo cual agrega complejidad operacional innecesaria para el MVP.

**Implementacion**: `ClaudeCodeRunner` invoca `claude -p <prompt> --output-format json --permission-mode <mode> ...` SIN `--bare`. Hereda la sesion autenticada del usuario.

**Trade-offs**:
- Pro: sin gestion de secretos en MVP, arranque mas rapido.
- Contra: cada desarrollador debe tener su propia suscripcion Claude activa. No portable a CI/CD sin ajustes.

**Path forward**: cuando se necesite CI/CD o deploy multi-usuario, se agregara soporte para `ANTHROPIC_API_KEY` como fallback. La interfaz `AgentRunner` sigue siendo la misma.

---

**Firmado**: Roman (Tech Lead), 2026-05-16  
**Revision**: Equipo completo (acta 2026-05-16-agentrunner-interface-claude-headless.md)
