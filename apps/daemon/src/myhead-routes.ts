import type { Express, Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { detectAgents, AGENT_DEFS, runAgent as runRuntimeAgent } from '@myhead/agent-runtime';
import {
  ControllerLoop,
  HubWriter,
  createEmptyHub,
  createOpenAiClient,
  createClaudeClient,
  DEFAULT_PLANNING_PROMPT,
  implementationPlanSchema,
  MyHeadConfigSchema,
  defaultConfigPath,
  type ImplementationPlan,
  type HubArtifact,
  type HubJson,
  type ModelClient,
  type WorkerDispatchContext,
} from '@myhead/myhead-core';
import type {
  PlanRequest,
  PlanConfirmResponse,
  HubListResponse,
  HubDetailResponse,
  HubSummary,
  UserMessageRequest,
  MyHeadSseEvent,
  WorkspaceRegisterRequest,
  WorkspaceRegisterResponse,
  WorkspaceListResponse,
} from '@myhead/contracts';
import fs from 'node:fs';
import path from 'node:path';
import { getHubsDir, getHubPath } from './daemon-paths.js';
import { WorkspaceRegistry, type WorkspaceContext } from './workspace-registry.js';

type ActiveLoopRecord = {
  workspaceId: string;
  runId: string;
  hubId: string;
  workspacePath: string;
  loop: ControllerLoop;
};

const workspaceRegistry = new WorkspaceRegistry();
const activeLoops = new Map<string, ActiveLoopRecord>();

export type RegisterMyHeadRoutesOptions = {
  initialWorkspacePath?: string | null;
  createModelClient?: () => ModelClient;
  runAgent?: typeof runRuntimeAgent;
};

export async function cancelActiveLoops(reason = 'MyHead daemon is shutting down'): Promise<void> {
  await Promise.all([...activeLoops.values()].map(async (active) => {
    await active.loop.cancel(reason);
    activeLoops.delete(active.hubId);
  }));
}

function loadConfig() {
  const configPath = defaultConfigPath();
  if (!fs.existsSync(configPath)) return null;
  const raw = fs.readFileSync(configPath, 'utf8');
  return MyHeadConfigSchema.parse(JSON.parse(raw));
}

function saveConfig(input: unknown) {
  const parsed = MyHeadConfigSchema.parse(input);
  const configPath = defaultConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const normalized = {
    ...parsed,
    baseUrl: parsed.baseUrl?.trim() || undefined,
  };
  fs.writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return { config: normalized, configPath };
}

function createConfiguredModelClient() {
  const config = loadConfig();
  if (!config) throw new Error('No MyHead config found. Run `myhead .` to configure.');

  if (config.protocol === 'claude') {
    return createClaudeClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      defaultModel: config.model,
    });
  }
  return createOpenAiClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    defaultModel: config.model,
  });
}

function getWorkspaceOr404(req: Request, res: Response): WorkspaceContext | null {
  const rawWorkspaceId = req.params.workspaceId;
  const workspaceId = Array.isArray(rawWorkspaceId) ? rawWorkspaceId[0] : rawWorkspaceId;
  if (!workspaceId) {
    res.status(400).json({ error: 'MISSING_WORKSPACE_ID' });
    return null;
  }
  const workspace = workspaceRegistry.get(workspaceId);
  if (!workspace) {
    res.status(404).json({ error: 'WORKSPACE_NOT_FOUND', workspaceId });
    return null;
  }
  return workspace;
}

function toWorkspaceDto(workspace: WorkspaceContext) {
  return {
    workspaceId: workspace.workspaceId,
    absolutePath: workspace.absolutePath,
    stateDir: workspace.stateDir,
    displayName: workspace.displayName,
    createdAt: workspace.createdAt,
    lastUsedAt: workspace.lastUsedAt,
  };
}

function readHubSnapshot(hubPath: string): HubJson | null {
  try {
    return JSON.parse(fs.readFileSync(hubPath, 'utf8')) as HubJson;
  } catch {
    return null;
  }
}

