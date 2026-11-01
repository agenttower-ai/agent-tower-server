'use strict';
// The admin token is kept only in memory; reloads require authentication again.
let token = '';
let timer;
const $ = id => document.getElementById(id);
const names = { app: 'App', 'wechat-mini-program': '微信小程序', unknown: '未知来源' };
const number = value => Number(value || 0).toLocaleString('zh-CN');
const date = value => value ? new Date(value).toLocaleString('zh-CN') : '—';
const source = value => names[value] || value || '未知来源';
function showLoggedIn(value) {
  $('login-panel').hidden = value;
  $('dashboard').hidden = !value;
  $('actions').hidden = !value;
  if (!value) { clearTimeout(timer); $('metrics').replaceChildren(); $('sources').replaceChildren(); $('devices').replaceChildren(); $('clients').replaceChildren(); $('registrations').replaceChildren(); $('updated').textContent = ''; }
}
async function request(route, body) {
  const response = await fetch(`/ops/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', credentials: 'omit' });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && route !== 'login') { token = ''; showLoggedIn(false); }
    throw new Error(data.error || '请求失败');
  }
  return data;
}
function cell(tag, text) { const element = document.createElement(tag); element.textContent = text; return element; }
async function refresh() {
  clearTimeout(timer);
  $('refresh').disabled = true;
  try {
    const [data, deviceData, clientData] = await Promise.all([request('stats'), request('devices'), request('clients')]);
    const users = data.users;
    const metrics = [['客户端总数', users.total], ['24 小时活跃', users.active24h], ['7 天活跃', users.active7d], ['30 天活跃', users.active30d], ['24 小时新增', users.new24h], ['已绑定客户端', users.bound], ['注册设备', data.devices.total], ['在线设备', data.devices.online]];
    $('metrics').replaceChildren(...metrics.map(([label, value]) => { const item = cell('div', ''); item.className = 'metric'; item.append(cell('span', label), cell('strong', number(value))); return item; }));
    $('sources').replaceChildren(...users.sources.map(source => { const row = document.createElement('tr'); row.append(...[names[source.source] || source.source, number(source.total), number(source.active24h), number(source.active7d), number(source.active30d), number(source.bound)].map(value => cell('td', value))); return row; }));
    if (!users.sources.length) { const row = document.createElement('tr'); const empty = cell('td', '暂无客户端接入'); empty.colSpan = 6; row.append(empty); $('sources').append(row); }
    $('registrations').replaceChildren(...users.registrations.map(day => { const item = document.createElement('div'); item.className = 'day'; item.append(cell('span', day.date.slice(5)), cell('strong', number(day.count))); return item; }));
    $('devices').replaceChildren(...deviceData.devices.map(device => { const row = document.createElement('tr'); row.append(...[device.name, device.id, device.platform || '—', source(device.source), device.online ? '在线' : '离线', date(device.lastSeenAt), number(device.clientCount)].map(value => cell('td', value))); return row; }));
    if (!deviceData.devices.length) { const row = document.createElement('tr'); const empty = cell('td', '暂无注册设备'); empty.colSpan = 7; row.append(empty); $('devices').append(row); }
    $('clients').replaceChildren(...clientData.clients.map(client => { const row = document.createElement('tr'); const bindings = (client.bindings || []).map(binding => binding.deviceName || binding.deviceId).join('、') || '未绑定'; row.append(...[client.name || '—', client.id, source(client.source), client.platform || '—', date(client.createdAt), date(client.lastSeenAt), bindings].map(value => cell('td', value))); return row; }));
    if (!clientData.clients.length) { const row = document.createElement('tr'); const empty = cell('td', '暂无客户端'); empty.colSpan = 7; row.append(empty); $('clients').append(row); }
    $('updated').textContent = `更新于 ${new Date(data.serverTime).toLocaleString('zh-CN')} · 服务运行 ${number(Math.floor(data.uptimeSeconds / 60))} 分钟 · 每 30 秒自动刷新`;
    $('message').textContent = '';
  } catch (error) { $('message').textContent = error.message; }
  finally { $('refresh').disabled = false; if (token) timer = setTimeout(refresh, 30000); }
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('login-button').disabled = true;
  const formElement = event.currentTarget;
  try {
    const form = new FormData(formElement);
    const data = await request('login', { username: form.get('username'), password: form.get('password') });
    token = data.token; formElement.reset(); showLoggedIn(true); await refresh();
  } catch (error) { $('message').textContent = error.message; }
  finally { $('login-button').disabled = false; }
});
$('refresh').addEventListener('click', refresh);
$('devices-panel').hidden = false;
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-tab]').forEach(item => item.classList.toggle('active', item === button));
  $('devices-panel').hidden = button.dataset.tab !== 'devices';
  $('clients-panel').hidden = button.dataset.tab !== 'clients';
}));
$('logout').addEventListener('click', async () => {
  $('logout').disabled = true;
  try { await request('logout', {}); token = ''; showLoggedIn(false); $('message').textContent = '已退出登录'; }
  catch (error) { $('message').textContent = error.message; }
  finally { $('logout').disabled = false; }
});
