// MockAgentRunner — implementacion deterministica para tests.
// Permite seedear respuestas exactas por (agentId, sha256(prompt)).
// Sin side-effects, totalmente predecible.
//
// Extiende funcionalidad para session-strategy testing (tarea #5):
// - Captura todos los AgentRunParams recibidos en `calls[]` para verificacion.
// - Permite configurar sessionId dinamicamente via `sessionIdProvider`.
// - Permite configurar success via `successProvider` para simular fallos.

import { createHash } from 'node:crypto';
import type { AgentRunner, AgentRunParams, AgentRunResult } from './types.js';

export class MockAgentRunner implements AgentRunner {
  private responses = new Map<string, AgentRunResult>();

  /**
   * Lista de todos los AgentRunParams recibidos por `run()`.
   * Util para verificar en tests que el dispatcher paso sessionId correctamente.
   */
  public calls: AgentRunParams[] = [];

  /**
   * Provider opcional para generar sessionId dinamicamente.
   * Si no esta definido, usa hash del prompt (default).
   * Permite simular sessions normales y fallback-after-expiry.
   */
  public sessionIdProvider?: (call: AgentRunParams, callIndex: number) => string;

  /**
   * Provider opcional para determinar si la ejecucion fue exitosa.
   * Si no esta definido, siempre devuelve success=true.
   * Permite simular tasks fallidas en tests.
   */
  public successProvider?: (call: AgentRunParams, callIndex: number) => boolean;

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
    // Capturar params antes de procesarlos
    const callIndex = this.calls.length;
    this.calls.push(params);

    const key = this.key(params.agentId, params.prompt);
    const seeded = this.responses.get(key);

    // Determinar sessionId (provider > seeded > default)
    let sessionId: string;
    if (this.sessionIdProvider) {
      sessionId = this.sessionIdProvider(params, callIndex);
    } else if (seeded?.sessionId) {
      sessionId = seeded.sessionId;
    } else {
      const hash = createHash('sha256').update(params.prompt).digest('hex').slice(0, 12);
      sessionId = callIndex === 0 ? 'mock-default' : `mock-${hash}`;
    }

    // Determinar success (provider > seeded > true)
    const success = this.successProvider
      ? this.successProvider(params, callIndex)
      : seeded?.success ?? true;

    if (seeded) {
      return { ...seeded, sessionId, success };
    }

    // Respuesta default si no hay seed
    return {
      success,
      sessionId,
      output: `Mock response from ${params.agentId}`,
      cost: 0,
      numTurns: 1,
      tokensInput: 0,
      tokensOutput: 0,
    };
  }

  /**
   * Limpia el estado interno del mock para reusar entre tests.
   */
  reset(): void {
    this.calls = [];
    this.responses.clear();
    this.sessionIdProvider = undefined;
    this.successProvider = undefined;
  }

  private key(agentId: string, prompt: string): string {
    const hash = createHash('sha256').update(prompt).digest('hex');
    return `${agentId}:${hash}`;
  }
}
