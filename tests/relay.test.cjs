const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
let WebSocket;
try { WebSocket = require('ws'); } catch { WebSocket = require('../node_modules/ws'); }
const { startRelayServer } = require('../relay-server.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function setup(t) {
  let code;
  const relay = startRelayServer({ deviceTokens: { alpha: 'a'.repeat(64), beta: 'b'.repeat(64) }, appKey: 'private-app-key', port: 0, onPairing: p => { code = p.code; }, allowedOrigin: 'http://localhost:5173' });
  t.after(() => relay.close()); await once(relay.server, 'listening');
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  const call = async (path, data, token, headers = {}) => { const r = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: r.status, body: await r.json() }; };
  async function device(id, token = id === 'alpha' ? 'a'.repeat(64) : 'b'.repeat(64)) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/device'); t.after(() => ws.terminate()); await once(ws, 'open'); const ready = once(ws, 'message'); ws.send(JSON.stringify({ type: 'device.auth', deviceId: id, token })); await ready;
    ws.send(JSON.stringify({ type: 'device.snapshot', state: { instances: [{ id: 'same', hostname: id, online: true, lastSeenAt: Date.now() }], sessions: [{ id: 'session', instanceId: 'same', title: id, status: 'busy' }], permissions: [{ id: 'permission', instanceId: 'same', sessionID: 'session', permission: 'shell' }] } }));
    await delay(25); return ws;
  }
  return { relay, base, call, device, pair: async () => (await call('/pair', { code })).body.token, getCode: () => code };
}
test('session controls are scoped and wait for matching Agent acknowledgement', async t => {
  const s = await setup(t), token = await s.pair();
  const alpha = await s.device('alpha');
  const beta = await s.device('beta');
  alpha.send(JSON.stringify({ type: 'device.snapshot', state: {
    instances: [{ id: 'same', online: true, lastSeenAt: Date.now(), contextId: 'project-a', capabilities: { sessionControl: true } }],
    sessions: [{ id: 'session', instanceId: 'same', contextId: 'project-a' }], permissions: [],
  } }));
  await delay(30);
  let betaCalls = 0;
  beta.on('message', () => betaCalls++);
  for (const action of ['create', 'abort', 'prompt']) {
    const message = once(alpha, 'message');
    let finished = false;
    const response = s.call('/session-control', { instanceId: 'alpha/same', sessionID: 'session', action, text: '继续', directory: 'C:/another-project', contextId: 'forged' }, token).then(r => { finished = true; return r; });
    const command = JSON.parse((await message)[0]);
    assert.equal(command.contextId, 'project-a');
      assert.equal(command.instanceId, 'same');
      assert.equal(command.directory, action === 'create' ? 'C:/another-project' : undefined);
    await delay(20); assert.equal(finished, false);
    alpha.send(JSON.stringify({ type: 'device.event', event: { type: 'monitor.action.result', instanceId: 'same', actionID: command.actionID, ok: true } }));
    assert.equal((await response).status, 200);
  }
  assert.equal(betaCalls, 0);
  assert.equal((await s.call('/session-control', { instanceId: 'alpha/same', action: 'prompt', text: '' }, token)).status, 400);
  assert.equal((await s.call('/session-control', { instanceId: 'alpha/same', action: 'abort', sessionID: 'missing' }, token)).status, 409);
  const phone = (await s.call('/mobile/register', { deviceId: 'control_phone_123456789', installSecret: 'f'.repeat(64) })).body.token;
  assert.equal((await s.call('/session-control', { instanceId: 'alpha/same', action: 'create' }, phone)).status, 403);
});

