import { randomUUID } from 'node:crypto';
import { HubWriter } from '../hub/writer.js';
import { createEmptyHub } from '../hub/schema.js';
import type { HubJson } from '../hub/schema.js';
import { assertValidTransition, isTerminalStatus } from '../hub/state-machine.js';
import { reviewVerdictSchema } from '../supervisor/schema.js';
import { DEFAULT_SUPERVISOR_PROMPT } from '../supervisor/prompt.js';
import { runVerification } from '../verification/runner.js';
import type { ModelClient } from '../model/client.js';
import type { ImplementationPlan } from '../planning/schema.js';
import type { ReviewVerdict } from '../supervisor/schema.js';
import type { ContextSnapshot, FinalResult, HubStatus, HubMessage, VerificationResult } from '../types.js';

export type WorkerDispatchContext = {
  contextSnapshotId: string;
  hubLogOffset: number;
  workspacePath: string;
  signal: AbortSignal;
  emitDelta: (delta: string) => void;
};

export type ControllerEvent =
  | { type: 'hub_status'; status: HubStatus }
  | { type: 'hub_message'; message: HubMessage }
  | { type: 'hub_message_delta'; streamId: string; role: string; delta: string; timestamp: number }
  | { type: 'review_started' }
  | { type: 'review_completed'; verdict: ReviewVerdict }
  | { type: 'worker_dispatch'; agent: string; stepId: string }
  | { type: 'error'; message: string; code: string }
  | { type: 'loop_idle' };

type EventSubscriptionOptions = {
  replay?: boolean;
  signal?: AbortSignal;
};

type EventSubscriber = {
  queue: ControllerEvent[];
  resolve: (() => void) | null;
};

export class ControllerLoop {
  private hubWriter: HubWriter;
  private model: ModelClient;
  private plan: ImplementationPlan;
  private currentHub: HubJson;
  private eventBacklog: ControllerEvent[] = [];
  private eventSubscribers = new Set<EventSubscriber>();
  private activeWorkers = new Map<string, Promise<void>>();
  private activeWorkerControllers = new Map<string, AbortController>();
  private pendingDispatchInstruction: string | null = null;
  private reviewLock: Promise<void> = Promise.resolve();
  private verificationResults: VerificationResult[] = [];
  private onTerminal?: (status: HubStatus) => void;
  private terminalNotified = false;

  private onDispatch: ((
    agent: string,
    prompt: string,
    context: WorkerDispatchContext,
  ) => Promise<Array<{ role: string; content: string }>>) | undefined;
  private workspacePath: string;

  constructor(opts: {
    hubWriter: HubWriter;
    model: ModelClient;
    plan: ImplementationPlan;
    workspacePath: string;
    hubId: string;
    initialHub?: HubJson;
    onTerminal?: (status: HubStatus) => void;
    onDispatch?: (
      agent: string,
      prompt: string,
      context: WorkerDispatchContext,
    ) => Promise<Array<{ role: string; content: string }>>;
  }) {
    this.hubWriter = opts.hubWriter;
    this.model = opts.model;
    this.plan = opts.plan;
    this.workspacePath = opts.workspacePath;
    this.onDispatch = opts.onDispatch;
    this.onTerminal = opts.onTerminal;
    this.currentHub = opts.initialHub ?? createEmptyHub(
      opts.hubId,
      opts.workspacePath,
      opts.plan.workerStrategy === 'both' ? ['claude', 'codex'] : [opts.plan.workerStrategy],
    );
  }

  async start(): Promise<void> {
    if (this.currentHub.status !== 'listening') return;
    await this.transition('message_queued');
    await this.transition('reviewing');
    await this.dispatchNextStep();
  }

  async cancel(reason = 'Cancelled by MyHead'): Promise<void> {
    if (isTerminalStatus(this.currentHub.status)) {
      this.notifyTerminalIfNeeded();
      return;
    }

    for (const controller of this.activeWorkerControllers.values()) {
      controller.abort(reason);
    }
    this.activeWorkerControllers.clear();
    this.activeWorkers.clear();
    this.pendingDispatchInstruction = null;

    const msg: HubMessage = createHubMessage('myhead', reason);
    this.currentHub = await this.hubWriter.appendMessage(this.currentHub, msg);
    this.emit({ type: 'hub_message', message: msg });

    this.currentHub = await this.hubWriter.enqueue((current) => {
      const base = current ?? this.currentHub;
      return {
        ...base,
        agentStatus: Object.fromEntries(
          Object.keys(base.agentStatus).map((agent) => [agent, 'cancelled']),
        ),
      };
    });

    await this.recordFinalResult('cancelled', reason);
    if (!isTerminalStatus(this.currentHub.status)) {
      await this.transition('cancelled');
    }
    this.notifyTerminalIfNeeded();
  }

