const { WebSocketServer } = require('ws');
const { randomBytes, createHash } = require('node:crypto');
const { startMobileGateway } = require('./mobile-api.cjs');
const { createDeviceRegistry } = require('./device-registry.cjs');
const { createMobileRegistry } = require('./mobile-registry.cjs');
const { loadAnnouncements } = require('./announcements.cjs');
const path = require('node:path');
const cleanIp = value => String(value || '').replace(/^::ffff:/, '').slice(0, 80);
function connectionMetadata(req) {
  const forwardedFor = String(req?.headers?.['x-forwarded-for'] || '').slice(0, 300);
  const remoteIp = cleanIp(req?.socket?.remoteAddress);
  const trustedProxy = remoteIp === '127.0.0.1' || remoteIp === '::1';
  return { ip: trustedProxy ? cleanIp(forwardedFor.split(',')[0].trim()) || remoteIp : remoteIp, remoteIp, forwardedFor, userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 300) };
}
function startRelayServer({ deviceTokens = {}, deviceStore = '', mobileStore = '', appKey = '', adminUsername = '', adminPassword = '', wechatNotifier, announcementsFile = path.join(__dirname, 'announcements.json'), setupAgentsFile, port = 17655, host = '127.0.0.1', allowedOrigin = '', onPairing }) {
  const devices = new Map();
  const notifiedPermissions = new Map();
  const registry = createDeviceRegistry({ legacyTokens: deviceTokens, file: deviceStore });
  const mobileRegistry = createMobileRegistry({ file: mobileStore });
  const bindings = new Map();
  const setupTickets = new Map();
  const ticketHash = value => createHash('sha256').update(value).digest('hex');
  function cleanupSetupTickets() { for (const [id, ticket] of setupTickets) if (ticket.expiresAt <= Date.now()) setupTickets.delete(id); }
  function issueSetupTicket(controller, metadata = {}) {
    if (!controller?.phoneId) throw Object.assign(new Error('请先在手机注册后再生成安装指令'), { status: 403 });
    cleanupSetupTickets();
    for (const [id, ticket] of setupTickets) if (ticket.phoneId === controller.phoneId) setupTickets.delete(id);
    if (setupTickets.size >= 1000) throw Object.assign(new Error('待安装设备过多，请稍后再试'), { status: 429 });
    const value = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 10 * 60_000;
    setupTickets.set(ticketHash(value), { phoneId: controller.phoneId, source: metadata.source || 'wechat-mini-program', metadata, expiresAt });
    return { ticket: value, expiresAt };
  }
  const bindingAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function bindingCode() { let code = ''; do { code = Array.from(randomBytes(8), b => bindingAlphabet[b % bindingAlphabet.length]).join(''); } while ([...bindings.values()].some(b => b.code === code)); return code; }
  function cleanupBindings() { for (const [id, binding] of bindings) if (binding.expiresAt <= Date.now() || binding.claimedAt && Date.now() - binding.claimedAt > 60_000) bindings.delete(id); }
  function requestBinding(body, metadata = {}) {
    cleanupBindings();
    if (bindings.size >= 20) throw Object.assign(new Error('待绑定设备已达上限，请稍后再试'), { status: 429 });
    if (!body || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.deviceId || '') || typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80) throw Object.assign(new Error('设备信息无效'), { status: 400 });
    const existing = registry.list().find(d => d.id === body.deviceId);
    if (existing && !registry.verify(body.deviceId, body.deviceToken)) throw Object.assign(new Error('设备 ID 已存在；请在已绑定的 Monitor 上重试，或更换设备 ID'), { status: 409 });
    const binding = { id: randomBytes(16).toString('hex'), secret: randomBytes(32).toString('hex'), code: bindingCode(), deviceId: body.deviceId, name: body.name.trim(), platform: String(body.platform || '').slice(0, 120), source: String(body.source || 'connector-cli').slice(0, 40), metadata, existing: Boolean(existing), expiresAt: Date.now() + 5 * 60_000 };
    bindings.set(binding.id, binding);
    return { bindId: binding.id, pollSecret: binding.secret, code: binding.code, expiresAt: binding.expiresAt };
  }
  function bindingStatus(body) {
    cleanupBindings(); const binding = bindings.get(body?.bindId);
    if (!binding || binding.secret !== body?.pollSecret) throw Object.assign(new Error('设备绑定请求不存在或已过期'), { status: 404 });
    if (binding.claimedAt) throw Object.assign(new Error('设备凭证已领取'), { status: 410 });
    if (!binding.approvedAt) return { status: 'pending', expiresAt: binding.expiresAt };
    const result = { status: 'approved', deviceId: binding.deviceId, name: binding.name, ...(binding.token ? { token: binding.token } : {}) };
    binding.token = ''; binding.claimedAt = Date.now(); return result;
  }
  function confirmBinding(body, controller, metadata = {}) {
    cleanupBindings(); const code = String(body?.code || '').trim().toUpperCase();
    const binding = [...bindings.values()].find(item => item.code === code && !item.approvedAt && !item.claimedAt);
    if (!binding) throw Object.assign(new Error('设备绑定码不正确、已过期或已使用'), { status: 404 });
    if (!controller?.phoneId && !controller?.allAccess) throw Object.assign(new Error('请使用已注册的 AgentTower App 确认绑定'), { status: 403 });
    if (!binding.existing) {
      const token = randomBytes(32).toString('hex'); registry.issue({ id: binding.deviceId, name: binding.name, platform: binding.platform, token, ...binding.metadata, source: binding.source }); binding.token = token;
    }
    if (controller.phoneId) mobileRegistry.attachDevice(controller.phoneId, { id: binding.deviceId, name: binding.name, platform: binding.platform }, { ...metadata, source: controller.source || metadata.source });
    binding.approvedAt = Date.now();
    return { ok: true, device: { id: binding.deviceId, name: binding.name, platform: binding.platform, managed: true } };
  }
  function autoBind(body, metadata = {}) {
    cleanupSetupTickets();
    const value = body?.setupTicket;
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw Object.assign(new Error('一次性安装凭证无效'), { status: 403 });
    const ticket = setupTickets.get(ticketHash(value));
    if (!ticket) throw Object.assign(new Error('一次性安装凭证已使用或过期，请在手机重新复制'), { status: 403 });
    const request = requestBinding(body, metadata);
    try {
      confirmBinding({ code: request.code }, { phoneId: ticket.phoneId, source: ticket.source }, ticket.metadata);
      const result = bindingStatus({ bindId: request.bindId, pollSecret: request.pollSecret });
      setupTickets.delete(ticketHash(value));
      bindings.delete(request.bindId);
      return { deviceId: result.deviceId, name: result.name, ...(result.token ? { token: result.token } : {}) };
    } catch (error) { bindings.delete(request.bindId); throw error; }
  }
  const prefix = (deviceId, instanceId) => `${deviceId}/${instanceId}`;
  function snapshot(allowedDeviceIds) {
    const allowed = allowedDeviceIds ? new Set(allowedDeviceIds) : null;
    const state = { instances: [], sessions: [], permissions: [] };
    for (const [id, device] of devices) {
      if (allowed && !allowed.has(id)) continue;
      const fresh = device.socket?.readyState === 1 && Date.now() - device.lastSeen < 15_000;
      for (const i of device.state.instances) state.instances.push({ ...i, id: prefix(id, i.id), deviceId: id, online: Boolean(fresh && i.online && Date.now() - i.lastSeenAt < 60_000) });
      for (const s of device.state.sessions) state.sessions.push({ ...s, instanceId: prefix(id, s.instanceId) });
      for (const p of device.state.permissions) state.permissions.push({ ...p, instanceId: prefix(id, p.instanceId) });
    }
    return state;
  }
  const api = startMobileGateway({ snapshot, port, host, allowedOrigin, onPairing, requestBinding, bindingStatus, confirmBinding, issueSetupTicket, autoBind, mobileRegistry, appKey, adminUsername, adminPassword, wechatNotifier, setupAgentsFile, operationsDetails: () => ({ devices: registry.list().map(device => ({ ...device, online: devices.get(device.id)?.socket?.readyState === 1, lastSeenAt: devices.get(device.id)?.lastSeen || device.lastSeenAt, clientCount: mobileRegistry.controllerCount(device.id) })), clients: mobileRegistry.listClients() }), announcements: () => loadAnnouncements(announcementsFile),
    verifyDevice(id, token) { return registry.verify(id, token); },
    listDeviceBindings(id) { return mobileRegistry.bindingsForDevice(id); },
    removeDeviceBinding(id, phoneId) { return mobileRegistry.detachDevice(phoneId, id, registry.list().find(device => device.id === id)?.name); },
    unbindMonitor(id, token) {
      if (!registry.verify(id, token)) throw Object.assign(new Error('设备凭证已失效'), { status: 401 });
      const device = registry.list().find(d => d.id === id);
      registry.remove(id);
      mobileRegistry.removeDevice(id, device?.name);
      for (const [key, binding] of bindings) if (binding.deviceId === id) bindings.delete(key);
      devices.get(id)?.socket?.close(1008, 'device unbound'); devices.delete(id);
    },
    listDevices: allowedDeviceIds => {
      const allowed = allowedDeviceIds ? new Set(allowedDeviceIds) : null;
      return registry.list().filter(device => !allowed || allowed.has(device.id)).map(device => ({ ...device, online: devices.get(device.id)?.socket?.readyState === 1, lastSeenAt: devices.get(device.id)?.lastSeen || device.lastSeenAt }));
    },
    renameDevice(id, name) { registry.rename(id, name); },
    removeDevice(id) { const name = registry.list().find(d => d.id === id)?.name; registry.remove(id); mobileRegistry.removeDevice(id, name); devices.get(id)?.socket?.close(1008, 'device unbound'); devices.delete(id); },
    detachDevice(phoneId, id) {
      if (!mobileRegistry.detachDevice(phoneId, id, registry.list().find(d => d.id === id)?.name)) throw Object.assign(new Error('设备未绑定到当前手机'), { status: 403 });
      if (mobileRegistry.controllerCount(id) > 0) return;
      if (registry.list().find(device => device.id === id)?.managed === false) return;
      for (const [key, binding] of bindings) if (binding.deviceId === id) bindings.delete(key);
      registry.remove(id); devices.get(id)?.socket?.close(1008, 'device unbound'); devices.delete(id);
    },
    send(instanceId, message) {
    for (const [id, device] of devices) {
      const local = device.state.instances.find(i => prefix(id, i.id) === instanceId);
      if (local && device.socket?.readyState === 1) { device.socket.send(JSON.stringify({ ...message, instanceId: local.id })); return true; }
    }
    return false;
  } });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  api.server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/device' || req.headers.origin) return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', (socket, req) => {
    let deviceId;
    const timeout = setTimeout(() => socket.close(1008, 'authentication required'), 5000);
    socket.on('error', () => {});
    socket.on('message', raw => {
      try {
        const message = JSON.parse(raw);
        if (!deviceId) {
          if (message.type !== 'device.auth' || !registry.verify(message.deviceId, message.token)) return socket.close(1008, 'invalid device credential');
          if (devices.get(message.deviceId)?.socket?.readyState === 1) return socket.close(1008, 'device already connected');
          deviceId = message.deviceId; clearTimeout(timeout);
          registry.observe(deviceId, connectionMetadata(req));
          devices.set(deviceId, { socket, lastSeen: Date.now(), state: { instances: [], sessions: [], permissions: [] } });
          socket.send(JSON.stringify({ type: 'device.ready' })); return;
        }
        const device = devices.get(deviceId);
        device.lastSeen = Date.now();
        if (message.type === 'device.snapshot') {
          if (!message.state || !['instances', 'sessions', 'permissions'].every(k => Array.isArray(message.state[k]) && message.state[k].length <= 1000)) throw new Error('invalid snapshot');
          if (!message.state.instances.every(i => i && typeof i.id === 'string') || !['sessions', 'permissions'].every(k => message.state[k].every(i => i && typeof i.id === 'string' && typeof i.instanceId === 'string'))) throw new Error('invalid record');
          const previous = new Set(device.state.permissions.map(p => `${p.instanceId}:${p.id}`));
          device.state = message.state;
          if (wechatNotifier?.enabled) for (const permission of message.state.permissions) {
            if (previous.has(`${permission.instanceId}:${permission.id}`)) continue;
            const noticeKey = `${deviceId}:${permission.instanceId}:${permission.id}`;
            if (notifiedPermissions.has(noticeKey)) continue;
            notifiedPermissions.set(noticeKey, Date.now());
            if (notifiedPermissions.size > 5000) for (const [key, at] of notifiedPermissions) {
              if (Date.now() - at > 60 * 60_000 || notifiedPermissions.size > 5000) notifiedPermissions.delete(key);
            }
            const session = message.state.sessions.find(item => item.instanceId === permission.instanceId && item.id === permission.sessionID);
            const instance = message.state.instances.find(item => item.id === permission.instanceId);
            const directory = String(session?.directory || instance?.directory || '').replace(/\\/g, '/');
            const projectName = directory.split('/').filter(Boolean).pop() || '';
            for (const subscriber of mobileRegistry.subscribersFor(deviceId, wechatNotifier.templateId)) {
              mobileRegistry.consumeSubscribeCredit(subscriber.phoneId, wechatNotifier.templateId);
              wechatNotifier.send(subscriber.openId, { sessionTitle: session?.title, projectName, agentName: session?.agent || instance?.agent }).then(() => {})
                .catch(error => console.error('[wechat-subscribe]', error.message));
            }
          }
        }
        if (message.type === 'device.event' && message.event && typeof message.event.instanceId === 'string') {
          const event = message.event;
          if (event.type === 'monitor.permission.resolved') device.state.permissions = device.state.permissions.filter(p => !(p.instanceId === event.instanceId && p.id === event.requestID));
          if (event.type === 'monitor.control.error') { const p = device.state.permissions.find(p => p.instanceId === event.instanceId && p.id === event.requestID); if (p) p.error = event.error; }
          api.observe({ ...event, instanceId: prefix(deviceId, event.instanceId) });
        }
      } catch (error) {
        const reason = ['invalid snapshot', 'invalid record'].includes(error?.message) ? error.message : 'invalid message';
        console.error('[relay]', `${deviceId || 'unauthenticated'}: ${reason}`);
        socket.close(1008, reason);
      }
    });
    socket.on('close', () => { clearTimeout(timeout); if (deviceId && devices.get(deviceId)?.socket === socket) devices.get(deviceId).socket = null; });
  });
  const heartbeat = setInterval(() => { for (const socket of wss.clients) socket.ping(); for (const d of devices.values()) if (d.socket && Date.now() - d.lastSeen > 15_000) d.socket.terminate(); }, 5000);
  return { ...api, snapshot, close() { clearInterval(heartbeat); for (const s of wss.clients) s.terminate(); wss.close(); api.close(); } };
}
module.exports = { startRelayServer };
