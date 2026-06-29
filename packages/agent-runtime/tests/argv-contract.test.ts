import { describe, expect, it } from 'vitest';
import { codexAgentDef } from '../src/defs/codex.js';
import { claudeAgentDef } from '../src/defs/claude.js';

describe('MyHead fixed worker argv contract', () => {
  it('builds Codex first-turn argv with fixed no-approval and last-message artifact', () => {
    const args = codexAgentDef.buildArgs('do it', [], [], {}, {
      cwd: '/repo',
      lastMessagePath: '/repo/.myhead/runs/run-1/artifacts/t1-last-message.txt',
    });

    expect(args).toEqual([
      'exec',
      '--cd',
      '/repo',
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
      '--output-last-message',
      '/repo/.myhead/runs/run-1/artifacts/t1-last-message.txt',
      '-',
    ]);
  });

  it('builds Codex resume argv with parent options before resume', () => {
    const args = codexAgentDef.buildArgs('continue', [], [], {}, {
      cwd: '/repo',
      resumeSessionId: 'codex-session-1',
      lastMessagePath: '/repo/.myhead/runs/run-1/artifacts/t2-last-message.txt',
    });

    expect(args).toEqual([
      'exec',
      '--cd',
      '/repo',
      '--dangerously-bypass-approvals-and-sandbox',
      'resume',
      '--json',
      '--output-last-message',
      '/repo/.myhead/runs/run-1/artifacts/t2-last-message.txt',
      'codex-session-1',
      '-',
    ]);
  });

  it('builds Claude first-turn argv with fixed dangerous skip and prompt file', () => {
    const args = claudeAgentDef.buildArgs('turn prompt', [], [], {}, {
      cwd: '/repo',
      newSessionId: 'claude-session-1',
      appendSystemPromptFile: '/repo/.myhead/runs/run-1/artifacts/t1-system-prompt.md',
    });

    expect(args).toEqual([
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--append-system-prompt-file',
      '/repo/.myhead/runs/run-1/artifacts/t1-system-prompt.md',
      '--session-id',
      'claude-session-1',
      'turn prompt',
    ]);
  });

  it('builds Claude resume argv without re-appending the system prompt file', () => {
    const args = claudeAgentDef.buildArgs('turn prompt', [], [], {}, {
      cwd: '/repo',
      resumeSessionId: 'claude-session-1',
      appendSystemPromptFile: '/repo/.myhead/runs/run-1/artifacts/t2-system-prompt.md',
    });

    expect(args).toEqual([
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--resume',
      'claude-session-1',
      'turn prompt',
    ]);
  });
});