  async pushWorkerResponse(agent: string, content: string): Promise<void> {
    if (isTerminalStatus(this.currentHub.status)) {
      throw new Error(`Hub is closed with status ${this.currentHub.status}`);
    }
    const msg: HubMessage = createHubMessage(agent, content);
    this.currentHub = await this.hubWriter.appendMessage(this.currentHub, msg, { queue: true });
    this.emit({ type: 'hub_message', message: msg });
    await this.transition('reviewing');
    await this.reviewAndAdvanceLocked();
  }

  private emit(ev: ControllerEvent) {
    this.eventBacklog.push(ev);
    for (const subscriber of this.eventSubscribers) {
      subscriber.queue.push(ev);
      if (subscriber.resolve) {
        subscriber.resolve();
        subscriber.resolve = null;
      }
    }
  }

  async *events(options: EventSubscriptionOptions = {}): AsyncIterable<ControllerEvent> {
    const subscriber: EventSubscriber = {
      queue: options.replay === false ? [] : [...this.eventBacklog],
      resolve: null,
    };
    this.eventSubscribers.add(subscriber);

    const waitForEvent = () => new Promise<void>((resolve) => {
      if (options.signal?.aborted) {
        resolve();
        return;
      }
      const wake = () => {
        options.signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        options.signal?.removeEventListener('abort', onAbort);
        if (subscriber.resolve === wake) subscriber.resolve = null;
        resolve();
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      subscriber.resolve = wake;
    });

    try {
      while (subscriber.queue.length > 0) {
        yield subscriber.queue.shift()!;
      }
      while (!isTerminalStatus(this.currentHub.status) && !options.signal?.aborted) {
        await waitForEvent();
        while (subscriber.queue.length > 0) {
          yield subscriber.queue.shift()!;
        }
      }
    } finally {
      this.eventSubscribers.delete(subscriber);
      subscriber.resolve = null;
    }
  }

  async pushUserMessage(content: string): Promise<void> {
    if (isTerminalStatus(this.currentHub.status)) {
      throw new Error(`Hub is closed with status ${this.currentHub.status}`);
    }
    const msg: HubMessage = createHubMessage('user', content);
    this.currentHub = await this.hubWriter.appendMessage(this.currentHub, msg);
    this.emit({ type: 'hub_message', message: msg });
    if (this.currentHub.status === 'listening') {
      await this.transition('message_queued');
    }
    await this.reviewAndAdvanceLocked();
  }

  private async reviewAndAdvanceLocked(): Promise<void> {
    const previous = this.reviewLock;
    let release!: () => void;
    this.reviewLock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (isTerminalStatus(this.currentHub.status)) return;
      await this.reviewAndAdvance();
    } finally {
      release();
    }
  }

  private async reviewAndAdvance(): Promise<void> {
    await this.transition('reviewing');
    this.emit({ type: 'review_started' });
    const reviewedHubLogLength = this.currentHub.hubLog.length;

    const messages = [
      { role: 'system' as const, content: DEFAULT_SUPERVISOR_PROMPT },
      { role: 'user' as const, content: buildSupervisorContext(this.plan, this.currentHub) },
    ];

    try {
      const modelVerdict = await this.model.completeJson(messages, reviewVerdictSchema);
      if (isTerminalStatus(this.currentHub.status)) {
        return;
      }
      if (this.currentHub.hubLog.length !== reviewedHubLogLength) {
        return;
      }
      const verdict = this.deferTerminalVerdictWhileWorkersRun(modelVerdict);
      this.emit({ type: 'review_completed', verdict });

      const myheadMsg: HubMessage = createHubMessage('myhead', renderReviewVerdictMessage(verdict));
      this.currentHub = await this.hubWriter.appendMessage(this.currentHub, myheadMsg);
      this.emit({ type: 'hub_message', message: myheadMsg });
      if (this.currentHub.pendingQueue.length > 0) {
        this.currentHub = await this.hubWriter.shiftPendingQueue(this.currentHub);
      }

      if (
        this.currentHub.pendingQueue.length === 0 &&
        (verdict.status === 'accepted' || verdict.status === 'failed' || verdict.status === 'blocked')
      ) {
        await this.recordFinalResult(verdict.status, verdict.summary);
      }

      await this.transition(mapVerdictToHubStatus(verdict.status));
      await this.handleVerdict(verdict);
      this.notifyTerminalIfNeeded();
    } catch (err) {
      await this.failLoop(
        `Supervisor review failed: ${err instanceof Error ? err.message : String(err)}`,
        'SUPERVISOR_ERROR',
      );
    }
  }

