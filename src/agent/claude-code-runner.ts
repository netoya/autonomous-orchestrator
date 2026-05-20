// ClaudeCodeRunner — implementacion real de AgentRunner via `claude -p` headless.
// IMPORTANTE: NO usa `--bare` para heredar OAuth del keychain del usuario (decision de Angel).
// Rechaza `dangerously-skip-permissions` en todos los parametros (spec 3.2.8).
// Alineado con docs/claude-headless.md.

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { AgentRunner, AgentRunParams, AgentRunResult } from './types.js';

// Donde tee'amos el stdout de claude para observabilidad en vivo.
// claude -p headless NO escribe a ~/.claude/projects/ (eso solo lo hace la GUI).
const STREAM_DIR = process.env.STREAM_DIR ?? 'state/conversations';

export class ClaudeCodeRunner implements AgentRunner {
  constructor() {
    // Sin constructor args — hereda auth del keychain via OAuth.
    // Desviacion intencional de spec 3.2.2 (que propone `--bare` + API key).
  }

  async run(params: AgentRunParams): Promise<AgentRunResult> {
    // Validacion de seguridad: rechazar dangerously-skip-permissions
    const dangerousPattern = /dangerously-skip-permissions/i;
    const checkFields = [
      params.permissionMode ?? '',
      (params.allowedTools ?? []).join(','),
      (params.disallowedTools ?? []).join(','),
      params.appendSystemPrompt ?? '',
      params.prompt,
    ];

    for (const field of checkFields) {
      if (dangerousPattern.test(field)) {
        return {
          success: false,
          sessionId: '',
          output: '',
          error: 'dangerously-skip-permissions is forbidden by spec 3.2.8',
        };
      }
    }

    // Si tenemos taskId, fuerza stream-json para que el stdout salga incremental
    // y podamos tee'arlo a fichero para observabilidad en vivo.
    const outputFormat =
      params.outputFormat ?? (params.taskId ? 'stream-json' : 'json');

    // Construir args para `claude`
    const args: string[] = ['-p', params.prompt];

    args.push('--output-format', outputFormat);

    if (params.inputFormat) {
      args.push('--input-format', params.inputFormat);
    }

    // stream-json requiere --verbose (docs/claude-headless.md L102).
    if (outputFormat === 'stream-json') {
      args.push('--verbose');
    }

    // IMPORTANTE: NO incluir --bare (decision de Angel para heredar OAuth)
    // La spec 3.2.2 propone --bare + ANTHROPIC_API_KEY, pero Angel quiere OAuth heredado.

    if (params.permissionMode) {
      args.push('--permission-mode', params.permissionMode);
    }

    if (params.allowedTools && params.allowedTools.length > 0) {
      // El CLI acepta tanto --allowedTools como --allowed-tools; usamos la forma camelCase
      // que aparece en docs/claude-headless.md.
      args.push('--allowedTools', params.allowedTools.join(','));
    }

    if (params.disallowedTools && params.disallowedTools.length > 0) {
      args.push('--disallowedTools', params.disallowedTools.join(','));
    }

    if (params.maxTurns) {
      args.push('--max-turns', String(params.maxTurns));
    }

    if (params.continueLast) {
      args.push('--continue');
    } else if (params.sessionId) {
      args.push('--resume', params.sessionId);
    }

    if (params.appendSystemPrompt) {
      args.push('--append-system-prompt', params.appendSystemPrompt);
    }

    if (params.model) {
      args.push('--model', params.model);
    }

    if (params.addDir) {
      for (const dir of params.addDir) {
        args.push('--add-dir', dir);
      }
    }

    // Tee del stdout a fichero para observabilidad en vivo (tail -F).
    // Solo si outputFormat=stream-json + taskId (sino el fichero seria un único JSON al final, no útil).
    let streamFile: WriteStream | null = null;
    if (outputFormat === 'stream-json' && params.taskId) {
      try {
        mkdirSync(STREAM_DIR, { recursive: true });
        const filename = params.flowId
          ? `${params.flowId}_${params.taskId}.jsonl`
          : `${params.taskId}.jsonl`;
        streamFile = createWriteStream(resolvePath(STREAM_DIR, filename), { flags: 'a' });
      } catch (err) {
        console.warn(`[claude-runner] tee disabled: ${(err as Error).message}`);
      }
    }

    // Spawn claude
    // stdio: 'ignore' en stdin para que claude -p no espere input por pipe (sin esto se cuelga).
    return new Promise<AgentRunResult>((resolve) => {
      const proc = spawn('claude', args, {
        cwd: params.cwd,
        env: { ...process.env, ...params.env },
        timeout: params.timeoutMs ?? 600_000, // 10 min default
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // FIX #3: Capturar PID para cleanup
      const childPid = proc.pid;

      // Notificar al caller (dispatcher) para persistir pid en DB —
      // habilita cancel cross-restart cuando el state in-memory se pierde.
      if (childPid !== undefined && params.onChildSpawned) {
        try {
          params.onChildSpawned(childPid);
        } catch (err) {
          console.error('[claude-code-runner] onChildSpawned callback threw:', err);
        }
      }

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        if (streamFile) streamFile.write(text);
      });

      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      // Cierro el stream cuando termine (en close y error).
      const closeStream = () => {
        if (streamFile) {
          streamFile.end();
          streamFile = null;
        }
      };

      proc.on('error', (err) => {
        closeStream();
        resolve({
          success: false,
          sessionId: '',
          output: '',
          error: `spawn-error: ${err.message}`,
          childPid,
        });
      });

      proc.on('close', (exitCode) => {
        closeStream();
        // FIX #1 (P0): Parsear stdout JSON PRIMERO, DESPUES validar exit code.
        // Razon: claude CLI puede salir con exit 1 (ej: max_turns_reached)
        // pero haber escrito JSON valido con is_error=false. Confiamos en el JSON.

        if (outputFormat === 'text') {
          // Para text mode, confiar solo en exit code (no hay JSON para validar)
          if (exitCode !== 0) {
            resolve({
              success: false,
              sessionId: '',
              output: '',
              error: stderr || `claude-exit-${exitCode}`,
              childPid,
            });
            return;
          }

          resolve({
            success: true,
            sessionId: '',
            output: stdout,
            childPid,
          });
          return;
        }

        if (outputFormat === 'stream-json') {
          // Parsear JSONL: ultima linea con type=result tiene los totales.
          const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
          let resultLine: Record<string, unknown> | null = null;
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            if (!line) continue;
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              if (parsed.type === 'result') {
                resultLine = parsed;
                break;
              }
            } catch {
              // ignorar lineas no-json
            }
          }

          if (!resultLine) {
            // No pudimos parsear resultado — confiar en exit code
            if (exitCode !== 0) {
              resolve({
                success: false,
                sessionId: '',
                output: stdout,
                error: stderr || `claude-exit-${exitCode}`,
                rawJson: stdout,
                childPid,
              });
              return;
            }

            resolve({
              success: false,
              sessionId: '',
              output: stdout,
              error: 'no-result-event-in-stream',
              rawJson: stdout,
              childPid,
            });
            return;
          }

          // JSON valido parseado — confiar en is_error del JSON
          const usage = resultLine.usage as
            | { input_tokens?: number; output_tokens?: number }
            | undefined;

          const jsonSuccess = resultLine.is_error !== true;

          // Si el JSON reporta success PERO exit code != 0, loguear warning
          if (jsonSuccess && exitCode !== 0) {
            console.warn(
              `[claude-runner] WARN: claude reported is_error=false but exited with code ${exitCode}. Trusting JSON output.`,
            );
          }

          resolve({
            success: jsonSuccess,
            sessionId: (resultLine.session_id as string) ?? '',
            output: (resultLine.result as string) ?? '',
            cost: resultLine.total_cost_usd as number | undefined,
            numTurns: resultLine.num_turns as number | undefined,
            tokensInput: usage?.input_tokens ?? 0,
            tokensOutput: usage?.output_tokens ?? 0,
            rawJson: resultLine,
            error: resultLine.is_error === true ? 'claude-reported-error' : undefined,
            childPid,
          });
          return;
        }

        // outputFormat === 'json'
        try {
          const raw = JSON.parse(stdout) as {
            session_id?: string;
            result?: string;
            total_cost_usd?: number;
            num_turns?: number;
            is_error?: boolean;
            usage?: { input_tokens?: number; output_tokens?: number };
          };

          const jsonSuccess = raw.is_error !== true;

          // Si el JSON reporta success PERO exit code != 0, loguear warning
          if (jsonSuccess && exitCode !== 0) {
            console.warn(
              `[claude-runner] WARN: claude reported is_error=false but exited with code ${exitCode}. Trusting JSON output.`,
            );
          }

          resolve({
            success: jsonSuccess,
            sessionId: raw.session_id ?? '',
            output: raw.result ?? '',
            cost: raw.total_cost_usd,
            numTurns: raw.num_turns,
            tokensInput: raw.usage?.input_tokens ?? 0,
            tokensOutput: raw.usage?.output_tokens ?? 0,
            rawJson: raw,
            error: raw.is_error === true ? 'claude-reported-error' : undefined,
            childPid,
          });
        } catch (err) {
          // JSON invalido — confiar en exit code
          if (exitCode !== 0) {
            resolve({
              success: false,
              sessionId: '',
              output: '',
              error: stderr || `claude-exit-${exitCode}`,
              rawJson: stdout,
              childPid,
            });
            return;
          }

          // Exit code 0 pero JSON invalido — error
          resolve({
            success: false,
            sessionId: '',
            output: '',
            error: 'invalid-json-from-claude',
            rawJson: stdout,
            childPid,
          });
        }
      });
    });
  }
}
