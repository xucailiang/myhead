import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentName, AgentStatus, FinalResult, HubMessage, HubStatus } from '../types.js';
import type { HubJson } from './schema.js';

export class HubWriter {
  private writeLock: Promise<void> = Promise.resolve();
  private tempSeq = 0;

  constructor(private readonly filePath: string) {}

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = this.writeLock;
    let resolveRelease: () => void;
    this.writeLock = new Promise((resolve) => {
      resolveRelease = resolve;
    });
    await release;
    try {
      return await fn();
    } finally {
      resolveRelease!();
    }
  }

  async readHub(): Promise<HubJson | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as HubJson;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async enqueue(mutator: (current: HubJson | null) => HubJson | Promise<HubJson>): Promise<HubJson> {
    return this.withLock(async () => {
      const current = await this.readHub();
      const next = await mutator(current);
      const updated = { ...next, updatedAt: Date.now() };
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });
      const tempPath = `${this.filePath}.tmp-${process.pid}-${++this.tempSeq}`;
      await fs.writeFile(tempPath, JSON.stringify(updated, null, 2), 'utf8');
      await fs.rename(tempPath, this.filePath);
      return updated;
    });
  }

  async writeHub(hub: HubJson): Promise<void> {
    await this.enqueue(() => hub);
  }

  async appendMessage(
    hub: HubJson,
    message: HubMessage,
    options: { queue?: boolean } = {},
  ): Promise<HubJson> {
    return this.enqueue((current) => {
      const base = current ?? hub;
      const messageId = message.id;
      const pendingQueue = options.queue && messageId
        ? [...base.pendingQueue, messageId]
        : base.pendingQueue;
      return {
        ...base,
        hubLog: [...base.hubLog, message],
        pendingQueue,
      };
    });
  }

  async shiftPendingQueue(hub: HubJson): Promise<HubJson> {
    return this.enqueue((current) => {
      const base = current ?? hub;
      return {
        ...base,
        pendingQueue: base.pendingQueue.slice(1),
      };
    });
  }

  async updateStatus(hub: HubJson, status: HubStatus): Promise<HubJson> {
    return this.enqueue((current) => ({
      ...(current ?? hub),
      status,
    }));
  }

  async updateAgentStatus(
    hub: HubJson,
    agent: AgentName,
    agentStatus: AgentStatus,
  ): Promise<HubJson> {
    return this.enqueue((current) => {
      const base = current ?? hub;
      return {
        ...base,
        agentStatus: { ...base.agentStatus, [agent]: agentStatus },
      };
    });
  }

  async updateFinalResult(
    hub: HubJson,
    finalResult: FinalResult,
  ): Promise<HubJson> {
    return this.enqueue((current) => ({
      ...(current ?? hub),
      finalResult,
    }));
  }
}
