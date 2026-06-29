import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { agentCapabilities } from './capabilities.js';
import type { RuntimeAgentDef, DetectedAgent, RuntimeCapabilityMap } from './types.js';

const execFileP = promisify(execFile);

function findOnPath(bin: string): string | null {
  const paths = process.env.PATH?.split(path.delimiter) ?? [];
  for (const dir of paths) {
    const full = path.join(dir, bin);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch {}
  }
  return null;
}

export async function detectAgent(def: RuntimeAgentDef): Promise<DetectedAgent | null> {
  const binPath = findOnPath(def.bin) ?? (def.fallbackBins?.map(findOnPath).find(Boolean) ?? null);
  if (!binPath) return null;

  let version: string | null = null;
  if (def.versionArgs) {
    try {
      const { stdout } = await execFileP(binPath, def.versionArgs, { timeout: 5000 });
      version = stdout.trim().split('\n')[0] ?? null;
    } catch {}
  }

  const capabilities: RuntimeCapabilityMap = {};
  if (def.helpArgs) {
    try {
      const { stdout } = await execFileP(binPath, def.helpArgs, { timeout: 5000 });
      const help = stdout;
      for (const [flag, key] of Object.entries(def.capabilityFlags ?? {})) {
        if (help.includes(flag)) capabilities[key] = true;
      }
      // Codex 0.140.0+ uses `-` as the stdin sentinel for `codex exec`.
      // Detect this from help text so buildArgs can add it dynamically.
      if (def.id === 'codex' && help.includes('if `-` is used')) {
        capabilities.stdinDash = true;
      }
    } catch {}
  }

  agentCapabilities.set(def.id, capabilities);
  return { id: def.id, name: def.name, version, path: binPath, capabilities };
}

export async function detectAgents(defs: RuntimeAgentDef[]): Promise<DetectedAgent[]> {
  const results = await Promise.all(defs.map(detectAgent));
  return results.filter((d): d is DetectedAgent => d !== null);
}
