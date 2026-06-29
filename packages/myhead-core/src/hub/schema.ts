import { z } from 'zod';
import type {
  AgentName,
  AgentStatus,
  AgentSession,
  BlockedEvent,
  ContextPolicy,
  ContextSnapshot,
  FinalResult,
  HubArtifact,
  HubMessage,
  HubStatus,
  HubTurn,
  ConfirmedPlan,
  ResumeCheckpoint,
  TurnInvocation,
} from '../types.js';

export const hubMessageSchema: z.ZodType<HubMessage> = z.object({
  id: z.string().optional(),
  role: z.string(),
  content: z.string(),
  timestamp: z.number(),
  visibility: z.enum(['hub', 'debug']).optional(),
  seenHubOffset: z.number().optional(),
});

export const confirmedPlanSchema: z.ZodType<ConfirmedPlan> = z.object({
  text: z.string(),
  hash: z.string(),
  summary: z.string(),
  promptSnapshot: z.string().optional(),
});

export const contextPolicySchema: z.ZodType<ContextPolicy> = z.object({
  mode: z.literal('full'),
  version: z.number(),
});

export const contextSnapshotSchema: z.ZodType<ContextSnapshot> = z.object({
  id: z.string(),
  targetAgent: z.string(),
  hubLogOffset: z.number(),
  estimatedTokens: z.number(),
  contextPolicyVersion: z.number(),
  compressedArtifact: z.null(),
  createdAt: z.number(),
});

export const agentSessionSchema: z.ZodType<AgentSession> = z.object({
  sessionId: z.string().optional(),
  cwd: z.string(),
  worktree: z.string().nullable().optional(),
  startedAt: z.number().optional(),
  updatedAt: z.number().optional(),
});

export const agentStatusSchema: z.ZodType<AgentStatus> = z.enum([
  'idle',
  'running',
  'blocked',
  'failed',
  'cancelled',
  'done',
]);

export const hubStatusSchema: z.ZodType<HubStatus> = z.enum([
  'listening',
  'message_queued',
  'reviewing',
  'verifying',
  'replying',
  'needs_user_decision',
  'continue',
  'revise',
  'accepted',
  'failed',
  'blocked',
  'cancelled',
]);

export const artifactSchema: z.ZodType<HubArtifact> = z.object({
  id: z.string(),
  kind: z.enum([
    'prompt',
    'system_prompt',
    'stdout',
    'stderr',
    'last_message',
    'stream_json',
    'diff',
    'verification',
    'raw',
  ]),
  path: z.string(),
  sha256: z.string().optional(),
  createdAt: z.number(),
});

export const turnInvocationSchema: z.ZodType<TurnInvocation> = z.object({
  id: z.string(),
  agent: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  inputArtifactId: z.string().optional(),
  outputArtifactIds: z.array(z.string()),
  contextSnapshotId: z.string().optional(),
  resumeSessionId: z.string().optional(),
  newSessionId: z.string().optional(),
  sessionId: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
});

export const resumeCheckpointSchema: z.ZodType<ResumeCheckpoint> = z.object({
  hubLogOffset: z.number(),
  currentStep: z.string().optional(),
  agentSessions: z.record(z.string(), z.string()),
  updatedAt: z.number(),
});

export const hubJsonSchema = z.object({
  schemaVersion: z.literal(1),
  hubId: z.string(),
  runId: z.string(),
  workspaceId: z.string(),
  workspacePath: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  status: hubStatusSchema,
  confirmedPlan: confirmedPlanSchema.nullable(),
  selectedAgents: z.array(z.string()),
  promptInjection: z.record(z.string(), z.string()),
  permissionMode: z.record(z.string(), z.string()),
  agentSessions: z.record(z.string(), agentSessionSchema),
  hubLog: z.array(hubMessageSchema),
  pendingQueue: z.array(z.string()),
  agentCursors: z.record(z.string(), z.number()),
  agentStatus: z.record(z.string(), agentStatusSchema),
  contextPolicy: contextPolicySchema,
  contextSnapshots: z.array(contextSnapshotSchema),
  turnInvocations: z.array(turnInvocationSchema),
  turns: z.array(z.custom<HubTurn>()),
  blockedEvents: z.array(z.custom<BlockedEvent>()),
  artifacts: z.array(artifactSchema),
  finalResult: z.custom<FinalResult>().nullable(),
  resumeCheckpoint: resumeCheckpointSchema.nullable(),
});

export type HubJson = z.infer<typeof hubJsonSchema>;

export type CreateHubOptions = {
  runId?: string;
  workspaceId?: string;
  confirmedPlan?: ConfirmedPlan;
  promptInjection?: Record<string, string>;
  permissionMode?: Record<string, string>;
};

export function createEmptyHub(
  hubId: string,
  workspacePath: string,
  selectedAgents: AgentName[],
  options: CreateHubOptions = {},
): HubJson {
  const now = Date.now();
  const agentStatus = Object.fromEntries(
    selectedAgents.map((a) => [a, 'idle' as AgentStatus]),
  ) as Record<AgentName, AgentStatus>;
  const agentCursors = Object.fromEntries(
    selectedAgents.map((a) => [a, 0]),
  ) as Record<AgentName, number>;

  return {
    schemaVersion: 1,
    hubId,
    runId: options.runId ?? hubId,
    workspaceId: options.workspaceId ?? workspacePath,
    workspacePath,
    createdAt: now,
    updatedAt: now,
    status: 'listening',
    confirmedPlan: options.confirmedPlan ?? null,
    selectedAgents,
    promptInjection: options.promptInjection ?? {},
    permissionMode: options.permissionMode ?? {},
    agentSessions: {},
    hubLog: [],
    pendingQueue: [],
    agentCursors,
    agentStatus,
    contextPolicy: { mode: 'full', version: 1 },
    contextSnapshots: [],
    turnInvocations: [],
    turns: [],
    blockedEvents: [],
    artifacts: [],
    finalResult: null,
    resumeCheckpoint: null,
  };
}
