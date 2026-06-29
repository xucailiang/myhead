import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './server.js';
import { openBrowser } from './browser-open.js';
import { parseCliArgs, resolvePort } from './cli.js';
import { cancelActiveLoops } from './myhead-routes.js';

const port = resolvePort();
const { workspacePath } = parseCliArgs(process.argv.slice(2), {
  requireWorkspaceArg: process.env.MYHEAD_CLI_ENTRY === '1',
});
const webDistPath = resolveWebDistPath();
const app = createApp({ webDistPath, initialWorkspacePath: workspacePath });
const server = app.listen(port, '127.0.0.1', () => {
  const daemonUrl = `http://127.0.0.1:${port}`;
  const webUrl = webDistPath
    ? daemonUrl
    : process.env.MYHEAD_WEB_URL ?? 'http://127.0.0.1:5173';
  console.log(`MyHead daemon running at ${daemonUrl}`);
  console.log(`MyHead web UI available at ${webUrl}`);
  openBrowser(webUrl);
});

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

async function shutdown(signal: string): Promise<void> {
  await cancelActiveLoops(`${signal}: MyHead daemon is shutting down`);
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}

function resolveWebDistPath(): string | null {
  const explicit = process.env.MYHEAD_WEB_DIST;
  if (explicit && hasIndexHtml(explicit)) return explicit;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../web/dist'),
    path.resolve(here, '../../../web/dist'),
    path.resolve(process.cwd(), 'apps/web/dist'),
  ];
  return candidates.find(hasIndexHtml) ?? null;
}

function hasIndexHtml(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'index.html'));
}
