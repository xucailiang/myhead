import { describe, it, expect } from 'vitest';
import { runAgentDef, type AgentEvent, AgentRuntimeError } from '../src/run-agent.js';
import type { RuntimeAgentDef } from '../src/types.js';

describe('runAgentDef', () => {
  it('emits stdout events for plain adapter', async () => {
    const def: RuntimeAgentDef = {
      id: 'plain-mock',
      name: 'Plain Mock',
      bin: 'node',
      buildArgs: () => ['-e', 'console.log("hello")'],
      promptViaStdin: false,
    };

    const events: AgentEvent[] = [];
    for await (const ev of runAgentDef(def, { prompt: 'ignored' })) {
      events.push(ev);
    }

    const stdoutEvents = events.filter((e) => e.type === 'stdout');
    expect(stdoutEvents).toHaveLength(1);
    expect(stdoutEvents[0]).toMatchObject({ type: 'stdout', chunk: 'hello\n' });
  });

  it('writes prompt to stdin for promptViaStdin adapters', async () => {
    const def: RuntimeAgentDef = {
      id: 'stdin-mock',
      name: 'Stdin Mock',
      bin: 'node',
      buildArgs: () => ['-e', 'let data=""; process.stdin.on("data", d => data += d); process.stdin.on("end", () => { console.log(data); });'],
      promptViaStdin: true,
    };

    const events: AgentEvent[] = [];
    for await (const ev of runAgentDef(def, { prompt: 'my-test-prompt' })) {
      events.push(ev);
    }

    const stdoutEvents = events.filter((e) => e.type === 'stdout');
    const chunks = stdoutEvents.map((e) => e.chunk).join('');
    expect(chunks).toContain('my-test-prompt');
  });

  it('does not pass Codex Desktop API key leakage into codex workers', async () => {
    const previousApiKey = process.env.CODEX_API_KEY;
    const previousOriginator = process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
    process.env.CODEX_API_KEY = 'sk-invalid-parent-key';
    process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'Codex Desktop';
    try {
      const def: RuntimeAgentDef = {
        id: 'codex',
        name: 'Codex Env Mock',
        bin: 'node',
        buildArgs: () => ['-e', 'console.log(process.env.CODEX_API_KEY ?? "unset")'],
        promptViaStdin: false,
      };

      const events: AgentEvent[] = [];
      for await (const ev of runAgentDef(def, { prompt: 'ignored' })) {
        events.push(ev);
      }

      const output = events
        .filter((event) => event.type === 'stdout')
        .map((event) => event.chunk)
        .join('');
      expect(output.trim()).toBe('unset');
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.CODEX_API_KEY;
      } else {
        process.env.CODEX_API_KEY = previousApiKey;
      }
      if (previousOriginator === undefined) {
        delete process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
      } else {
        process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = previousOriginator;
      }
    }
  });

  it('parses json-event-stream output', async () => {
    const def: RuntimeAgentDef = {
      id: 'json-mock',
      name: 'JSON Mock',
      bin: 'node',
      buildArgs: () => ['-e', 'console.log(JSON.stringify({type:"message",role:"assistant",content:"hi"}))'],
      promptViaStdin: false,
      streamFormat: 'json-event-stream',
      eventParser: 'mock',
    };

    const events: AgentEvent[] = [];
    for await (const ev of runAgentDef(def, { prompt: 'ignored' })) {
      events.push(ev);
    }

    // json-event-stream handler may or may not surface unknown kinds as raw;
    // we just verify it consumed stdout without throwing.
    expect(events.length).toBeGreaterThan(0);
  });

  it('passes resume session ids into argv construction and invocation events', async () => {
    let seenResumeSessionId: string | undefined;
    const def: RuntimeAgentDef = {
      id: 'resume-mock',
      name: 'Resume Mock',
      bin: 'node',
      buildArgs: (_prompt, _images, _extraDirs, _options, runtimeContext) => {
        seenResumeSessionId = runtimeContext.resumeSessionId;
        return ['-e', 'console.log("resumed")'];
      },
      promptViaStdin: false,
    };

    const events: AgentEvent[] = [];
    for await (const ev of runAgentDef(def, {
      prompt: 'ignored',
      resumeSessionId: 'session-1',
    })) {
      events.push(ev);
    }

    expect(seenResumeSessionId).toBe('session-1');
    expect(events.find((event) => event.type === 'invocation_started')).toMatchObject({
      type: 'invocation_started',
      resumeSessionId: 'session-1',
    });
    expect(events.find((event) => event.type === 'invocation_completed')).toMatchObject({
      type: 'invocation_completed',
      resumeSessionId: 'session-1',
    });
  });

  it('throws when binary is not found', async () => {
    const def: RuntimeAgentDef = {
      id: 'missing',
      name: 'Missing',
      bin: 'this-binary-definitely-does-not-exist-12345',
      buildArgs: () => [],
      promptViaStdin: false,
    };

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of runAgentDef(def, { prompt: 'ignored' })) {
        // no-op
      }
    }).rejects.toThrow(AgentRuntimeError);
  });

  it('aborts a running adapter process when MyHead cancels the signal', async () => {
    const controller = new AbortController();
    const def: RuntimeAgentDef = {
      id: 'long-running-mock',
      name: 'Long Running Mock',
      bin: 'node',
      buildArgs: () => ['-e', 'setInterval(() => console.log("tick"), 100)'],
      promptViaStdin: false,
    };

    const run = async () => {
      for await (const ev of runAgentDef(def, { prompt: 'ignored', signal: controller.signal })) {
        if (ev.type === 'invocation_started') {
          controller.abort('test cancellation');
        }
      }
    };

    await expect(run()).rejects.toMatchObject({
      name: 'AgentRuntimeError',
      code: 'AGENT_ABORTED',
    });
  });
});
