import { z } from 'zod';
import { actionSchema } from '../policies/actionSchema.js';

/**
 * Versioned device protocol shared by the server and the Android client.
 *
 * Both sides validate every inbound message against these schemas and reject
 * unknown protocol versions instead of guessing.
 */

export const PROTOCOL_VERSION = 1;
export const SUPPORTED_PROTOCOL_VERSIONS = [1];

const envelope = {
  protocol_version: z.number().int().min(1),
  message_id: z.string().min(1).max(64).optional(),
  sent_at: z.string().max(40).optional(),
};

const deviceClient = z
  .object({
    app_version: z.string().min(1).max(40),
    android_version: z.string().min(1).max(40),
    device_model: z.string().max(80).optional(),
    accessibility_enabled: z.boolean().optional(),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* Device -> server                                                     */
/* ------------------------------------------------------------------ */

export const deviceHelloSchema = z
  .object({
    ...envelope,
    type: z.literal('device_hello'),
    device_id: z.string().min(1).max(64),
    device_token: z.string().min(16).max(256),
    client: deviceClient.optional(),
  })
  .strict();

export const heartbeatSchema = z
  .object({ ...envelope, type: z.literal('heartbeat'), nonce: z.string().max(64).optional() })
  .strict();

export const deviceStatusSchema = z
  .object({
    ...envelope,
    type: z.literal('device_status'),
    accessibility_enabled: z.boolean(),
    battery_percent: z.number().int().min(0).max(100).optional(),
    charging: z.boolean().optional(),
  })
  .strict();

const sanitizedResult = z
  .object({
    summary: z.string().max(1000).optional(),
    package_name: z.string().max(255).optional(),
    activity: z.string().max(255).optional(),
    matched: z.boolean().optional(),
    match_count: z.number().int().min(0).max(1000).optional(),
    scrolled: z.boolean().optional(),
    visible_text: z.array(z.string().max(200)).max(50).optional(),
    elements: z
      .array(
        z
          .object({
            text: z.string().max(200).optional(),
            content_description: z.string().max(200).optional(),
            class_name: z.string().max(200).optional(),
            clickable: z.boolean().optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
  })
  .strict()
  .nullable()
  .optional();

export const actionResultSchema = z
  .object({
    ...envelope,
    type: z.literal('action_result'),
    task_id: z.string().min(1).max(64),
    action_id: z.string().min(1).max(64),
    sequence: z.number().int().min(1).max(1000),
    status: z.enum(['succeeded', 'failed']),
    error_code: z
      .enum([
        'ACTION_TIMEOUT',
        'APP_NOT_INSTALLED',
        'TARGET_AMBIGUOUS',
        'TARGET_NOT_FOUND',
        'ACCESSIBILITY_NOT_ENABLED',
        'ACTION_NOT_ALLOWED',
        'SCREEN_BLOCKED',
        'TASK_CANCELLED',
        'INVALID_REQUEST',
        'INTERNAL_ERROR',
      ])
      .optional(),
    message: z.string().max(500).optional(),
    duration_ms: z.number().int().min(0).max(600000).optional(),
    result: sanitizedResult,
  })
  .strict();

export const taskProgressSchema = z
  .object({
    ...envelope,
    type: z.literal('task_progress'),
    task_id: z.string().min(1).max(64),
    status: z.enum(['running', 'awaiting_approval', 'completed', 'failed', 'cancelled']),
    message: z.string().max(500).optional(),
  })
  .strict();

export const deviceProtocolErrorSchema = z
  .object({
    ...envelope,
    type: z.literal('protocol_error'),
    error_code: z.string().min(1).max(64),
    message: z.string().max(500).optional(),
    ref_message_id: z.string().max(64).optional(),
  })
  .strict();

/**
 * The phone asks the server to plan and run a task.
 *
 * The device is already authenticated, so this is the owner's own phone asking;
 * it is still validated and rate limited exactly like the HTTP API, and the
 * instruction goes through the same TaskService, planner and policy engine.
 */
export const taskCreateSchema = z
  .object({
    ...envelope,
    type: z.literal('task_create'),
    request_id: z.string().min(1).max(64),
    instruction: z.string().min(1).max(1000),
  })
  .strict();

/** The owner approves a sensitive task from the phone itself. */
export const taskApproveSchema = z
  .object({
    ...envelope,
    type: z.literal('task_approve'),
    task_id: z.string().min(1).max(64),
  })
  .strict();

export const taskDenySchema = z
  .object({
    ...envelope,
    type: z.literal('task_deny'),
    task_id: z.string().min(1).max(64),
  })
  .strict();

export const inboundMessageSchema = z.discriminatedUnion('type', [
  taskApproveSchema,
  taskDenySchema,
  deviceHelloSchema,
  heartbeatSchema,
  deviceStatusSchema,
  actionResultSchema,
  taskProgressSchema,
  taskCreateSchema,
  deviceProtocolErrorSchema,
]);

/* ------------------------------------------------------------------ */
/* Server -> device                                                     */
/* ------------------------------------------------------------------ */

export const authOkSchema = z
  .object({
    ...envelope,
    type: z.literal('device_auth_ok'),
    device_id: z.string().max(64),
    server_time: z.string().max(40),
    heartbeat_interval_ms: z.number().int().min(1000),
    protocol_version: z.literal(1),
  })
  .strict();

export const authFailedSchema = z
  .object({
    ...envelope,
    type: z.literal('device_auth_failed'),
    error_code: z.enum([
      'AUTHENTICATION_REQUIRED',
      'DEVICE_REVOKED',
      'INVALID_PROTOCOL_VERSION',
      'INVALID_REQUEST',
      'RATE_LIMITED',
    ]),
    message: z.string().max(300),
  })
  .strict();

export const heartbeatAckSchema = z
  .object({ ...envelope, type: z.literal('heartbeat_ack'), server_time: z.string().max(40) })
  .strict();

export const taskDispatchSchema = z
  .object({
    ...envelope,
    type: z.literal('task_dispatch'),
    task_id: z.string().min(1).max(64),
    instruction: z.string().min(1).max(1000),
    action_count: z.number().int().min(1),
    expires_at: z.string().max(40),
  })
  .strict();

export const executeActionSchema = z
  .object({
    ...envelope,
    type: z.literal('execute_action'),
    task_id: z.string().min(1).max(64),
    action_id: z.string().min(1).max(64),
    sequence: z.number().int().min(1),
    expires_at: z.string().max(40),
    action: actionSchema,
  })
  .strict();

export const cancelTaskSchema = z
  .object({
    ...envelope,
    type: z.literal('cancel_task'),
    task_id: z.string().min(1).max(64),
    reason: z.enum(['user_cancelled', 'task_expired', 'device_revoked', 'policy_denied']),
  })
  .strict();

export const approvalRequiredSchema = z
  .object({
    ...envelope,
    type: z.literal('approval_required'),
    task_id: z.string().min(1).max(64),
    reasons: z.array(z.string().max(300)).max(20),
  })
  .strict();

export const taskCompletedSchema = z
  .object({
    ...envelope,
    type: z.literal('task_completed'),
    task_id: z.string().min(1).max(64),
    status: z.enum(['completed', 'failed', 'cancelled', 'expired']),
    summary: z.string().max(1000).optional(),
    error_code: z.string().max(64).optional(),
  })
  .strict();

export const deviceRevokedSchema = z
  .object({
    ...envelope,
    type: z.literal('device_revoked'),
    reason: z.string().max(200),
  })
  .strict();

export const serverProtocolErrorSchema = z
  .object({
    ...envelope,
    type: z.literal('protocol_error'),
    error_code: z.string().min(1).max(64),
    message: z.string().max(500),
    ref_message_id: z.string().max(64).optional(),
  })
  .strict();

/** The task was queued; `task_id` lets the phone follow it. */
export const taskAcceptedSchema = z
  .object({
    ...envelope,
    type: z.literal('task_accepted'),
    request_id: z.string().min(1).max(64),
    task_id: z.string().min(1).max(64),
    status: z.enum(['queued', 'planning', 'awaiting_approval', 'running', 'completed', 'failed', 'cancelled', 'expired']),
  })
  .strict();

/** The task was refused before it ever reached the device. */
export const taskRejectedSchema = z
  .object({
    ...envelope,
    type: z.literal('task_rejected'),
    request_id: z.string().min(1).max(64),
    error_code: z.string().min(1).max(64),
    message: z.string().max(500),
  })
  .strict();

/** Outcome of an approve/deny decision taken on the phone. */
export const approvalResultSchema = z
  .object({
    ...envelope,
    type: z.literal('approval_result'),
    task_id: z.string().min(1).max(64),
    approved: z.boolean(),
    status: z.enum(['queued', 'planning', 'awaiting_approval', 'running', 'completed', 'failed', 'cancelled', 'expired']),
    error_code: z.string().min(1).max(64).optional(),
    message: z.string().max(300).optional(),
  })
  .strict();

export const outboundMessageSchema = z.discriminatedUnion('type', [
  approvalResultSchema,
  authOkSchema,
  authFailedSchema,
  heartbeatAckSchema,
  taskDispatchSchema,
  executeActionSchema,
  cancelTaskSchema,
  approvalRequiredSchema,
  taskCompletedSchema,
  deviceRevokedSchema,
  taskAcceptedSchema,
  taskRejectedSchema,
  serverProtocolErrorSchema,
]);

export function isSupportedProtocolVersion(version) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(Number(version));
}

export function parseInboundMessage(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, errorCode: 'INVALID_REQUEST', message: 'Message is not valid JSON.' };
  }
  if (!isSupportedProtocolVersion(json?.protocol_version)) {
    return {
      ok: false,
      errorCode: 'INVALID_PROTOCOL_VERSION',
      message: `Unsupported protocol_version. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}.`,
    };
  }
  const parsed = inboundMessageSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      errorCode: 'INVALID_REQUEST',
      message: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    };
  }
  return { ok: true, message: parsed.data };
}

/** Builds an outbound envelope, guaranteeing the protocol version is present. */
export function envelopeFor(type, payload = {}) {
  return {
    protocol_version: PROTOCOL_VERSION,
    type,
    sent_at: new Date().toISOString(),
    ...payload,
  };
}
