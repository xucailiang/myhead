import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import type { RuntimeAgentDef, AgentLaunchResolution } from './types.js';

export function resolveAgentLaunch(def: RuntimeAgentDef): AgentLaunchResolution {
  const paths = process.env.PATH?.split(path.delimiter) ?? [];
  let selectedPath: string | null = null;

  for (const bin of [def.bin, ...(def.fallbackBins ?? [])]) {
    for (const dir of paths) {
      const full = path.join(dir, bin);
      try {
        accessSync(full, constants.X_OK);
        selectedPath = full;
        break;
      } catch {}
    }
    if (selectedPath) break;
  }

  if (!selectedPath) {
    return { launchPath: null, childPathPrepend: [] };
  }

  const childPathPrepend = path.isAbsolute(selectedPath)
    ? [path.dirname(selectedPath)]
    : [];

  return { launchPath: selectedPath, childPathPrepend };
}
