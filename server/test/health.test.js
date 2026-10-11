import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, ownerHeaders } from './helpers/testServer.js';

test('healthz answers without authentication and without touching dependencies', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'nexus-phone-agent');
  assert.equal(body.protocol_version, 1);
  assert.ok(body.uptime_seconds >= 0);
});

test('readyz reports ok when the provider is configured', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const response = await fetch(`${baseUrl}/readyz`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.checks.ai.configured, true);
  assert.equal(body.checks.store.ok, true);
});

test('readyz reports degraded when the AI provider is missing', async (t) => {
  const { baseUrl, close } = await startTestServer({ env: { AI_PROVIDER: 'none' } });
  t.after(close);

  const response = await fetch(`${baseUrl}/readyz`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.status, 'degraded');
  assert.ok(body.reasons.includes('ai_provider_not_configured'));
  assert.equal(body.checks.ai.configured, false);
});

test('health endpoints never leak configuration secrets', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const health = await (await fetch(`${baseUrl}/healthz`)).text();
  const ready = await (await fetch(`${baseUrl}/readyz`)).text();
  for (const secret of ['test-owner-token']) {
    assert.ok(!health.includes(secret));
    assert.ok(!ready.includes(secret));
  }
});

test('unknown routes return the documented error shape', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const response = await fetch(`${baseUrl}/api/v1/does-not-exist`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.ok(body.error.message.length > 0);
  assert.ok(body.error.request_id);
});

test('error responses never contain stack traces', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const response = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: 'x' }),
  });
  assert.equal(response.status, 400);
  const text = await response.text();
  assert.ok(!text.includes('at '), 'no stack frames in the response');
  assert.ok(!text.includes('node_modules'));
  const body = JSON.parse(text);
  assert.equal(body.error.code, 'INVALID_REQUEST');
  assert.ok(Array.isArray(body.error.details.issues));
});

test('the root path redirects to the health endpoint', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const response = await fetch(`${baseUrl}/`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/healthz');
});

test('security headers are set on API responses', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
});

test('the status endpoint reports limits, storage and device state', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const response = await fetch(`${baseUrl}/api/v1/status`, { headers: ownerHeaders() });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.storage.driver, 'memory');
  assert.equal(body.limits.maxActionsPerTask, 12);
  assert.equal(body.websocket.path, '/api/v1/device');
  assert.ok(Array.isArray(body.devices));
});
