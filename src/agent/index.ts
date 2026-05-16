// Factory para AgentRunner.
// Por defecto usa MockAgentRunner (no consume tokens, ideal para dev/tests).
// Switch via env var AGENT_RUNNER=claude para invocar al CLI real.

import type { AgentRunner } from './types.js';
import { MockAgentRunner } from './mock.js';
import { ClaudeCodeRunner } from './claude-code-runner.js';

export * from './types.js';
export { MockAgentRunner } from './mock.js';
export { ClaudeCodeRunner } from './claude-code-runner.js';

/**
 * Factory de AgentRunner.
 *
 * - AGENT_RUNNER=mock (default) → MockAgentRunner (sin tokens, determinista)
 * - AGENT_RUNNER=claude → ClaudeCodeRunner (invoca `claude -p` real via OAuth heredado)
 */
export function makeAgentRunner(): AgentRunner {
  const mode = process.env.AGENT_RUNNER ?? 'mock';

  if (mode === 'claude') {
    return new ClaudeCodeRunner();
  }

  return new MockAgentRunner();
}
