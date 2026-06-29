import { describe, expect, it } from 'vitest';
import { Readable, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../src/server.js';
import type { ModelClient } from '@myhead/myhead-core';

describe('MyHead routes', () => {
  it('saves supervisor model config without echoing the api key', async () => {
    const home = await makeTempDir('myhead-home-');
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const app = createApp();
      const saved = await invokeJson<{
        configured: boolean;
        protocol: string;
        baseUrl: string;
        model: string;
        apiKey?: string;
        configPath: string;
      }>(
        app,
        'POST',
        '/api/config',
        {
          protocol: 'openai',
          apiKey: 'sk-test-secret',
          baseUrl: 'https://example.test/v1',
          model: 'test-model',
        },
      );

      expect(saved).toMatchObject({
        configured: true,
        protocol: 'openai',
        baseUrl: 'https://example.test/v1',
        model: 'test-model',
      });
      expect(saved.apiKey).toBeUndefined();

      const configPath = path.join(home, '.myhead', 'config.json');
      expect(saved.configPath).toBe(configPath);
      const rawConfig = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
        apiKey?: string;
        model?: string;
      };
      expect(rawConfig.apiKey).toBe('sk-test-secret');
      expect(rawConfig.model).toBe('test-model');

      const shown = await invokeJson<{ configured: boolean; apiKey?: string }>(app, 'GET', '/api/config');
      expect(shown.configured).toBe(true);
      expect(shown.apiKey).toBeUndefined();
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('creates a hub, runs an injected worker, reviews it, and persists the final result', async () => {
    const workspace = await makeTempDir('myhead-route-workspace-');
    const app = createApp({
      initialWorkspacePath: workspace,
      routeOptions: {
        createModelClient: () => acceptedModel(),
        runAgent: fakeRunAgent,
      },
    });

    const workspaces = await invokeJson<{ workspaces: Array<{ workspaceId: string; absolutePath: string }> }>(
      app,
      'GET',
      '/api/workspaces',
    );
    expect(workspaces.workspaces).toHaveLength(1);
    expect(workspaces.workspaces[0]?.absolutePath).toBe(workspace);

    const plan = {
      goal: 'Create hello.js',
      steps: [{ id: '1', description: 'Create hello.js', expectedOutput: 'hello.js exists' }],
      constraints: ['Do not modify unrelated files'],
      successCriteria: ['hello.js exists'],
      risks: [],
      workerStrategy: 'codex',
      verificationPlan: [],
    };
    const created = await invokeJson<{ hubId: string; runId: string; workspaceId: string }>(
      app,
      'POST',
      `/api/workspaces/${workspaces.workspaces[0]?.workspaceId}/hub`,
      {
        planEncoded: Buffer.from(JSON.stringify(plan), 'utf8').toString('base64'),
        workerStrategy: 'codex',
      },
    );
    expect(created.workspaceId).toBe(workspaces.workspaces[0]?.workspaceId);

    const detail = await waitForHubStatus(app, created.workspaceId, created.hubId, 'accepted');
    expect(detail.confirmedPlan.summary).toBe('Create hello.js');
    expect(detail.hubLog.some((m) => m.role === 'codex' && m.content.includes('worker completed'))).toBe(true);
    expect(detail.finalResult).toMatchObject({
      verdict: 'accepted',
      summary: 'worker result accepted',
    });

    const hubPath = path.join(workspace, '.myhead', 'sessions', `${created.hubId}.json`);
    const saved = JSON.parse(await fs.readFile(hubPath, 'utf8')) as { finalResult?: { verdict?: string } };
    expect(saved.finalResult?.verdict).toBe('accepted');

    const eventStream = await invoke(
      app,
      'GET',
      `/api/workspaces/${created.workspaceId}/hub/${created.hubId}/events`,
    );
    expect(eventStream.statusCode).toBe(200);
    expect(eventStream.body).toContain('"type":"hub_status"');
    expect(eventStream.body).toContain('"status":"accepted"');
    expect(eventStream.body).toContain('worker completed under MyHead supervision');
    expect(eventStream.body).not.toContain('HUB_NOT_FOUND');

    await fs.rm(workspace, { recursive: true, force: true });
  });
});

function acceptedModel(): ModelClient {
  return {
    async *chat() {},
    async completeJson() {
      return {
        status: 'accepted',
        summary: 'worker result accepted',
        findings: [],
        missingVerification: [],
        recommendedReply: 'accepted',
      };
    },
  };
}

async function* fakeRunAgent() {
  yield { type: 'invocation_started', command: 'fake-worker', args: [], cwd: '.', artifacts: {} };
  yield { type: 'text_delta', delta: 'worker completed under MyHead supervision' };
  yield { type: 'invocation_completed', command: 'fake-worker', args: [], cwd: '.', artifacts: {}, exitCode: 0 };
}

async function waitForHubStatus(
  app: ReturnType<typeof createApp>,
  workspaceId: string,
  hubId: string,
  status: string,
) {
  let last: Awaited<ReturnType<typeof invokeJson<{
    status: string;
    confirmedPlan: { summary: string };
    hubLog: Array<{ role: string; content: string }>;
    finalResult?: unknown;
  }>>> | null = null;
  for (let i = 0; i < 50; i += 1) {
    last = await invokeJson(app, 'GET', `/api/workspaces/${workspaceId}/hub/${hubId}`);
    if (last.status === status && last.finalResult) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Hub did not reach ${status}. Last status: ${last?.status ?? 'unknown'}`);
}

async function invokeJson<T>(
  app: ReturnType<typeof createApp>,
  method: string,
  url: string,
  body?: unknown,
): Promise<T> {
  const response = await invoke(app, method, url, body);
  expect(response.statusCode).toBeGreaterThanOrEqual(200);
  expect(response.statusCode).toBeLessThan(300);
  return JSON.parse(response.body) as T;
}

function invoke(
  app: ReturnType<typeof createApp>,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ statusCode: number; body: string }> {
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const req = new Readable({
    read() {
      this.push(rawBody || null);
      if (rawBody) this.push(null);
    },
  }) as Readable & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = method;
  req.url = url;
  req.headers = rawBody
    ? {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(rawBody)),
      }
    : {};

  const res = new MockResponse();
  return new Promise((resolve, reject) => {
    res.onDone = () => resolve({ statusCode: res.statusCode, body: res.body });
    app.handle(req as never, res as never, reject);
  });
}

class MockResponse extends Writable {
  statusCode = 200;
  body = '';
  onDone: (() => void) | null = null;

  constructor() {
    super();
    const headers = new Map<string, string | number | readonly string[]>();
    this.setHeader = (name: string, value: string | number | readonly string[]) => {
      headers.set(name.toLowerCase(), value);
      return this;
    };
    this.getHeader = (name: string) => headers.get(name.toLowerCase());
    this.removeHeader = (name: string) => {
      headers.delete(name.toLowerCase());
    };
    this.writeHead = (statusCode: number, nextHeaders?: Record<string, string>) => {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(nextHeaders ?? {})) {
        this.setHeader(name, value);
      }
      return this;
    };
    this.write = (chunk: Buffer | string) => {
      this.body += chunk.toString();
      return true;
    };
    this.end = (
      chunk?: Buffer | string | (() => void),
      encoding?: BufferEncoding | (() => void),
      callback?: () => void,
    ) => {
      if (typeof chunk === 'function') {
        callback = chunk;
        chunk = undefined;
      }
      if (typeof encoding === 'function') {
        callback = encoding;
      }
      if (chunk) this.body += chunk.toString();
      callback?.();
      this.onDone?.();
      return this;
    };
  }

  setHeader!: (name: string, value: string | number | readonly string[]) => this;
  getHeader!: (name: string) => string | number | readonly string[] | undefined;
  removeHeader!: (name: string) => void;
  writeHead!: (statusCode: number, headers?: Record<string, string>) => this;
  write!: (chunk: Buffer | string) => boolean;
  end!: (
    chunk?: Buffer | string | (() => void),
    encoding?: BufferEncoding | (() => void),
    callback?: () => void,
  ) => this;

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.body += chunk.toString();
    callback();
  }
}

async function makeTempDir(prefix: string): Promise<string> {
  const tmpRoot = path.resolve(process.cwd(), '../../..', 'tmp');
  await fs.mkdir(tmpRoot, { recursive: true });
  return fs.mkdtemp(path.join(tmpRoot, prefix));
}
