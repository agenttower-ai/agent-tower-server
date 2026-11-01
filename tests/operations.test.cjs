const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMobileGateway } = require('../mobile-api.cjs');
const { createMobileRegistry } = require('../mobile-registry.cjs');

const password = 'operations-only-password-'.repeat(3);
async function start(t, options = {}) {
  const gateway = startMobileGateway({ port: 0, snapshot: () => ({ instances: [], sessions: [], permissions: [] }), send: () => false, ...options });
  t.after(() => gateway.close());
  await once(gateway.server, 'listening');
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  return async (route, body, token = '', headers = {}) => fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test('operations requires independent admin auth, expires sessions and revokes logout', async t => {
  let time = Date.now();
  let pairing;
  const registry = createMobileRegistry();
  const phoneToken = registry.issue({ id: 'phone_1234567890123456', installSecret: 'f'.repeat(64), source: 'app' });
  const request = await start(t, { adminUsername: 'admin', adminPassword: password, mobileRegistry: registry, now: () => time, onPairing: value => pairing = value.code });
  assert.equal((await request('/ops')).status, 200);
  assert.equal((await request('/ops/app.js')).status, 200);
  assert.equal((await request('/ops/styles.css')).status, 200);
  assert.equal((await request('/ops/stats')).status, 401);
  assert.equal((await request('/ops/stats', undefined, phoneToken)).status, 401);
  const legacyToken = (await (await request('/pair', { code: pairing })).json()).token;
  assert.equal((await request('/ops/stats', undefined, legacyToken)).status, 401);
  assert.equal((await request('/ops/login', { username: 'admin', password: 'incorrect' })).status, 401);
  assert.equal((await request('/ops/login', { username: 'admin', password }, '', { Origin: 'https://other.example' })).status, 403);
  const response = await request('/ops/login', { username: 'admin', password });
  assert.equal(response.status, 200);
  const { token } = await response.json();
  const stats = await request('/ops/stats', undefined, token);
  assert.equal(stats.status, 200);
  assert.equal(stats.headers.get('cache-control'), 'no-store');
  const body = await stats.json();
  assert.equal(body.users.total, 1);
  assert.equal(body.users.active24h, 1);
  assert.equal(JSON.stringify(body).includes(phoneToken), false);
  assert.equal((await request('/snapshot', undefined, token)).status, 401);
  assert.equal((await request('/ops/logout', {}, token)).status, 200);
  assert.equal((await request('/ops/stats', undefined, token)).status, 401);
  const next = await (await request('/ops/login', { username: 'admin', password })).json();
  time += 8 * 60 * 60_000;
  assert.equal((await request('/ops/stats', undefined, next.token)).status, 401);
});

test('authenticated operations detail endpoints return safe device and client lists only', async t => {
  let pairing;
  const registry = createMobileRegistry();
  const phoneToken = registry.issue({ id: 'phone_1234567890123456', name: '运营手机', platform: 'android', source: 'app', installSecret: 'f'.repeat(64) });
  registry.attachDevice('phone_1234567890123456', { id: 'office', name: '办公室电脑', platform: 'linux' }, { source: 'app' });
  const request = await start(t, { adminUsername: 'admin', adminPassword: password, mobileRegistry: registry, onPairing: value => pairing = value.code, operationsDetails: () => ({ devices: [{ id: 'office', name: '办公室电脑', platform: 'linux', source: 'binding', online: true, lastSeenAt: Date.now(), clientCount: 1, token: 'device-secret' }], clients: registry.listClients() }) });
  const login = await (await request('/ops/login', { username: 'admin', password })).json();
  assert.equal((await request('/ops/devices')).status, 401);
  const devices = await (await request('/ops/devices', undefined, login.token)).json();
  const clients = await (await request('/ops/clients', undefined, login.token)).json();
  assert.equal(devices.devices[0].name, '办公室电脑');
  assert.equal(devices.devices[0].token, undefined);
  assert.equal(clients.clients[0].id, 'phone_1234567890123456');
  assert.equal(clients.clients[0].bindings[0].deviceName, '办公室电脑');
  assert.equal(JSON.stringify(clients).includes(phoneToken), false);
  assert.equal(JSON.stringify(clients).includes('f'.repeat(64)), false);
  const legacy = await (await request('/pair', { code: pairing })).json();
  for (const route of ['/ops/devices', '/ops/clients']) {
    assert.equal((await request(route, undefined, phoneToken)).status, 401);
    assert.equal((await request(route, undefined, legacy.token)).status, 401);
  }
});

test('operations is disabled without configuration and login attempts are bounded', async t => {
  const disabled = await start(t);
  assert.equal((await disabled('/ops')).status, 503);
  assert.equal((await disabled('/ops/stats')).status, 503);
  let time = Date.now();
  const request = await start(t, { adminUsername: 'admin', adminPassword: password, now: () => time });
  for (let i = 0; i < 5; i++) assert.equal((await request('/ops/login', { username: 'admin', password: 'wrong' })).status, 401);
  assert.equal((await request('/ops/login', { username: 'admin', password })).status, 429);
  time += 15 * 60_000;
  assert.equal((await request('/ops/login', { username: 'admin', password })).status, 200);
});

test('persisted statistics distinguish active windows, sources and UTC registrations without secrets', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttower-operations-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'phones.json');
  const now = Date.parse('2026-09-30T12:00:00Z');
  const day = 86400000;
  fs.writeFileSync(file, JSON.stringify({ phones: [
    { id: 'recent', tokenHash: 'secret-hash', source: 'app', deviceIds: ['pc'], createdAt: now - 1000, lastSeenAt: now },
    { id: 'week', tokenHash: 'secret-hash', source: 'wechat-mini-program', deviceIds: [], createdAt: now - 10 * day, lastSeenAt: now - 3 * day },
    { id: 'month', tokenHash: 'secret-hash', source: 'app', deviceIds: [], createdAt: now - 31 * day, lastSeenAt: now - 20 * day },
    { id: 'inactive', tokenHash: 'secret-hash', source: 'app', deviceIds: [], createdAt: now - 40 * day, lastSeenAt: now - 40 * day },
  ] }));
  const stats = createMobileRegistry({ file }).statistics(now);
  assert.deepEqual([stats.total, stats.active24h, stats.active7d, stats.active30d, stats.new24h, stats.bound], [4, 1, 2, 3, 1, 1]);
  assert.equal(stats.sources.find(source => source.source === 'app').total, 3);
  assert.equal(stats.registrations.length, 14);
  assert.deepEqual(stats.registrations.at(-1), { date: '2026-09-30', count: 1 });
  assert.equal(stats.registrations.reduce((sum, entry) => sum + entry.count, 0), 2);
  assert.equal(JSON.stringify(stats).includes('secret-hash'), false);
});
