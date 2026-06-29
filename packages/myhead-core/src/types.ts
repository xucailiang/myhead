export type AgentName = string;
export type WorkspaceId = string;
export type RunId = string;

export const KNOWN_AGENT_NAMES = ['claude', 'codex'] as const;
export type KnownAgentName = (typeof KNOWN_AGENT_NAMES)[number];

export type HubStatus =
  | 'listening'
  | 'message_queued'
  | 'reviewing'
  | 'verifying'
  | 'replying'
  | 'needs_user_decision'
  | 'continue'
  | 'revise'
  | 'accepted'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export type AgentStatus =
  | 'idle'
  | 'running'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'done';

export type HubMessage = {
  id?: string;
  role: string;
  content: string;
  timestamp: number;
  visibility?: 'hub' | 'debug';
  seenHubOffset?: number;
};

export const HUB_ROLES = {
  MYHEAD: 'myhead',
  USER: 'user',
} as const;

export type ConfirmedPlan = {
  text: string;
  hash: string;
  summary: string;
  promptSnapshot?: string;
};

export type ContextPolicy = {
  mode: 'full';
  version: number;
};

export type ContextSnapshot = {
  id: string;
  targetAgent: AgentName;
  hubLogOffset: number;
  estimatedTokens: number;
  contextPolicyVersion: number;
  compressedArtifact: null;
  createdAt: number;
};

export type AgentSession = {
  sessionId?: string;
  cwd: string;
  worktree?: string | null;
  startedAt?: number;
  updatedAt?: number;
};

export type TurnInvocation = {
  id: string;
  agent: AgentName;
  command: string;
  args: string[];
  cwd: string;
  inputArtifactId?: string;
  outputArtifactIds: string[];
  contextSnapshotId?: string;
  resumeSessionId?: string;
  newSessionId?: string;
  sessionId?: string;
  exitCode?: number | null;
  startedAt: number;
  endedAt?: number;
};

export type VerificationResult = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  summary: string;
  passed: boolean;
};

export type HubTurn = {
  id: string;
  inboundMessageId?: string;
  review?: unknown;
  replyMessageId?: string;
  verification?: VerificationResult;
  statusBefore: HubStatus;
  statusAfter: HubStatus;
  createdAt: number;
};

export type BlockedEventReason =
  | 'capability_missing'
  | 'permission_prompt'
  | 'ask_option'
  | 'context_overflow'
  | 'session_unavailable'
  | 'workspace_isolation_failed'
  | 'needs_user_decision';

export type BlockedEvent = {
  id: string;
  agent?: AgentName;
  reason: BlockedEventReason;
  detail: string;
  artifactIds?: string[];
  createdAt: number;
};

export type ArtifactKind =
  | 'prompt'
  | 'system_prompt'
  | 'stdout'
  | 'stderr'
  | 'last_message'
  | 'stream_json'
  | 'diff'
  | 'verification'
  | 'raw';

export type HubArtifact = {
  id: string;
  kind: ArtifactKind;
  path: string;
  sha256?: string;
  createdAt: number;
};

export type FinalResult = {
  verdict: 'accepted' | 'failed' | 'blocked' | 'cancelled';
  summary: string;
  changedFiles: string[];
  verification: VerificationResult[];
  risks: string[];
  nextSteps: string[];
};

export type ResumeCheckpoint = {
  hubLogOffset: number;
  currentStep?: string;
  agentSessions: Partial<Record<AgentName, string>>;
  updatedAt: number;
};
