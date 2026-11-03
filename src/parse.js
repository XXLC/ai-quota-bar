'use strict';
const {t} = require('./i18n');
const {stripVTControlCharacters} = require('node:util');
const stripAnsi = text => stripVTControlCharacters(
  String(text ?? '').replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
).replace(/^\uFEFF/, '');
const removeControls = text => String(text)
  .replace(/[\r\n\t]/g, ' ')
  .replace(/[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/g, '');
function takePoints(text, count) {
  let result = '';
  let length = 0;
  for (const point of String(text ?? '')) {
    if (length++ >= count) break;
    result += point;
  }
  return result;
}
function redactEmail(token) {
  const separator = token.indexOf('@');
  if (separator <= 0 || separator !== token.lastIndexOf('@')) return token;
  const local = token.slice(0, separator);
  const domain = token.slice(separator + 1).replace(/\.+$/, '');
  const dot = domain.lastIndexOf('.');
  if (dot <= 0 || !/^[\w.+-]+$/.test(local) || !/^[\w.-]+$/.test(domain.slice(0, dot)) ||
      !/^[A-Za-z]{2,}$/.test(domain.slice(dot + 1))) return token;
  return t('common.redacted') + token.slice(separator + 1 + domain.length);
}
function sanitize(text, maxLen = 120) {
  // Giới hạn trước mọi regex để đầu ra lỗi rất dài không khóa luồng giao diện.
  const input = takePoints(text, 2000);
  const line = stripAnsi(input).split(/\r?\n/).find(value => value.trim())?.trim() || '';
  const clean = removeControls(line)
    .replace(/[\w.+@-]+/g, redactEmail)
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, t('common.redacted'))
    .replace(/([?&](?:token|access_token|refresh_token|id_token|key|apikey|api_key|secret|client_secret|password|auth|authorization|code)=)[^&#\s]*/gi,
      '$1' + t('common.redacted'))
    .replace(/(?:\beyJ|ya29\.)[A-Za-z0-9_\-./+=]*/g, t('common.redacted'))
    .replace(/[A-Za-z0-9_\-./+=]{24,}/g, t('common.redacted'));
  return [...clean].length > maxLen ? takePoints(clean, Math.max(0, maxLen - 3)) + '...' : clean;
}
const groupNames = new Map([
  ['Gemini Models', 'Gemini'],
  ['Claude and GPT models', 'Claude/GPT']
]);
const groupLabel = name => groupNames.get(name) || name.replace(/ models$/i, '');
function parseReset(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d+)?)?(Z|[+-](\d\d):(\d\d))$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const daysInMonth = new Date(Date.UTC(+year, +month, 0)).getUTCDate();
  if (+month < 1 || +month > 12 || +day < 1 || +day > daysInMonth || +hour > 23 ||
      +minute > 59 || +(second || 0) > 59 || +(offsetHour || 0) > 23 || +(offsetMinute || 0) > 59) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}
function bucket(groupName, name, window, fraction, reset, percent = fraction * 100 + 1e-9) {
  if (!groupName || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) return null;
  const label = String(name || window || '').replace(/ Limit Remaining$/i, '').trim();
  if (!label) return null;
  const windowKey = window === '5h' || window === 'weekly' ? window :
    /five[\s-]*hour/i.test(label) ? '5h' : /weekly/i.test(label) ? 'weekly' : 'other:' + label;
  return {
    groupName,
    groupLabel: groupLabel(groupName),
    windowKey,
    windowLabel: windowKey === '5h' ? t('window.fiveHour') : windowKey === 'weekly' ? t('window.weekly') : label,
    fraction,
    percent: Math.max(0, Math.min(100, Math.floor(percent))),
    resetAt: parseReset(reset)
  };
}
function normalize(items) {
  const groups = new Map();
  for (const item of items.filter(Boolean)) {
    if (!groups.has(item.groupName)) groups.set(item.groupName, new Map());
    groups.get(item.groupName).set(item.windowKey, item);
  }
  const rank = item => item.windowKey === '5h' ? 0 : item.windowKey === 'weekly' ? 1 : 2;
  return [...groups.values()].flatMap(group => [...group.values()].sort((a, b) => rank(a) - rank(b)));
}
function parseTsv(text) {
  return normalize(stripAnsi(text).split(/\r?\n/).map(line => {
    const [group, name, value, reset] = line.split('\t').map(part => part.trim());
    if (!/^\d+(?:\.\d+)?\s*%$/.test(value || '') || !name) return null;
    const percent = Number(value.replace(/\s*%$/, ''));
    return bucket(group, name, null, percent / 100, reset, percent);
  }));
}
function parse(text) {
  let data;
  try {
    data = JSON.parse(stripAnsi(text));
  } catch {
    return {error: {type: 'exit', message: sanitize(text) || t('error.noQuota')}};
  }
  // Không nhận kết quả có lượt gọi model, kể cả khi model trả bảng quota giống thật.
  if (data?.command?.name !== 'usage' || data.num_turns !== 0 ||
      (data.conversation_id && data.conversation_id !== '') ||
      (data.status !== undefined && data.status !== 'SUCCESS')) {
    return {error: {type: 'unexpected', message: t('error.unexpected')}};
  }
  const groups = data.command?.data?.groups;
  const buckets = Array.isArray(groups) ? normalize(groups.flatMap(group => {
    if (!group || !Array.isArray(group.buckets)) return [];
    return group.buckets.filter(item => item && typeof item === 'object').map(item =>
      bucket(typeof group.name === 'string' ? group.name : '', item.name, item.window,
        item.remaining_fraction, item.reset_time));
  })) : data.conversation_id === '' ? parseTsv(data.response) : [];
  return buckets.length ? {buckets} : {
    error: {type: 'exit', message: sanitize(data.response) || t('error.noQuota')}
  };
}
module.exports = {parse, parseTsv, normalize, groupLabel, sanitize, stripAnsi, removeControls};