  private async handleVerdict(verdict: ReviewVerdict): Promise<void> {
    if (this.currentHub.pendingQueue.length > 0 && verdict.status !== 'failed' && verdict.status !== 'blocked') {
      await this.transition('reviewing');
      await this.reviewAndAdvance();
      return;
    }

    switch (verdict.status) {
      case 'accepted':
        this.currentHub = await this.hubWriter.updateAgentStatus(this.currentHub, 'myhead' as never, 'done');
        return;
      case 'continue':
        await this.dispatchNextStep(verdict.recommendedReply);
        break;
      case 'revise':
        await this.dispatchNextStep(verdict.recommendedReply);
        break;
      case 'verify': {
        const results = await runVerification(this.workspacePath, verdict.missingVerification.map((cmd) => ({
          command: cmd,
          expectedExitCode: 0,
          description: cmd,
        })));

        const allPassed = results.every((r) => r.passed);
        this.verificationResults.push(...results);
        const verificationMsg: HubMessage = createHubMessage(
          'myhead',
          `Verification ${allPassed ? 'passed' : 'failed'}:\n${results.map((r) => r.summary).join('\n')}`,
        );
        this.currentHub = await this.hubWriter.appendMessage(this.currentHub, verificationMsg);
        this.emit({ type: 'hub_message', message: verificationMsg });
        if (allPassed) {
          await this.transition('reviewing');
          await this.reviewAndAdvance();
        } else {
          const summary = results.map((r) => r.summary).join('\n');
          await this.transition('revise');
          await this.dispatchNextStep(`Verification failed. Fix the issues and report back:\n${summary}`);
        }
        break;
      }
      case 'needs_user_decision':
        // Wait for user input
        break;
      case 'failed':
        break;
      case 'blocked':
        break;
    }
  }

