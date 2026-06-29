import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ControllerLoop } from '../src/controller/loop.js';
import { createEmptyHub } from '../src/hub/schema.js';
import { HubWriter } from '../src/hub/writer.js';
import type { ModelClient } from '../src/model/client.js';
import type { ImplementationPlan } from '../src/planning/schema.js';

describe('ControllerLoop', () => {
  it('preserves the confirmed plan from the initialized hub', async () => {
    const dir = await makeTempDir('myhead-loop-');
    const hubPath = path.join(dir, '.myhead', 'sessions', 'hub-1.json');
    const writer = new HubWriter(hubPath);
    const planText = 'Create hello.js that prints Hello MyHead.';
    const plan = makePlan(planText);
    const hub = createEmptyHub('hub-1', dir, ['codex'], {
      workspaceId: 'workspace-1',
      runId: 'run-1',
      confirmedPlan: {
        text: planText,
        hash: 'hash-1',
        summary: plan.goal,
      },
    });
    await writer.writeHub(hub);

    const loop = new ControllerLoop({
      hubWriter: writer,
      model: acceptedModel(),
      plan,
      workspacePath: dir,
      hubId: 'hub-1',
      initialHub: hub,
    });

    await loop.pushUserMessage('done');

    const saved = await writer.readHub();
    expect(saved?.status).toBe('accepted');
    expect(saved?.finalResult).toMatchObject({
      verdict: 'accepted',
      summary: 'done',
    });
    expect(saved?.confirmedPlan?.text).toBe(planText);
    expect(saved?.workspaceId).toBe('workspace-1');
    expect(saved?.runId).toBe('run-1');

    await cleanupDir(dir);
  });

  it('records a context snapshot before dispatch and includes hub context in the worker prompt', async () => {
    const dir = await makeTempDir('myhead-loop-');
    const hubPath = path.join(dir, '.myhead', 'sessions', 'hub-1.json');
    const writer = new HubWriter(hubPath);
    const planText = 'Create hello.js that prints Hello MyHead.';
    const plan = makePlan(planText);
    const hub = createEmptyHub('hub-1', dir, ['codex'], {
      workspaceId: 'workspace-1',
      runId: 'run-1',
      confirmedPlan: {
        text: planText,
        hash: 'hash-1',
        summary: plan.goal,
      },
    });
    await writer.writeHub({
      ...hub,
      hubLog: [
        {
          id: 'm-1',
          role: 'user',
          content: 'Please continue carefully.',
          timestamp: 1,
          visibility: 'hub',
        },
      ],
    });

    const dispatches: Array<{
      agent: string;
      prompt: string;
      contextSnapshotId: string;
      hubLogOffset: number;
    }> = [];
    const loop = new ControllerLoop({
      hubWriter: writer,
      model: acceptedModel(),
      plan,
      workspacePath: dir,
      hubId: 'hub-1',
      initialHub: {
        ...hub,
        hubLog: [
          {
            id: 'm-1',
            role: 'user',
            content: 'Please continue carefully.',
            timestamp: 1,
            visibility: 'hub',
          },
        ],
      },
      onDispatch: async (agent, prompt, context) => {
        dispatches.push({
          agent,
          prompt,
          contextSnapshotId: context.contextSnapshotId,
          hubLogOffset: context.hubLogOffset,
        });
        return [{ role: agent, content: 'done' }];
      },
    });

    const eventPump = waitForAccepted(loop);
    await loop.start();
    await eventPump;

    const saved = await writer.readHub();
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.agent).toBe('codex');
    expect(dispatches[0]?.prompt).toContain('You are worker "codex".');
    expect(dispatches[0]?.prompt).toContain('## Hub Context');
    expect(dispatches[0]?.prompt).toContain('[user] Please continue carefully.');
    expect(dispatches[0]?.prompt).toContain('[myhead] 发给 Codex 的任务');
    expect(dispatches[0]?.hubLogOffset).toBe(2);
    expect(saved?.contextSnapshots).toHaveLength(1);
    expect(saved?.contextSnapshots[0]?.id).toBe(dispatches[0]?.contextSnapshotId);
    expect(saved?.contextSnapshots[0]?.targetAgent).toBe('codex');
    expect(saved?.agentCursors.codex).toBe(2);
    expect(saved?.hubLog[1]).toMatchObject({
      role: 'myhead',
      content: expect.stringContaining('发给 Codex 的任务'),
    });

    await cleanupDir(dir);
  });

  it('emits worker response deltas before the final hub message', async () => {
    const dir = await makeTempDir('myhead-loop-');
    const hubPath = path.join(dir, '.myhead', 'sessions', 'hub-1.json');
    const writer = new HubWriter(hubPath);
    const plan = makePlan('Stream worker output.');
    const hub = createEmptyHub('hub-1', dir, ['codex'], {
      workspaceId: 'workspace-1',
      runId: 'run-1',
      confirmedPlan: {
        text: JSON.stringify(plan),
        hash: 'hash-1',
        summary: plan.goal,
      },
    });
    await writer.writeHub(hub);

    const seen: string[] = [];
    const loop = new ControllerLoop({
      hubWriter: writer,
      model: acceptedModel(),
      plan,
      workspacePath: dir,
      hubId: 'hub-1',
      initialHub: hub,
      onDispatch: async (agent, _prompt, context) => {
        context.emitDelta('worker ');
        context.emitDelta('streaming');
        return [{ role: agent, content: 'worker streaming' }];
      },
    });

    const eventPump = (async () => {
      for await (const event of loop.events()) {
        if (event.type === 'hub_message_delta') {
          seen.push(event.delta);
        }
        if (event.type === 'hub_status' && event.status === 'accepted') {
          return;
        }
      }
    })();

    await loop.start();
    await eventPump;

    expect(seen.join('')).toBe('worker streaming');

    await cleanupDir(dir);
  });

  it('runs both selected workers together without redispatching while one is still active', async () => {
    const dir = await makeTempDir('myhead-loop-');
    const hubPath = path.join(dir, '.myhead', 'sessions', 'hub-1.json');
    const writer = new HubWriter(hubPath);
    const plan = { ...makePlan('Coordinate both workers.'), workerStrategy: 'both' as const };
    const hub = createEmptyHub('hub-1', dir, ['claude', 'codex'], {
      workspaceId: 'workspace-1',
      runId: 'run-1',
      confirmedPlan: {
        text: JSON.stringify(plan),
        hash: 'hash-1',
        summary: plan.goal,
      },
    });
    await writer.writeHub(hub);

    const codexDone = deferred<Array<{ role: string; content: string }>>();
    const claudeDone = deferred<Array<{ role: string; content: string }>>();
    const dispatches: string[] = [];
    const loop = new ControllerLoop({
      hubWriter: writer,
      model: sequenceModel(['continue', 'accepted']),
      plan,
      workspacePath: dir,
      hubId: 'hub-1',
      initialHub: hub,
      onDispatch: async (agent) => {
        dispatches.push(agent);
        return agent === 'codex' ? codexDone.promise : claudeDone.promise;
      },
    });

    const eventPump = waitForAccepted(loop);
    await loop.start();
    expect(dispatches.sort()).toEqual(['claude', 'codex']);

    codexDone.resolve([{ role: 'codex', content: 'codex partial result' }]);
    await waitUntil(() => dispatches.length === 2);
    expect(dispatches).toHaveLength(2);

    claudeDone.resolve([{ role: 'claude', content: 'claude result' }]);
    await eventPump;

    const saved = await writer.readHub();
    expect(dispatches).toHaveLength(2);
    expect(saved?.status).toBe('accepted');
    expect(saved?.pendingQueue).toEqual([]);
    expect(saved?.finalResult?.verdict).toBe('accepted');
    expect(saved?.hubLog.some((m) => m.role === 'codex')).toBe(true);
    expect(saved?.hubLog.some((m) => m.role === 'claude')).toBe(true);

    await cleanupDir(dir);
  });

  it('marks a failed worker and cancels active peers when the hub fails', async () => {
    const dir = await makeTempDir('myhead-loop-');
    const hubPath = path.join(dir, '.myhead', 'sessions', 'hub-1.json');
    const writer = new HubWriter(hubPath);
    const plan = { ...makePlan('Fail one worker.'), workerStrategy: 'both' as const };
    const hub = createEmptyHub('hub-1', dir, ['claude', 'codex'], {
      workspaceId: 'workspace-1',
      runId: 'run-1',
      confirmedPlan: {
        text: JSON.stringify(plan),
        hash: 'hash-1',
        summary: plan.goal,
      },
    });
    await writer.writeHub(hub);

    let claudeAborted = false;
    const loop = new ControllerLoop({
      hubWriter: writer,
      model: sequenceModel(['continue']),
      plan,
      workspacePath: dir,
      hubId: 'hub-1',
      initialHub: hub,
      onDispatch: async (agent, _prompt, context) => {
        if (agent === 'codex') throw new Error('codex crashed');
        return new Promise((resolve, reject) => {
          context.signal.addEventListener('abort', () => {
            claudeAborted = true;
            reject(new Error('peer cancelled'));
          });
        });
      },
    });

    const eventPump = waitForStatus(loop, 'failed');
    await loop.start();
    await eventPump;

    const saved = await writer.readHub();
    expect(claudeAborted).toBe(true);
    expect(saved?.status).toBe('failed');
    expect(saved?.agentStatus.codex).toBe('failed');
    expect(saved?.agentStatus.claude).toBe('cancelled');
    expect(saved?.finalResult?.verdict).toBe('failed');

    await cleanupDir(dir);
  });

  it('waits for all active workers before running verification verdicts', async () => {
    const dir = await makeTempDir('myhead-loop-');
    const hubPath = path.join(dir, '.myhead', 'sessions', 'hub-1.json');
    const writer = new HubWriter(hubPath);
    const plan = { ...makePlan('Verify after both workers.'), workerStrategy: 'both' as const };
    const hub = createEmptyHub('hub-1', dir, ['claude', 'codex'], {
      workspaceId: 'workspace-1',
      runId: 'run-1',
      confirmedPlan: {
        text: JSON.stringify(plan),
        hash: 'hash-1',
        summary: plan.goal,
      },
    });
    await writer.writeHub(hub);

    const claudeDone = deferred<Array<{ role: string; content: string }>>();
    const codexDone = deferred<Array<{ role: string; content: string }>>();
    const loop = new ControllerLoop({
      hubWriter: writer,
      model: sequenceModel(['verify', 'accepted']),
      plan,
      workspacePath: dir,
      hubId: 'hub-1',
      initialHub: hub,
      onDispatch: async (agent) => (agent === 'claude' ? claudeDone.promise : codexDone.promise),
    });

    const eventPump = waitForAccepted(loop);
    await loop.start();
    claudeDone.resolve([{ role: 'claude', content: 'claude done' }]);
    await waitUntil(async () => {
      const saved = await writer.readHub();
      return saved?.hubLog.some((message) => message.content.includes('Waiting for active workers')) ?? false;
    });
    codexDone.resolve([{ role: 'codex', content: 'codex done' }]);
    await eventPump;

    const saved = await writer.readHub();
    expect(saved?.status).toBe('accepted');
    expect(saved?.finalResult?.verification).toEqual([]);
    expect(saved?.hubLog.some((message) => message.content.includes('Verification passed'))).toBe(false);

    await cleanupDir(dir);
  });

  it('keeps active workers alive when an event subscriber disconnects', async () => {
    const dir = await makeTempDir('myhead-loop-');
    const hubPath = path.join(dir, '.myhead', 'sessions', 'hub-1.json');
    const writer = new HubWriter(hubPath);
    const plan = makePlan('Keep worker lifecycle separate from UI subscribers.');
    const hub = createEmptyHub('hub-1', dir, ['codex'], {
      workspaceId: 'workspace-1',
      runId: 'run-1',
      confirmedPlan: {
        text: JSON.stringify(plan),
        hash: 'hash-1',
        summary: plan.goal,
      },
    });
    await writer.writeHub(hub);

    const workerDone = deferred<Array<{ role: string; content: string }>>();
    const dispatches: string[] = [];
    const loop = new ControllerLoop({
      hubWriter: writer,
      model: sequenceModel(['accepted', 'accepted']),
      plan,
      workspacePath: dir,
      hubId: 'hub-1',
      initialHub: hub,
      onDispatch: async (agent) => {
        dispatches.push(agent);
        return workerDone.promise;
      },
    });

    const controller = new AbortController();
    const subscriber = (async () => {
      for await (const _event of loop.events({ signal: controller.signal })) {
        // Drain until the simulated browser tab disconnects.
      }
    })();

    await loop.start();
    expect(dispatches).toEqual(['codex']);
    controller.abort();
    await subscriber;

    await loop.pushUserMessage('Can we accept now?');
    let saved = await writer.readHub();
    expect(saved?.status).toBe('continue');
    expect(saved?.hubLog.some((message) => message.content.includes('Waiting for active workers'))).toBe(true);

    const eventPump = waitForAccepted(loop);
    workerDone.resolve([{ role: 'codex', content: 'worker finally completed' }]);
    await eventPump;

    saved = await writer.readHub();
    expect(saved?.status).toBe('accepted');
    expect(saved?.hubLog.some((message) => message.role === 'codex')).toBe(true);
    expect(dispatches).toHaveLength(1);

    await cleanupDir(dir);
  });

  it('notifies once when the hub reaches a terminal status', async () => {
    const dir = await makeTempDir('myhead-loop-');
    const hubPath = path.join(dir, '.myhead', 'sessions', 'hub-1.json');
    const writer = new HubWriter(hubPath);
    const plan = makePlan('Notify terminal status.');
    const hub = createEmptyHub('hub-1', dir, ['codex'], {
      workspaceId: 'workspace-1',
      runId: 'run-1',
      confirmedPlan: {
        text: JSON.stringify(plan),
        hash: 'hash-1',
        summary: plan.goal,
      },
    });
    await writer.writeHub(hub);

    const terminalStatuses: string[] = [];
    const loop = new ControllerLoop({
      hubWriter: writer,
      model: acceptedModel(),
      plan,
      workspacePath: dir,
      hubId: 'hub-1',
      initialHub: hub,
      onTerminal: (status) => terminalStatuses.push(status),
    });

    await loop.pushUserMessage('done');
    await loop.cancel('late cancel');

    expect(terminalStatuses).toEqual(['accepted']);

    await cleanupDir(dir);
  });

  it('includes multi-worker ownership guidance in worker prompts', async () => {
    const dir = await makeTempDir('myhead-loop-');
    const hubPath = path.join(dir, '.myhead', 'sessions', 'hub-1.json');
    const writer = new HubWriter(hubPath);
    const plan: ImplementationPlan = {
      ...makePlan('Split ownership.'),
      workerStrategy: 'both',
      collaborationPlan: {
        mode: 'parallel_cooperate',
        assignments: {
          codex: ['Create codex-owned.txt'],
          claude: ['Create claude-owned.txt'],
        },
        coordinationRules: ['Each worker must only edit its owned file.'],
      },
    };
    const hub = createEmptyHub('hub-1', dir, ['claude', 'codex'], {
      workspaceId: 'workspace-1',
      runId: 'run-1',
      confirmedPlan: {
        text: JSON.stringify(plan),
        hash: 'hash-1',
        summary: plan.goal,
      },
    });
    await writer.writeHub(hub);

    const prompts = new Map<string, string>();
    const loop = new ControllerLoop({
      hubWriter: writer,
      model: sequenceModel(['accepted']),
      plan,
      workspacePath: dir,
      hubId: 'hub-1',
      initialHub: hub,
      onDispatch: async (agent, prompt) => {
        prompts.set(agent, prompt);
        return [{ role: agent, content: `${agent} done` }];
      },
    });

    const eventPump = waitForAccepted(loop);
    await loop.start();
    await eventPump;

    expect(prompts.get('codex')).toContain('You are worker "codex".');
    expect(prompts.get('codex')).toContain('Your assignment: Create codex-owned.txt');
    expect(prompts.get('codex')).toContain('- claude: Create claude-owned.txt');
    expect(prompts.get('codex')).toContain('Do not take over another worker');

    await cleanupDir(dir);
  });

  it('sends supervisor revision guidance back to the worker', async () => {
    const dir = await makeTempDir('myhead-loop-');
    const hubPath = path.join(dir, '.myhead', 'sessions', 'hub-1.json');
    const writer = new HubWriter(hubPath);
    const plan = makePlan('Revise until correct.');
    const hub = createEmptyHub('hub-1', dir, ['codex'], {
      workspaceId: 'workspace-1',
      runId: 'run-1',
      confirmedPlan: {
        text: JSON.stringify(plan),
        hash: 'hash-1',
        summary: plan.goal,
      },
    });
    await writer.writeHub(hub);

    const prompts: string[] = [];
    const loop = new ControllerLoop({
      hubWriter: writer,
      model: sequenceModel(['revise', 'accepted'], 'Please fix the missing verification.'),
      plan,
      workspacePath: dir,
      hubId: 'hub-1',
      initialHub: hub,
      onDispatch: async (_agent, prompt) => {
        prompts.push(prompt);
        return [{ role: 'codex', content: prompts.length === 1 ? 'first draft' : 'fixed draft' }];
      },
    });

    const eventPump = waitForAccepted(loop);
    await loop.start();
    await eventPump;

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Please fix the missing verification.');

    await cleanupDir(dir);
  });

  it('records verification output and final result in the hub JSON', async () => {
    const dir = await makeTempDir('myhead-loop-');
    const hubPath = path.join(dir, '.myhead', 'sessions', 'hub-1.json');
    const writer = new HubWriter(hubPath);
    const plan = makePlan('Verify before accepting.');
    const hub = createEmptyHub('hub-1', dir, ['codex'], {
      workspaceId: 'workspace-1',
      runId: 'run-1',
      confirmedPlan: {
        text: JSON.stringify(plan),
        hash: 'hash-1',
        summary: plan.goal,
      },
    });
    await writer.writeHub(hub);

    const loop = new ControllerLoop({
      hubWriter: writer,
      model: sequenceModel(['verify', 'accepted']),
      plan,
      workspacePath: dir,
      hubId: 'hub-1',
      initialHub: hub,
      onDispatch: async (agent) => [{ role: agent, content: 'implementation done' }],
    });

    const eventPump = waitForAccepted(loop);
    await loop.start();
    await eventPump;

    const saved = await writer.readHub();
    expect(saved?.hubLog.some((m) => m.content.includes('Verification passed'))).toBe(true);
    expect(saved?.finalResult?.verdict).toBe('accepted');
    expect(saved?.finalResult?.verification).toHaveLength(1);
    expect(saved?.finalResult?.verification[0]?.passed).toBe(true);

    await cleanupDir(dir);
  });

  it('cancels active workers through their MyHead-owned abort signal', async () => {
    const dir = await makeTempDir('myhead-loop-');
    const hubPath = path.join(dir, '.myhead', 'sessions', 'hub-1.json');
    const writer = new HubWriter(hubPath);
    const plan = makePlan('Long running task.');
    const hub = createEmptyHub('hub-1', dir, ['codex'], {
      workspaceId: 'workspace-1',
      runId: 'run-1',
      confirmedPlan: {
        text: JSON.stringify(plan),
        hash: 'hash-1',
        summary: plan.goal,
      },
    });
    await writer.writeHub(hub);

    let workerSignal: AbortSignal | null = null;
    const loop = new ControllerLoop({
      hubWriter: writer,
      model: sequenceModel(['accepted']),
      plan,
      workspacePath: dir,
      hubId: 'hub-1',
      initialHub: hub,
      onDispatch: async (_agent, _prompt, context) => {
        workerSignal = context.signal;
        await new Promise(() => {});
        return [];
      },
    });

    await loop.start();
    expect(workerSignal?.aborted).toBe(false);

    await loop.cancel('test cancellation');

    const saved = await writer.readHub();
    expect(workerSignal?.aborted).toBe(true);
    expect(saved?.status).toBe('cancelled');
    expect(saved?.agentStatus.codex).toBe('cancelled');
    expect(saved?.hubLog.at(-1)?.content).toBe('test cancellation');

    await cleanupDir(dir);
  });
});

