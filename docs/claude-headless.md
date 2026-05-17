# Claude Code como Agente desde Bash

Guía práctica para usar Claude Code en modo **headless** (no-interactivo) desde scripts de bash, manteniendo conversaciones y ejecutando tareas como agente autónomo.

---

## Tabla de contenidos

1. [Conceptos básicos](#conceptos-básicos)
2. [Modo print (`-p`) y conversaciones](#modo-print--p-y-conversaciones)
3. [Formatos de salida](#formatos-de-salida)
4. [Ejecutar como agente](#ejecutar-como-agente)
5. [Control de permisos y herramientas](#control-de-permisos-y-herramientas)
6. [Scripts de ejemplo](#scripts-de-ejemplo)
7. [Buenas prácticas y advertencias](#buenas-prácticas-y-advertencias)
8. [Referencias oficiales](#referencias-oficiales)

---

## Conceptos básicos

Claude Code se puede ejecutar de dos maneras:

- **Modo interactivo (REPL):** `claude` → abre una sesión de chat en la terminal.
- **Modo headless / print:** `claude -p "tu prompt"` → ejecuta una sola consulta, imprime el resultado a `stdout` y sale.

El modo headless es lo que permite usarlo desde scripts, pipelines de CI/CD y como agente autónomo. Internamente usa el **Claude Agent SDK**, que provee el mismo loop de agente, herramientas y manejo de contexto que la versión interactiva.

> 📌 **Nota:** A partir del 15 de junio de 2026, el uso del Agent SDK y `claude -p` en planes de suscripción consume un crédito mensual separado de tu uso interactivo. Ver [documentación oficial sobre planes](https://docs.claude.com/en/docs/claude-code/headless).

---

## Modo print (`-p`) y conversaciones

### Consulta simple

```bash
claude -p "Explicá este código" 
```

### Procesar entrada por pipe

```bash
cat logs.txt | claude -p "Explicá este error"
```

### Mantener una conversación

Hay dos formas de continuar una conversación previa:

**Continuar la última conversación:**
```bash
claude -p "Empezá una revisión de código"
claude -p "Ahora enfocate en las consultas a la base de datos" --continue
claude -p "Generá un resumen de todos los problemas" --continue
```

**Retomar una sesión específica por ID:**
```bash
# Guardar el session_id en una variable
session_id=$(claude -p "Empezá una revisión" --output-format json | jq -r '.session_id')

# Retomar más tarde
claude -p "Continuá esa revisión" --resume "$session_id"
```

Esto es útil cuando manejás múltiples conversaciones en paralelo.

---

## Formatos de salida

El flag `--output-format` controla cómo Claude devuelve la respuesta:

| Formato          | Uso                                                           |
| ---------------- | ------------------------------------------------------------- |
| `text` (default) | Texto plano, ideal para lectura humana                        |
| `json`           | JSON estructurado con resultado, session_id, costo y metadata |
| `stream-json`    | Stream línea por línea (JSONL) para procesar en tiempo real   |

### Ejemplo con JSON

```bash
result=$(claude -p "Generá una función de ordenamiento" --output-format json)
code=$(echo "$result" | jq -r '.result')
cost=$(echo "$result" | jq -r '.total_cost_usd')
session=$(echo "$result" | jq -r '.session_id')

echo "Código generado (costo: \$$cost)"
echo "$code"
```

### Ejemplo con streaming

```bash
claude -p "Refactorizá src/auth.py" \
  --output-format stream-json \
  --verbose \
| jq -r 'select(.type=="assistant") | .message.content[] | select(.type=="text") | .text'
```

> ⚠️ `stream-json` requiere también el flag `--verbose`.

---

## Ejecutar como agente

Un **agente** es Claude Code ejecutándose autónomamente: lee archivos, ejecuta comandos bash, edita código y toma decisiones sin intervención humana en cada paso.

### Patrón básico

```bash
claude -p "Encontrá y arreglá el bug en auth.py" \
  --allowedTools "Read,Edit,Bash" \
  --permission-mode acceptEdits
```

### Modos de permisos (`--permission-mode`)

| Modo                | Comportamiento                                                                  |
| ------------------- | ------------------------------------------------------------------------------- |
| `default`           | Pide permiso para cada operación sensible                                       |
| `acceptEdits`       | Auto-acepta ediciones de archivos                                               |
| `plan`              | Modo planificación: Claude propone un plan antes de ejecutar                    |
| `bypassPermissions` | Salta todas las verificaciones (equivalente a `--dangerously-skip-permissions`) |

### Agente con system prompt personalizado

```bash
claude -p "Revisá este PR" \
  --append-system-prompt "Sos un reviewer senior. Enfocate en seguridad y performance." \
  --allowedTools "Read,Grep,Glob,Bash(git diff:*)" \
  --output-format json
```

> 💡 Preferí `--append-system-prompt` sobre `--system-prompt`: el append preserva las capacidades por defecto de Claude Code y suma tus instrucciones. El reemplazo completo puede romper comportamientos esperados.

### Stream JSON como input (multi-turno desde stdin)

Permite varios turnos sin relanzar el binario:

```bash
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Explicá este código"}]}}' \
  | claude -p \
    --output-format stream-json \
    --input-format stream-json \
    --verbose
```

---

## Control de permisos y herramientas

### Permitir herramientas específicas (`--allowedTools`)

Las herramientas listadas se aprueban sin prompt; cualquier otra requiere permiso o se rechaza (según el modo):

```bash
# Solo lectura
claude -p "Analizá este código" --allowedTools "Read,Grep,Glob"

# Lectura + edición controlada
claude -p "Arreglá los bugs" --allowedTools "Read,Write,Edit"

# Bash con patrones específicos
claude -p "Revisá el repo" \
  --allowedTools "Read" "Bash(git log:*)" "Bash(git diff:*)"
```

### Denegar herramientas específicas (`--disallowedTools`)

```bash
claude -p "Hacé un análisis" --disallowedTools "Write,Edit,Bash(rm:*)"
```

### Agente "bloqueado" (locked-down)

Para un agente con superficie de herramientas fija y rechazo silencioso de todo lo demás, combiná `allowedTools` con el modo `dontAsk` (en el SDK programático):

```javascript
// En el SDK de TypeScript/Python
const options = {
  allowedTools: ["Read", "Glob", "Grep"],
  permissionMode: "dontAsk"
};
```

### `--dangerously-skip-permissions`

Salta TODAS las verificaciones de permisos. **Solo usalo en entornos aislados** (contenedores, VMs, sandbox de CI).

```bash
claude -p "Setup completo del proyecto" --dangerously-skip-permissions
```

---

## Scripts de ejemplo

### 1. Chat conversacional simple

```bash
#!/bin/bash
# chat.sh - Chat interactivo con persistencia de sesión

echo "Chat con Claude (escribí 'salir' para terminar)"

# Primera interacción
read -p "Tú: " input
RESP=$(claude -p "$input" --output-format json)
SESSION_ID=$(echo "$RESP" | jq -r '.session_id')
echo "Claude: $(echo "$RESP" | jq -r '.result')"

# Loop
while true; do
    read -p "Tú: " input
    [ "$input" = "salir" ] && break
    
    RESP=$(claude -p --resume "$SESSION_ID" "$input" --output-format json)
    echo "Claude: $(echo "$RESP" | jq -r '.result')"
done
```

### 2. Agente con stream parseado en vivo

```bash
#!/bin/bash
# agente-stream.sh - Ver al agente trabajar en tiempo real

claude -p "$1" \
  --permission-mode acceptEdits \
  --output-format stream-json --verbose \
| while IFS= read -r line; do
    tipo=$(echo "$line" | jq -r '.type // empty')
    case "$tipo" in
        assistant)
            echo "$line" | jq -r '.message.content[] | 
                if .type=="text" then "💬 " + .text
                elif .type=="tool_use" then "🔧 " + .name + ": " + (.input | tostring)
                else empty end'
            ;;
        user)
            echo "$line" | jq -r '.message.content[]? | 
                select(.type=="tool_result") | 
                "✅ resultado: " + (.content | tostring | .[0:200])'
            ;;
        result)
            echo "━━━ Terminó ━━━"
            echo "$line" | jq -r '"Costo: $" + (.total_cost_usd | tostring) + 
                " | Turnos: " + (.num_turns | tostring)'
            ;;
    esac
done
```

Uso: `./agente-stream.sh "Refactorizá src/ para usar async/await"`

### 3. Auditoría de seguridad automatizada (CI/CD)

```bash
#!/bin/bash
# security-audit.sh - Auditoría programada

LOG="audit-$(date +%Y%m%d).json"

claude -p "
Realizá una auditoría de seguridad completa:
1. Escaneá dependencias en busca de vulnerabilidades conocidas
2. Buscá patrones de código peligrosos
3. Identificá posibles secretos expuestos

Generá un reporte JSON con prioridades (high/medium/low).
" \
  --allowedTools "Read,Grep,Glob,Bash(npm audit:*)" \
  --output-format json \
  --max-turns 20 \
  > "$LOG"

echo "Auditoría completa: $LOG"
```

### 4. Code review de un PR

```bash
#!/bin/bash
# review-pr.sh

PR_FILES=$(git diff --name-only origin/main...HEAD)

claude -p "
Sos un reviewer senior. Analizá estos archivos modificados:
$PR_FILES

Buscá:
1. Bugs potenciales
2. Problemas de performance
3. Vulnerabilidades de seguridad
4. Violaciones de convenciones

Formato: JSON con severidad (high/medium/low).
" \
  --allowedTools "Read,Grep,Bash(git diff:*)" \
  --output-format json \
  --append-system-prompt "Sé crítico pero constructivo." \
  > review.json

cat review.json | jq -r '.result'
```

### 5. Agente en background (no supervisado)

```bash
#!/bin/bash
# agente-nocturno.sh

LOG="agente-$(date +%Y%m%d-%H%M).log"

nohup claude -p "$(cat tarea.md)" \
  --permission-mode acceptEdits \
  --output-format stream-json --verbose \
  --max-turns 50 \
  > "$LOG" 2>&1 &

echo "Agente corriendo, PID: $!"
echo "Log: $LOG"
```

### 6. Cron job semanal

```bash
# crontab -e
0 7 * * 1 cd /repo && claude -p "Generá un reporte semanal de calidad de código y cobertura de tests" \
  --allowedTools "Read,Grep,Glob,Bash(npm test:*)" \
  --output-format text \
  > /reports/weekly_$(date +\%Y\%m\%d).md 2>&1
```

---

## Buenas prácticas y advertencias

### ⚠️ Advertencias de seguridad

1. **`--dangerously-skip-permissions` es peligroso.** El agente puede ejecutar cualquier comando bash, borrar archivos, hacer `git push`, etc. Usalo solo en:
   - Contenedores Docker aislados
   - VMs descartables
   - Sandboxes de CI/CD efímeros

2. **Trabajá siempre en una rama git separada** cuando el agente puede modificar código, para poder revertir fácil.

3. **Empezá restrictivo:** definí `--allowedTools` con la lista mínima necesaria antes de pasar a permisos más amplios.

### 💰 Control de costos

- Usá `--max-turns N` para cortar después de N iteraciones (evita loops infinitos costosos).
- Con `--output-format json` obtenés `total_cost_usd` por invocación para trackear gasto.
- Para tareas simples, `--max-turns 1` o `2` puede alcanzar.

### 🔧 Manejo de errores

```bash
if ! claude -p "$prompt" 2>error.log; then
    echo "Error:" >&2
    cat error.log >&2
    exit 1
fi
```

### 📝 Contexto del proyecto con `CLAUDE.md`

Creá un archivo `CLAUDE.md` en la raíz del proyecto. Claude Code lo lee automáticamente y lo usa como contexto persistente: convenciones del equipo, arquitectura, patrones importantes, decisiones técnicas, etc.

### 🔒 Modo `--bare` (recomendado para scripts)

El modo `--bare` salta OAuth y lecturas del keychain. La autenticación viene únicamente de `ANTHROPIC_API_KEY` o de un `apiKeyHelper`. Es el modo recomendado para invocaciones desde scripts y SDK, y será el default de `-p` en versiones futuras.

```bash
ANTHROPIC_API_KEY=sk-... claude -p "tu prompt" --bare
```

---

## Tabla resumen de flags clave

| Flag                             | Para qué sirve                                           |
| -------------------------------- | -------------------------------------------------------- |
| `-p` / `--print`                 | Modo no-interactivo (headless)                           |
| `--continue`                     | Continúa la última conversación                          |
| `--resume <id>`                  | Retoma una sesión específica                             |
| `--output-format`                | `text` / `json` / `stream-json`                          |
| `--input-format`                 | `text` / `stream-json`                                   |
| `--verbose`                      | Logging detallado (requerido para `stream-json`)         |
| `--allowedTools`                 | Whitelist de herramientas                                |
| `--disallowedTools`              | Blacklist de herramientas                                |
| `--permission-mode`              | `default` / `acceptEdits` / `plan` / `bypassPermissions` |
| `--dangerously-skip-permissions` | Salta TODOS los permisos (cuidado)                       |
| `--max-turns N`                  | Limita turnos del agente                                 |
| `--add-dir`                      | Directorios adicionales accesibles                       |
| `--append-system-prompt`         | Suma instrucciones al system prompt                      |
| `--agents`                       | Define subagents personalizados vía JSON                 |
| `--model`                        | Elegir modelo (`sonnet`, `opus`, `haiku`, `opusplan`)    |
| `--bare`                         | Modo limpio para scripts (sin OAuth/keychain)            |

---

## Referencias oficiales

### Documentación principal

- **Headless mode (CLI):** <https://docs.claude.com/en/docs/claude-code/headless>
- **CLI Reference completa:** <https://docs.claude.com/en/docs/claude-code/cli-reference>
- **Claude Agent SDK overview:** <https://docs.claude.com/en/api/agent-sdk/overview>
- **Configurar permisos del SDK:** <https://docs.claude.com/en/docs/claude-code/sdk/sdk-permissions>
- **Migración a Claude Agent SDK:** <https://docs.claude.com/en/docs/claude-code/sdk/migration-guide>

### Configuración

- **Settings.json:** <https://docs.claude.com/en/docs/claude-code/settings>
- **MCP servers:** <https://docs.claude.com/en/docs/claude-code/mcp>
- **Hooks:** <https://docs.claude.com/en/docs/claude-code/hooks>
- **Subagents:** <https://docs.claude.com/en/docs/claude-code/sub-agents>

### Recursos adicionales

- **Anthropic API Docs:** <https://docs.anthropic.com>
- **Claude Code en GitHub:** <https://github.com/anthropics/claude-code>
- **Quickstart del Agent SDK:** <https://docs.claude.com/en/api/agent-sdk/quickstart>

---

*Última actualización: mayo 2026. Para la lista canónica de comandos y flags, ejecutá `claude --help` en tu máquina.*