function writeHubSnapshot(
  res: Response,
  hub: HubJson,
  scope: { workspaceId: string; runId: string; hubId: string },
): void {
  res.write(`data: ${JSON.stringify({ ...scope, type: 'hub_status', status: hub.status, snapshot: true })}\n\n`);
  for (const msg of hub.hubLog ?? []) {
    res.write(`data: ${JSON.stringify({
      ...scope,
      type: 'hub_message',
      id: msg.id,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      snapshot: true,
    })}\n\n`);
  }
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function registerMyHeadRoutes(app: Express, options: RegisterMyHeadRoutesOptions = {}) {
  const createModelClient = options.createModelClient ?? createConfiguredModelClient;
  const runAgent = options.runAgent ?? runRuntimeAgent;

  if (options.initialWorkspacePath) {
    workspaceRegistry.register(options.initialWorkspacePath);
  }

  app.get('/api/workspaces', (_req: Request, res: Response) => {
    const response: WorkspaceListResponse = {
      workspaces: workspaceRegistry.list().map(toWorkspaceDto),
    };
    res.json(response);
  });

  app.post('/api/workspaces', (req: Request, res: Response) => {
    const body = req.body as WorkspaceRegisterRequest;
    if (!body.path) {
      res.status(400).json({ error: 'MISSING_WORKSPACE_PATH' });
      return;
    }
    try {
      const workspace = workspaceRegistry.register(body.path);
      const response: WorkspaceRegisterResponse = { workspace: toWorkspaceDto(workspace) };
      res.json(response);
    } catch (err) {
      res.status(400).json({ error: 'WORKSPACE_INVALID', message: (err as Error).message });
    }
  });

  // POST /api/pick-workspace — open native folder picker, return path
  app.post('/api/pick-workspace', (_req: Request, res: Response) => {
    const script = `
      tell application "System Events"
        set frontApp to name of first application process whose frontmost is true
      end tell
      tell application "Finder"
        activate
        set f to choose folder with prompt "Select workspace folder"
        POSIX path of f
      end tell
      tell application frontApp to activate
    `;
    execFile('osascript', ['-e', script], { timeout: 30000 }, (err: Error | null, stdout: string) => {
      if (err) {
        res.json({ cancelled: true });
        return;
      }
      const p = stdout.trim();
      if (!p) {
        res.json({ cancelled: true });
        return;
      }
      try {
        const workspace = workspaceRegistry.register(p);
        res.json({ path: p, workspace: toWorkspaceDto(workspace) });
      } catch (registerErr) {
        res.status(400).json({ error: 'WORKSPACE_INVALID', message: (registerErr as Error).message });
      }
    });
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/agents', async (_req: Request, res: Response) => {
    try {
      const agents = await detectAgents(AGENT_DEFS);
      res.json({ agents });
    } catch (err) {
      res.status(500).json({ error: 'AGENT_DETECTION_FAILED', message: (err as Error).message });
    }
  });

  app.get('/api/config', (_req: Request, res: Response) => {
    try {
      const configPath = defaultConfigPath();
      const config = loadConfig();
      if (!config) {
        res.json({ configured: false, configPath });
        return;
      }
      res.json({
        configured: true,
        protocol: config.protocol,
        baseUrl: config.baseUrl ?? '',
        model: config.model,
        configPath,
      });
    } catch {
      res.json({ configured: false });
    }
  });

  app.post('/api/config', (req: Request, res: Response) => {
    try {
      const { config, configPath } = saveConfig(req.body);
      res.json({
        configured: true,
        protocol: config.protocol,
        baseUrl: config.baseUrl ?? '',
        model: config.model,
        configPath,
      });
    } catch (err) {
      res.status(400).json({ error: 'CONFIG_INVALID', message: (err as Error).message });
    }
  });

  app.post('/api/workspaces/:workspaceId/plan', async (req: Request, res: Response) => {
    const workspace = getWorkspaceOr404(req, res);
    if (!workspace) return;
    await handlePlanRequest(req, res, createModelClient);
  });

  app.post('/api/workspaces/:workspaceId/plan/structured', async (req: Request, res: Response) => {
    const workspace = getWorkspaceOr404(req, res);
    if (!workspace) return;
    await handleStructuredPlanRequest(req, res, createModelClient);
  });

  // POST /api/plan — stream planning conversation
  app.post('/api/plan', async (req: Request, res: Response) => {
    await handlePlanRequest(req, res, createModelClient);
  });

  // POST /api/plan/structured — ask model to output structured plan
  app.post('/api/plan/structured', async (req: Request, res: Response) => {
    await handleStructuredPlanRequest(req, res, createModelClient);
  });

  // POST /api/workspaces/:workspaceId/hub — create execution hub from confirmed plan
  app.post('/api/workspaces/:workspaceId/hub', async (req: Request, res: Response) => {
    const workspace = getWorkspaceOr404(req, res);
    if (!workspace) return;
    const workspacePath = workspace.absolutePath;
    const body = req.body as { planText?: string; workerStrategy?: string; planEncoded?: string };
    const workerStrategy = (body.workerStrategy ?? 'codex') as 'codex' | 'claude' | 'both';

    // Accept either raw planText or base64-encoded JSON plan.
    let planText = body.planText ?? '';
    if (body.planEncoded) {
      try {
        planText = Buffer.from(body.planEncoded, 'base64').toString('utf8');
      } catch { /* use empty */ }
    }
    if (!planText.trim()) {
      res.status(400).json({ error: 'MISSING_PLAN', message: 'Provide planText or planEncoded' });
      return;
    }

    try {
      const plan = parsePlanFromText(planText, workerStrategy);

      const runId = randomUUID();
      const hubId = randomUUID();
      const hubPath = getHubPath(workspacePath, hubId);
      const hubWriter = new HubWriter(hubPath);
      const selectedAgents = plan.workerStrategy === 'both' ? ['claude', 'codex'] : [plan.workerStrategy];
      const confirmedPlan = {
        text: planText,
        hash: hashText(planText),
        summary: plan.goal,
        promptSnapshot: DEFAULT_PLANNING_PROMPT,
      };

      const hub = createEmptyHub(hubId, workspacePath, selectedAgents, {
        runId,
        workspaceId: workspace.workspaceId,
        confirmedPlan,
        promptInjection: Object.fromEntries(selectedAgents.map((agent) => [agent, agent === 'claude' ? 'append-system-prompt-file' : 'stdin-prompt-package'])),
        permissionMode: Object.fromEntries(selectedAgents.map((agent) => [agent, agent === 'claude' ? 'dangerously-skip-permissions' : 'dangerously-bypass-approvals-and-sandbox'])),
      });
      await hubWriter.writeHub(hub);

      const onDispatch = async (
        agent: string,
        prompt: string,
        dispatchContext: WorkerDispatchContext,
      ) => {
        const lines: string[] = [];
        const turnId = randomUUID();
        let capturedSessionId = await readResumeSessionId(hubWriter, agent);
        const artifactDir = path.join(workspacePath, '.myhead', 'runs', runId, 'artifacts');
        const stream = runAgent(agent, {
          prompt,
          cwd: workspacePath,
          artifactDir,
          turnId,
          resumeSessionId: capturedSessionId,
          systemPrompt: DEFAULT_PLANNING_PROMPT,
          signal: dispatchContext.signal,
        });
        for await (const ev of stream) {
          const t = (ev as { type?: string }).type;
          capturedSessionId = sessionIdFromEvent(ev) ?? capturedSessionId;
          if (t === 'invocation_started') {
            await recordInvocationStarted(
              hubWriter,
              ev,
              turnId,
              agent,
              workspacePath,
              dispatchContext,
            );
          } else if (t === 'invocation_completed') {
            capturedSessionId = sessionIdFromEvent(ev) ?? capturedSessionId;
            await recordInvocationCompleted(
              hubWriter,
              ev,
              turnId,
              agent,
              workspacePath,
              capturedSessionId ?? null,
            );
          } else
          if (t === 'text_delta') {
            const delta = (ev as { delta: string }).delta;
            lines.push(delta);
            dispatchContext.emitDelta(delta);
          } else if (t === 'thinking_delta') {
            // Thinking is captured in stream artifacts and hidden from the live hub transcript.
          } else if (t === 'stderr') {
            // stderr is captured as a debug artifact and hidden from the live hub transcript.
          } else if (t === 'raw') {
            const line = (ev as { line: string }).line;
            try {
              const parsed = JSON.parse(line);
              if (parsed.type === 'item.completed' && parsed.item?.type === 'agent_message') {
                const text = parsed.item.text ?? '';
                if (text) lines.push(text);
              }
            } catch {
              // raw JSONL is captured as a debug artifact and not shown by default.
            }
          }
        }
        if (lines.length === 0) {
          return [{ role: agent, content: '(no output)' }];
        }
        return [{ role: agent, content: lines.join('') }];
      };

      const model = createModelClient();
      let loop!: ControllerLoop;
      loop = new ControllerLoop({
        hubWriter,
        model,
        plan,
        workspacePath,
        hubId,
        initialHub: hub,
        onDispatch,
        onTerminal: () => {
          const active = activeLoops.get(hubId);
          if (active?.loop === loop) {
            activeLoops.delete(hubId);
          }
        },
      });
      activeLoops.set(hubId, {
        workspaceId: workspace.workspaceId,
        runId,
        hubId,
        workspacePath,
        loop,
      });

      const response: PlanConfirmResponse = { workspaceId: workspace.workspaceId, runId, hubId };
      res.json(response);

      void loop.start().catch((err) => {
        console.error(`Failed to start hub ${hubId}:`, err);
      });
    } catch (err) {
      res.status(400).json({ error: 'PLAN_INVALID', message: (err as Error).message });
    }
  });

  // GET /api/workspaces/:workspaceId/hub/:id/events — SSE event stream
  app.get('/api/workspaces/:workspaceId/hub/:id/events', async (req: Request, res: Response) => {
    const workspace = getWorkspaceOr404(req, res);
    if (!workspace) return;
    const id = req.params.id as string;
    const workspacePath = workspace.absolutePath;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const active = activeLoops.get(id);
    const hubPath = getHubPath(workspacePath, id);
    if (!active || active.workspaceId !== workspace.workspaceId) {
      const snapshot = readHubSnapshot(hubPath);
      if (snapshot && snapshot.workspaceId === workspace.workspaceId) {
        writeHubSnapshot(res, snapshot, {
          workspaceId: snapshot.workspaceId,
          runId: snapshot.runId,
          hubId: snapshot.hubId,
        });
      } else {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Hub not found', code: 'HUB_NOT_FOUND', workspaceId: workspace.workspaceId, hubId: id })}\n\n`);
      }
      res.end();
      return;
    }

    // Send snapshot: current status + full hubLog so reconnecting clients catch up.
    const snapshot = readHubSnapshot(hubPath);
    if (snapshot) {
      writeHubSnapshot(res, snapshot, {
        workspaceId: active.workspaceId,
        runId: active.runId,
        hubId: active.hubId,
      });
    }

    let closed = false;
    const streamController = new AbortController();
    req.on('close', () => {
      closed = true;
      streamController.abort();
    });

    (async () => {
      try {
        for await (const ev of active.loop.events({ replay: false, signal: streamController.signal })) {
          if (closed) break;
          const sseEvent = toSseEvent(ev, active);
          res.write(`data: ${JSON.stringify(sseEvent)}\n\n`);
        }
      } catch (err) {
        if (!closed) {
          res.write(`data: ${JSON.stringify({ type: 'error', message: (err as Error).message, code: 'LOOP_ERROR' })}\n\n`);
        }
      }
      if (!closed) res.end();
    })().catch(() => {});
  });

  // POST /api/workspaces/:workspaceId/hub/:id/message — push user message into loop
  app.post('/api/workspaces/:workspaceId/hub/:id/message', async (req: Request, res: Response) => {
    const workspace = getWorkspaceOr404(req, res);
    if (!workspace) return;
    const id = req.params.id as string;
    const { content } = req.body as UserMessageRequest;

    const active = activeLoops.get(id);
    if (!active || active.workspaceId !== workspace.workspaceId) {
      res.status(404).json({ error: 'HUB_NOT_FOUND' });
      return;
    }

    try {
      await active.loop.pushUserMessage(content);
      res.json({ status: 'ok' });
    } catch (err) {
      res.status(500).json({ error: 'MESSAGE_FAILED', message: (err as Error).message });
    }
  });

  // POST /api/workspaces/:workspaceId/hub/:id/cancel — cancel active workers and close hub
  app.post('/api/workspaces/:workspaceId/hub/:id/cancel', async (req: Request, res: Response) => {
    const workspace = getWorkspaceOr404(req, res);
    if (!workspace) return;
    const id = req.params.id as string;
    const active = activeLoops.get(id);
    if (!active || active.workspaceId !== workspace.workspaceId) {
      res.status(404).json({ error: 'HUB_NOT_FOUND' });
      return;
    }

    try {
      await active.loop.cancel('Cancelled by user');
      activeLoops.delete(id);
      res.json({ status: 'cancelled' });
    } catch (err) {
      res.status(500).json({ error: 'CANCEL_FAILED', message: (err as Error).message });
    }
  });

  // GET /api/workspaces/:workspaceId/hubs — list hubs for workspace
  app.get('/api/workspaces/:workspaceId/hubs', async (req: Request, res: Response) => {
    const workspace = getWorkspaceOr404(req, res);
    if (!workspace) return;
    const workspacePath = workspace.absolutePath;
    const hubsDir = getHubsDir(workspacePath);

    try {
      const entries = fs.readdirSync(hubsDir);
      const hubs: HubSummary[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const hubPath = path.join(hubsDir, entry);
        const raw = fs.readFileSync(hubPath, 'utf8');
        const hub = JSON.parse(raw);
        hubs.push({
          hubId: hub.hubId,
          runId: hub.runId,
          workspaceId: hub.workspaceId,
          workspacePath: hub.workspacePath,
          status: hub.status,
          createdAt: hub.createdAt,
          updatedAt: hub.updatedAt,
        });
      }
      hubs.sort((a, b) => b.createdAt - a.createdAt);
      const response: HubListResponse = { hubs };
      res.json(response);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.json({ hubs: [] });
        return;
      }
      res.status(500).json({ error: 'HUBS_LIST_FAILED', message: (err as Error).message });
    }
  });

  // GET /api/workspaces/:workspaceId/hub/:id — hub detail
  app.get('/api/workspaces/:workspaceId/hub/:id', async (req: Request, res: Response) => {
    const workspace = getWorkspaceOr404(req, res);
    if (!workspace) return;
    const id = req.params.id as string;
    const workspacePath = workspace.absolutePath;
    const filePath = getHubPath(workspacePath, id);

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const hub = JSON.parse(raw);
      const response: HubDetailResponse = {
        hubId: hub.hubId,
        runId: hub.runId,
        workspaceId: hub.workspaceId,
        workspacePath: hub.workspacePath,
        status: hub.status,
        createdAt: hub.createdAt,
        updatedAt: hub.updatedAt,
        confirmedPlan: hub.confirmedPlan,
        finalResult: hub.finalResult,
        hubLog: hub.hubLog,
      };
      res.json(response);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'HUB_NOT_FOUND' });
        return;
      }
      res.status(500).json({ error: 'HUB_LOAD_FAILED', message: (err as Error).message });
    }
  });
}

