import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/testServer.js';

test('the control panel is served without authentication and carries no credential', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const response = await fetch(`${baseUrl}/console/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);

  const html = await response.text();
  assert.match(html, /NEXUS control panel/);
  assert.doesNotMatch(html, /sk-[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(html, /Bearer [A-Za-z0-9]/);
});

test('the panel loads its stylesheet and script from this origin only', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  for (const asset of ['console.css', 'console.js']) {
    const response = await fetch(`${baseUrl}/console/${asset}`);
    assert.equal(response.status, 200, `${asset} should be served`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.text();
    assert.doesNotMatch(body, /https?:\/\/(?!localhost)[a-z0-9.-]+\.[a-z]{2,}/i);
  }

  const missing = await fetch(`${baseUrl}/console/does-not-exist.js`);
  assert.equal(missing.status, 404);
});

test('serving the panel does not open the API: unauthenticated calls are still refused', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const tasks = await fetch(`${baseUrl}/api/v1/tasks`);
  assert.equal(tasks.status, 401);

  const devices = await fetch(`${baseUrl}/api/v1/devices`);
  assert.equal(devices.status, 401);

  const pair = await fetch(`${baseUrl}/api/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'create' }),
  });
  assert.equal(pair.status, 401);
});
