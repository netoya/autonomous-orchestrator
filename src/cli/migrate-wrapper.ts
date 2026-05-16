// Wrapper para orchestrator migrate
// Delega al migration runner existente.

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrateScript = resolve(__dirname, 'migrate.ts');

export default async function migrate(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'up';

  return new Promise((resolve, reject) => {
    const proc = spawn('tsx', [migrateScript, subcommand], {
      stdio: 'inherit',
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Migration failed with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}
