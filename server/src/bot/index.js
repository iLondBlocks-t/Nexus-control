import { TelegramBot } from './telegram.js';
import { getLogger } from '../logging/logger.js';

/**
 * Bot factory.
 *
 * Only one adapter is enabled at a time on purpose: a single, fully implemented
 * integration beats several half finished ones. Telegram is the default because
 * its Bot API is a plain HTTPS API with no session to maintain; see
 * docs/BOT_SETUP.md for the rationale and for the WhatsApp/Baileys caveats.
 */
export function createBot({ config, tasks, registry, executor, store, pairing, logger = getLogger({ component: 'bot' }) }) {
  if (!config.telegram.enabled) {
    return {
      name: 'disabled',
      enabled: false,
      async start() {},
      async stop() {},
      status: () => ({ enabled: false, provider: 'none' }),
    };
  }

  return new TelegramBot({ config: config.telegram, tasks, registry, executor, logger, store, pairing });
}

export { TelegramBot };
