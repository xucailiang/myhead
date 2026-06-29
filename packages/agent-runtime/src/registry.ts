import { claudeAgentDef } from './defs/claude.js';
import { codexAgentDef } from './defs/codex.js';
import type { RuntimeAgentDef } from './types.js';

export const AGENT_DEFS: RuntimeAgentDef[] = [claudeAgentDef, codexAgentDef];

export function getAgentDef(id: string): RuntimeAgentDef | null {
  return AGENT_DEFS.find((a) => a.id === id) || null;
}