  private async dispatchNextStep(supervisorInstruction?: string): Promise<void> {
    const instruction = supervisorInstruction?.trim() || this.pendingDispatchInstruction;
    if (instruction) {
      this.pendingDispatchInstruction = instruction;
    }

    if (this.activeWorkers.size > 0) {
      this.emit({ type: 'loop_idle' });
      return;
    }

    this.pendingDispatchInstruction = null;
    for (const agent of this.currentHub.selectedAgents) {
      if (this.activeWorkers.has(agent)) continue;
      const dispatchMsg = createDispatchMessage(agent, this.plan, instruction ?? undefined);
      this.currentHub = await this.hubWriter.appendMessage(this.currentHub, dispatchMsg);
      this.emit({ type: 'hub_message', message: dispatchMsg });

      let snapshot: ContextSnapshot;
      this.currentHub = await this.hubWriter.enqueue((current) => {
        const base = current ?? this.currentHub;
        snapshot = createContextSnapshot(agent, base);
        return {
          ...base,
          agentStatus: { ...base.agentStatus, [agent]: 'running' },
          agentCursors: { ...base.agentCursors, [agent]: snapshot.hubLogOffset },
          contextSnapshots: [...base.contextSnapshots, snapshot],
        };
      });
      this.emit({ type: 'worker_dispatch', agent, stepId: 'next' });

      if (this.onDispatch) {
        const abortController = new AbortController();
        this.activeWorkerControllers.set(agent, abortController);
        const prompt = buildWorkerPrompt(this.plan, this.currentHub, snapshot!, instruction ?? undefined);
        const streamId = randomUUID();
        const worker = this.onDispatch(agent, prompt, {
          contextSnapshotId: snapshot!.id,
          hubLogOffset: snapshot!.hubLogOffset,
          workspacePath: this.workspacePath,
          signal: abortController.signal,
          emitDelta: (delta: string) => {
            if (!delta || isTerminalStatus(this.currentHub.status)) return;
            this.emit({
              type: 'hub_message_delta',
              streamId,
              role: agent,
              delta,
              timestamp: Date.now(),
            });
          },
        }).then(async (messages) => {
          this.activeWorkerControllers.delete(agent);
          if (isTerminalStatus(this.currentHub.status)) {
            this.activeWorkers.delete(agent);
            return;
          }
          for (const m of messages) {
            const msg: HubMessage = createHubMessage(m.role, m.content);
            this.currentHub = await this.hubWriter.appendMessage(this.currentHub, msg, { queue: true });
            this.emit({ type: 'hub_message', message: msg });
          }
          this.currentHub = await this.hubWriter.updateAgentStatus(this.currentHub, agent, 'done');
          this.activeWorkers.delete(agent);
          if (isTerminalStatus(this.currentHub.status)) return;
          await this.transition('reviewing');
          await this.reviewAndAdvanceLocked();
        }).catch(async (err) => {
          this.activeWorkerControllers.delete(agent);
          this.activeWorkers.delete(agent);
          if (abortController.signal.aborted) return;
          if (isTerminalStatus(this.currentHub.status)) return;
          await this.failLoop(`Worker ${agent} failed: ${String(err)}`, 'WORKER_ERROR', agent);
        });
        this.activeWorkers.set(agent, worker);
      }
    }
  }

  private async transition(to: HubStatus): Promise<void> {
    assertValidTransition(this.currentHub.status, to);
    this.currentHub = await this.hubWriter.updateStatus(this.currentHub, to);
    this.emit({ type: 'hub_status', status: to });
  }

  private deferTerminalVerdictWhileWorkersRun(verdict: ReviewVerdict): ReviewVerdict {
    if (this.activeWorkers.size === 0 || verdict.status === 'continue') {
      return verdict;
    }
    return {
      ...verdict,
      status: 'continue',
      summary: `${verdict.summary}\n\nWaiting for active workers before acting on this verdict.`,
      recommendedReply: 'Wait for the remaining active worker responses before review, verification, or final outcome.',
    };
  }

  private async failLoop(message: string, code: string, failedAgent?: string): Promise<void> {
    await this.stopActiveWorkersForTerminalFailure(failedAgent);
    const msg: HubMessage = createHubMessage('myhead', message);
    this.currentHub = await this.hubWriter.appendMessage(this.currentHub, msg);
    this.emit({ type: 'hub_message', message: msg });
    this.emit({ type: 'error', message, code });
    await this.recordFinalResult('failed', message);
    if (!isTerminalStatus(this.currentHub.status)) {
      await this.transition('failed');
    }
    this.notifyTerminalIfNeeded();
  }

  private async stopActiveWorkersForTerminalFailure(failedAgent?: string): Promise<void> {
    for (const [agent, controller] of this.activeWorkerControllers) {
      if (agent !== failedAgent) {
        controller.abort('Stopped because MyHead entered a terminal failure state.');
      }
    }
    this.activeWorkerControllers.clear();
    this.activeWorkers.clear();

    this.currentHub = await this.hubWriter.enqueue((current) => {
      const base = current ?? this.currentHub;
      const agentStatus = { ...base.agentStatus };
      if (failedAgent) agentStatus[failedAgent] = 'failed';
      for (const [agent, status] of Object.entries(agentStatus)) {
        if (status === 'running') {
          agentStatus[agent] = agent === failedAgent ? 'failed' : 'cancelled';
        }
      }
      return { ...base, agentStatus };
    });
  }

  private async recordFinalResult(
    verdict: FinalResult['verdict'],
    summary: string,
  ): Promise<void> {
    const finalResult: FinalResult = {
      verdict,
      summary,
      changedFiles: [],
      verification: this.verificationResults,
      risks: [],
      nextSteps: [],
    };
    this.currentHub = await this.hubWriter.updateFinalResult(this.currentHub, finalResult);
  }

