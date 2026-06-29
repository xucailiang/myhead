import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceRegistry } from '../src/workspace-registry.js';

describe('WorkspaceRegistry', () => {
  it('registers a workspace with a stable id and local state dir', async () => {
    const dir = await makeTempDir('myhead-workspace-');
    const registry = new WorkspaceRegistry();

    const first = registry.register(dir);
    const second = registry.register(dir);

    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.absolutePath).toBe(first.absolutePath);
    expect(await exists(path.join(dir, '.myhead'))).toBe(true);
    expect(registry.get(first.workspaceId)?.absolutePath).toBe(first.absolutePath);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rejects files as workspaces', async () => {
    const dir = await makeTempDir('myhead-workspace-');
    const file = path.join(dir, 'not-a-workspace.txt');
    await fs.writeFile(file, 'nope', 'utf8');
    const registry = new WorkspaceRegistry();

    expect(() => registry.register(file)).toThrow(/not a directory/);

    await fs.rm(dir, { recursive: true, force: true });
  });
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function makeTempDir(prefix: string): Promise<string> {
  const tmpRoot = path.resolve(process.cwd(), '../../..', 'tmp');
  await fs.mkdir(tmpRoot, { recursive: true });
  return fs.mkdtemp(path.join(tmpRoot, prefix));
}