function makePlan(text: string): ImplementationPlan {
  return {
    goal: text,
    steps: [{ id: '1', description: text, expectedOutput: 'hello.js' }],
    constraints: [],
    successCriteria: [],
    risks: [],
    workerStrategy: 'codex',
    verificationPlan: [],
  };
}

function acceptedModel(): ModelClient {
  return {
    async *chat() {},
    async completeJson() {
      return {
        status: 'accepted',
        summary: 'done',
        findings: [],
        missingVerification: [],
        recommendedReply: 'done',
      };
    },
  };
}

function sequenceModel(
  statuses: Array<'accepted' | 'continue' | 'revise' | 'verify'>,
  recommendedReply = 'continue',
): ModelClient {
  let index = 0;
  return {
    async *chat() {},
    async completeJson() {
      const status = statuses[Math.min(index, statuses.length - 1)] ?? 'accepted';
      index += 1;
      return {
        status,
        summary: status,
        findings: [],
        missingVerification: status === 'verify' ? ['node --version'] : [],
        recommendedReply,
      };
    },
  };
}

async function waitForAccepted(loop: ControllerLoop): Promise<void> {
  return waitForStatus(loop, 'accepted');
}

async function waitForStatus(loop: ControllerLoop, status: 'accepted' | 'failed'): Promise<void> {
  for await (const event of loop.events()) {
    if (event.type === 'hub_status' && event.status === status) {
      return;
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > 1000) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function makeTempDir(prefix: string): Promise<string> {
  const tmpRoot = path.resolve(process.cwd(), '../../..', 'tmp');
  await fs.mkdir(tmpRoot, { recursive: true });
  return fs.mkdtemp(path.join(tmpRoot, prefix));
}

async function cleanupDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 4) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
