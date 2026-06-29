import { z } from 'zod';

const stringArraySchema = z.preprocess((value) => normalizeStringArray(value), z.array(z.string()));

const workerStrategySchema = z.preprocess((value) => {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item).toLowerCase());
    if (items.includes('both') || (items.includes('codex') && items.includes('claude'))) return 'both';
    const first = items.find((item) => item === 'codex' || item === 'claude');
    return first ?? value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'both' || (normalized.includes('codex') && normalized.includes('claude'))) return 'both';
    if (normalized.includes('claude')) return 'claude';
    if (normalized.includes('codex')) return 'codex';
  }
  return value;
}, z.enum(['codex', 'claude', 'both']));

const assignmentsSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([agent, assignments]) => [agent, normalizeStringArray(assignments)]),
  );
}, z.record(z.string(), z.array(z.string())));

const collaborationPlanSchema = z.preprocess((value) => {
  if (typeof value === 'string') return null;
  return value;
}, z.object({
  mode: z.enum(['single_worker', 'parallel_cooperate']),
  assignments: assignmentsSchema,
  coordinationRules: stringArraySchema,
}).nullable().optional());

export const implementationPlanSchema = z.object({
  goal: z.string(),
  steps: z.array(z.object({
    id: z.string(),
    description: z.string(),
    expectedOutput: z.string(),
    dependsOn: stringArraySchema.nullable().optional(),
  })),
  constraints: stringArraySchema,
  successCriteria: stringArraySchema,
  risks: z.array(z.object({
    description: z.string(),
    severity: z.enum(['low', 'medium', 'high']),
    mitigation: z.string(),
  })),
  workerStrategy: workerStrategySchema,
  collaborationPlan: collaborationPlanSchema,
  verificationPlan: z.array(z.object({
    command: z.string(),
    expectedExitCode: z.number().nullable().optional(),
    description: z.string(),
  })),
});

export type ImplementationPlan = z.infer<typeof implementationPlanSchema>;

function normalizeStringArray(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === 'string' ? item : String(item));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (value === null || value === undefined) return [];
  return [String(value)];
}
