/**
 * Explicit task state machine.
 *
 * Every transition is validated, so a race (cancellation arriving while a task is
 * planning, a device disconnecting mid-action) cannot move a task into an
 * impossible state.
 */

export const TASK_STATUSES = Object.freeze([
  'queued',
  'planning',
  'awaiting_approval',
  'running',
  'completed',
  'failed',
  'cancelled',
  'expired',
]);

export const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled', 'expired']);

const TRANSITIONS = Object.freeze({
  queued: ['planning', 'cancelled', 'expired', 'failed'],
  planning: ['running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'expired'],
  awaiting_approval: ['running', 'failed', 'cancelled', 'expired'],
  running: ['awaiting_approval', 'completed', 'failed', 'cancelled', 'expired'],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
});

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

export function isActive(status) {
  return ['queued', 'planning', 'awaiting_approval', 'running'].includes(status);
}

/**
 * Assert a transition is legal, returning the target status.
 * Terminal states are idempotent: re-asserting them is a no-op.
 */
export function assertTransition(from, to) {
  if (from === to && isTerminal(from)) return to;
  if (!canTransition(from, to)) {
    const error = new Error(`Illegal task transition: ${from} -> ${to}`);
    error.code = 'TASK_NOT_ACTIONABLE';
    throw error;
  }
  return to;
}
