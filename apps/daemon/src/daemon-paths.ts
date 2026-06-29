import os from 'node:os';
import path from 'node:path';

export function getUserDataDir(): string {
  return path.join(os.homedir(), '.myhead');
}

export function getWorkspaceStateDir(workspacePath: string): string {
  return path.join(workspacePath, '.myhead');
}

export function getHubsDir(workspacePath: string): string {
  return path.join(getWorkspaceStateDir(workspacePath), 'sessions');
}

export function getHubPath(workspacePath: string, hubId: string): string {
  return path.join(getHubsDir(workspacePath), `${hubId}.json`);
}

export function getAgentSessionDbPath(): string {
  return path.join(getUserDataDir(), 'sessions.db');
}
