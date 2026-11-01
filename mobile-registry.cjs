const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');

const hash = value => createHash('sha256').update(value).digest('hex');
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const text = (value, limit = 200) => String(value || '').slice(0, limit);
const sourceOf = value => {
  const source = text(value, 40).toLowerCase();
  if (source === 'wechat' || source === 'wechat-mini-program') return 'wechat-mini-program';
  if (source === 'app' || source === 'ios' || source === 'android') return 'app';
  return source || 'unknown';
};
const observation = metadata => ({
  source: sourceOf(metadata?.source || metadata?.platform),
  ip: text(metadata?.ip, 80),
  remoteIp: text(metadata?.remoteIp, 80),
  forwardedFor: text(metadata?.forwardedFor, 300),
  userAgent: text(metadata?.userAgent, 300),
});

function createMobileRegistry({ file = '', limit = 10000 } = {}) {
  const phones = new Map();
  if (file && fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const phone of saved.phones || []) if (phone?.id && phone?.tokenHash) {
      const deviceIds = Array.isArray(phone.deviceIds) ? [...new Set(phone.deviceIds.filter(id => typeof id === 'string'))] : [];
      const bindings = Array.isArray(phone.bindings) ? phone.bindings.filter(binding => binding?.deviceId && deviceIds.includes(binding.deviceId)) : [];
      for (const deviceId of deviceIds) if (!bindings.some(binding => binding.deviceId === deviceId)) bindings.push({ deviceId, source: sourceOf(phone.source || phone.platform), boundAt: phone.createdAt || Date.now(), lastSeenAt: phone.updatedAt || phone.createdAt || Date.now() });
      phones.set(phone.id, { ...phone, source: sourceOf(phone.source || phone.platform), deviceIds, bindings });
    }
  }
  function persist() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 4, phones: [...phones.values()] }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  return {
    listClients() {
      return [...phones.values()].map(phone => ({
        id: phone.id,
        name: phone.name,
        platform: phone.platform,
        source: phone.source,
        createdAt: phone.createdAt,
        lastSeenAt: phone.lastSeenAt,
        deviceIds: [...phone.deviceIds],
        bindings: (phone.bindings || []).map(binding => ({
          deviceId: binding.deviceId,
          deviceName: binding.deviceName,
          devicePlatform: binding.devicePlatform,
          boundAt: binding.boundAt,
          lastSeenAt: binding.lastSeenAt,
        })),
      })).sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
    },
    statistics(now = Date.now()) {
      const all = [...phones.values()];
      const day = 86400000;
      const active = (items, days) => items.filter(phone => (phone.lastSeenAt || phone.createdAt || 0) >= now - days * day).length;
      const sources = [...new Set(all.map(phone => phone.source))].sort().map(source => {
        const items = all.filter(phone => phone.source === source);
        return { source, total: items.length, active24h: active(items, 1), active7d: active(items, 7), active30d: active(items, 30), bound: items.filter(phone => phone.deviceIds.length > 0).length };
      });
      const midnight = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
      const registrations = Array.from({ length: 14 }, (_, i) => {
        const start = midnight - (13 - i) * day;
        return { date: new Date(start).toISOString().slice(0, 10), count: all.filter(phone => phone.createdAt >= start && phone.createdAt < start + day).length };
      });
      return { total: all.length, active24h: active(all, 1), active7d: active(all, 7), active30d: active(all, 30), bound: all.filter(phone => phone.deviceIds.length > 0).length, new24h: all.filter(phone => phone.createdAt >= now - day).length, sources, registrations };
    },
    issue({ id, name = '手机', platform = '', installSecret = '', trusted = false, source = '', ip = '', remoteIp = '', forwardedFor = '', userAgent = '' }) {
      if (!/^[a-zA-Z0-9_-]{16,80}$/.test(id || '')) throw Object.assign(new Error('手机安装标识无效'), { status: 400 });
      if (!trusted && !/^[a-fA-F0-9]{64,128}$/.test(installSecret)) throw Object.assign(new Error('手机安装凭证无效'), { status: 403 });
      if (!phones.has(id) && phones.size >= limit) throw Object.assign(new Error('已授权手机数量达到上限'), { status: 429 });
      const token = randomBytes(32).toString('hex');
      const existing = phones.get(id);
      if (!trusted && existing?.installSecretHash && !safeEqual(hash(installSecret), existing.installSecretHash)) throw Object.assign(new Error('手机安装凭证不匹配'), { status: 403 });
      const seen = observation({ source, platform, ip, remoteIp, forwardedFor, userAgent });
      phones.set(id, { id, name: text(name, 80), platform: text(platform, 120), ...seen, tokenHash: hash(token), installSecretHash: existing?.installSecretHash || (installSecret ? hash(installSecret) : undefined), deviceIds: existing?.deviceIds || [], bindings: existing?.bindings || [], detachedDevices: existing?.detachedDevices || [], wechatOpenId: existing?.wechatOpenId || '', subscribeCreditsByTemplate: existing?.subscribeCreditsByTemplate || {}, createdAt: existing?.createdAt || Date.now(), lastSeenAt: Date.now(), updatedAt: Date.now() });
      persist();
      return token;
    },
    authenticate(token, metadata) {
      const tokenHash = hash(token || '');
      for (const phone of phones.values()) if (safeEqual(tokenHash, phone.tokenHash)) {
        const now = Date.now();
        if (metadata && (now - (phone.lastSeenAt || 0) >= 60_000 || metadata.ip && metadata.ip !== phone.ip)) {
          Object.assign(phone, observation({ ...metadata, source: metadata.source || phone.source, platform: phone.platform }), { lastSeenAt: now, updatedAt: now });
          for (const binding of phone.bindings || []) binding.lastSeenAt = now;
          persist();
        }
        return { id: phone.id, name: phone.name, platform: phone.platform, source: phone.source, deviceIds: [...phone.deviceIds] };
      }
      return null;
    },
    verify(token) {
      return Boolean(this.authenticate(token));
    },
    attachDevice(phoneId, device, metadata = {}) {
      const phone = phones.get(phoneId);
      if (!phone) throw Object.assign(new Error('手机凭证已失效'), { status: 401 });
      const descriptor = typeof device === 'string' ? { id: device } : device || {};
      const deviceId = descriptor.id;
      if (!deviceId) throw Object.assign(new Error('设备信息无效'), { status: 400 });
      if (!phone.deviceIds.includes(deviceId)) phone.deviceIds.push(deviceId);
      const now = Date.now();
      const seen = observation({ ...phone, ...metadata });
      const previous = (phone.bindings || []).find(binding => binding.deviceId === deviceId);
      const binding = { ...previous, deviceId, deviceName: text(descriptor.name || previous?.deviceName || deviceId, 80), devicePlatform: text(descriptor.platform || previous?.devicePlatform, 120), ...seen, boundAt: previous?.boundAt || now, lastSeenAt: now };
      phone.bindings = [...(phone.bindings || []).filter(item => item.deviceId !== deviceId), binding];
      phone.detachedDevices = (phone.detachedDevices || []).filter(d => d.id !== deviceId);
      phone.updatedAt = now; persist();
    },
    hasDevice(phoneId, deviceId) {
      return Boolean(phones.get(phoneId)?.deviceIds.includes(deviceId));
    },
    setWechatOpenId(phoneId, openId, templateId) {
      const phone = phones.get(phoneId);
      if (!phone || phone.source !== 'wechat-mini-program') throw Object.assign(new Error('仅小程序凭证可订阅'), { status: 403 });
      if (phone.wechatOpenId && phone.wechatOpenId !== openId) throw Object.assign(new Error('微信身份已变化，请撤销授权后重新接入'), { status: 409 });
      phone.wechatOpenId = openId; phone.updatedAt = Date.now(); persist();
      return { credits: phone.subscribeCreditsByTemplate?.[templateId] || 0 };
    },
    addSubscribeCredit(phoneId, templateId) {
      const phone = phones.get(phoneId);
      if (!phone?.wechatOpenId) throw Object.assign(new Error('请先关联微信身份'), { status: 409 });
      if (!templateId) throw Object.assign(new Error('订阅模板无效'), { status: 400 });
      phone.subscribeCreditsByTemplate ||= {};
      phone.subscribeCreditsByTemplate[templateId] = Math.min(20, (phone.subscribeCreditsByTemplate[templateId] || 0) + 1);
      phone.updatedAt = Date.now(); persist();
      return { credits: phone.subscribeCreditsByTemplate[templateId] };
    },
    subscribersFor(deviceId, templateId) {
      return [...phones.values()].filter(phone => phone.source === 'wechat-mini-program' && phone.deviceIds.includes(deviceId) && phone.wechatOpenId && phone.subscribeCreditsByTemplate?.[templateId] > 0)
        .map(phone => ({ phoneId: phone.id, openId: phone.wechatOpenId }));
    },
    consumeSubscribeCredit(phoneId, templateId) {
      const phone = phones.get(phoneId);
      if (!phone?.subscribeCreditsByTemplate?.[templateId]) return;
      phone.subscribeCreditsByTemplate[templateId] -= 1; phone.updatedAt = Date.now(); persist();
    },
    detachedDevices(phoneId) { return phones.get(phoneId)?.detachedDevices || []; },
    bindingsFor(phoneId) { return (phones.get(phoneId)?.bindings || []).map(binding => ({ ...binding })); },
    bindingsForDevice(deviceId) {
      return [...phones.values()]
        .filter(phone => phone.deviceIds.includes(deviceId))
        .map(phone => ({
          phoneId: phone.id,
          phoneName: phone.name,
          phonePlatform: phone.platform,
          source: phone.source,
          binding: (phone.bindings || []).find(item => item.deviceId === deviceId) || { deviceId },
        }));
    },
    forgetDevice(phoneId, deviceId) {
      const phone = phones.get(phoneId);
      if (!phone || phone.deviceIds.includes(deviceId)) throw Object.assign(new Error('请先解绑设备'), { status: 409 });
      phone.detachedDevices = (phone.detachedDevices || []).filter(d => d.id !== deviceId);
      persist();
    },
    detachDevice(phoneId, deviceId, name = deviceId) {
      const phone = phones.get(phoneId);
      if (!phone || !phone.deviceIds.includes(deviceId)) return false;
      phone.deviceIds = phone.deviceIds.filter(id => id !== deviceId);
      phone.bindings = (phone.bindings || []).filter(binding => binding.deviceId !== deviceId);
      phone.detachedDevices = [...(phone.detachedDevices || []).filter(d => d.id !== deviceId), { id: deviceId, name, bound: false, online: false, detachedAt: Date.now() }];
      phone.updatedAt = Date.now(); persist(); return true;
    },
    removeDevice(deviceId, name = deviceId) {
      let changed = false;
      for (const phone of phones.values()) {
        if (!phone.deviceIds.includes(deviceId)) continue;
        phone.deviceIds = phone.deviceIds.filter(id => id !== deviceId);
        phone.bindings = (phone.bindings || []).filter(binding => binding.deviceId !== deviceId);
        phone.detachedDevices = [...(phone.detachedDevices || []).filter(d => d.id !== deviceId), { id: deviceId, name, bound: false, online: false, detachedAt: Date.now() }];
        phone.updatedAt = Date.now(); changed = true;
      }
      if (changed) persist();
    },
    controllerCount(deviceId) {
      return [...phones.values()].filter(phone => phone.deviceIds.includes(deviceId)).length;
    },
    revoke(token) {
      const tokenHash = hash(token || '');
      for (const [id, phone] of phones) {
        if (safeEqual(tokenHash, phone.tokenHash)) { phones.delete(id); persist(); return true; }
      }
      return false;
    },
  };
}

module.exports = { createMobileRegistry };
