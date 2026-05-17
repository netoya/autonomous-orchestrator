#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# benchmark-resume.sh
#
# Mide si --resume del Claude Code CLI realmente ahorra tokens_input >= 30%.
# Bloqueante para la feature de session-strategy del orchestrator.
#
# Ejecutar desde la raiz del orchestrator:
#   bash scripts/benchmark-resume.sh
#
# Salida: tabla comparativa + veredicto (viable / NO viable).
###############################################################################

CLAUDE_BIN="/home/angel/.local/bin/claude"
STATE_DIR="/home/angel/projects/autonomous-orchestrator/state"
OUTPUT_1="${STATE_DIR}/benchmark-resume-1.json"
OUTPUT_2="${STATE_DIR}/benchmark-resume-2.json"
OUTPUT_3="${STATE_DIR}/benchmark-resume-3.json"

# Verificar dependencias
echo "[1/7] Verificando dependencias..."
if ! command -v jq &>/dev/null; then
    echo "ERROR: jq no esta disponible. Instalar con: sudo apt install jq"
    exit 1
fi

if [ ! -x "$CLAUDE_BIN" ]; then
    echo "ERROR: Claude CLI no encontrado en $CLAUDE_BIN"
    exit 1
fi

echo "       jq: OK"
echo "       claude: $($CLAUDE_BIN --version)"
echo ""

# Crear directorio state si no existe
mkdir -p "$STATE_DIR"

# Prompts realistas pero cortos que no requieran mucho procesamiento
PROMPT_1="Lee el archivo package.json de este repositorio y dime cual es el nombre del proyecto."
PROMPT_2="Ahora dime cuantos archivos .ts hay en el directorio src/"

echo "[2/7] Invocacion 1: sesion nueva (prompt corto)..."
echo "      Prompt: \"$PROMPT_1\""

# Invocacion 1: sesion nueva, capturar session_id
set +e
$CLAUDE_BIN -p "$PROMPT_1" \
    --output-format json \
    --permission-mode acceptEdits \
    --max-turns 5 \
    > "$OUTPUT_1" 2>&1
EXIT_1=$?
set -e

if [ $EXIT_1 -ne 0 ]; then
    echo "ERROR: Primera invocacion fallo (exit code $EXIT_1)"
    echo "Contenido de $OUTPUT_1:"
    cat "$OUTPUT_1"
    exit 1
fi

SESSION_ID=$(jq -r '.session_id // empty' "$OUTPUT_1")
INPUT_TOKENS_1=$(jq -r '.usage.input_tokens // 0' "$OUTPUT_1")
CACHE_CREATE_1=$(jq -r '.usage.cache_creation_input_tokens // 0' "$OUTPUT_1")
CACHE_READ_1=$(jq -r '.usage.cache_read_input_tokens // 0' "$OUTPUT_1")
COST_1=$(jq -r '.total_cost_usd // 0' "$OUTPUT_1")
TOTAL_INPUT_1=$((INPUT_TOKENS_1 + CACHE_CREATE_1 + CACHE_READ_1))

if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "null" ]; then
    echo "ERROR: No se pudo capturar session_id de la primera invocacion"
    echo "Output JSON:"
    cat "$OUTPUT_1"
    exit 1
fi

echo "       session_id: $SESSION_ID"
echo "       input_tokens: $INPUT_TOKENS_1"
echo "       cache_creation_tokens: $CACHE_CREATE_1"
echo "       cache_read_tokens: $CACHE_READ_1"
echo "       total_input_processing: $TOTAL_INPUT_1"
echo "       cost: \$$COST_1"
echo ""

# Esperar 1 segundo antes de la segunda invocacion
sleep 1

echo "[3/7] Invocacion 2: --resume (segundo prompt diferente)..."
echo "      Prompt: \"$PROMPT_2\""
echo "      Resumiendo sesion: $SESSION_ID"

set +e
$CLAUDE_BIN -p "$PROMPT_2" \
    --resume "$SESSION_ID" \
    --output-format json \
    --permission-mode acceptEdits \
    --max-turns 5 \
    > "$OUTPUT_2" 2>&1
