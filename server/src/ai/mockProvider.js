import { AppError } from '../utils/errors.js';
import { parseJsonObject } from './openaiProvider.js';

/**
 * Deterministic offline planner.
 *
 * Exists so the full task pipeline can be exercised without a paid API key
 * (tests, first-run smoke checks). It is NEVER used in production:
 * `buildProvider()` refuses to construct it when NODE_ENV=production, and the
 * configuration validator rejects AI_PROVIDER=mock in production.
 *
 * It only emits actions from the real allowlist, so it cannot do anything a real
 * model could not propose.
 */
export class MockProvider {
  constructor({ model = 'mock-planner-v1' } = {}) {
    this.model = model;
    this.name = 'mock';
  }

  get configured() {
    return true;
  }

  validateProviderConfig() {
    return { ok: true, issues: [] };
  }

  async getProviderHealth() {
    return { provider: 'mock', configured: true, model: this.model, reachable: true, model_available: true, issues: [] };
  }

  async planTask({ userPayload }) {
    const instruction = String(userPayload?.instruction ?? '').toLowerCase();
    const actions = [];

    const youtube = instruction.includes('youtube');
    const settings = instruction.includes('setting');
    const wifi = instruction.includes('wi-fi') || instruction.includes('wifi');
    const scroll = instruction.includes('scroll');
    const back = instruction.includes('back') || instruction.includes('previous screen');
    const read = instruction.includes('read') || instruction.includes('summar');

    if (youtube) {
      actions.push({ type: 'open_app', package_name: 'com.google.android.youtube', reason: 'Open the requested app' });
    } else if (wifi) {
      actions.push({ type: 'open_settings', target: 'wifi', reason: 'Open the Wi-Fi settings page' });
    } else if (settings) {
      actions.push({ type: 'open_settings', target: 'home', reason: 'Open Android settings' });
    } else if (scroll) {
      actions.push({ type: 'scroll', direction: 'down', amount: 'medium', reason: 'Scroll the visible list' });
    } else if (back) {
      actions.push({ type: 'back', reason: 'Return to the previous screen' });
    } else if (read) {
      actions.push({ type: 'read_visible_ui', max_nodes: 20, reason: 'Summarise the visible screen' });
    } else if (instruction.includes('send') || instruction.includes('message')) {
      // Deliberately lands in the sensitive bucket so approval is exercised.
      actions.push({ type: 'tap_element', match: { text: 'Send' }, reason: 'Tap the send control' });
    } else {
      throw new AppError('INVALID_AI_PLAN', {
        details: {
          issues: [
            'The offline mock planner only understands a few demo instructions (open YouTube, Wi-Fi settings, scroll, back, read screen). Configure a real AI provider for anything else.',
          ],
        },
      });
    }

    const raw = {
      task_summary: `Mock plan for: ${userPayload?.instruction ?? ''}`.slice(0, 300),
      requires_approval: false,
      actions,
    };
    return { raw, rawText: JSON.stringify(raw), usage: null };
  }

  normalizeProviderError(error) {
    return error instanceof AppError ? error : new AppError('AI_PROVIDER_ERROR');
  }
}

export { parseJsonObject };
