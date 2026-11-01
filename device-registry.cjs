const fs = require('node:fs');
const path = require('node:path');
const { createHash, timingSafeEqual } = require('node:crypto');

const hash = value => createHash('sha256').update(value).digest('hex');
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const text = (value, limit = 300) => String(value || '').slice(0, limit);

function createDeviceRegistry({ legacyTokens = {}, file = '' } = {}) {
  const managed = new Map();
  if (file && fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const device of saved.devices || []) if (device?.id && device?.tokenHash) managed.set(device.id, device);
  }
  function persist() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 2, devices: [...managed.values()] }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  return {
    verify(id, token) {
      const legacy = legacyTokens[id];
      if (typeof legacy === 'string' && safeEqual(token, legacy)) return true;
      const device = managed.get(id);
      return Boolean(device && safeEqual(hash(token || ''), device.tokenHash));
    },
    issue({ id, name, token, platform = '', source = 'connector-cli', ip = '', remoteIp = '', forwardedFor = '', userAgent = '' }) {
      if (legacyTokens[id] || managed.has(id)) throw Object.assign(new Error('设备 ID 已存在'), { status: 409 });
      const now = Date.now();
      managed.set(id, { id, name: name || id, platform: text(platform, 120), source: text(source, 40) || 'connector-cli', registeredIp: text(ip, 80), lastIp: text(ip, 80), remoteIp: text(remoteIp, 80), forwardedFor: text(forwardedFor), userAgent: text(userAgent), tokenHash: hash(token), createdAt: now, lastSeenAt: now });
      persist();
    },
    observe(id, { ip = '', remoteIp = '', forwardedFor = '', userAgent = '' } = {}) {
      const device = managed.get(id);
      if (!device) return false;
      const now = Date.now();
      const changed = ip && ip !== device.lastIp;
      device.lastIp = text(ip || device.lastIp, 80);
      device.remoteIp = text(remoteIp || device.remoteIp, 80);
      device.forwardedFor = text(forwardedFor || device.forwardedFor);
      device.userAgent = text(userAgent || device.userAgent);
      if (changed || now - (device.lastSeenAt || 0) >= 60_000) { device.lastSeenAt = now; persist(); }
      return true;
    },
    rename(id, name) {
      const device = managed.get(id);
      if (!device) throw Object.assign(new Error(legacyTokens[id] ? '环境变量设备不能在线重命名' : '设备不存在'), { status: legacyTokens[id] ? 409 : 404 });
      device.name = name; persist();
    },
    remove(id) {
      if (!managed.delete(id)) throw Object.assign(new Error(legacyTokens[id] ? '环境变量设备不能在线解除绑定' : '设备不存在'), { status: legacyTokens[id] ? 409 : 404 });
      persist();
    },
    list() {
      return [
        ...Object.keys(legacyTokens).map(id => ({ id, name: id, managed: false, source: 'environment', registrationMethod: 'environment' })),
        ...[...managed.values()].map(({ tokenHash: _, ...device }) => ({ ...device, managed: true, source: device.source || 'connector-cli', registrationMethod: 'binding' })),
      ];
    },
  };
}

module.exports = { createDeviceRegistry };