function parsePlanFromText(text: string, fallbackWorkerStrategy: string): ImplementationPlan {
  try {
    const parsed = implementationPlanSchema.safeParse(JSON.parse(text));
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // Plain text plans are still accepted for CLI/manual testing.
  }
  return buildPlanFromText(text, fallbackWorkerStrategy);
}

function buildPlanFromText(text: string, workerStrategy: string): ImplementationPlan {
  return {
    goal: text.split('\n')[0]?.trim() || text.slice(0, 80),
    steps: [{ id: '1', description: text, expectedOutput: 'Per plan' }],
    constraints: [],
    successCriteria: [],
    risks: [],
    workerStrategy: workerStrategy as 'codex' | 'claude' | 'both',
    verificationPlan: [],
  };
}

async function recordInvocationStarted(
  hubWriter: HubWriter,
  event: Record<string, unknown>,
  turnId: string,
  agent: string,
  cwd: string,
  dispatchContext: WorkerDispatchContext,
): Promise<void> {
  const artifacts = artifactRecordsFromEvent(event, turnId);
  await hubWriter.enqueue((current) => {
    if (!current) throw new Error('Hub missing while recording invocation start');
    const inputArtifactId = artifacts.find((artifact) => (
      artifact.kind === 'prompt' || artifact.kind === 'system_prompt'
    ))?.id;
    const outputArtifactIds = artifacts
      .filter((artifact) => artifact.kind !== 'prompt' && artifact.kind !== 'system_prompt')
      .map((artifact) => artifact.id);
    const resumeSessionId = stringFromUnknown(event.resumeSessionId);
    const newSessionId = stringFromUnknown(event.newSessionId);
    return {
      ...current,
      artifacts: mergeArtifacts(current.artifacts, artifacts),
      turnInvocations: [
        ...current.turnInvocations,
        {
          id: turnId,
          agent,
          command: String(event.command ?? ''),
          args: Array.isArray(event.args) ? event.args.map(String) : [],
          cwd,
          inputArtifactId,
          outputArtifactIds,
          contextSnapshotId: dispatchContext.contextSnapshotId,
          ...(resumeSessionId ? { resumeSessionId } : {}),
          ...(newSessionId ? { newSessionId } : {}),
          exitCode: null,
          startedAt: Date.now(),
        },
      ],
    };
  });
}

