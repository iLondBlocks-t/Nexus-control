#!/usr/bin/env node
/**
 * Static checks for the server and scripts.
 *
 * Deliberately dependency free: syntax checking plus a small set of rules that
 * matter for this project (no debug prints in the server, no obvious secrets,
 * no unfinished markers left in the source).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const TARGETS = ['server/src', 'server/test', 'scripts'];

const MARKERS = ['FIX' + 'ME', 'X'.repeat(3)];

const RULES = [
  {
    id: 'no-console-in-server',
    test: (file, source) => file.includes(`${path.sep}src${path.sep}`) && /console\.(log|debug|info)\(/.test(source),
    message: 'use the structured logger (server/src/logging/logger.js) instead of console',
  },
  {
    id: 'no-hardcoded-secret',
    test: (file, source) =>
      /\b(sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9]{20,})\b/.test(source),
    message: 'a real looking credential is embedded in the source',
  },
  {
    id: 'no-unfinished-marker',
    // Built from fragments so this rule does not flag its own source.
    test: (_file, source) => new RegExp(`(^|[^A-Za-z])(${MARKERS.join('|')})([^A-Za-z]|$)`).test(source),
    message: 'unfinished marker left in the source',
  },
];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

const problems = [];
let checked = 0;

for (const target of TARGETS) {
  const directory = path.join(ROOT, target);
  if (!fs.existsSync(directory)) continue;
  for (const file of walk(directory)) {
    checked += 1;
    const relative = path.relative(ROOT, file);
    try {
      await run(process.execPath, ['--check', file]);
    } catch (error) {
      problems.push({ file: relative, rule: 'syntax', message: String(error.stderr ?? error.message).trim() });
      continue;
    }
    const source = fs.readFileSync(file, 'utf8');
    for (const rule of RULES) {
      if (rule.test(file, source)) problems.push({ file: relative, rule: rule.id, message: rule.message });
    }
  }
}

if (problems.length) {
  process.stdout.write(`lint: ${problems.length} problem(s) in ${checked} file(s)\n\n`);
  for (const problem of problems) {
    process.stdout.write(`  ${problem.file}: [${problem.rule}] ${problem.message}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`lint: ok (${checked} files checked)\n`);
}
