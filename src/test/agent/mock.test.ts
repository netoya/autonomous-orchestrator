// Tests para MockAgentRunner.
// Verifica seeding, respuestas default, y hash diferencial.

import { describe, it, expect } from 'vitest';
import { MockAgentRunner } from '../../agent/mock.js';

describe('MockAgentRunner', () => {
  it('devuelve respuesta seeded cuando hay match exacto', async () => {
    const runner = new MockAgentRunner();
    const agentId = 'softwarefactory_mateo';
    const prompt = 'Implementar API REST';

    runner.seed(agentId, prompt, {
      output: 'API implementada correctamente',
      cost: 0.05,
      numTurns: 3,
    });

    const result = await runner.run({ agentId, prompt });

    expect(result.success).toBe(true);
    expect(result.output).toBe('API implementada correctamente');
    expect(result.cost).toBe(0.05);
    expect(result.numTurns).toBe(3);
    expect(result.sessionId).toMatch(/^mock-/);
  });

  it('devuelve respuesta default cuando no hay seed', async () => {
    const runner = new MockAgentRunner();

    const result = await runner.run({
      agentId: 'softwarefactory_valeria',
      prompt: 'Crear componente React',
    });

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe('mock-default');
    expect(result.output).toContain('softwarefactory_valeria');
    expect(result.cost).toBe(0);
    expect(result.numTurns).toBe(1);
  });

  it('diferencia respuestas por hash del prompt', async () => {
    const runner = new MockAgentRunner();
    const agentId = 'softwarefactory_sofia';

    runner.seed(agentId, 'Test A', { output: 'Respuesta A' });
    runner.seed(agentId, 'Test B', { output: 'Respuesta B' });

    const resultA = await runner.run({ agentId, prompt: 'Test A' });
    const resultB = await runner.run({ agentId, prompt: 'Test B' });

    expect(resultA.output).toBe('Respuesta A');
    expect(resultB.output).toBe('Respuesta B');
    expect(resultA.sessionId).not.toBe(resultB.sessionId);
  });

  it('permite seed con campos parciales', async () => {
    const runner = new MockAgentRunner();

    runner.seed('agent-x', 'prompt-y', { cost: 0.1 });

    const result = await runner.run({ agentId: 'agent-x', prompt: 'prompt-y' });

    expect(result.success).toBe(true);
    expect(result.cost).toBe(0.1);
    expect(result.output).toContain('agent-x'); // default output
  });
});
