import process from 'node:process';
import path from 'node:path';

export function resolvePort(): number {
  const env = process.env.MYHEAD_PORT;
  if (env) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 17573;
}

export type ParseCliArgsOptions = {
  requireWorkspaceArg?: boolean;
};

export function parseCliArgs(
  argv: string[] = process.argv.slice(2),
  options: ParseCliArgsOptions = {},
): { workspacePath: string | null } {
  const envWorkspace = process.env.MYHEAD_WORKSPACE;
  if (envWorkspace) {
    return { workspacePath: path.resolve(envWorkspace) };
  }

  if (argv.length === 0 && !options.requireWorkspaceArg) {
    return { workspacePath: null };
  }

  if (argv.length !== 1 || argv[0] !== '.') {
    console.error('Usage: myhead .');
    process.exit(1);
  }
  return { workspacePath: process.cwd() };
}
