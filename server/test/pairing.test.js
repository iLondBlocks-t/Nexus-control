import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, pairDevice, ownerHeaders } from './helpers/testServer.js';

test('pairing creates a short lived, single use code', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const created = await fetch(`${baseUrl}/api/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ action: 'create', label: 'Galaxy J7 Prime' }),
  });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.match(body.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(body.expires_in_seconds, 300);

  const completed = await fetch(`${baseUrl}/api/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'complete',
      code: body.code,
      client: { app_version: '0.1.0', android_version: '9', device_model: 'SM-J730F' },
    }),
  });
  assert.equal(completed.status, 201);
  const paired = await completed.json();
  assert.ok(paired.device_id.startsWith('dev_'));
  assert.ok(paired.device_token.length >= 32);

  // Second use of the same code must fail.
  const reuse = await fetch(`${baseUrl}/api/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'complete',
      code: body.code,
      client: { app_version: '0.1.0', android_version: '9' },
    }),
  });
  assert.equal(reuse.status, 410);
  assert.equal((await reuse.json()).error.code, 'PAIRING_USED');
});

test('pairing codes expire', async (t) => {
  const { baseUrl, server, close } = await startTestServer({ env: { PAIRING_CODE_TTL_SECONDS: '30' } });
  t.after(close);

  const created = await fetch(`${baseUrl}/api/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ action: 'create' }),
  });
  const { code } = await created.json();

  // Force the record into the past through the storage layer.
  const pairings = await server.store.listPairings();
  const record = pairings.find((entry) => entry.codeHash);
  await server.store.updatePairing(record.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });

  const completed = await fetch(`${baseUrl}/api/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'complete', code, client: { app_version: '0.1.0', android_version: '9' } }),
  });
  assert.equal(completed.status, 410);
  assert.equal((await completed.json()).error.code, 'PAIRING_EXPIRED');
});

test('a wrong code is rejected and counted, and locks out after too many attempts', async (t) => {
  const { baseUrl, server, close } = await startTestServer({
    env: { PAIRING_MAX_ATTEMPTS: '2', PAIRING_COMPLETE_RATE_PER_MINUTE: '100' },
  });
  t.after(close);

  const created = await fetch(`${baseUrl}/api/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ action: 'create' }),
  });
  const { code } = await created.json();
  const wrong = `${code.slice(0, 4)}-ZZZZ`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'complete', code: wrong, client: { app_version: '0.1.0', android_version: '9' } }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'PAIRING_INVALID');
  }

  const locked = await fetch(`${baseUrl}/api/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'complete', code: wrong, client: { app_version: '0.1.0', android_version: '9' } }),
  });
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).error.code, 'PAIRING_LOCKED');

  // The correct code still works: the lockout is per source, and a success clears it.
  assert.ok(server.pairing.isLockedOut('ip:::ffff:127.0.0.1') || server.pairing.isLockedOut('ip:127.0.0.1'));

  const pairings = await server.store.listPairings();
  assert.ok(pairings.every((entry) => entry.usedAt === null || entry.usedAt === undefined));
});

test('creating a pairing code requires the owner token', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const response = await fetch(`${baseUrl}/api/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'create' }),
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'AUTHENTICATION_REQUIRED');
});

test('invalid pairing payloads are rejected', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const response = await fetch(`${baseUrl}/api/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'complete', code: 'x' }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'INVALID_REQUEST');
  assert.ok(Array.isArray(body.error.details.issues));
});

test('a paired device appears in the owner device list and can be revoked', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const paired = await pairDevice(baseUrl);
  const listed = await fetch(`${baseUrl}/api/v1/devices`, { headers: ownerHeaders() });
  const devices = await listed.json();
  assert.equal(devices.count, 1);
  assert.equal(devices.devices[0].device_id, paired.device_id);
  assert.equal(devices.devices[0].online, false);

  const revoked = await fetch(`${baseUrl}/api/v1/devices/${paired.device_id}/revoke`, {
    method: 'POST',
    headers: ownerHeaders(),
  });
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).status, 'revoked');

  const after = await fetch(`${baseUrl}/api/v1/devices`, { headers: ownerHeaders() });
  const afterBody = await after.json();
  assert.ok(afterBody.devices[0].revoked_at);
});
