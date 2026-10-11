import { ACTION_TYPES, validateAction, validatePlan } from './actionSchema.js';
import { AppError } from '../utils/errors.js';

/**
 * Deterministic policy engine.
 *
 * The AI may only *propose*; this module decides. It runs on the server before
 * dispatch and again, independently, on the device.
 */

/** Labels that mean "this tap may send, buy, delete or publish something". */
const SENSITIVE_LABELS = [
  'send',
  'post',
  'publish',
  'share',
  'upload',
  'buy',
  'purchase',
  'pay',
  'payment',
  'checkout',
  'subscribe',
  'order',
  'donate',
  'transfer',
  'delete',
  'remove account',
  'uninstall',
  'install',
  'confirm',
  'accept',
  'agree',
  'continue to payment',
  'place order',
];

/** Text that must never be typed or tapped, whatever the model asks. */
const FORBIDDEN_LABELS = [
  'ignore previous instructions',
  'ignore all previous instructions',
  'system prompt',
  'disregard the above',
  'new instructions:',
];

/** Shapes that look like secrets and must never be typed into a field. */
const SECRET_SHAPES = [
  /\b\d{3}[- ]?\d{3}\b/, // possible OTP / verification code
  /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9!@#$%^&*]{12,}$/, // password-like
];

const SENSITIVE_FIELD_HINTS = ['password', 'passwd', 'pin', 'cvv', 'card number', 'otp', 'verification code'];

export function isSensitiveLabel(text) {
  const value = String(text ?? '').toLowerCase().trim();
  if (!value) return false;
  return SENSITIVE_LABELS.some((label) => value.includes(label));
}

export function isForbiddenLabel(text) {
  const value = String(text ?? '').toLowerCase().trim();
  if (!value) return false;
  return FORBIDDEN_LABELS.some((label) => value.includes(label));
}

export function looksLikeSecret(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  return SECRET_SHAPES.some((pattern) => pattern.test(value));
}

export function isSensitiveFieldHint(text) {
  const value = String(text ?? '').toLowerCase();
  if (!value) return false;
  return SENSITIVE_FIELD_HINTS.some((hint) => value.includes(hint));
}

/**
 * Classify a single action.
 * @returns {{decision: 'allow'|'approval'|'deny', reasons: string[]}}
 */
export function classifyAction(action, { sensitiveMode = 'approval' } = {}) {
  const reasons = [];

  if (isForbiddenLabel(action?.match?.text) || isForbiddenLabel(action?.match?.content_description)) {
    return { decision: 'deny', reasons: ['The target text looks like a prompt injection attempt.'] };
  }
  if (isForbiddenLabel(action?.target?.text)) {
    return { decision: 'deny', reasons: ['The target field text looks like a prompt injection attempt.'] };
  }

  if (action?.type === 'type_text') {
    if (looksLikeSecret(action.text)) {
      return { decision: 'deny', reasons: ['NEXUS never types credentials, OTP codes or password-like values.'] };
    }
    if (isSensitiveFieldHint(action?.target?.text) || isSensitiveFieldHint(action?.target?.content_description)) {
      return { decision: 'deny', reasons: ['NEXUS never types into password, PIN or card fields.'] };
    }
    reasons.push('Typing text into a field can submit information.');
    return { decision: sensitiveMode === 'deny' ? 'deny' : 'approval', reasons };
  }

  if (action?.type === 'tap_element') {
    const label = `${action?.match?.text ?? ''} ${action?.match?.content_description ?? ''}`.trim();
    if (isSensitiveLabel(label)) {
      reasons.push(`The element label ("${label}") suggests an irreversible or outgoing action.`);
      return { decision: sensitiveMode === 'deny' ? 'deny' : 'approval', reasons };
    }
  }

  return { decision: 'allow', reasons };
}

/**
 * Validate and screen a whole plan.
 *
 * Throws `INVALID_AI_PLAN` when the shape is unusable and `ACTION_NOT_ALLOWED`
 * when a proposed action is denied outright.
 */
export function screenPlan(plan, { maxActions = 12, sensitiveMode = 'approval' } = {}) {
  const parsed = validatePlan(plan);
  if (!parsed.success) {
    throw new AppError('INVALID_AI_PLAN', {
      details: { issues: parsed.error.issues.slice(0, 10).map((issue) => issue.message) },
    });
  }

  const value = parsed.data;
  if (value.actions.length > maxActions) {
    throw new AppError('INVALID_AI_PLAN', {
      details: { issues: [`plan contains ${value.actions.length} actions, limit is ${maxActions}`] },
    });
  }

  const screened = [];
  let requiresApproval = value.requires_approval === true;
  const approvalReasons = [];

  value.actions.forEach((action, index) => {
    const verdict = classifyAction(action, { sensitiveMode });
    if (verdict.decision === 'deny') {
      throw new AppError('ACTION_NOT_ALLOWED', {
        details: { actionIndex: index, type: action.type, reasons: verdict.reasons },
      });
    }
    if (verdict.decision === 'approval') {
      requiresApproval = true;
      for (const reason of verdict.reasons) approvalReasons.push(`action ${index + 1}: ${reason}`);
    }
    screened.push({ ...action, sequence: index + 1 });
  });

  return {
    taskSummary: value.task_summary,
    requiresApproval,
    approvalReasons,
    needsClarification: value.needs_clarification === true,
    clarificationQuestion: value.clarification_question,
    actions: screened,
  };
}

/** Independently re-check one action just before it is dispatched to a device. */
export function screenAction(action, { sensitiveMode = 'approval' } = {}) {
  const parsed = validateAction(action);
  if (!parsed.success) {
    throw new AppError('ACTION_NOT_ALLOWED', {
      details: { issues: parsed.error.issues.slice(0, 10).map((issue) => issue.message) },
    });
  }
  const verdict = classifyAction(parsed.data, { sensitiveMode });
  if (verdict.decision === 'deny') {
    throw new AppError('ACTION_NOT_ALLOWED', { details: { reasons: verdict.reasons } });
  }
  return { action: parsed.data, requiresApproval: verdict.decision === 'approval', reasons: verdict.reasons };
}

export const ALLOWED_ACTION_TYPES = ACTION_TYPES;
