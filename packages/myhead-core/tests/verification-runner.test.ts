import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runVerification } from '../src/verification/runner.js';

describe('runVerification', () => {
  it('runs verification commands with shell semantics', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myhead-verify-'));
    try {
      await fs.writeFile(path.join(dir, 'result.txt'), 'hello\n', 'utf8');

      const results = await runVerification(dir, [
        {
          command: 'test "$(cat result.txt)" = "hello"',
          expectedExitCode: 0,
          description: 'result.txt has expected content',
        },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0]?.passed).toBe(true);
      expect(results[0]?.summary).toBe('PASS: result.txt has expected content');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