test('session messages are fetched from the owning device on demand', async t => {
  const s = await setup(t), token = await s.pair();
  const alpha = await s.device('alpha');
  const beta = await s.device('beta');
  alpha.send(JSON.stringify({ type: 'device.snapshot', state: {
    instances: [{ id: 'same', online: true, lastSeenAt: Date.now(), contextId: 'project-a', capabilities: { sessionControl: true } }],
    sessions: [{ id: 'session', instanceId: 'same', contextId: 'project-a' }], permissions: [],
  } }));
  await delay(30);
  let betaCalls = 0;
  beta.on('message', () => betaCalls++);
  const commandEvent = once(alpha, 'message');
  const response = s.call('/session-messages', { instanceId: 'alpha/same', sessionID: 'session' }, token);
  const command = JSON.parse((await commandEvent)[0]);
  assert.equal(command.action, 'history');
  assert.equal(command.contextId, 'project-a');
  assert.equal(command.instanceId, 'same');
  assert.equal(command.sessionID, 'session');
  alpha.send(JSON.stringify({ type: 'device.event', event: { type: 'monitor.action.result', instanceId: 'same', actionID: command.actionID, ok: true,
    messages: [{ messageID: 'old-user', role: 'user', text: '之前的提问', at: 123 }] } }));
  assert.deepEqual((await response).body.messages.map(m => m.text), ['之前的提问']);
  assert.equal(betaCalls, 0);
  assert.equal((await s.call('/session-messages', { instanceId: 'beta/same', sessionID: 'missing' }, token)).status, 409);
  assert.equal((await s.call('/session-messages', { instanceId: 'alpha/same', sessionID: 'missing' }, token)).status, 409);
});
test('Cursor history works while its hook instance is idle and the device remains online', async t => {
  const s = await setup(t), token = await s.pair();
  const device = await s.device('alpha');
  device.send(JSON.stringify({ type: 'device.snapshot', state: {
    instances: [{ id: 'cursor:conversation', agent: 'cursor', online: true, lastSeenAt: Date.now() - 120_000, contextId: 'conversation', capabilities: { history: true, sessionControl: false } }],
    sessions: [{ id: 'conversation', instanceId: 'cursor:conversation', contextId: 'conversation' }], permissions: [],
  } }));
  await delay(30);
  const commandEvent = once(device, 'message');
  const response = s.call('/session-messages', { instanceId: 'alpha/cursor:conversation', sessionID: 'conversation' }, token);
  const command = JSON.parse((await commandEvent)[0]);
  assert.equal(command.action, 'history');
  device.send(JSON.stringify({ type: 'device.event', event: { type: 'monitor.action.result', instanceId: 'cursor:conversation', actionID: command.actionID, ok: true, messages: [{ role: 'user', text: '历史消息' }] } }));
  assert.deepEqual((await response).body.messages.map(m => m.text), ['历史消息']);
  assert.equal((await s.call('/session-control', { instanceId: 'alpha/cursor:conversation', sessionID: 'conversation', action: 'prompt', text: '继续' }, token)).status, 409);
});
test('available models are fetched from the connected Agent and scoped to its device', async t => {
  const s = await setup(t), token = await s.pair();
  const alpha = await s.device('alpha');
  const beta = await s.device('beta');
  alpha.send(JSON.stringify({ type: 'device.snapshot', state: {
    instances: [{ id: 'same', online: true, lastSeenAt: Date.now(), contextId: 'project-a', capabilities: { sessionControl: true } }],
    sessions: [], permissions: [],
  } }));
  await delay(30);
  let betaCalls = 0;
  beta.on('message', () => betaCalls++);
  const commandEvent = once(alpha, 'message');
  const response = s.call('/session-models', { instanceId: 'alpha/same' }, token);
  const command = JSON.parse((await commandEvent)[0]);
  assert.equal(command.action, 'models');
  assert.equal(command.contextId, 'project-a');
  assert.equal(command.instanceId, 'same');
  alpha.send(JSON.stringify({ type: 'device.event', event: { type: 'monitor.action.result', instanceId: 'same', actionID: command.actionID, ok: true,
    models: [{ id: 'openai/gpt-test', name: 'GPT Test', provider: 'OpenAI' }] } }));
  assert.deepEqual((await response).body.models.map(model => model.id), ['openai/gpt-test']);
  assert.equal(betaCalls, 0);
  assert.equal((await s.call('/session-models', { instanceId: 'beta/missing' }, token)).status, 409);
});
test('authentication, single-use pairing, origin isolation and token revocation', async t => {
  const s = await setup(t);
  assert.equal((await s.call('/snapshot')).status, 401);
  assert.equal((await s.call('/pair', { code: 'wrong' })).status, 403);
  const old = s.getCode(), token = await s.pair();
  assert.equal(typeof token, 'string');
  assert.equal((await s.call('/pair', { code: old })).status, 403);
  assert.equal((await s.call('/snapshot', undefined, token, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await s.call('/snapshot', undefined, token)).status, 200);
  assert.equal((await s.call('/unpair', {}, token)).status, 200);
  assert.equal((await s.call('/snapshot', undefined, token)).status, 401);
});
test('private app registers silently and receives a revocable persistent phone credential', async t => {
  const s = await setup(t);
  assert.equal((await s.call('/mobile/register', { appKey: 'wrong', deviceId: 'phone_1234567890123456' })).status, 403);
  const registered = await s.call('/mobile/register', { appKey: 'private-app-key', deviceId: 'phone_1234567890123456', name: 'My phone', platform: 'android' });
  assert.equal(registered.status, 201);
  const token = registered.body.token;
  assert.equal((await s.call('/snapshot', undefined, token)).status, 200);
  assert.equal((await s.call('/unpair', {}, token)).status, 200);
  assert.equal((await s.call('/snapshot', undefined, token)).status, 401);
});
test('public app registration uses a per-install secret and never needs the shared server key', async t => {
  const s = await setup(t);
  const body = { deviceId: 'public_phone_123456789012', installSecret: 'c'.repeat(64), name: 'Public phone', platform: 'android' };
  const registered = await s.call('/mobile/register', body);
  assert.equal(registered.status, 201);
  assert.equal((await s.call('/snapshot', undefined, registered.body.token)).status, 200);
  assert.equal((await s.call('/mobile/register', { ...body, installSecret: 'd'.repeat(64) })).status, 403);
  const rotated = await s.call('/mobile/register', body);
  assert.equal(rotated.status, 201);
  assert.equal((await s.call('/snapshot', undefined, registered.body.token)).status, 401);
  assert.equal((await s.call('/snapshot', undefined, rotated.body.token)).status, 200);
});
test('same IDs across devices are isolated; only actual Agent acknowledgement completes approval', async t => {
  const s = await setup(t), token = await s.pair();
  const alpha = await s.device('alpha'), beta = await s.device('beta');
  const view = (await s.call('/snapshot', undefined, token)).body;
  assert.deepEqual(view.instances.map(i => i.id), ['alpha/same', 'beta/same']);
  const receivedA = [], receivedB = [];
  alpha.on('message', raw => receivedA.push(JSON.parse(raw))); beta.on('message', raw => receivedB.push(JSON.parse(raw)));
  let finished = false;
  const result = s.call('/permission', { instanceId: 'alpha/same', requestID: 'permission', reply: 'once' }, token).then(r => { finished = true; return r; });
  await delay(70); assert.equal(finished, false); assert.equal(receivedA.length, 1); assert.equal(receivedB.length, 0);
  assert.equal(receivedA[0].instanceId, 'same');
  assert.equal((await s.call('/permission', { instanceId: 'alpha/same', requestID: 'permission', reply: 'reject' }, token)).status, 409);
  alpha.send(JSON.stringify({ type: 'device.event', event: { type: 'monitor.permission.resolved', instanceId: 'same', requestID: 'permission' } }));
  assert.equal((await result).body.resolved, true);
  assert.equal((await s.call('/snapshot', undefined, token)).body.permissions.length, 1);
  assert.equal((await s.call('/permission', { instanceId: 'alpha/same', requestID: 'permission', reply: 'once' }, token)).status, 409);
});
test('offline devices and unsupported control cannot be approved; device errors propagate', async t => {
  const s = await setup(t), token = await s.pair(), alpha = await s.device('alpha');
  assert.equal((await s.call('/permission', { instanceId: 'alpha/same', requestID: 'permission', reply: 'always' }, token)).status, 400);
  assert.equal((await s.call('/stop', {}, token)).status, 404);
  alpha.on('message', raw => { const m = JSON.parse(raw); alpha.send(JSON.stringify({ type: 'device.event', event: { type: 'monitor.control.error', instanceId: 'same', requestID: m.requestID, error: 'Agent unavailable' } })); });
  const failed = await s.call('/permission', { instanceId: 'alpha/same', requestID: 'permission', reply: 'reject' }, token);
  assert.equal(failed.status, 502); assert.equal(failed.body.error, 'Agent unavailable');
  alpha.close(); await once(alpha, 'close'); await delay(25);
  assert.equal((await s.call('/permission', { instanceId: 'alpha/same', requestID: 'permission', reply: 'once' }, token)).status, 409);
});
test('invalid device credentials cannot publish data', async t => {
  const s = await setup(t);
  const ws = new WebSocket(s.base.replace('http:', 'ws:') + '/device'); t.after(() => ws.terminate());
  await once(ws, 'open'); const closed = once(ws, 'close'); ws.send(JSON.stringify({ type: 'device.auth', deviceId: 'alpha', token: 'wrong' }));
  assert.equal((await closed)[0], 1008); assert.equal(s.relay.snapshot().instances.length, 0);
});
test('oversized device snapshots report a diagnostic close reason', async t => {
  const s = await setup(t);
  const ws = new WebSocket(s.base.replace('http:', 'ws:') + '/device'); t.after(() => ws.terminate());
  await once(ws, 'open'); const ready = once(ws, 'message'); ws.send(JSON.stringify({ type: 'device.auth', deviceId: 'alpha', token: 'a'.repeat(64) })); await ready;
  const closed = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'device.snapshot', state: { instances: Array.from({ length: 1001 }, (_, id) => ({ id: String(id) })), sessions: [], permissions: [] } }));
  const [code, reason] = await closed;
  assert.equal(code, 1008); assert.equal(reason.toString(), 'invalid snapshot');
});
test('phone confirms one-time device binding and can rename or revoke the issued credential', async t => {
  const s = await setup(t), phone = await s.pair();
  const requested = await s.call('/device-bind/request', { deviceId: 'new-device', name: 'New laptop', platform: 'test' });
  assert.equal(requested.status, 201); assert.match(requested.body.code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal((await s.call('/device-bind/confirm', { code: requested.body.code }, phone)).status, 200);
  assert.equal((await s.call('/device-bind/confirm', { code: requested.body.code }, phone)).status, 404);
  const issued = await s.call('/device-bind/status', { bindId: requested.body.bindId, pollSecret: requested.body.pollSecret });
  assert.equal(issued.body.status, 'approved'); assert.equal(issued.body.token.length, 64);
  const ws = new WebSocket(s.base.replace('http:', 'ws:') + '/device'); t.after(() => ws.terminate());
  await once(ws, 'open'); const ready = once(ws, 'message'); ws.send(JSON.stringify({ type: 'device.auth', deviceId: 'new-device', token: issued.body.token })); await ready;
  const listed = await s.call('/devices', undefined, phone);
  assert.equal(listed.body.devices.find(d => d.id === 'new-device').online, true);
  assert.equal((await s.call('/devices/rename', { deviceId: 'new-device', name: 'Renamed laptop' }, phone)).status, 200);
  assert.equal((await s.call('/devices', undefined, phone)).body.devices.find(d => d.id === 'new-device').name, 'Renamed laptop');
  const closed = once(ws, 'close'); assert.equal((await s.call('/devices/unbind', { deviceId: 'new-device' }, phone)).status, 200); await closed;
  const rejected = new WebSocket(s.base.replace('http:', 'ws:') + '/device'); t.after(() => rejected.terminate());
  await once(rejected, 'open'); const denied = once(rejected, 'close'); rejected.send(JSON.stringify({ type: 'device.auth', deviceId: 'new-device', token: issued.body.token })); assert.equal((await denied)[0], 1008);
});

test('registered phones can only see and control monitors they explicitly bound', async t => {
  const s = await setup(t);
  const register = async id => (await s.call('/mobile/register', { appKey: 'private-app-key', deviceId: id, name: id, platform: 'test' })).body.token;
  const phoneA = await register('phone_A_1234567890123456');
  const phoneB = await register('phone_B_1234567890123456');
  const bind = async (phone, deviceId) => {
    const requested = await s.call('/device-bind/request', { deviceId, name: deviceId, platform: 'test' });
    assert.equal((await s.call('/device-bind/confirm', { code: requested.body.code }, phone)).status, 200);
    const issued = await s.call('/device-bind/status', { bindId: requested.body.bindId, pollSecret: requested.body.pollSecret });
    return issued.body.token;
  };
  const tokenA = await bind(phoneA, 'owned-a');
  const tokenB = await bind(phoneB, 'owned-b');
  await s.device('owned-a', tokenA); await s.device('owned-b', tokenB);
  assert.deepEqual((await s.call('/snapshot', undefined, phoneA)).body.devices.map(d => d.id), ['owned-a']);
  assert.deepEqual((await s.call('/snapshot', undefined, phoneB)).body.devices.map(d => d.id), ['owned-b']);
  assert.equal((await s.call('/devices/rename', { deviceId: 'owned-b', name: 'stolen' }, phoneA)).status, 403);
  assert.equal((await s.call('/permission', { instanceId: 'owned-b/same', requestID: 'permission', reply: 'once' }, phoneA)).status, 403);
});

test('an existing monitor token can create a new controller relationship without rotating its credential', async t => {
  const s = await setup(t);
  const phone = (await s.call('/mobile/register', { appKey: 'private-app-key', deviceId: 'phone_existing_1234567890', name: 'Second phone', platform: 'test' })).body.token;
  const requested = await s.call('/device-bind/request', { deviceId: 'alpha', name: 'Alpha', platform: 'test', deviceToken: 'a'.repeat(64) });
  assert.equal(requested.status, 201);
  assert.equal((await s.call('/device-bind/confirm', { code: requested.body.code }, phone)).status, 200);
  const approved = await s.call('/device-bind/status', { bindId: requested.body.bindId, pollSecret: requested.body.pollSecret });
  assert.equal(approved.body.status, 'approved'); assert.equal(approved.body.token, undefined);
  await s.device('alpha');
  assert.deepEqual((await s.call('/devices', undefined, phone)).body.devices.map(d => d.id), ['alpha']);
});

test('device binding confirmation locks one phone after five failed codes', async t => {
  const s = await setup(t);
  const register = async id => (await s.call('/mobile/register', { appKey: 'private-app-key', deviceId: id, name: id, platform: 'test' })).body.token;
  const blockedPhone = await register('phone_blocked_1234567890');
  const otherPhone = await register('phone_other_123456789012');
  const requested = await s.call('/device-bind/request', { deviceId: 'rate-limited-device', name: 'Rate limited', platform: 'test' });
  for (let index = 0; index < 5; index += 1) assert.equal((await s.call('/device-bind/confirm', { code: 'AAAAAAAA' }, blockedPhone)).status, 404);
  assert.equal((await s.call('/device-bind/confirm', { code: requested.body.code }, blockedPhone)).status, 429);
  assert.equal((await s.call('/device-bind/confirm', { code: requested.body.code }, otherPhone)).status, 200);
});

test('phone detach, monitor revocation, record removal and rebinding remain isolated', async t => {
  const s = await setup(t);
  const register = async id => (await s.call('/mobile/register', { appKey: 'private-app-key', deviceId: id })).body.token;
  const a = await register('unbind_phone_a_123456');
  const b = await register('unbind_phone_b_123456');
  async function bind(phone, deviceToken) {
    const req = await s.call('/device-bind/request', { deviceId: 'unbind-pc', name: 'My PC', deviceToken });
    assert.equal(req.status, 201);
    assert.equal((await s.call('/device-bind/confirm', { code: req.body.code }, phone)).status, 200);
    return (await s.call('/device-bind/status', { bindId: req.body.bindId, pollSecret: req.body.pollSecret })).body.token;
  }
  const credential = await bind(a);
  await bind(b, credential);
  await s.device('unbind-pc', credential);
  assert.equal((await s.call('/devices/remove', { deviceId: 'unbind-pc' }, a)).status, 409);
  assert.equal((await s.call('/devices/unbind', { deviceId: 'unbind-pc' }, a)).status, 200);
  let view = (await s.call('/snapshot', undefined, a)).body;
  assert.equal(view.instances.length, 0);
  assert.equal(view.devices[0].bound, false);
  assert.equal(view.devices[0].name, 'My PC');
  assert.equal((await s.call('/snapshot', undefined, b)).body.instances.length, 1);
  assert.equal((await s.call('/devices/remove', { deviceId: 'unbind-pc' }, a)).status, 200);
  assert.equal((await s.call('/devices', undefined, a)).body.devices.length, 0);
  assert.equal((await s.call('/device/unbind', { deviceId: 'unbind-pc' }, a)).status, 401);
  assert.equal((await s.call('/device/unbind', { deviceId: 'unbind-pc' }, credential)).status, 200);
  view = (await s.call('/snapshot', undefined, b)).body;
  assert.equal(view.instances.length, 0);
  assert.equal(view.devices[0].bound, false);
  assert.equal((await s.call('/device/unbind', { deviceId: 'unbind-pc' }, credential)).status, 401);
  const fresh = await bind(b);
  assert.notEqual(fresh, credential);
  assert.deepEqual((await s.call('/devices', undefined, b)).body.devices.map(d => d.bound), [true]);
  assert.equal((await s.call('/devices/unbind', { deviceId: 'unbind-pc' }, b)).status, 200);
  assert.equal((await s.call('/device/unbind', { deviceId: 'unbind-pc' }, fresh)).status, 401);
});