async function recordInvocationCompleted(
  hubWriter: HubWriter,
  event: Record<string, unknown>,
  turnId: string,
  agent: string,
  cwd: string,
  sessionId: string | null,
): Promise<void> {
  await hubWriter.enqueue((current) => {
    if (!current) throw new Error('Hub missing while recording invocation completion');
    const now = Date.now();
    const existingSession = current.agentSessions[agent];
    const nextAgentSessions = sessionId
      ? {
          ...current.agentSessions,
          [agent]: {
            ...existingSession,
            sessionId,
            cwd,
            startedAt: existingSession?.startedAt ?? now,
            updatedAt: now,
          },
        }
      : current.agentSessions;
    return {
      ...current,
      agentSessions: nextAgentSessions,
      turnInvocations: current.turnInvocations.map((invocation) => (
        invocation?.id === turnId
          ? {
              ...invocation,
              ...(sessionId ? { sessionId } : {}),
              exitCode: numberFromUnknown(event.exitCode),
              endedAt: now,
            }
          : invocation
      )),
      resumeCheckpoint: buildResumeCheckpoint(current, nextAgentSessions, now),
    };
  });
}

function artifactRecordsFromEvent(event: Record<string, unknown>, turnId: string): HubArtifact[] {
  const artifacts = event.artifacts as Record<string, unknown> | undefined;
  if (!artifacts) return [];
  const now = Date.now();
  const specs = [
    ['prompt', artifacts.promptPath],
    ['stdout', artifacts.stdoutPath],
    ['stderr', artifacts.stderrPath],
    ['stream_json', artifacts.streamJsonPath],
    ['last_message', artifacts.lastMessagePath],
    ['system_prompt', artifacts.systemPromptPath],
  ] as const;
  return specs
    .filter(([, p]) => typeof p === 'string' && p.length > 0)
    .map(([kind, p]) => ({
      id: `${turnId}:${kind}:${String(p)}`,
      kind,
      path: String(p),
      createdAt: now,
    }));
}

