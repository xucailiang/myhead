import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HubWriter } from '../src/hub/writer.js';
import { createEmptyHub } from '../src/hub/schema.js';

describe('HubWriter', () => {
  it('writes hub atomically and reads back', async () => {
    const dir = await makeTempDir('myhead-test-');
    const filePath = path.join(dir, 'hub.json');
    const writer = new HubWriter(filePath);

    let hub = createEmptyHub('hub-1', dir, ['claude', 'codex']);
    hub = await writer.updateStatus(hub, 'message_queued');

    const read = await writer.readHub();
    expect(read).not.toBeNull();
    expect(read?.hubId).toBe('hub-1');
    expect(read?.status).toBe('message_queued');
    expect(read?.contextPolicy).toEqual({ mode: 'full', version: 1 });
    expect(read?.contextSnapshots).toEqual([]);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns null for missing file', async () => {
    const dir = await makeTempDir('myhead-test-');
    const writer = new HubWriter(path.join(dir, 'definitely-missing-myhead-hub.json'));
    const read = await writer.readHub();
    expect(read).toBeNull();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('serializes concurrent mutators from the last saved hub state', async () => {
    const dir = await makeTempDir('myhead-test-');
    const filePath = path.join(dir, 'hub.json');
    const writer = new HubWriter(filePath);
    const hub = createEmptyHub('hub-1', dir, ['codex'], {
      workspaceId: 'workspace-1',
      runId: 'run-1',
      confirmedPlan: {
        text: 'plan',
        hash: 'hash',
        summary: 'plan',
      },
    });
    await writer.writeHub(hub);

    await Promise.all(Array.from({ length: 20 }, (_, i) => writer.enqueue((current) => ({
      ...(current ?? hub),
      hubLog: [
        ...((current ?? hub).hubLog),
        { id: `m-${i}`, role: 'codex', content: `message ${i}`, timestamp: i },
      ],
    }))));

    const read = await writer.readHub();
    expect(read?.hubLog).toHaveLength(20);
    expect(read?.confirmedPlan?.text).toBe('plan');

    await fs.rm(dir, { recursive: true, force: true });
  });
});

async function makeTempDir(prefix: string): Promise<string> {
  const tmpRoot = path.resolve(process.cwd(), '../../..', 'tmp');
  await fs.mkdir(tmpRoot, { recursive: true });
  return fs.mkdtemp(path.join(tmpRoot, prefix));
}
