const { startRelayServer } = require('./relay-server.cjs');
const path = require('node:path');
const { createWechatNotifier } = require('./wechat-notify.cjs');
let deviceTokens;
try { deviceTokens = JSON.parse(process.env.AGENTTOWER_DEVICE_TOKENS || '{}'); } catch { throw new Error('AGENTTOWER_DEVICE_TOKENS 必须为 JSON 对象'); }
if (!deviceTokens || Array.isArray(deviceTokens) || Object.entries(deviceTokens).some(([id, token]) => !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || typeof token !== 'string' || token.length < 32)) throw new Error('AGENTTOWER_DEVICE_TOKENS 必须是设备 ID 到至少 32 位旧版凭证的 JSON 对象，参见 README');
const appKey = process.env.AGENTTOWER_APP_KEY || '';
const adminUsername = process.env.AGENTTOWER_ADMIN_USERNAME || '';
const adminPassword = process.env.AGENTTOWER_ADMIN_PASSWORD || '';
if (appKey && appKey.length < 32) throw new Error('AGENTTOWER_APP_KEY 至少需要 32 个字符');
let templateData = {};
try { templateData = JSON.parse(process.env.AGENTTOWER_WECHAT_TEMPLATE_DATA || '{}'); } catch { throw new Error('AGENTTOWER_WECHAT_TEMPLATE_DATA 必须为 JSON 对象'); }
const wechatNotifier = createWechatNotifier({ appId: process.env.AGENTTOWER_WECHAT_APP_ID, appSecret: process.env.AGENTTOWER_WECHAT_APP_SECRET, templateId: process.env.AGENTTOWER_WECHAT_TEMPLATE_ID, templateData });
const relay = startRelayServer({ deviceTokens, adminUsername, adminPassword, deviceStore: process.env.AGENTTOWER_DEVICE_STORE || path.join(process.cwd(), 'data', 'devices.json'), mobileStore: process.env.AGENTTOWER_MOBILE_STORE || path.join(process.cwd(), 'data', 'phones.json'), announcementsFile: process.env.AGENTTOWER_ANNOUNCEMENTS_FILE || path.join(__dirname, 'announcements.json'), appKey, wechatNotifier, port: Number(process.env.PORT) || 17655, host: process.env.HOST || '127.0.0.1', allowedOrigin: process.env.AGENTTOWER_WEB_ORIGIN || '' });
relay.server.on('listening', () => console.log(`[AgentTower] relay listening on ${relay.server.address().address}:${relay.server.address().port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { relay.close(); process.stdin.pause(); });
