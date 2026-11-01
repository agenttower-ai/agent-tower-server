const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const digest = value => createHash('sha256').update(value).digest();

function createOperations({ username = '', password = '', statistics, details = () => ({ devices: [], clients: [] }), now = Date.now }) {
  if ((username || password) && (!username || password.length < 12)) throw new Error('运维后台需要管理员用户名和至少 12 字符的密码');
  const sessions = new Map();
  const attempts = new Map();
  const assets = { '/ops': ['index.html', 'text/html'], '/ops/': ['index.html', 'text/html'], '/ops/app.js': ['app.js', 'text/javascript'], '/ops/styles.css': ['styles.css', 'text/css'] };
  return async function handle(req, res, metadata) {
    const route = req.url.split('?')[0];
    if (route !== '/ops' && !route.startsWith('/ops/')) return false;
    const finish = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); return true; };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (!username || !password) return finish(503, { error: '运维后台尚未配置管理员凭证' });
    if (req.headers.origin) {
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      const protocol = req.socket.encrypted || local && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      if (req.headers.origin !== `${protocol}://${req.headers.host}`) return finish(403, { error: '运维后台仅允许同源访问' });
    }
    if (req.method === 'GET' && assets[route]) {
      const [file, type] = assets[route];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(path.join(__dirname, 'ops', file)));
      return true;
    }
    for (const [key, expiry] of sessions) if (expiry <= now()) sessions.delete(key);
    for (const [key, entry] of attempts) if (entry.expiresAt <= now()) attempts.delete(key);
    if (req.method === 'POST' && route === '/ops/login') {
      const key = metadata.ip;
      const entry = attempts.get(key) || { count: 0, expiresAt: now() + 15 * 60_000 };
      if (entry.count >= 5 || attempts.size >= 10000 && !attempts.has(key)) return finish(429, { error: '登录尝试过多，请 15 分钟后重试' });
      entry.count += 1; attempts.set(key, entry);
      let body;
      try {
        let data = '';
        for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > 4096) return finish(413, { error: '请求过大' }); }
        body = JSON.parse(data);
      } catch { return finish(400, { error: '无效 JSON' }); }
      const valid = typeof body?.username === 'string' && typeof body?.password === 'string'
        && timingSafeEqual(digest(body.username), digest(username)) && timingSafeEqual(digest(body.password), digest(password));
      if (!valid) return finish(401, { error: '管理员用户名或密码不正确' });
      if (sessions.size >= 100) return finish(429, { error: '管理员会话数量已达上限' });
      attempts.delete(key);
      const token = randomBytes(32).toString('hex');
      const expiresAt = now() + 8 * 60 * 60_000;
      sessions.set(digest(token).toString('hex'), expiresAt);
      return finish(200, { token, expiresAt });
    }
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const key = digest(token).toString('hex');
    if (!sessions.has(key)) return finish(401, { error: '请先登录运维后台' });
    if (req.method === 'POST' && route === '/ops/logout') { sessions.delete(key); return finish(200, { ok: true }); }
    if (req.method === 'GET' && route === '/ops/stats') {
      try { return finish(200, statistics()); }
      catch (error) { console.error('[operations]', error.message); return finish(503, { error: '统计数据暂时不可用' }); }
    }
    if (req.method === 'GET' && (route === '/ops/devices' || route === '/ops/clients')) {
      try {
        const data = details();
        return finish(200, route === '/ops/devices' ? { devices: data.devices.map(device => ({ id: device.id, name: device.name, platform: device.platform, source: device.source, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt, online: Boolean(device.online && now() - device.lastSeenAt < 15000), clientCount: device.clientCount || 0 })) } : { clients: data.clients });
      }
      catch (error) { console.error('[operations]', error.message); return finish(503, { error: '明细数据暂时不可用' }); }
    }
    return finish(404, { error: '运维接口不存在' });
  };
}
module.exports = { createOperations };
