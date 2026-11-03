'use strict';
const {t} = require('../i18n');
const {createHttpProvider, quotaBucket} = require('./http');
const finiteNumber = value => (typeof value === 'number' || typeof value === 'string' && value.trim()) &&
  Number.isFinite(Number(value)) ? Number(value) : null;
function parseUsage(data, now = Date.now()) {
  return ['primary', 'secondary'].map(position => {
    const value = data?.rate_limit?.[position + '_window'];
    if (!value) return null;
    const seconds = finiteNumber(value.limit_window_seconds);
    if (value.limit_window_seconds != null && (seconds === null || seconds <= 0)) return null;
    const label = seconds === null ? t('window.generic') :
      seconds === 18000 ? t('window.fiveHour') : seconds === 604800 ? t('window.weekly') :
      seconds % 86400 === 0 ? t('window.days', seconds / 86400) :
      seconds % 3600 === 0 ? t('window.hours', seconds / 3600) : t('window.minutes', Math.round(seconds / 60));
    const windowKey = seconds === 18000 ? '5h' : seconds === 604800 ? 'weekly' :
      'other:' + (seconds === null ? position : seconds + 's');
    const absoluteReset = finiteNumber(value.reset_at);
    const relativeReset = finiteNumber(value.reset_after_seconds);
    const resetAt = absoluteReset !== null ? absoluteReset * 1000 :
      relativeReset !== null ? now + relativeReset * 1000 : null;
    return quotaBucket('codex', 'Codex', windowKey, label, finiteNumber(value.used_percent), resetAt);
  }).filter(Boolean);
}
const createProvider = deps => createHttpProvider('codex', 'Codex', parseUsage, deps);
module.exports = {...createProvider(), createProvider, parseUsage};
