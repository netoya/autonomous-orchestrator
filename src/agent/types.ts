// Interfaz AgentRunner y tipos relacionados.
// Cumple con el contrato de spec 3.2.1 + ADR-0001.

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

export interface AgentRunner {
  run(params: AgentRunParams): Promise<AgentRunResult>;
}
