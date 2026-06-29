import type { HubStatus } from '../types.js';

const VALID_TRANSITIONS: Record<HubStatus, HubStatus[]> = {
  listening: ['message_queued', 'blocked', 'cancelled'],
  message_queued: ['reviewing', 'blocked', 'cancelled'],
  reviewing: ['continue', 'revise', 'verifying', 'replying', 'needs_user_decision', 'accepted', 'failed', 'blocked', 'cancelled'],
  continue: ['reviewing', 'failed', 'blocked', 'cancelled'],
  revise: ['verifying', 'replying', 'reviewing', 'needs_user_decision', 'failed', 'blocked', 'cancelled'],
  verifying: ['continue', 'revise', 'reviewing', 'replying', 'needs_user_decision', 'accepted', 'failed', 'blocked', 'cancelled'],
  replying: ['listening', 'reviewing', 'needs_user_decision', 'accepted', 'failed', 'blocked', 'cancelled'],
  needs_user_decision: ['listening', 'reviewing', 'accepted', 'failed', 'blocked', 'cancelled'],
  accepted: [],
  failed: [],
  blocked: [],
  cancelled: [],
};

export function canTransition(from: HubStatus, to: HubStatus): boolean {
  if (from === to) return true;
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminalStatus(status: HubStatus): boolean {
  return ['accepted', 'failed', 'blocked', 'cancelled'].includes(status);
}

export function assertValidTransition(from: HubStatus, to: HubStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid hub status transition: ${from} -> ${to}`);
  }
}
