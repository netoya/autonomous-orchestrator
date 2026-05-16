// ClaudeCodeRunner — implementacion real de AgentRunner via `claude -p` headless.
// IMPORTANTE: NO usa `--bare` para heredar OAuth del keychain del usuario (decision de Angel).
// Rechaza `dangerously-skip-permissions` en todos los parametros (spec 3.2.8).

import { spawn } from 'node:child_process';
import type { AgentRunner, AgentRunParams, AgentRunResult } from './types.js';

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

    // Construir args para `claude`
    const args: string[] = ['-p', params.prompt];

    // Output format (default: json)
    args.push('--output-format', params.outputFormat ?? 'json');

    // IMPORTANTE: NO incluir --bare (decision de Angel para heredar OAuth)
    // La spec 3.2.2 propone --bare + ANTHROPIC_API_KEY, pero Angel quiere OAuth heredado.

    if (params.permissionMode) {
      args.push('--permission-mode', params.permissionMode);
    }

    if (params.allowedTools && params.allowedTools.length > 0) {
      // La flag correcta es --allowed-tools (no --allowedTools en camelCase)
      args.push('--allowed-tools', params.allowedTools.join(','));
    }

    if (params.maxTurns) {
      args.push('--max-turns', String(params.maxTurns));
    }

    if (params.sessionId) {
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

    // Spawn claude
    return new Promise<AgentRunResult>((resolve) => {
      const proc = spawn('claude', args, {
        cwd: params.cwd,
        env: { ...process.env, ...params.env },
        timeout: params.timeoutMs ?? 600_000, // 10 min default
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      proc.on('error', (err) => {
        resolve({
          success: false,
          sessionId: '',
          output: '',
          error: `spawn-error: ${err.message}`,
        });
      });

      proc.on('close', (exitCode) => {
        if (exitCode !== 0) {
          resolve({
            success: false,
            sessionId: '',
            output: '',
            error: stderr || `claude-exit-${exitCode}`,
          });
          return;
        }

        // Parsear JSON de stdout
        try {
          const raw = JSON.parse(stdout) as {
            session_id?: string;
            result?: string;
            total_cost_usd?: number;
            num_turns?: number;
            usage?: { input_tokens?: number; output_tokens?: number };
          };

          resolve({
            success: true,
            sessionId: raw.session_id ?? '',
            output: raw.result ?? '',
            cost: raw.total_cost_usd,
            numTurns: raw.num_turns,
            tokensInput: raw.usage?.input_tokens ?? 0,
            tokensOutput: raw.usage?.output_tokens ?? 0,
            rawJson: raw,
          });
        } catch (err) {
          resolve({
            success: false,
            sessionId: '',
            output: '',
            error: 'invalid-json-from-claude',
            rawJson: stdout,
          });
        }
      });
    });
  }
}
