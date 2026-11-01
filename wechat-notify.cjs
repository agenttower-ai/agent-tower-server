// WeChat credentials stay on the relay server. Template data keys must match the
// exact template selected in the Mini Program console.
function createWechatNotifier({ appId = '', appSecret = '', templateId = '', templateData = {}, fetcher = fetch } = {}) {
  const enabled = Boolean(appId && appSecret && !appSecret.startsWith('REPLACE_') && templateId && Object.keys(templateData).length);
  let accessToken = '', expiresAt = 0, refreshing;
  async function json(url, options) {
    const response = await fetcher(url, options);
    const body = await response.json();
    if (!response.ok || body.errcode) throw new Error(`微信接口错误 ${body.errcode || response.status}: ${body.errmsg || ''}`);
    return body;
  }
  async function exchange(code) {
    if (!enabled) throw new Error('订阅消息尚未配置');
    if (typeof code !== 'string' || !/^[\w-]{8,256}$/.test(code)) throw new Error('微信登录凭证无效');
    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
    const result = await json(url);
    if (!result.openid) throw new Error('微信未返回 OpenID');
    return result.openid;
  }
  async function token() {
    if (accessToken && Date.now() < expiresAt) return accessToken;
    if (!refreshing) refreshing = (async () => {
      const result = await json(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`);
      accessToken = result.access_token;
      expiresAt = Date.now() + Math.max(0, Number(result.expires_in || 7200) - 300) * 1000;
      return accessToken;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function send(openid, { sessionTitle = '', projectName = '', agentName = '' } = {}) {
    if (!enabled) return false;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date()).map(part => [part.type, part.value]));
    const reminderTime = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    const title = Array.from(String(sessionTitle).replace(/\s+/g, ' ').trim()).slice(0, 20).join('') || 'Agent 审批';
    const project = Array.from(String(projectName).replace(/\s+/g, ' ').trim()).slice(0, 20).join('') || '未命名项目';
    const agent = Array.from(String(agentName).replace(/\s+/g, ' ').trim()).slice(0, 20).join('') || 'Agent';
    const data = Object.fromEntries(Object.entries(templateData).map(([key, value]) => [key, {
      value: Array.from(String(value).replaceAll('{{now}}', reminderTime).replaceAll('{{sessionTitle}}', title)
        .replaceAll('{{projectName}}', project).replaceAll('{{agentName}}', agent)).slice(0, 20).join('')
    }]));
    await json(`https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(await token())}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ touser: openid, template_id: templateId, page: 'pages/index/index', miniprogram_state: 'formal', data })
    });
    return true;
  }
  return { enabled, templateId: enabled ? templateId : '', exchange, send };
}
module.exports = { createWechatNotifier };