EXIT_2=$?
set -e

if [ $EXIT_2 -ne 0 ]; then
    echo "ERROR: Segunda invocacion (--resume) fallo (exit code $EXIT_2)"
    echo "Contenido de $OUTPUT_2:"
    cat "$OUTPUT_2"
    exit 1
fi

INPUT_TOKENS_2=$(jq -r '.usage.input_tokens // 0' "$OUTPUT_2")
CACHE_CREATE_2=$(jq -r '.usage.cache_creation_input_tokens // 0' "$OUTPUT_2")
CACHE_READ_2=$(jq -r '.usage.cache_read_input_tokens // 0' "$OUTPUT_2")
COST_2=$(jq -r '.total_cost_usd // 0' "$OUTPUT_2")
TOTAL_INPUT_2=$((INPUT_TOKENS_2 + CACHE_CREATE_2 + CACHE_READ_2))

echo "       input_tokens: $INPUT_TOKENS_2"
echo "       cache_creation_tokens: $CACHE_CREATE_2"
echo "       cache_read_tokens: $CACHE_READ_2"
echo "       total_input_processing: $TOTAL_INPUT_2"
echo "       cost: \$$COST_2"
echo ""

# Esperar antes de la baseline
sleep 1

echo "[4/7] Invocacion 3: baseline SIN --resume (mismo segundo prompt)..."
echo "      Prompt: \"$PROMPT_2\""

set +e
$CLAUDE_BIN -p "$PROMPT_2" \
    --output-format json \
    --permission-mode acceptEdits \
    --max-turns 5 \
    > "$OUTPUT_3" 2>&1
EXIT_3=$?
set -e

if [ $EXIT_3 -ne 0 ]; then
    echo "ERROR: Tercera invocacion (baseline) fallo (exit code $EXIT_3)"
    echo "Contenido de $OUTPUT_3:"
    cat "$OUTPUT_3"
    exit 1
fi

INPUT_TOKENS_3=$(jq -r '.usage.input_tokens // 0' "$OUTPUT_3")
CACHE_CREATE_3=$(jq -r '.usage.cache_creation_input_tokens // 0' "$OUTPUT_3")
CACHE_READ_3=$(jq -r '.usage.cache_read_input_tokens // 0' "$OUTPUT_3")
COST_3=$(jq -r '.total_cost_usd // 0' "$OUTPUT_3")
TOTAL_INPUT_3=$((INPUT_TOKENS_3 + CACHE_CREATE_3 + CACHE_READ_3))

echo "       input_tokens: $INPUT_TOKENS_3"
echo "       cache_creation_tokens: $CACHE_CREATE_3"
echo "       cache_read_tokens: $CACHE_READ_3"
echo "       total_input_processing: $TOTAL_INPUT_3"
echo "       cost: \$$COST_3"
echo ""

echo "[5/7] Resultados capturados."
echo ""

echo "[6/7] Tabla comparativa:"
echo "----------------------------------------------------------------------------------------------------"
printf "%-20s | %-10s | %-13s | %-13s | %-18s | %-10s\n" \
    "Invocacion" "Input" "Cache Create" "Cache Read" "Total Input Proc" "Cost (USD)"
echo "----------------------------------------------------------------------------------------------------"
printf "%-20s | %-10s | %-13s | %-13s | %-18s | \$%-9s\n" \
    "1. Nueva sesion" "$INPUT_TOKENS_1" "$CACHE_CREATE_1" "$CACHE_READ_1" "$TOTAL_INPUT_1" "$COST_1"
printf "%-20s | %-10s | %-13s | %-13s | %-18s | \$%-9s\n" \
    "2. Con --resume" "$INPUT_TOKENS_2" "$CACHE_CREATE_2" "$CACHE_READ_2" "$TOTAL_INPUT_2" "$COST_2"
printf "%-20s | %-10s | %-13s | %-13s | %-18s | \$%-9s\n" \
    "3. Baseline (nuevo)" "$INPUT_TOKENS_3" "$CACHE_CREATE_3" "$CACHE_READ_3" "$TOTAL_INPUT_3" "$COST_3"
