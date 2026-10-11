#!/usr/bin/env node
/**
 * Fail the build if a credential shaped string is about to be committed.
 *
 * Run it in CI and before pushing. It only inspects files tracked by git, so
 * node_modules and the data directory are ignored automatically.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');

const PATTERNS = [
  { id: 'openai-key', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { id: 'github-token', regex: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { id: 'telegram-bot-token', regex: /\b\d{8,12}:[A-Za-z0-9_-]{35}\b/ },
  { id: 'private-key-block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'android-keystore', regex: /\b(storePassword|keyPassword)\s*=?\s*["'][^"'{]{6,}["']/ },
];

const ALLOWED_FILES = new Set(['.env.example', 'docs/TROUBLESHOOTING.md', 'SECURITY.md']);
const SCANNED_EXTENSIONS = new Set(['.js', '.json', '.md', '.yml', '.yaml', '.xml', '.java', '.gradle', '.properties', '.env', '.txt']);

async function trackedFiles() {
  try {
    const { stdout } = await run('git', ['-C', ROOT, 'ls-files', '-z']);
    return stdout.split('\0').filter(Boolean);
  } catch {
    // Not a git checkout: fall back to a recursive scan.
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'data') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else found.push(path.relative(ROOT, full));
      }
    };
    walk(ROOT);
    return found;
  }
}

const files = await trackedFiles();
const findings = [];

for (const relative of files) {
  if (ALLOWED_FILES.has(relative)) continue;
  if (!SCANNED_EXTENSIONS.has(path.extname(relative))) continue;
  if (relative.startsWith('android/gradle/wrapper/')) continue;
  const absolute = path.join(ROOT, relative);
  if (!fs.existsSync(absolute)) continue;
  let source;
  try {
    source = fs.readFileSync(absolute, 'utf8');
  } catch {
    continue; // binary file
  }
  for (const pattern of PATTERNS) {
    const match = pattern.regex.exec(source);
    if (match) {
      findings.push({ file: relative, id: pattern.id, sample: `${match[0].slice(0, 6)}…` });
    }
  }
}

if (findings.length) {
  process.stdout.write(`check-secrets: ${findings.length} possible secret(s) found\n\n`);
  for (const finding of findings) {
    process.stdout.write(`  ${finding.file}: ${finding.id} (${finding.sample})\n`);
  }
  process.stdout.write('\nRemove them, rotate the credential, and keep secrets in .env / CI secrets.\n');
  process.exitCode = 1;
} else {
  process.stdout.write(`check-secrets: ok (${files.length} tracked files scanned)\n`);
}
