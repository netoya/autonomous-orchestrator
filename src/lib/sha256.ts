// Hash SHA-256 de strings.
// Usado para checksums de migraciones y validacion de context snapshots.

import { createHash } from 'node:crypto';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}
