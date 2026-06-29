import { describe, it, expect } from 'vitest';
import { canTransition, assertValidTransition, isTerminalStatus } from '../src/hub/state-machine.js';

describe('state-machine', () => {
  it('allows listening -> message_queued', () => {
    expect(canTransition('listening', 'message_queued')).toBe(true);
  });

  it('allows reviewing -> accepted', () => {
    expect(canTransition('reviewing', 'accepted')).toBe(true);
  });

  it('forbids listening -> accepted', () => {
    expect(canTransition('listening', 'accepted')).toBe(false);
  });

  it('allows same-state transitions', () => {
    expect(canTransition('listening', 'listening')).toBe(true);
  });

  it('throws on invalid transition', () => {
    expect(() => assertValidTransition('listening', 'accepted')).toThrow();
  });

  it('identifies terminal statuses', () => {
    expect(isTerminalStatus('accepted')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('listening')).toBe(false);
  });
});
