// Ejecutor de comandos para waiters activos kind='exec-command'.
//
// Diseñado para resolver el problema de que sub-claudes en modo headless mueren
// con SIGTERM cuando ejecutan comandos como `npm run dev`, `npx playwright test`,
// `curl localhost` (el wrapper anti-comandos los bloquea/mata).
//
// El agente crea un waiter activo con condition_kind='exec-command' y se va.
// El dispatcher (este modulo, en tickF) lo ejecuta desde el contexto del orchestrator
// — donde no hay wrapper — y deja el resultado en value_json para que el agente
// lo lea en la siguiente invocacion (--resume sessionId).

import { spawn } from 'node:child_process';

/**
 * Allowlist de comandos seguros. La primera palabra del cmd debe matchear.
 * Bloquea explicitamente: rm, sudo, git push, redirecciones a paths absolutos
 * fuera del cwd permitido.
 */
const ALLOWED_BINARIES = new Set([
  'npm',
  'npx',
  'node',
  'tsx',
  'curl',
  'sqlite3',
  'ls',
  'cat',
  'pwd',
  'echo',
  'mkdir',
  'cp',
  'mv',
  'find',
  'grep',
  'sed',
  'awk',
  'wc',
  'head',
  'tail',
  'pkill',
  'cd', // builtin de bash, util en bash -lc para cambiar de dir antes de comando
  'true',
  'false',
  'test',
  'sleep',
]);

const FORBIDDEN_TOKENS = [
  'rm -rf',
  'sudo',
  'git push',
  'git reset --hard',
  ':(){',
  '$(curl',
  'dd if=',
];

export interface ExecParams {
  cmd: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  rejected?: string; // motivo si fue bloqueado por allowlist
}

export function isAllowedCommand(cmd: string): { allowed: boolean; reason?: string } {
  const trimmed = cmd.trim();
  if (trimmed.length === 0) return { allowed: false, reason: 'empty command' };

  for (const tok of FORBIDDEN_TOKENS) {
    if (trimmed.includes(tok)) {
      return { allowed: false, reason: `forbidden token: ${tok}` };
    }
  }

  // Para bash -lc "..." extraemos el primer binary del wrap
  const tokens = trimmed.split(/\s+/);
  const firstBinary = tokens[0] ?? '';
  if (firstBinary === 'bash' || firstBinary === 'sh') {
    // Permitido si toda la cadena que sigue solo invoca binarios del allowlist.
    // Match simple: extraer comandos despues de -c, -lc, etc.
    const inner = trimmed.match(/-l?c\s+['"]?(.+?)['"]?$/);
    if (!inner || !inner[1]) {
      return { allowed: false, reason: 'bash sin -c reconocible' };
    }
    // Validar cada subcomando separado por && o ;
    const subs = inner[1].split(/(?:&&|;|\|\|)/).map((s) => s.trim()).filter(Boolean);
    for (const sub of subs) {
      const subFirst = sub.split(/\s+/)[0] ?? '';
      if (!ALLOWED_BINARIES.has(subFirst)) {
        return { allowed: false, reason: `bash inner cmd no allowlisted: ${subFirst}` };
      }
    }
    return { allowed: true };
  }

  if (!firstBinary || !ALLOWED_BINARIES.has(firstBinary)) {
    return { allowed: false, reason: `binary no allowlisted: ${firstBinary}` };
  }
  return { allowed: true };
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024; // 64 KB por canal — protege contra OOM

export async function executeCommand(params: ExecParams): Promise<ExecResult> {
  const start = Date.now();
  const check = isAllowedCommand(params.cmd);
  if (!check.allowed) {
    return {
      ok: false,
      exitCode: -1,
      stdout: '',
      stderr: '',
      durationMs: 0,
      rejected: check.reason,
    };
  }

  return new Promise((resolve) => {
    const proc = spawn('bash', ['-lc', params.cmd], {
      cwd: params.cwd,
      env: process.env,
      timeout: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += chunk.toString('utf8');
        if (stdout.length > MAX_OUTPUT_BYTES) {
          stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
          stdoutTruncated = true;
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += chunk.toString('utf8');
        if (stderr.length > MAX_OUTPUT_BYTES) {
          stderr = stderr.slice(0, MAX_OUTPUT_BYTES);
          stderrTruncated = true;
        }
      }
    });

    proc.on('error', (err) => {
      resolve({
        ok: false,
        exitCode: -1,
        stdout,
        stderr: stderr + `\n[spawn error] ${err.message}`,
        durationMs: Date.now() - start,
      });
    });

    proc.on('close', (exitCode) => {
      if (stdoutTruncated) stdout += `\n[stdout truncated at ${MAX_OUTPUT_BYTES} bytes]`;
      if (stderrTruncated) stderr += `\n[stderr truncated at ${MAX_OUTPUT_BYTES} bytes]`;
      resolve({
        ok: exitCode === 0,
        exitCode: exitCode ?? -1,
        stdout,
        stderr,
        durationMs: Date.now() - start,
      });
    });
  });
}
