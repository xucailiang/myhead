import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAgentDef } from './registry.js';
import { resolveAgentLaunch } from './launch.js';
import { execAgentFile } from './invocation.js';
import { createClaudeStreamHandler } from './parsers/claude-stream.js';
import { createJsonEventStreamHandler } from './parsers/json-event-stream.js';
import type { RuntimeAgentDef, RuntimeBuildOptions, RuntimeContext, RuntimeExecOptions } from './types.js';

export type AgentEvent = Record<string, unknown>;

export type RunAgentOptions = {
  prompt: string;
  cwd?: string;
  env?: Record<string, string>;
  model?: string;
  reasoning?: string;
  extraAllowedDirs?: string[];
  resumeSessionId?: string;
  newSessionId?: string;
  artifactDir?: string;
  turnId?: string;
  systemPrompt?: string;
  signal?: AbortSignal;
};

export class AgentRuntimeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly exitCode: number | null = null,
  ) {
    super(message);
    this.name = 'AgentRuntimeError';
  }
}

export async function* runAgent(
  agentId: string,
  options: RunAgentOptions,
): AsyncIterable<AgentEvent> {
  const def = getAgentDef(agentId);
  if (!def) {
    throw new AgentRuntimeError(`Unknown agent: ${agentId}`, 'UNKNOWN_AGENT');
  }
  yield* runAgentDef(def, options);
}

export async function* runAgentDef(
  def: RuntimeAgentDef,
  options: RunAgentOptions,
): AsyncIterable<AgentEvent> {
  const launch = resolveAgentLaunch(def);
  if (!launch.launchPath) {
    throw new AgentRuntimeError(`Agent binary not found: ${def.bin}`, 'AGENT_NOT_FOUND');
  }

  const buildOptions: RuntimeBuildOptions = {
    prompt: options.prompt,
    model: options.model,
    reasoning: options.reasoning,
  };
  const artifacts = await prepareArtifacts(def, options);

  const runtimeContext: RuntimeContext = {
    cwd: options.cwd,
    resumeSessionId: options.resumeSessionId,
    newSessionId: options.newSessionId ?? (def.resumesSessionViaCli ? randomUUID() : undefined),
    lastMessagePath: artifacts.lastMessagePath,
    appendSystemPromptFile: artifacts.systemPromptPath,
  };

  const args = def.buildArgs(
    options.prompt,
    [],
    options.extraAllowedDirs ?? [],
    buildOptions,
    runtimeContext,
  );

  const execOptions: RuntimeExecOptions = {
    cwd: options.cwd,
    env: buildAgentEnv(def, options.env),
    signal: options.signal,
  };

  const child = execAgentFile(launch.launchPath, args, execOptions);
  const events: AgentEvent[] = [];
  let done = false;
  let error: unknown = null;
  let stdoutBuffer = '';
  let stderrBuffer = '';

  const pushEvent = (ev: AgentEvent) => {
    events.push(ev);
    // Wake up the generator if it's waiting
    if (waitResolve) {
      waitResolve();
      waitResolve = null;
    }
  };

  let waitResolve: (() => void) | null = null;

  function waitForEvent(): Promise<void> {
    return new Promise((resolve) => {
      waitResolve = resolve;
    });
  }

  // Create the appropriate stream handler based on streamFormat.
  let handler: { feed: (chunk: string) => void; flush: () => void } | null = null;

  if (def.streamFormat === 'claude-stream-json') {
    handler = createClaudeStreamHandler(
      (ev) => pushEvent(ev as AgentEvent),
      { suppressHtmlArtifactsAfterFileWrite: def.id === 'claude' },
    );
  } else if (def.streamFormat === 'json-event-stream') {
    handler = createJsonEventStreamHandler(
      def.eventParser || def.id,
      (ev) => pushEvent(ev as AgentEvent),
    );
  } else {
    // Plain text fallback: emit raw stdout chunks.
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk);
      stdoutBuffer += text;
      pushEvent({ type: 'stdout', chunk: text });
    });
  }

  if (handler) {
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk);
      stdoutBuffer += text;
      handler!.feed(text);
    });
    child.on('close', () => handler!.flush());
  }

  child.stderr?.on('data', (chunk) => {
    const text = String(chunk);
    stderrBuffer += text;
    pushEvent({ type: 'stderr', chunk: text });
  });

  child.on('error', (err: Error) => {
    error = err;
    done = true;
    if (waitResolve) waitResolve();
  });

  let exitCode: number | null = null;
  child.on('close', (code) => {
    exitCode = code ?? null;
    done = true;
    if (waitResolve) waitResolve();
  });

  pushEvent({
    type: 'invocation_started',
    command: launch.launchPath,
    args,
    cwd: options.cwd,
    artifacts,
    resumeSessionId: runtimeContext.resumeSessionId,
    newSessionId: runtimeContext.newSessionId,
  });

  // Write prompt to stdin if the adapter expects it.
  if (def.promptViaStdin && child.stdin) {
    const promptInputFormat = def.promptInputFormat ?? 'text';
    if (promptInputFormat === 'stream-json') {
      const userMessage = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: options.prompt }],
        },
      });
      child.stdin.write(`${userMessage}\n`, 'utf8');
    } else {
      child.stdin.end(options.prompt, 'utf8');
    }
  }

  try {
    while (!done || events.length > 0) {
      while (events.length > 0) {
        yield events.shift()!;
      }
      if (!done) {
        await waitForEvent();
      }
    }
  } finally {
    if (!child.killed) {
      child.kill();
    }
  }

  await writeOutputArtifacts(artifacts, stdoutBuffer, stderrBuffer);
  yield {
    type: 'invocation_completed',
    command: launch.launchPath,
    args,
    cwd: options.cwd,
    artifacts,
    exitCode,
    resumeSessionId: runtimeContext.resumeSessionId,
    newSessionId: runtimeContext.newSessionId,
  };

  if (error instanceof Error) {
    if (options.signal?.aborted && error.name === 'AbortError') {
      throw new AgentRuntimeError('Agent run aborted by MyHead', 'AGENT_ABORTED', exitCode);
    }
    throw new AgentRuntimeError(error.message, 'AGENT_EXECUTION_FAILED');
  }

  if (exitCode !== 0 && exitCode !== null) {
    throw new AgentRuntimeError(
      `Agent exited with code ${exitCode}`,
      'AGENT_EXIT_ERROR',
      exitCode,
    );
  }
}

