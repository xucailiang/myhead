import { describe, it, expect } from 'vitest';
import { resolveAgentLaunch } from '../src/launch.js';
import { getAgentDef } from '../src/registry.js';

describe('launch', () => {
  it('resolves claude binary from PATH', () => {
    const def = getAgentDef('claude');
    expect(def).not.toBeNull();
    const launch = resolveAgentLaunch(def!);
    expect(launch.launchPath).not.toBeNull();
    expect(launch.launchPath).toMatch(/claude$/);
  });

  it('resolves codex binary from PATH', () => {
    const def = getAgentDef('codex');
    expect(def).not.toBeNull();
    const launch = resolveAgentLaunch(def!);
    expect(launch.launchPath).not.toBeNull();
    expect(launch.launchPath).toMatch(/codex$/);
  });

  it('returns null for non-existent binary', () => {
    const def = {
      id: 'nonexistent',
      name: 'Nonexistent',
      bin: 'this-binary-definitely-does-not-exist-12345',
      buildArgs: () => [],
    };
    const launch = resolveAgentLaunch(def);
    expect(launch.launchPath).toBeNull();
  });
});
