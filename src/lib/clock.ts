// Clock utility para facilitar mocking en tests.
// Todos los timestamps del sistema se generan con now().

export function now(): number {
  return Date.now();
}
