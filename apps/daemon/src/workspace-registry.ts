import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getWorkspaceStateDir } from './daemon-paths.js';

export type WorkspaceContext = {
  workspaceId: string;
  absolutePath: string;
  stateDir: string;
  displayName: string;
  createdAt: number;
  lastUsedAt: number;
};

export class WorkspaceRegistry {
  private readonly byId = new Map<string, WorkspaceContext>();

  register(workspacePath: string): WorkspaceContext {
    const absolutePath = path.resolve(workspacePath);
    const stat = fs.statSync(absolutePath);
    if (!stat.isDirectory()) {
      throw new Error(`Workspace is not a directory: ${absolutePath}`);
    }

    const workspaceId = stableWorkspaceId(absolutePath);
    const existing = this.byId.get(workspaceId);
    const now = Date.now();
    if (existing) {
      existing.lastUsedAt = now;
      return existing;
    }

    const stateDir = getWorkspaceStateDir(absolutePath);
    fs.mkdirSync(stateDir, { recursive: true });

    const context: WorkspaceContext = {
      workspaceId,
      absolutePath,
      stateDir,
      displayName: path.basename(absolutePath) || absolutePath,
      createdAt: now,
      lastUsedAt: now,
    };
    this.byId.set(workspaceId, context);
    return context;
  }

  get(workspaceId: string): WorkspaceContext | null {
    const context = this.byId.get(workspaceId);
    if (!context) return null;
    context.lastUsedAt = Date.now();
    return context;
  }

  list(): WorkspaceContext[] {
    return [...this.byId.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }
}

export function stableWorkspaceId(absolutePath: string): string {
  return createHash('sha256').update(absolutePath).digest('hex').slice(0, 16);
}
