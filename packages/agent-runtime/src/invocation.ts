import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { RuntimeExecOptions } from './types.js';

export function execAgentFile(
  command: string,
  args: string[],
  options: RuntimeExecOptions = {},
): ChildProcessWithoutNullStreams {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: options.signal,
  });
}
