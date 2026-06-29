import { z } from 'zod';

const nullableFindingFileSchema = z.union([z.string(), z.null(), z.undefined()])
  .transform((value): string | null => {
    if (value === undefined || value === null) return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return null;
    return trimmed;
  });

const nullableFindingLineSchema = z.union([z.number(), z.string(), z.null(), z.undefined()])
  .transform((value): number | null => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number') return value;
    const trimmed = value.trim();
    if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  });

export const reviewVerdictSchema = z.object({
  status: z.enum([
    'accepted',
    'continue',
    'revise',
    'verify',
    'needs_user_decision',
    'failed',
    'blocked',
  ]),
  summary: z.string(),
  findings: z.array(z.object({
    severity: z.enum(['info', 'warning', 'critical']),
    description: z.string(),
    file: nullableFindingFileSchema.optional(),
    line: nullableFindingLineSchema.optional(),
  })),
  missingVerification: z.array(z.string()),
  recommendedReply: z.string(),
  nextStep: z.string().nullable().optional(),
});

export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;
