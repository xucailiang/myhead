import { describe, it, expect } from 'vitest';
import { getAgentDef, AGENT_DEFS } from '../src/registry.js';

describe('registry', () => {
  it('registers exactly claude and codex', () => {
    expect(AGENT_DEFS.map((d) => d.id).sort()).toEqual(['claude', 'codex']);
  });

  it('returns claude def', () => {
    const def = getAgentDef('claude');
    expect(def).not.toBeNull();
    expect(def?.id).toBe('claude');
    expect(def?.bin).toBe('claude');
    expect(def?.streamFormat).toBe('claude-stream-json');
  });

  it('returns codex def', () => {
    const def = getAgentDef('codex');
    expect(def).not.toBeNull();
    expect(def?.id).toBe('codex');
    expect(def?.bin).toBe('codex');
    expect(def?.streamFormat).toBe('json-event-stream');
    expect(def?.eventParser).toBe('codex');
  });

  it('returns null for unknown agent', () => {
    expect(getAgentDef('foo')).toBeNull();
  });
});