function mergeArtifacts(existing: HubArtifact[], next: HubArtifact[]): HubArtifact[] {
  const seen = new Set<string>();
  const merged: HubArtifact[] = [];
  for (const artifact of [...existing, ...next]) {
    const id = artifact.id;
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(artifact);
  }
  return merged;
}

async function readResumeSessionId(
  hubWriter: HubWriter,
  agent: string,
): Promise<string | undefined> {
  const hub = await hubWriter.readHub();
  if (!hub) return undefined;
  return sessionIdFromHub(hub, agent) ?? undefined;
}

function sessionIdFromHub(hub: HubJson, agent: string): string | null {
  const session = hub.agentSessions[agent];
  if (!session) return null;
  return typeof session.sessionId === 'string' && session.sessionId
    ? session.sessionId
    : null;
}

function sessionIdFromEvent(event: Record<string, unknown>): string | null {
  const direct = stringFromUnknown(event.sessionId);
  if (direct) return direct;
  const resumed = stringFromUnknown(event.resumeSessionId);
  if (resumed) return resumed;
  return stringFromUnknown(event.newSessionId);
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberFromUnknown(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function buildResumeCheckpoint(
  current: HubJson,
  agentSessions: HubJson['agentSessions'],
  updatedAt: number,
): NonNullable<HubJson['resumeCheckpoint']> {
  return {
    hubLogOffset: current.hubLog.length,
    agentSessions: Object.fromEntries(
      Object.entries(agentSessions)
        .map(([agent, session]) => [agent, session.sessionId] as const)
        .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
    ),
    updatedAt,
  };
}

async function handlePlanRequest(
  req: Request,
  res: Response,
  createModelClient: () => ModelClient,
): Promise<void> {
  const { message, messages } = req.body as PlanRequest;
  if (!message && (!messages || messages.length === 0)) {
    res.status(400).json({ error: 'MISSING_MESSAGE' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ type: 'status', message: 'MyHead 已连接模型，正在等待首个输出...' })}\n\n`);

  try {
    const model = createModelClient();
    const chatMessages = normalizePlanningMessages(message, messages);
    const stream = model.chat([
      { role: 'system', content: DEFAULT_PLANNING_PROMPT },
      ...chatMessages,
    ]);

    for await (const delta of stream) {
      if (delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ type: 'text_delta', content: delta.text })}\n\n`);
      } else if (delta.type === 'error') {
        res.write(`data: ${JSON.stringify({ type: 'error', message: delta.message })}\n\n`);
      }
    }
    res.write(`data: [DONE]\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: (err as Error).message })}\n\n`);
  }
  res.end();
}

