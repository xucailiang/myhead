export type HubSummary = {
  hubId: string;
  runId: string;
  workspaceId: string;
  workspacePath: string;
  status: string;
  createdAt: number;
  updatedAt: number;
};

export type HubListResponse = {
  hubs: HubSummary[];
};

export type HubDetailResponse = {
  hubId: string;
  runId: string;
  workspaceId: string;
  workspacePath: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  confirmedPlan: {
    text: string;
    hash: string;
    summary: string;
  } | null;
  finalResult: {
    verdict: 'accepted' | 'failed' | 'blocked' | 'cancelled';
    summary: string;
    changedFiles: string[];
    verification: Array<{
      command: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      summary: string;
      passed: boolean;
    }>;
    risks: string[];
    nextSteps: string[];
  } | null;
  hubLog: Array<{
    id?: string;
    role: string;
    content: string;
    timestamp: number;
  }>;
};

export type UserMessageRequest = {
  content: string;
};
