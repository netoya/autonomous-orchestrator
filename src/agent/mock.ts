// MockAgentRunner — implementacion deterministica para tests.
// Permite seedear respuestas exactas por (agentId, sha256(prompt)).
// Sin side-effects, totalmente predecible.

import { createHash } from 'node:crypto';
import type { AgentRunner, AgentRunParams, AgentRunResult } from './types.js';

export class MockAgentRunner implements AgentRunner {
  private responses = new Map<string, AgentRunResult>();

  /**
   * Seedea una respuesta para un agente + prompt especifico.
   * La clave es `agentId:sha256(prompt)`.
   */
  seed(agentId: string, prompt: string, partial: Partial<AgentRunResult>): void {
    const key = this.key(agentId, prompt);
    const hash = createHash('sha256').update(prompt).digest('hex').slice(0, 12);
    this.responses.set(key, {
      success: true,
      sessionId: `mock-${hash}`,
      output: partial.output ?? `Mock response from ${agentId}`,
      cost: partial.cost ?? 0,
      numTurns: partial.numTurns ?? 1,
      tokensInput: partial.tokensInput ?? 0,
      tokensOutput: partial.tokensOutput ?? 0,
      ...partial,
    });
  }

  async run(params: AgentRunParams): Promise<AgentRunResult> {
    const key = this.key(params.agentId, params.prompt);
    const seeded = this.responses.get(key);

    if (seeded) {
      return seeded;
    }

    // Respuesta default si no hay seed
    return {
      success: true,
      sessionId: 'mock-default',
      output: `Mock response from ${params.agentId}`,
      cost: 0,
      numTurns: 1,
      tokensInput: 0,
      tokensOutput: 0,
    };
  }

  private key(agentId: string, prompt: string): string {
    const hash = createHash('sha256').update(prompt).digest('hex');
    return `${agentId}:${hash}`;
  }
}
