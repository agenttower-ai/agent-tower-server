const fs = require('node:fs');
const path = require('node:path');
const { translations } = require('./localized-content.cjs');

function loadProjectLinks(file = process.env.AGENTTOWER_PROJECT_LINKS_FILE || path.join(__dirname, 'project-links.json')) {
  if (!fs.existsSync(file)) return { links: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed.links) || parsed.links.length > 12) throw new Error('项目链接必须为数组，最多 12 项');
  const ids = new Set();
  const links = parsed.links.filter(item => item && item.enabled !== false && item.url).map(item => {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(item.id || '') || ids.has(item.id)
      || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 40
      || typeof item.url !== 'string' || item.url.length > 1000) throw new Error('项目链接配置无效');
    ids.add(item.id);
    const value = item.url.trim();
    const url = new URL(value);
    const web = url.protocol === 'https:' && url.hostname && !url.username && !url.password;
    const email = /^mailto:[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(value);
    if (!web && !email) throw new Error('项目链接仅支持 HTTPS 网页或 mailto 邮箱');
    return { id: item.id, label: item.label.trim(), url: value,
      ...(item.translations ? { translations: translations(item.translations, content => {
        if (!content || typeof content.label !== 'string' || !content.label.trim() || content.label.length > 40) return null;
        return { label: content.label.trim() };
      }) } : {}) };
  });
  return { links };
}

module.exports = { loadProjectLinks };