  private notifyTerminalIfNeeded(): void {
    if (this.terminalNotified || !isTerminalStatus(this.currentHub.status)) return;
    this.terminalNotified = true;
    this.onTerminal?.(this.currentHub.status);
  }
}

function createHubMessage(role: string, content: string): HubMessage {
  return {
    id: randomUUID(),
    role,
    content,
    timestamp: Date.now(),
    visibility: 'hub',
  };
}

function createDispatchMessage(
  agent: string,
  plan: ImplementationPlan,
  supervisorInstruction?: string,
): HubMessage {
  return createHubMessage('myhead', renderDispatchMessage(agent, plan, supervisorInstruction));
}

function renderDispatchMessage(
  agent: string,
  plan: ImplementationPlan,
  supervisorInstruction?: string,
): string {
  const assignments = plan.collaborationPlan?.assignments?.[agent] ?? [];
  const lines = [
    `发给 ${renderAgentName(agent)} 的任务：`,
    '',
    `目标：${plan.goal}`,
  ];

  if (assignments.length > 0) {
    lines.push('', '你的分工：');
    for (const assignment of assignments) {
      lines.push(`- ${assignment}`);
    }
  } else {
    lines.push('', '当前范围：按已确认实施方案执行你负责的下一步。');
  }

  lines.push(
    '',
    '当前指令：',
    supervisorInstruction?.trim()
      || '继续推进下一个合适步骤；完成、阻塞和验证证据都回报给 MyHead。',
  );

  if (plan.workerStrategy === 'both') {
    lines.push(
      '',
      '协作边界：通过 MyHead 和 Message Hub 协调，不要直接向另一个 worker 发消息；不要覆盖另一个 worker 明确负责的文件或步骤。',
    );
  }

  return lines.join('\n');
}

function renderAgentName(agent: string): string {
  const names: Record<string, string> = {
    codex: 'Codex',
    claude: 'Claude',
  };
  return names[agent] ?? agent;
}

function mapVerdictToHubStatus(verdictStatus: ReviewVerdict['status']): HubStatus {
  const mapping: Record<ReviewVerdict['status'], HubStatus> = {
    accepted: 'accepted',
    continue: 'continue',
    revise: 'revise',
    verify: 'verifying',
    needs_user_decision: 'needs_user_decision',
    failed: 'failed',
    blocked: 'blocked',
  };
  return mapping[verdictStatus];
}

function renderReviewVerdictMessage(verdict: ReviewVerdict): string {
  const lines = [
    `审查结论：${renderVerdictStatus(verdict.status)}`,
    '',
    verdict.summary.trim(),
  ];

  if (verdict.findings.length > 0) {
    lines.push('', '发现：');
    for (const finding of verdict.findings) {
      const location = finding.file
        ? `（${finding.file}${finding.line ? `:${finding.line}` : ''}）`
        : '';
      lines.push(`- ${renderFindingSeverity(finding.severity)}：${finding.description}${location}`);
    }
  }

  if (verdict.missingVerification.length > 0) {
    lines.push('', '还需要验证：');
    for (const item of verdict.missingVerification) {
      lines.push(`- ${item}`);
    }
  }

  const recommendedReply = verdict.recommendedReply.trim();
  if (recommendedReply.length > 0) {
    lines.push('', '下一步给 worker 的指令：', recommendedReply);
  }

  return lines.join('\n');
}

function renderVerdictStatus(status: ReviewVerdict['status']): string {
  const names: Record<ReviewVerdict['status'], string> = {
    accepted: '已通过',
    continue: '继续执行',
    revise: '需要修订',
    verify: '需要验证',
    needs_user_decision: '需要用户决策',
    failed: '失败',
    blocked: '阻塞',
  };
  return `${names[status]} (${status})`;
}

function renderFindingSeverity(severity: ReviewVerdict['findings'][number]['severity']): string {
  const names: Record<ReviewVerdict['findings'][number]['severity'], string> = {
    info: '信息',
    warning: '警告',
    critical: '严重',
  };
  return names[severity];
}