echo "----------------------------------------------------------------------------------------------------"
echo ""

echo "[7/7] Calculo de ahorro..."

# Comparacion correcta: costo acumulado de 2 invocaciones
# Escenario A (con --resume): invocacion 1 + invocacion 2 resumed
# Escenario B (sin --resume): invocacion 1 + invocacion 3 nueva
COSTO_CON_RESUME=$(echo "$COST_1 + $COST_2" | bc)
COSTO_SIN_RESUME=$(echo "$COST_1 + $COST_3" | bc)

TOTAL_TOKENS_CON_RESUME=$((TOTAL_INPUT_1 + TOTAL_INPUT_2))
TOTAL_TOKENS_SIN_RESUME=$((TOTAL_INPUT_1 + TOTAL_INPUT_3))

if [ "$(echo "$COSTO_SIN_RESUME == 0" | bc)" -eq 1 ]; then
    echo "ERROR: Costo baseline es 0, no se puede calcular ahorro"
    exit 1
fi

AHORRO_COSTO=$(echo "scale=2; (($COSTO_SIN_RESUME - $COSTO_CON_RESUME) / $COSTO_SIN_RESUME) * 100" | bc)

# Ahorro en total input processing tokens
if [ "$TOTAL_TOKENS_SIN_RESUME" -eq 0 ]; then
    echo "ERROR: Total tokens baseline es 0"
    exit 1
fi

AHORRO_TOKENS=$(echo "scale=2; (($TOTAL_TOKENS_SIN_RESUME - $TOTAL_TOKENS_CON_RESUME) / $TOTAL_TOKENS_SIN_RESUME) * 100" | bc)

echo "Comparacion de 2 invocaciones secuenciales:"
echo ""
echo "Escenario CON --resume (invoc 1 + invoc 2 resumed):"
echo "  Total tokens procesados:  $TOTAL_TOKENS_CON_RESUME"
echo "  Costo total:              \$$COSTO_CON_RESUME"
echo ""
echo "Escenario SIN --resume (invoc 1 + invoc 3 nueva):"
echo "  Total tokens procesados:  $TOTAL_TOKENS_SIN_RESUME"
echo "  Costo total:              \$$COSTO_SIN_RESUME"
echo ""
echo "Ahorro con --resume:"
echo "  Tokens:  ${AHORRO_TOKENS}%"
echo "  Costo:   ${AHORRO_COSTO}%"
echo ""

# Veredicto basado en ahorro de costo (metrica mas clara que tokens)
THRESHOLD=30

# bc retorna 1 si la comparacion es verdadera, 0 si falsa
VIABLE=$(echo "$AHORRO_COSTO >= $THRESHOLD" | bc)

echo ""
echo "======================================================================="
if [ "$VIABLE" -eq 1 ]; then
    echo "VEREDICTO: feature VIABLE"
    echo ""
    echo "El --resume ahorra ${AHORRO_COSTO}% en costo total para 2 invocaciones,"
    echo "superando el umbral del ${THRESHOLD}%."
    echo "Ahorro adicional en tokens procesados: ${AHORRO_TOKENS}%"
    echo ""
    echo "Recomendacion: PROCEDER con la implementacion de session-strategy"
    echo "en el orchestrator. El beneficio justifica la complejidad."
else
    echo "VEREDICTO: feature NO VIABLE - CANCELAR"
    echo ""
    echo "El --resume solo ahorra ${AHORRO_COSTO}% en costo total,"
    echo "por debajo del umbral del ${THRESHOLD}%."
    echo ""
    echo "Recomendacion: CANCELAR la feature de session-strategy."
    echo "El beneficio no justifica la complejidad adicional."
fi
echo "======================================================================="
echo ""

echo "JSON crudos guardados en:"
echo "  - $OUTPUT_1"
echo "  - $OUTPUT_2"
echo "  - $OUTPUT_3"
echo ""
echo "Benchmark completo."