function normalizePlanningMessages(
  message: string | undefined,
  messages: PlanRequest['messages'],
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  if (messages && messages.length > 0) {
    return messages
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({
        role: m.role === 'system' ? 'system' : m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }));
  }
  return [{ role: 'user', content: message ?? '' }];
}

async function handleStructuredPlanRequest(
  req: Request,
  res: Response,
  createModelClient: () => ModelClient,
): Promise<void> {
  const { messages } = req.body as { messages?: Array<{ role: string; content: string }> };
  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'MISSING_MESSAGES' });
    return;
  }
  try {
    const model = createModelClient();
    const chatMessages = messages.map((m) => ({
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content,
    }));
    const plan = await model.completeJson(
      [
        ...chatMessages,
        {
          role: 'user',
          content: 'Based on our conversation above, produce a structured implementation plan as a JSON object. Follow the schema exactly.',
        },
      ],
      implementationPlanSchema,
    );
    res.json({ plan });
  } catch (err) {
    res.status(400).json({ error: 'STRUCTURED_PLAN_FAILED', message: (err as Error).message });
  }
}

function toSseEvent(ev: Record<string, unknown>, active: ActiveLoopRecord): MyHeadSseEvent {
  const scope = {
    workspaceId: active.workspaceId,
    runId: active.runId,
    hubId: active.hubId,
  };
  const t = ev.type as string;
  switch (t) {
    case 'hub_status':
      return { ...scope, type: 'hub_status', status: ev.status as string };
    case 'hub_message': {
      const msg = (ev.message ?? ev) as { id?: string; role: string; content: string; timestamp: number };
      return {
        ...scope,
        type: 'hub_message',
        id: msg.id,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
      };
    }
    case 'hub_message_delta':
      return {
        ...scope,
        type: 'hub_message_delta',
        streamId: ev.streamId as string,
        role: ev.role as string,
        delta: ev.delta as string,
        timestamp: ev.timestamp as number,
      };
    case 'review_started':
      return { ...scope, type: 'review_started' };
    case 'review_completed':
      return { ...scope, type: 'review_completed', verdict: ev.verdict };
    case 'worker_dispatch':
      return {
        ...scope,
        type: 'worker_dispatch',
        agent: ev.agent as string,
        stepId: ev.stepId as string,
      };
    case 'error':
      return {
        ...scope,
        type: 'error',
        message: ev.message as string,
        code: ev.code as string,
      };
    default:
      return { ...scope, type: 'error', message: `Unknown event type: ${t}`, code: 'UNKNOWN_EVENT' };
  }
}
