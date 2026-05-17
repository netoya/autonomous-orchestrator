#!/usr/bin/env node
// CLI minima del orchestrator.
// Delega a subcomandos en src/cli/.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

const args = process.argv.slice(2);
const command = args[0];

if (!command) {
  console.error('Usage: orchestrator <command> [args]');
  console.error('');
  console.error('Commands:');
  console.error('  status                    Show system status');
  console.error('  flow create <name>        Create a new flow');
  console.error('  coordinate "<idea>"       Create flow + coordinator task');
  console.error('  task list                 List tasks');
  console.error('  waiter list               List waiters');
  console.error('  waiter fulfill <id> --json <json>  Fulfill a waiter');
  console.error('  migrate                   Run migrations');
  process.exit(1);
}

// Dynamically import subcommand
const subcommandPath = resolve(rootDir, 'dist/cli', `${command}.js`);

try {
  const subcommand = await import(subcommandPath);
  await subcommand.default(args.slice(1));
} catch (err) {
  if (err.code === 'ERR_MODULE_NOT_FOUND') {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
  throw err;
}
