// Waiter pasivo: approve-text
// Schema de validacion para aprobaciones simples con decision + comentarios.

import { z } from 'zod';

/**
 * Schema Zod para waiter pasivo de tipo approve-text.
 *
 * Campos:
 * - decision: 'approved' o 'rejected'
 * - comments: texto libre opcional
 * - reviewed_by: identificador del revisor (requerido)
 */
export const ApproveTextSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  comments: z.string().optional(),
  reviewed_by: z.string().min(1),
});

export type ApproveTextInput = z.infer<typeof ApproveTextSchema>;

/**
 * Valida input de waiter pasivo approve-text.
 * Lanza ZodError si no cumple el schema.
 */
export function validateApproveText(input: unknown): ApproveTextInput {
  return ApproveTextSchema.parse(input);
}
