export type PlanRequest = {
  message?: string;
  messages?: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
};

export type PlanDelta = {
  type: 'text_delta' | 'plan_structured';
  content: string;
};

export type PlanConfirmRequest = {
  planEncoded?: string;
  planText?: string;
  workerStrategy: 'codex' | 'claude' | 'both';
};

export type PlanConfirmResponse = {
  workspaceId: string;
  runId: string;
  hubId: string;
};
