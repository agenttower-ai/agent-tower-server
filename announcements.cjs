const fs = require('node:fs');
const { translations } = require('./localized-content.cjs');

function content(item) {
  if (!item || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 100 || !Array.isArray(item.paragraphs)) return null;
  return { title: item.title.trim(), paragraphs: item.paragraphs.filter(value => typeof value === 'string' && value.trim()).slice(0, 12).map(value => value.slice(0, 1200)) };
}

function loadAnnouncements(file) {
  if (!file || !fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('公告文件必须是 JSON 数组');
  return parsed.slice(0, 30).filter(item => item && /^[a-zA-Z0-9_-]{1,80}$/.test(item.id || '')
    && typeof item.title === 'string' && item.title.trim() && item.title.length <= 100
    && typeof item.publishedAt === 'string' && !Number.isNaN(Date.parse(item.publishedAt))
    && Array.isArray(item.paragraphs))
    .map(item => ({ id: item.id, publishedAt: item.publishedAt, ...content(item),
      ...(item.translations ? { translations: translations(item.translations, content) } : {}) }))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

module.exports = { loadAnnouncements };
