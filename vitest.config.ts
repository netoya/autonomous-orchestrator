import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true, // Requerido para better-sqlite3 (no serializable entre threads)
        isolate: false // Evita serialization de contexto
      }
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: [
        'node_modules',
        'dist',
        'src/test/fixtures',
        '**/*.test.ts'
      ]
    }
  }
});
