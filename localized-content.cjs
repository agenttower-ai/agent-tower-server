// Keep default fields for older clients, and expose only validated translations.
function translations(value, sanitize) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([locale]) => /^[a-z]{2,3}(?:[-_][a-zA-Z]{2,4})?$|^zhHant$/.test(locale))
    .map(([locale, content]) => [locale, sanitize(content)])
    .filter(([, content]) => content));
}

module.exports = { translations };