function buildAgentEnv(
  def: RuntimeAgentDef,
  explicitEnv: RunAgentOptions['env'],
): Record<string, string> | undefined {
  if (explicitEnv) return explicitEnv;
  if (def.id !== 'codex' || !process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) {
    return undefined;
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // Codex Desktop can inject an internal API key into child processes. If
  // inherited, it overrides the user's configured Codex CLI auth and can make
  // worker runs fail with invalid_api_key.
  delete env.CODEX_API_KEY;
  return env;
}

export type AgentRunArtifacts = {
  turnId: string;
  promptPath?: string;
  systemPromptPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  streamJsonPath?: string;
  lastMessagePath?: string;
};

async function prepareArtifacts(
  def: RuntimeAgentDef,
  options: RunAgentOptions,
): Promise<AgentRunArtifacts> {
  const turnId = options.turnId ?? randomUUID();
  const artifacts: AgentRunArtifacts = { turnId };
  if (!options.artifactDir) return artifacts;

  await fs.mkdir(options.artifactDir, { recursive: true });
  const prefix = path.join(options.artifactDir, turnId);
  artifacts.promptPath = `${prefix}-prompt.md`;
  artifacts.stdoutPath = `${prefix}-stdout.log`;
  artifacts.stderrPath = `${prefix}-stderr.log`;
  artifacts.streamJsonPath = `${prefix}-stream.jsonl`;
  await fs.writeFile(artifacts.promptPath, options.prompt, 'utf8');

  if (def.id === 'codex') {
    artifacts.lastMessagePath = `${prefix}-last-message.txt`;
  }
  if (def.id === 'claude') {
    artifacts.systemPromptPath = `${prefix}-system-prompt.md`;
    await fs.writeFile(
      artifacts.systemPromptPath,
      options.systemPrompt ?? 'You are a MyHead worker. Follow the provided execution context and report only to MyHead.',
      'utf8',
    );
  }
  return artifacts;
}

async function writeOutputArtifacts(
  artifacts: AgentRunArtifacts,
  stdout: string,
  stderr: string,
): Promise<void> {
  const writes: Array<Promise<void>> = [];
  if (artifacts.stdoutPath) writes.push(fs.writeFile(artifacts.stdoutPath, stdout, 'utf8'));
  if (artifacts.streamJsonPath) writes.push(fs.writeFile(artifacts.streamJsonPath, stdout, 'utf8'));
  if (artifacts.stderrPath) writes.push(fs.writeFile(artifacts.stderrPath, stderr, 'utf8'));
  await Promise.all(writes);
}