function createContextSnapshot(agent: string, hub: HubJson): ContextSnapshot {
  const hubLogText = renderHubLog(hub);
  const planText = JSON.stringify(hub.confirmedPlan ?? {}, null, 2);
  return {
    id: randomUUID(),
    targetAgent: agent,
    hubLogOffset: hub.hubLog.length,
    estimatedTokens: estimateTokens(`${planText}\n${hubLogText}`),
    contextPolicyVersion: hub.contextPolicy.version,
    compressedArtifact: null,
    createdAt: Date.now(),
  };
}

function buildWorkerPrompt(
  plan: ImplementationPlan,
  hub: ReturnType<typeof createEmptyHub>,
  snapshot: ContextSnapshot,
  supervisorInstruction?: string,
): string {
  const peerAgents = hub.selectedAgents.filter((agent) => agent !== snapshot.targetAgent);
  return [
    '## Worker Identity',
    `You are worker "${snapshot.targetAgent}".`,
    peerAgents.length > 0
      ? `Other workers in this hub: ${peerAgents.map((agent) => `"${agent}"`).join(', ')}.`
      : 'No other workers are selected for this hub.',
    '',
    '## Implementation Plan',
    JSON.stringify(plan, null, 2),
    '',
    '## Collaboration Contract',
    ...renderCollaborationContract(plan, snapshot.targetAgent, peerAgents),
    '',
    '## Hub Context',
    `Workspace: ${hub.workspacePath}`,
    `Context snapshot: ${snapshot.id}`,
    `Hub log offset: ${snapshot.hubLogOffset}`,
    '',
    renderHubLog(hub) || '(empty — no hub messages yet)',
    '',
    '## Supervisor Instruction',
    supervisorInstruction?.trim() || 'Continue with the next appropriate step in the confirmed implementation plan.',
    '',
    '## Instructions',
    'You are a coding agent. Execute the implementation plan step by step.',
    `Only perform work assigned to worker "${snapshot.targetAgent}" when the plan or collaboration contract names worker-specific ownership.`,
    'Do not take over another worker’s explicitly assigned files or steps unless MyHead asks you to revise or complete blocked work.',
    'Use the hub context to understand what other workers have already reported; coordinate by reporting to MyHead, not by addressing other workers.',
    'Only communicate with MyHead, the supervisor. Do not address the user directly.',
    'Report what you did after each step.',
  ].join('\n');
}

function renderCollaborationContract(
  plan: ImplementationPlan,
  targetAgent: string,
  peerAgents: string[],
): string[] {
  if (plan.workerStrategy !== 'both') {
    return ['Single-worker run: execute the confirmed plan under MyHead supervision.'];
  }

  const collaborationPlan = plan.collaborationPlan;
  const assignments = collaborationPlan?.assignments?.[targetAgent] ?? [];
  const peerSummary = peerAgents.map((agent) => {
    const peerAssignments = collaborationPlan?.assignments?.[agent] ?? [];
    return `- ${agent}: ${peerAssignments.length > 0 ? peerAssignments.join('; ') : 'assignment not specified'}`;
  });

  return [
    'Multi-worker run: Codex and Claude cooperate through MyHead and the shared message hub.',
    `Your assignment: ${assignments.length > 0 ? assignments.join('; ') : 'follow only the steps that explicitly name your worker id; if no step names you, report that you need MyHead clarification.'}`,
    'Peer assignments:',
    ...(peerSummary.length > 0 ? peerSummary : ['- none']),
    'Coordination rules:',
    ...((collaborationPlan?.coordinationRules?.length ?? 0) > 0
      ? collaborationPlan!.coordinationRules.map((rule) => `- ${rule}`)
      : [
          '- Do not directly message peer workers.',
          '- Do not overwrite peer-owned files.',
          '- Report completion, blockers, and verification evidence back to MyHead.',
        ]),
  ];
}

function buildSupervisorContext(plan: ImplementationPlan, hub: ReturnType<typeof createEmptyHub>): string {
  const planText = JSON.stringify(plan, null, 2);
  const hubLogText = renderHubLog(hub);
  return [
    '## Confirmed Implementation Plan',
    planText,
    '## Hub Log',
    hubLogText || '(empty — no messages yet)',
    '## Instructions',
    'Review the current state and produce a verdict.',
  ].join('\n\n');
}

function renderHubLog(hub: Pick<HubJson, 'hubLog'>): string {
  return hub.hubLog
    .map((m, index) => `${index + 1}. [${m.role}] ${m.content}`)
    .join('\n');
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
