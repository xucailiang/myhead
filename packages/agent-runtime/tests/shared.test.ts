import { describe, it, expect } from 'vitest';
import { clampCodexReasoning, DEFAULT_MODEL_OPTION } from '../src/defs/shared.js';

describe('shared', () => {
  it('DEFAULT_MODEL_OPTION has expected shape', () => {
    expect(DEFAULT_MODEL_OPTION).toEqual({
      id: 'default',
      label: 'Default (CLI config)',
    });
  });

  it('clampCodexReasoning maps minimal to low for gpt-5.5', () => {
    expect(clampCodexReasoning('gpt-5.5', 'minimal')).toBe('low');
  });

  it('clampCodexReasoning maps xhigh to high for gpt-5.1', () => {
    expect(clampCodexReasoning('gpt-5.1', 'xhigh')).toBe('high');
  });

  it('clampCodexReasoning leaves other values unchanged', () => {
    expect(clampCodexReasoning('gpt-5', 'medium')).toBe('medium');
    expect(clampCodexReasoning(undefined, 'high')).toBe('high');
  });

  it('clampCodexReasoning handles empty effort', () => {
    expect(clampCodexReasoning('gpt-5.5', null)).toBeNull();
    expect(clampCodexReasoning('gpt-5.5', undefined)).toBeUndefined();
  });
});
