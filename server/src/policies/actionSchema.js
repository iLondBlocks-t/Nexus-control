import { z } from 'zod';

/**
 * The single source of truth for the action allowlist.
 *
 * The Android client enforces exactly the same list (see
 * `android/app/src/main/java/com/nexus/phoneagent/policy/LocalPolicy.java`).
 * Nothing outside this schema can ever be executed on a device.
 */

export const ACTION_TYPES = Object.freeze([
  'open_app',
  'open_settings',
  'tap_element',
  'scroll',
  'type_text',
  'wait_for_screen',
  'read_visible_ui',
  'back',
  'stop',
]);

export const OPEN_SETTINGS_TARGETS = Object.freeze([
  'home',
  'wifi',
  'bluetooth',
  'display',
  'sound',
  'battery',
  'applications',
  'storage',
  'location',
  'security',
  'accessibility',
  'accounts',
  'date_time',
  'language',
  'developer',
  'airplane_mode',
  'nfc',
]);

const reason = z.string().max(300).optional();

const packageName = z
  .string()
  .min(3)
  .max(255)
  .regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/, 'must be a valid Android package identifier');

const matchText = z.string().min(1).max(200);

const elementMatchShape = z
  .object({
    text: matchText.optional(),
    content_description: matchText.optional(),
    resource_id: z.string().min(1).max(255).optional(),
    class_name: z.string().min(1).max(255).optional(),
  })
  .strict();

/** A required element matcher: at least one field must be supplied. */
const elementMatch = elementMatchShape.refine(
  (value) => Object.keys(value).length > 0,
  'at least one match field is required',
);

/** An optional element matcher: absent, or present with at least one field. */
const optionalElementMatch = elementMatchShape
  .partial()
  .strict()
  .optional()
  .refine((value) => !value || Object.keys(value).length > 0, 'at least one match field is required');

const timeoutMs = z.number().int().min(500).max(30000).optional();

const openApp = z
  .object({ type: z.literal('open_app'), package_name: packageName, reason })
  .strict();

const openSettings = z
  .object({ type: z.literal('open_settings'), target: z.enum(OPEN_SETTINGS_TARGETS), reason })
  .strict();

const tapElement = z
  .object({
    type: z.literal('tap_element'),
    match: elementMatch,
    timeout_ms: timeoutMs,
    reason,
  })
  .strict();

const scroll = z
  .object({
    type: z.literal('scroll'),
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.enum(['small', 'medium', 'large']).optional(),
    target: optionalElementMatch,
    reason,
  })
  .strict();

const typeText = z
  .object({
    type: z.literal('type_text'),
    text: z.string().min(1).max(500),
    target: optionalElementMatch,
    clear_first: z.boolean().optional(),
    reason,
  })
  .strict();

const waitForScreen = z
  .object({
    type: z.literal('wait_for_screen'),
    expect: z
      .object({
        text: matchText.optional(),
        package_name: packageName.optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, 'at least one expectation is required'),
    timeout_ms: timeoutMs,
    reason,
  })
  .strict();

const readVisibleUi = z
  .object({
    type: z.literal('read_visible_ui'),
    max_nodes: z.number().int().min(1).max(50).optional(),
    reason,
  })
  .strict();

const back = z.object({ type: z.literal('back'), reason }).strict();

const stop = z.object({ type: z.literal('stop'), reason }).strict();

export const actionSchema = z.discriminatedUnion('type', [
  openApp,
  openSettings,
  tapElement,
  scroll,
  typeText,
  waitForScreen,
  readVisibleUi,
  back,
  stop,
]);

/** Schema for a whole AI produced plan. Rejects unknown fields and unknown actions. */
export const planSchema = z
  .object({
    task_summary: z.string().min(1).max(300),
    requires_approval: z.boolean(),
    needs_clarification: z.boolean().optional(),
    clarification_question: z.string().max(300).optional(),
    actions: z.array(actionSchema).min(1).max(30),
  })
  .strict();

export function validateAction(action) {
  return actionSchema.safeParse(action);
}

export function validatePlan(plan) {
  return planSchema.safeParse(plan);
}
