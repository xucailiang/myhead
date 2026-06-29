import { execFile } from 'node:child_process';
import process from 'node:process';

export function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open'
    : platform === 'win32' ? 'start'
    : 'xdg-open';
  execFile(command, [url], (err) => {
    if (err) console.error('Failed to open browser:', err.message);
  });
}
