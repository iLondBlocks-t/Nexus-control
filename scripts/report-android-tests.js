#!/usr/bin/env node
/**
 * Turns a Gradle unit-test run into readable CI output.
 *
 * GitHub hides raw job logs behind a signed blob URL, which not every
 * environment can download. This script re-publishes the interesting lines as
 * job annotations ("::error::"), so a failure can be read straight from the
 * Checks API, and exits non-zero only when the build actually failed.
 *
 * Usage: node scripts/report-android-tests.js <gradle-log> [test-results-dir]
 */
import fs from 'node:fs';
import path from 'node:path';

const logPath = process.argv[2] ?? '';
const resultsDir = process.argv[3] ?? path.join('android', 'app', 'build', 'test-results', 'testDebugUnitTest');

function sanitise(value) {
  return String(value)
    .replace(/%/g, '%25')
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ')
    .trim();
}

const log = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';

if (!log) {
  console.log('No Gradle log was provided; nothing to report.');
  process.exit(0);
}

const succeeded = /BUILD SUCCESSFUL/.test(log);

if (succeeded) {
  const counts = [...log.matchAll(/(\d+)\s+tests?,\s+(\d+)\s+passed,\s+(\d+)\s+failed/g)];
  console.log(`client unit tests: BUILD SUCCESSFUL${counts.length ? ` (${counts[0][0]})` : ''}`);
  process.exit(0);
}

const patterns = [
  /error:/,
  /^\s+symbol:/,
  /^\s+location:/,
  /^\s+required:/,
  /^\s+found:/,
  /^\s+reason:/,
  /^e: /,
  /FAILED/,
  /Compilation failed/,
  /Could not resolve/,
  /Could not find/,
  /Caused by:/,
  /Execution failed/,
  /What went wrong/,
];

let emitted = 0;
for (const line of log.split(/\r?\n/)) {
  if (emitted >= 40) break;
  if (patterns.some((pattern) => pattern.test(line))) {
    const text = sanitise(line);
    if (text) {
      console.log(`::error::${text.slice(0, 400)}`);
      emitted += 1;
    }
  }
}

/* Failing assertions from the JUnit XML reports. */
if (fs.existsSync(resultsDir)) {
  for (const file of fs.readdirSync(resultsDir).sort()) {
    if (!file.endsWith('.xml')) continue;
    const source = fs.readFileSync(path.join(resultsDir, file), 'utf8');
    const failures = [...source.matchAll(/<testcase name="([^"]+)"[^>]*>\s*<failure message="([^"]{0,400})/g)];
    for (const [, name, message] of failures) {
      const decoded = sanitise(
        message
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&'),
      );
      console.log(`::error file=${file}::${name}: ${decoded}`.slice(0, 500));
    }
    const summary = source.match(/<testsuite[^>]*tests="(\d+)"[^>]*skipped="(\d+)"[^>]*failures="(\d+)"[^>]*errors="(\d+)"/);
    if (summary) {
      console.log(`${file}: ${summary[1]} tests, ${summary[3]} failures, ${summary[4]} errors`);
    }
  }
}

console.log('client unit tests: FAILED');
process.exit(1);
