// Authenticated phone API on the central relay server. Never runs on an Agent device.
const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { createOperations } = require('./operations.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { loadProjectLinks } = require('./project-links.cjs');
const { loadAnnouncements } = require('./announcements.cjs');

const header = (req, name, limit = 300) => String(req.headers[name] || '').slice(0, limit);
const cleanIp = value => String(value || '').replace(/^::ffff:/, '').slice(0, 80);
function requestMetadata(req) {
  const forwardedFor = header(req, 'x-forwarded-for');
  const remoteIp = cleanIp(req.socket.remoteAddress);
  const trustedProxy = remoteIp === '127.0.0.1' || remoteIp === '::1';
  return {
    source: header(req, 'x-agenttower-source', 40),
    ip: trustedProxy ? cleanIp(forwardedFor.split(',')[0].trim()) || remoteIp : remoteIp,
    remoteIp,
    forwardedFor,
    userAgent: header(req, 'user-agent'),
  };
}

function startMobileGateway({ snapshot, send, requestBinding, bindingStatus, confirmBinding, issueSetupTicket, autoBind, unbindMonitor, verifyDevice, listDeviceBindings = () => [], removeDeviceBinding = () => false, listDevices = () => [], operationsDetails = () => ({ devices: listDevices(), clients: [] }), renameDevice, removeDevice, detachDevice, mobileRegistry, wechatNotifier, announcements = () => [], setupAgentsFile = process.env.AGENTTOWER_SETUP_AGENTS_FILE || path.join(__dirname, 'setup-agents.json'), appKey = '', adminUsername = '', adminPassword = '', port = 17655, host = '127.0.0.1', onPairing = () => {}, allowedOrigin = '', now = Date.now }) {
  const startedAt = now();
  const operations = createOperations({ username: adminUsername, password: adminPassword, now, details: operationsDetails, statistics: () => {
    const time = now();
    const devices = listDevices();
    return { serverTime: time, uptimeSeconds: Math.floor((time - startedAt) / 1000), users: mobileRegistry.statistics(time), devices: { total: devices.length, online: devices.filter(device => device.online && time - device.lastSeenAt < 15000).length } };
  } });
  const tokens = new Map();
  const pending = new Map();
  const bindingAttempts = new Map();
  const registrationAttempts = new Map();
  const logs = [];
  let sequence = 0;
  let pairing;
  let attempts = 0;
  function rotatePairing() {
    pairing = { code: randomBytes(6).toString('hex').toUpperCase(), expiresAt: now() + 5 * 60_000 };
    attempts = 0;
    onPairing({ ...pairing, port });
    return pairing;
  }
  rotatePairing();
  const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const allowedIds = controller => controller?.allAccess ? null : controller?.deviceIds || [];
  const deviceIdOf = instanceId => typeof instanceId === 'string' ? instanceId.split('/', 1)[0] : '';
  const canAccess = (controller, deviceId) => Boolean(controller?.allAccess || controller?.deviceIds?.includes(deviceId));
  const deviceList = controller => {
    const bindings = new Map((controller?.phoneId ? mobileRegistry.bindingsFor(controller.phoneId) : []).map(binding => [binding.deviceId, binding]));
    return [...listDevices(allowedIds(controller)).map(d => ({ ...d, bound: true, ...(bindings.has(d.id) ? { binding: bindings.get(d.id) } : {}) })), ...(controller?.phoneId ? mobileRegistry.detachedDevices(controller.phoneId) : [])];
  };
  function view(controller) {
    const ids = allowedIds(controller);
    const state = snapshot(ids);
    const visibleLogs = ids ? logs.filter(log => ids.includes(deviceIdOf(log.instanceId))) : logs;
    return {
      ...state, devices: deviceList(controller), serverTime: now(), capabilities: { permission: true, deviceBinding: true, sessionControl: true, pause: false, stop: true, restart: false, prompt: true },
      permissions: state.permissions.map(p => ({ ...p, submitting: pending.has(`${p.instanceId}:${p.id}`) })),
      logs: visibleLogs.slice(-300),
    };
  }
  function observe(message) {
    if (!message?.instanceId) return;
    if (message.type === 'monitor.action.result') {
      const key = `action:${message.instanceId}:${message.actionID}`;
      const entry = pending.get(key);
      if (entry) { clearTimeout(entry.timer); pending.delete(key); entry.finish(message.ok ? 200 : 502, message); }
    }
    if (message.type === 'monitor.permission.resolved' || message.type === 'monitor.control.error') {
      const key = `${message.instanceId}:${message.requestID}`;
      const entry = pending.get(key);
      if (entry) { clearTimeout(entry.timer); pending.delete(key); entry.finish(message.type.endsWith('error') ? 502 : 200, { resolved: !message.type.endsWith('error'), error: message.error }); }
    }
    if (!['monitor.output', 'monitor.input'].includes(message.type) || typeof message.text !== 'string' || !message.text.trim() || typeof message.sessionID !== 'string') return;
    const role = message.type === 'monitor.input' ? 'user' : 'assistant';
    const existing = message.messageID && logs.find(log => log.instanceId === message.instanceId && log.sessionID === message.sessionID && log.messageID === message.messageID && log.role === role);
    if (existing) { existing.text = message.text.slice(0, 12000); return; }
    logs.push({ id: ++sequence, at: now(), instanceId: message.instanceId,
      sessionID: message.sessionID, messageID: message.messageID, role, level: 'success', text: message.text.slice(0, 12000),
    });
    if (logs.length > 300) logs.shift();
  }
  const server = http.createServer(async (req, res) => {
    const finish = (status, body) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); } };
    if (await operations(req, res, requestMetadata(req))) return;
    // Only an explicitly configured web preview origin may use browser CORS.
    if (req.headers.origin) {
      if (req.headers.origin !== allowedOrigin) return finish(403, { error: '此浏览器来源未获授权' });
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-AgentTower-Source');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const route = req.url.split('?')[0];
    if (req.method === 'GET' && route === '/health') return finish(200, { name: 'AgentTower', version: 2 });
    if (req.method === 'GET' && route === '/project-links') {
      try { return finish(200, loadProjectLinks()); }
      catch (error) { console.error('[project-links]', error.message); return finish(503, { error: '项目链接暂时不可用' }); }
    }
    if (req.method === 'GET' && route === '/setup/agents') {
      try {
        const agents = JSON.parse(fs.readFileSync(setupAgentsFile, 'utf8'));
        if (!Array.isArray(agents) || !agents.length) throw new Error('Agent 文件必须是非空 JSON 数组');
        return finish(200, { agents });
      } catch (error) { console.error('[setup-agents]', error.message); return finish(503, { error: 'Agent 列表暂时不可用' }); }
    }
    if (req.method === 'GET' && route === '/announcements') {
      try { return finish(200, { announcements: announcements() }); }
      catch (error) { console.error('[announcements]', error.message); return finish(503, { error: '公告暂时不可用' }); }
    }
    if (req.method === 'GET' && route === '/mobile/announcements') {
      try { return finish(200, { announcements: loadAnnouncements(process.env.AGENTTOWER_MOBILE_ANNOUNCEMENTS_FILE || path.join(__dirname, 'mobile-announcements.json')) }); }
      catch (error) { console.error('[mobile-announcements]', error.message); return finish(503, { error: 'Mobile announcements unavailable' }); }
    }
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    for (const [key, expiry] of tokens) if (expiry <= now()) tokens.delete(key);
    const publicRoutes = ['/pair', '/mobile/register', '/device-bind/request', '/device-bind/status', '/device-bind/auto', '/device/unbind', '/device/bindings'];
    const metadata = requestMetadata(req);
    const phone = mobileRegistry?.authenticate(token, metadata);
    const controller = tokens.has(token) ? { allAccess: true, deviceIds: null } : phone ? { phoneId: phone.id, deviceIds: phone.deviceIds } : null;
    if (!publicRoutes.includes(route) && !controller) return finish(401, { error: '手机凭证已失效，请重新连接工作空间' });
    const deviceId = header(req, 'x-agenttower-device-id', 80);
    if (route === '/device/bindings' && !verifyDevice?.(deviceId, token)) return finish(401, { error: '设备凭证已失效' });
    if (route === '/device/bindings' && req.method === 'GET') return finish(200, { bindings: listDeviceBindings(deviceId) });
    if (req.method === 'GET' && route === '/snapshot') return finish(200, view(controller));
    if (req.method === 'GET' && route === '/devices') return finish(200, { devices: deviceList(controller) });
    if (req.method === 'GET' && route === '/wechat/subscribe-config') return finish(200, { enabled: !!wechatNotifier?.enabled, templateId: wechatNotifier?.templateId || '' });
    if (req.method !== 'POST') return finish(404, { error: '接口不存在' });
    let body;
    try {
      let data = '';
      const limit = route === '/session-control' ? 24000 : route === '/permission' ? 48000 : 8192;
      for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > limit) { finish(413, { error: '请求过大' }); return; } }
      body = JSON.parse(data);
      if (!body || typeof body !== 'object') throw new Error();
    } catch { return finish(400, { error: '无效 JSON' }); }
    if (route === '/device/bindings') {
      if (typeof body.phoneId !== 'string' || !body.phoneId) return finish(400, { error: '手机标识无效' });
      return removeDeviceBinding(deviceId, body.phoneId) ? finish(200, { ok: true }) : finish(404, { error: '该手机未绑定此设备' });
    }
    if (route === '/mobile/register') {
      const trusted = Boolean(appKey && equal(body.appKey, appKey));
      if (!trusted) {
        const key = req.socket.remoteAddress || 'unknown';
        const previous = registrationAttempts.get(key);
        const entry = !previous || now() - previous.startedAt > 60 * 60_000 ? { startedAt: now(), count: 0 } : previous;
        if (entry.count >= 10) return finish(429, { error: '此网络的手机注册次数过多，请稍后再试' });
        entry.count += 1; registrationAttempts.set(key, entry);
      }
      try {
        const accessToken = mobileRegistry.issue({ id: body.deviceId, name: body.name, platform: body.platform, installSecret: body.installSecret, trusted, ...metadata, source: body.source || metadata.source });
        return finish(201, { token: accessToken });
      } catch (error) { return finish(error.status || 500, { error: error.message || '手机注册失败' }); }
    }
    try {
      if (route === '/wechat/identity') {
        if (!controller?.phoneId || !wechatNotifier?.enabled) return finish(403, { error: '订阅消息尚未启用' });
        const openId = await wechatNotifier.exchange(body.code);
        return finish(200, mobileRegistry.setWechatOpenId(controller.phoneId, openId, wechatNotifier.templateId));
      }
      if (route === '/wechat/subscribe') {
        if (!controller?.phoneId || !wechatNotifier?.enabled || body.templateId !== wechatNotifier.templateId) return finish(403, { error: '订阅模板无效' });
        return finish(200, mobileRegistry.addSubscribeCredit(controller.phoneId, wechatNotifier.templateId));
      }
      if (route === '/device/unbind') { unbindMonitor(body.deviceId, token); return finish(200, { ok: true }); }
      if (route === '/devices/remove') {
        if (!controller?.phoneId || typeof body.deviceId !== 'string') return finish(400, { error: '无效设备参数' });
        mobileRegistry.forgetDevice(controller.phoneId, body.deviceId);
        return finish(200, { ok: true });
      }
      if (route === '/device-bind/request') return finish(201, requestBinding(body, metadata));
      if (route === '/device-bind/status') return finish(200, bindingStatus(body));
      if (route === '/setup/issue') return finish(201, issueSetupTicket(controller, metadata));
      if (route === '/device-bind/auto') return finish(201, autoBind(body, metadata));
      if (route === '/device-bind/confirm') {
        const key = `${controller?.phoneId || 'legacy'}:${req.socket.remoteAddress || 'unknown'}`;
        const previous = bindingAttempts.get(key);
        const entry = !previous || now() - previous.startedAt > 10 * 60_000 ? { startedAt: now(), failures: 0 } : previous;
        if (entry.failures >= 5) return finish(429, { error: '绑定码错误次数过多，请 10 分钟后再试' });
        try {
          const result = confirmBinding(body, controller, metadata);
          bindingAttempts.delete(key);
          return finish(200, result);
        } catch (error) {
          entry.failures += 1; bindingAttempts.set(key, entry);
          return finish(error.status || 500, { error: error.message || '设备绑定失败', attemptsRemaining: Math.max(0, 5 - entry.failures) });
        }
      }
      if (route === '/devices/rename') {
        if (typeof body.deviceId !== 'string' || typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80) return finish(400, { error: '设备名称无效' });
        if (!canAccess(controller, body.deviceId)) return finish(403, { error: '当前手机无权管理该设备' });
        renameDevice(body.deviceId, body.name.trim()); return finish(200, { ok: true });
      }
      if (route === '/devices/unbind') {
        if (typeof body.deviceId !== 'string') return finish(400, { error: '设备 ID 无效' });
        if (!canAccess(controller, body.deviceId)) return finish(403, { error: '当前手机未绑定该设备' });
        if (controller.phoneId) detachDevice(controller.phoneId, body.deviceId); else removeDevice(body.deviceId);
        return finish(200, { ok: true });
      }
    } catch (error) { return finish(error.status || 500, { error: error.message || '设备绑定失败' }); }
    if (route === '/pair') {
      if (now() >= pairing.expiresAt || ++attempts > 10) return finish(429, { error: '手机控制台接入码已过期或尝试过多，请在服务器控制台重新生成' });
      if (!equal(body.code, pairing.code)) return finish(403, { error: '手机控制台接入码不正确' });
      const accessToken = randomBytes(32).toString('hex');
      const expiresAt = now() + 24 * 60 * 60_000;
      if (tokens.size >= 20) return finish(429, { error: '手机连接凭证已达上限，请重启网关' });
      tokens.set(accessToken, expiresAt);
      rotatePairing();
      return finish(200, { token: accessToken, expiresAt });
    }
    if (route === '/unpair') { tokens.delete(token); mobileRegistry?.revoke(token); return finish(200, { ok: true }); }
    if (route === '/session-models') {
      if (typeof body.instanceId !== 'string' || !body.instanceId || body.instanceId.length > 500) return finish(400, { error: '无效设备参数' });
      if (!canAccess(controller, deviceIdOf(body.instanceId))) return finish(403, { error: '当前手机无权读取该设备' });
      const state = snapshot(allowedIds(controller));
      const instance = state.instances.find(i => i.id === body.instanceId);
      if (!instance?.online || now() - instance.lastSeenAt > 60_000) return finish(409, { error: '设备已离线' });
      if (!instance.contextId || instance.capabilities?.sessionControl !== true) return finish(409, { error: '请更新适配器并重启 Agent' });
      const actionID = randomBytes(16).toString('hex');
      const key = `action:${body.instanceId}:${actionID}`;
      const timer = setTimeout(() => { pending.delete(key); finish(504, { error: '模型拉取超时，请重试' }); }, 12_000);
      pending.set(key, { timer, finish });
      let sent = false;
      try { sent = send(body.instanceId, { type: 'control.session', actionID, action: 'models', contextId: instance.contextId }); } catch {}
      if (!sent) { clearTimeout(timer); pending.delete(key); finish(409, { error: 'Agent 控制通道未连接' }); }
      return;
    }
    if (route === '/session-messages') {
      if (typeof body.instanceId !== 'string' || typeof body.sessionID !== 'string' || !body.sessionID || body.instanceId.length > 500 || body.sessionID.length > 500) return finish(400, { error: '无效会话参数' });
      if (!canAccess(controller, deviceIdOf(body.instanceId))) return finish(403, { error: '当前手机无权读取该设备' });
      const state = snapshot(allowedIds(controller));
      const instance = state.instances.find(i => i.id === body.instanceId);
      const session = state.sessions.find(s => s.instanceId === body.instanceId && s.id === body.sessionID);
      if (!session) return finish(409, { error: '会话已失效，请刷新' });
      const localHistory = ['cursor', 'codebuddy-desktop'].includes(instance?.agent) && instance.capabilities?.history === true;
      if (localHistory ? !deviceList(controller).some(d => d.id === deviceIdOf(body.instanceId) && d.online) : !instance?.online || now() - instance.lastSeenAt > 60_000) return finish(409, { error: '设备已离线' });
      if (!session.contextId || (!localHistory && instance.capabilities?.sessionControl !== true)) return finish(409, { error: '请更新适配器并重启 Agent' });
      const actionID = randomBytes(16).toString('hex');
      const key = `action:${body.instanceId}:${actionID}`;
      const timer = setTimeout(() => { pending.delete(key); finish(504, { error: '消息拉取超时，请重新打开会话' }); }, 12_000);
      pending.set(key, { timer, finish });
      let sent = false;
      try { sent = send(body.instanceId, { type: 'control.session', actionID, action: 'history', contextId: session.contextId, sessionID: session.id }); } catch {}
      if (!sent) { clearTimeout(timer); pending.delete(key); finish(409, { error: 'Agent 控制通道未连接' }); }
      return;
    }
    if (route === '/session-control') {
      if (typeof body.instanceId !== 'string' || !['create', 'abort', 'prompt'].includes(body.action)
        || (body.text !== undefined && (typeof body.text !== 'string' || body.text.length > 4000))
        || (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > 200))
        || (body.model !== undefined && (typeof body.model !== 'string' || body.model.length > 300 || !/^[^/\s]+\/.+$/.test(body.model.trim())))
        || (body.directory !== undefined && (typeof body.directory !== 'string' || !body.directory.trim() || body.directory.length > 4096))
        || (body.action === 'prompt' && !body.text?.trim())) return finish(400, { error: '无效会话参数' });
      if (!canAccess(controller, deviceIdOf(body.instanceId))) return finish(403, { error: '当前手机无权控制该设备' });
      const state = snapshot(allowedIds(controller));
      const instance = state.instances.find(i => i.id === body.instanceId);
      if (!instance?.online || now() - instance.lastSeenAt > 60000) return finish(409, { error: '设备已离线' });
      const session = state.sessions.find(s => s.instanceId === body.instanceId && s.id === body.sessionID);
      if (body.action !== 'create' && !session) return finish(409, { error: '会话已失效，请刷新' });
      const contextId = body.action === 'create' ? instance.contextId : session.contextId;
      if (!contextId || instance.capabilities?.sessionControl !== true) return finish(409, { error: '请更新 Connector 并重启 Agent' });
      const actionID = randomBytes(16).toString('hex');
      const key = `action:${body.instanceId}:${actionID}`;
      const timer = setTimeout(() => { pending.delete(key); finish(504, { error: 'Agent 回执超时，结果未知，请刷新后确认，勿重复发送' }); }, 12000);
      pending.set(key, { timer, finish });
      let sent = false;
      try { sent = send(body.instanceId, { type: 'control.session', actionID, action: body.action, contextId, directory: body.action === 'create' ? body.directory : undefined, sessionID: session?.id, title: body.title, model: body.model, text: body.text }); } catch {}
      if (!sent) { clearTimeout(timer); pending.delete(key); finish(409, { error: 'Agent 控制通道未连接' }); }
      return;
    }
    if (route !== '/permission') return finish(404, { error: '此控制能力尚未接入' });
    const validAnswers = body.reply === 'answer' && Array.isArray(body.answers)
      && body.answers.length <= 5
      && body.answers.every(answer => Array.isArray(answer) && answer.length <= 20 && answer.every(value => typeof value === 'string' && value.length <= 2000));
    if ((!['once', 'always', 'reject'].includes(body.reply) && !validAnswers) || typeof body.instanceId !== 'string' || typeof body.requestID !== 'string') return finish(400, { error: '无效审批参数' });
    if (!canAccess(controller, deviceIdOf(body.instanceId))) return finish(403, { error: '当前手机无权控制该设备' });
    const state = snapshot(allowedIds(controller));
    const request = state.permissions.find(p => p.instanceId === body.instanceId && p.id === body.requestID);
    if (!request) return finish(409, { error: '该审批已处理或已失效，请刷新' });
    const instance = state.instances.find(i => i.id === body.instanceId);
    if (body.reply === 'always' && (request.questions?.length || (instance?.agent !== 'opencode' && request.allowSimilar !== true))) return finish(400, { error: '此请求不支持允许类似请求，请更新 Connector' });
    if (!instance?.online || now() - instance.lastSeenAt > 60_000) return finish(409, { error: '设备已离线，不能审批' });
    const key = `${body.instanceId}:${body.requestID}`;
    if (pending.has(key)) return finish(409, { error: '正在等待 Agent 回执，请勿重复提交' });
    const timer = setTimeout(() => { pending.delete(key); finish(504, { error: 'Agent 回执超时，结果未知，请刷新审批状态' }); }, 12_000);
    pending.set(key, { timer, finish });
    let sent = false;
    try { sent = send(body.instanceId, { type: 'control.permission.reply', requestID: body.requestID, reply: body.reply, answers: body.answers }); } catch {}
    if (!sent) { clearTimeout(timer); pending.delete(key); finish(409, { error: 'Agent 控制通道未连接' }); }
  });
  server.requestTimeout = 20_000;
  server.on('error', error => console.error('[mobile-gateway]', error.message));
  server.listen(port, host);
  return { server, observe, rotatePairing, close() {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.finish(503, { error: '网关已停止' }); }
    pending.clear(); tokens.clear(); bindingAttempts.clear(); registrationAttempts.clear(); server.close(); server.closeAllConnections();
  } };
}
module.exports = { startMobileGateway };
