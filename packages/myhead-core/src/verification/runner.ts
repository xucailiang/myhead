import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { VerificationResult } from '../types.js';

const execP = promisify(exec);

export type VerificationCommand = {
  command: string;
  expectedExitCode?: number;
  description: string;
};

export async function runVerification(
  cwd: string,
  commands: VerificationCommand[],
  timeoutMs: number = 120_000,
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  for (const cmd of commands) {
    let exitCode: number | null = null;
    let stdout = '';
    let stderr = '';

    try {
      const result = await execP(cmd.command, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });
      exitCode = 0;
      stdout = result.stdout;
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
      stdout = e.stdout ?? '';
      stderr = e.stderr ?? '';
      exitCode = typeof e.code === 'number' ? e.code : null;
    }

    const expected = cmd.expectedExitCode ?? 0;
    results.push({
      command: cmd.command,
      exitCode,
      stdout,
      stderr,
      summary: exitCode === expected
        ? `PASS: ${cmd.description}`
        : `FAIL (exit ${exitCode}, expected ${expected}): ${cmd.description}`,
      passed: exitCode === expected,
    });
  }

  return results;
}
