#!/usr/bin/env node
/**
 * Validate the deployment configuration without starting the server.
 *
 * Usage: npm run check:config
 * Prints every configuration warning and refuses to continue on an error.
 */
import { buildConfig } from '../server/src/config/index.js';

const { ok, config, issues } = buildConfig(process.env);

process.stdout.write('NEXUS configuration report\n');
process.stdout.write('==========================\n');

if (!issues.length) {
  process.stdout.write('No issues found.\n');
} else {
  for (const issue of issues) {
    process.stdout.write(`  [${issue.level.toUpperCase()}] ${issue.message}\n`);
  }
}

if (config) {
  process.stdout.write('\nEffective settings (secrets hidden)\n');
  process.stdout.write(`  environment        : ${config.env}\n`);
  process.stdout.write(`  port               : ${config.port}\n`);
  process.stdout.write(`  websocket path     : ${config.wsPath}\n`);
  process.stdout.write(`  owner token        : ${config.ownerTokenConfigured ? 'configured' : 'EPHEMERAL (development only)'}\n`);
  process.stdout.write(`  storage driver     : ${config.storage.driver}${config.storage.databaseUrl || config.storage.path ? ` (${config.storage.databaseUrl || config.storage.path})` : ''}\n`);
  process.stdout.write(`  ai provider        : ${config.ai.provider} / ${config.ai.model} (${config.ai.configured ? 'configured' : 'NOT CONFIGURED'})\n`);
  process.stdout.write(`  action budget      : ${config.tasks.maxActionsPerTask} actions, ${config.tasks.maxDurationSeconds}s\n`);
  process.stdout.write(`  sensitive policy   : ${config.policy.sensitiveMode}\n`);
  process.stdout.write(`  telegram bot       : ${config.telegram.enabled ? 'enabled' : 'disabled'}\n`);
}

process.exitCode = ok ? 0 : 1;
if (!ok) process.stdout.write('\nConfiguration is invalid: the server will refuse to start.\n');
