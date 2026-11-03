'use strict';
const {t} = require('../i18n');
const {sanitize} = require('../parse');
const {createHttpProvider, quotaBucket} = require('./http');
const scopedLabel = value => typeof value === 'string' ? sanitize(value, 40)
  .replace(/[\u007f-\u009f\\`*[\]<>|#!~]/g, '')
  .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '').replace(/\$\(/g, '(').trim() : '';
function parseUsage(data) {
  const limits = new Map();
  for (const entry of Array.isArray(data?.limits) ? data.limits : []) {
    if (!entry) continue;
    let windowKey, label;
    if (entry.kind === 'session' || !['weekly_all', 'weekly_scoped'].includes(entry.kind) && entry.group === 'session') {
      windowKey = '5h'; label = t('window.fiveHour');
    } else if (entry.kind === 'weekly_all') {
      windowKey = 'weekly'; label = t('window.weekly');
    } else if (entry.kind === 'weekly_scoped' || entry.group === 'weekly') {
      label = scopedLabel(entry.scope?.model?.display_name) || scopedLabel(entry.scope?.surface) ||
        scopedLabel(t('window.weekly') + (typeof entry.kind === 'string' ? ' (' + entry.kind + ')' : ''));
      windowKey = 'other:' + label;
    } else continue;
    const bucket = quotaBucket('claude', 'Claude', windowKey, label, entry.percent,
      typeof entry.resets_at === 'string' ? Date.parse(entry.resets_at) : null);
    // So sánh phần còn lại chưa làm tròn để giữ giới hạn ràng buộc hơn khi trùng tên.
    if (bucket && (!limits.has(windowKey) || bucket.fraction < limits.get(windowKey).fraction)) {
      limits.set(windowKey, bucket);
    }
  }
  if (limits.size) return [...limits.values()];
  const windows = [
    ['five_hour', '5h', t('window.fiveHour')], ['seven_day', 'weekly', t('window.weekly')],
    ['seven_day_opus', 'other:Opus', 'Opus'], ['seven_day_sonnet', 'other:Sonnet', 'Sonnet']
  ];
  return windows.map(([key, windowKey, label]) => {
    const value = data?.[key];
    return quotaBucket('claude', 'Claude', windowKey, label, value?.utilization,
      typeof value?.resets_at === 'string' ? Date.parse(value.resets_at) : null);
  }).filter(Boolean);
}
const createProvider = deps => createHttpProvider('claude', 'Claude Code', parseUsage, deps);
module.exports = {...createProvider(), createProvider, parseUsage};
