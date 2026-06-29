export type RuntimeEnv = NodeJS.ProcessEnv | Record<string, string>;

export type RuntimeModelOption = {
  id: string;
  label: string;
};

export type RuntimeBuildOptions = {
  prompt?: string;
  model?: string;
  reasoning?: string;
  imagePaths?: string[];
};

export type RuntimeContext = {
  resumeSessionId?: string;
  newSessionId?: string;
  cwd?: string;
  lastMessagePath?: string;
  appendSystemPromptFile?: string;
};

export type RuntimeCapabilityMap = Record<string, boolean>;

export type RuntimeListModels = {
  args: string[];
  parse: (stdout: string) => RuntimeModelOption[] | null;
  timeoutMs: number;
};

export type RuntimeAgentDef = {
  id: string;
  name: string;
  bin: string;
  fallbackBins?: string[];
  versionArgs?: string[];
  authProbe?: { args: string[]; timeoutMs: number };
  helpArgs?: string[];
  capabilityFlags?: Record<string, string>;
  fallbackModels?: RuntimeModelOption[];
  listModels?: RuntimeListModels;
  reasoningOptions?: RuntimeModelOption[];
  buildArgs: (
    prompt: string,
    imagePaths: string[],
    extraAllowedDirs: string[],
    options: RuntimeBuildOptions,
    runtimeContext: RuntimeContext,
  ) => string[];
  promptViaStdin?: boolean;
  promptInputFormat?: 'text' | 'stream-json';
  streamFormat?: string;
  eventParser?: string;
  externalMcpInjection?: string;
  resumesSessionViaCli?: boolean;
};

export type DetectedAgent = {
  id: string;
  name: string;
  version: string | null;
  path: string | null;
  capabilities: RuntimeCapabilityMap;
};

export type RuntimeExecOptions = {
  cwd?: string;
  env?: RuntimeEnv;
  timeout?: number;
  signal?: AbortSignal;
};

export type AgentLaunchResolution = {
  launchPath: string | null;
  childPathPrepend: string[];
};
