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

  it('captura todos los params en calls[] para verificacion', async () => {
    const runner = new MockAgentRunner();

    await runner.run({ agentId: 'agent-a', prompt: 'prompt-1' });
    await runner.run({ agentId: 'agent-b', prompt: 'prompt-2', sessionId: 'prev-session' });

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]?.agentId).toBe('agent-a');
    expect(runner.calls[0]?.prompt).toBe('prompt-1');
    expect(runner.calls[0]?.sessionId).toBeUndefined();
    expect(runner.calls[1]?.agentId).toBe('agent-b');
    expect(runner.calls[1]?.sessionId).toBe('prev-session');
  });

  it('sessionIdProvider permite configurar sessionId dinamicamente', async () => {
    const runner = new MockAgentRunner();

    runner.sessionIdProvider = (params, callIndex) => `custom-session-${callIndex}`;

    const result1 = await runner.run({ agentId: 'agent-x', prompt: 'p1' });
    const result2 = await runner.run({ agentId: 'agent-x', prompt: 'p2' });

    expect(result1.sessionId).toBe('custom-session-0');
    expect(result2.sessionId).toBe('custom-session-1');
  });

  it('successProvider permite simular fallos', async () => {
    const runner = new MockAgentRunner();

    runner.successProvider = (params, callIndex) => callIndex !== 1;

    const result1 = await runner.run({ agentId: 'agent-x', prompt: 'p1' });
    const result2 = await runner.run({ agentId: 'agent-x', prompt: 'p2' });
    const result3 = await runner.run({ agentId: 'agent-x', prompt: 'p3' });

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(false);
    expect(result3.success).toBe(true);
  });

  it('reset limpia calls y providers', async () => {
    const runner = new MockAgentRunner();

    runner.sessionIdProvider = () => 'test-session';
    await runner.run({ agentId: 'agent-x', prompt: 'p1' });

    expect(runner.calls).toHaveLength(1);

    runner.reset();

    expect(runner.calls).toHaveLength(0);
    expect(runner.sessionIdProvider).toBeUndefined();
  });
});
