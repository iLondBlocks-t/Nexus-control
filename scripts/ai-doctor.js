#!/usr/bin/env node
/**
 * AI provider diagnostics.
 *
 * Usage:
 *   npm run ai:doctor          configuration only, never calls the provider
 *   npm run ai:doctor -- --live  additionally calls the provider's models endpoint
 *
 * The API key is never printed, and a live check only reports whether the
 * configured model is visible to the account.
 */
import { buildConfig } from '../server/src/config/index.js';
import { buildProvider } from '../server/src/ai/provider.js';

const live = process.argv.includes('--live');
const { config } = buildConfig(process.env);
const provider = buildProvider(config);

process.stdout.write('NEXUS AI provider diagnostics\n');
process.stdout.write('=============================\n');

const validation = provider.validateProviderConfig();
process.stdout.write(`provider            : ${provider.name}\n`);
process.stdout.write(`model               : ${config.ai.model}${config.ai.modelConfigured ? '' : ' (default, OPENAI_MODEL not set)'}\n`);
process.stdout.write(`base url            : ${config.ai.baseUrl}\n`);
process.stdout.write(`api key present     : ${config.ai.apiKey ? 'yes (hidden)' : 'no'}\n`);
process.stdout.write(`configured          : ${validation.ok ? 'yes' : 'no'}\n`);

if (!validation.ok) {
  process.stdout.write('\nIssues:\n');
  for (const issue of validation.issues) process.stdout.write(`  - ${issue}\n`);
  process.stdout.write('\nSet OPENAI_API_KEY and OPENAI_MODEL in the hosting environment, then re-run.\n');
  process.exitCode = 1;
}

if (live) {
  const health = await provider.getProviderHealth({ live: true });
  process.stdout.write(`\nlive check\n`);
  process.stdout.write(`  reachable         : ${health.reachable}\n`);
  process.stdout.write(`  model available   : ${health.model_available}\n`);
  for (const issue of health.issues ?? []) process.stdout.write(`  - ${issue}\n`);
  process.exitCode = health.reachable && health.model_available ? 0 : 1;
} else {
  process.stdout.write('\nRun with `-- --live` to call the provider (uses one request, no task is planned).\n');
}
