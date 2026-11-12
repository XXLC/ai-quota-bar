'use strict';
process.env.TZ = 'Asia/Ho_Chi_Minh';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {setLocale, getLocale, localeFor, t} = require('../src/i18n');
const {en, vi} = require('../src/messages');
const {display, notification, countdown, resetTime, ago} = require('../src/format');
const {parse, parseTsv, sanitize} = require('../src/parse');
const {resolveAgy, createRunner} = require('../src/runner');
const {emptyState, localResult, createStore} = require('../src/state');
const root = path.resolve(__dirname, '..');
const accented = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;
function english(value) {
  if (typeof value === 'string') assert.doesNotMatch(value, accented);
  else if (Array.isArray(value)) value.forEach(english);
  else if (value && typeof value === 'object') Object.values(value).forEach(english);
}
test('Locale mặc định, ranh giới vi, thay chỗ giữ chỗ và khóa thiếu', () => {
  assert.equal(getLocale(), 'en');
  for (const language of ['vi', 'vi-VN', 'VI']) assert.equal(localeFor(language), 'vi');
  for (const language of ['en', 'en-US', 'fr', 'zh-cn', '', undefined, 'vietnamese']) assert.equal(localeFor(language), 'en');
  setLocale('vi');
  assert.equal(t('error.timeout', 17), 'Hết thời gian chờ (17 giây).');
  en['test.fallback'] = 'Fallback {0} {1} {0}';
  try { assert.equal(t('test.fallback', '$&', 9), 'Fallback $& 9 $&'); }
  finally { delete en['test.fallback']; }
  assert.equal(t('missing.key'), 'missing.key');
  setLocale('en');
});
test('Từ điển cùng khóa, cùng chỗ giữ chỗ; mọi khóa đều dùng và mọi lời gọi đều hợp lệ', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(vi).sort());
  const placeholders = value => [...new Set(value.match(/\{\d+\}/g) || [])].sort();
  for (const key of Object.keys(en)) assert.deepEqual(placeholders(en[key]), placeholders(vi[key]), key);
  const used = new Set();
  for (const file of fs.readdirSync(path.join(root, 'src'), {recursive: true}).filter(file => file.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(root, 'src', file), 'utf8');
    for (const [, key] of source.matchAll(/\bt\('([^']+)'/g)) {
      assert.ok(Object.hasOwn(en, key), file + ': ' + key); used.add(key);
    }
    for (const [, key] of source.matchAll(/'([A-Za-z]+(?:\.[A-Za-z]+)+)'/g)) {
      if (Object.hasOwn(en, key)) used.add(key);
    }
    if (file !== 'messages.js') {
      const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      assert.doesNotMatch(withoutComments, accented, file);
    }
  }
  // Không có khóa ngoại lệ hoặc khóa mồ côi.
  assert.deepEqual([...used].sort(), Object.keys(en).sort());
  english(en);
});
const now = Date.parse('2026-11-02T19:48:00Z');
const sample = (percent = 60, resetAt = now + 3600000, windowKey = '5h') => ({
  groupName: 'Gemini Models', groupLabel: 'Gemini', windowKey,
  windowLabel: '5 giờ', percent, resetAt
});
test('Tiếng Anh: mọi trạng thái, QuickPick, thông báo và định dạng thời gian', () => {
  setLocale('en');
  const base = {...emptyState(), lastSuccessAt: now};
  const states = [emptyState(), {...emptyState(), runningSince: now},
    ...[60, 20, 5].map(percent => ({...base, buckets: [sample(percent)]})),
    {...base, buckets: [sample(20, now)]}, {...base, buckets: [sample(20, null)]},
    {...base, buckets: [sample(60, now + 3600000, 'weekly')]},
    {...base, buckets: [sample()], manualRefresh: true},
    {...base, buckets: [sample()], lastSuccessAt: now - 700000},
    {...base, buckets: [sample()], error: {type: 'exit', message: t('error.noQuota')}},
    {...base, buckets: [sample()], lastAttemptAt: now, error: {type: 'timeout', message: t('error.timeout', 45)}},
    {...emptyState(), error: {type: 'not-found', message: t('error.notFound')}}];
  states.map(state => display(state, now)).forEach(english);
  const normal = display({...base, buckets: [sample()]}, now);
  assert.equal(normal.text, 'Gemini 60% | --');
  assert.ok(normal.tooltip.includes('| Gemini | 5-hour | 60% | Tue 03 Nov 03:48 | 1 h 0 min |'));
  assert.equal(normal.title, 'Antigravity Quota - last updated: 02:48');
  assert.equal(display({...emptyState(), runningSince: now}, now).text, '$(sync~spin) AI Quota Bar');
  assert.equal(display({...base, buckets: [sample(5)]}, now).items[1].label, '$(error) 5-hour: 5% (critical)');
  for (const recovered of [false, true]) for (const windowKey of ['5h', 'weekly', 'other:Daily']) {
    english(notification({events: [{bucket: {...sample(20, null, windowKey), windowLabel: 'Daily'}, recovered}]}));
  }
  assert.equal(notification({events: [{bucket: sample(20), recovered: false}]}),
    'Antigravity Quota: Gemini (5-hour) 20% remaining, resets at Tue 03 Nov 03:48.');
  assert.equal(resetTime(now), 'Tue 03 Nov 02:48');
  for (const [delta, expected] of [[0, 'reset time reached'], [30000, 'under 1 min'],
    [720000, '12 min'], [8820000, '2 h 27 min'], [367200000, '4 d 6 h']]) {
    assert.equal(countdown(now + delta, now), expected);
  }
  assert.equal(resetTime(null), 'unknown'); assert.equal(countdown(null, now), 'unknown');
  english([ago(now, now), ago(now, now + 120000), sanitize('Bearer abc user@example.com ?token=abc')]);
  // Duyệt mọi thông điệp với các giá trị động để phát hiện phần dịch bị bỏ sót.
  for (const key of Object.keys(en)) english(t(key, 17, 'Group', 3, 4));
});
test('Tiếng Anh: parse, resolve, runner và lỗi lưu trạng thái', async () => {
  setLocale('en');
  const failures = ['', '{}', JSON.stringify({num_turns: 1}),
    JSON.stringify({num_turns: 0, command: {name: 'usage', data: {groups: []}}})].map(parse);
  english(failures);
  english(parseTsv('Gemini Models\tFive Hour Limit Remaining\t20%'));
  for (const configPath of ['relative.exe', 'C:\\missing.exe', 'C:\\agy.cmd', '']) {
    english(resolveAgy({configPath, platform: 'win32', env: {}, exists: () => false}));
  }
  for (const mode of ['success', 'invalid', 'unexpected', 'empty', 'spawn', 'throw', 'missing', 'timeout']) {
    let callback; const timers = []; const logs = [];
    const runner = createRunner({platform: 'win32', env: {PATH: 'C:\\bin'}, homedir: () => 'C:\\',
      exists: () => true, log: message => logs.push(message),
      setTimer: callback => {timers.push(callback); return timers.length;}, clearTimer() {},
      execFile(file, args, options, cb) {
        if (file.endsWith('taskkill.exe')) { cb(new Error('kill failed')); return {}; }
        if (mode === 'throw') throw new Error('spawn failed');
        callback = cb; return {pid: 1, stdin: {end() {}}};
      }});
    const pending = runner.run();
    if (mode === 'timeout') timers[0]();
    else if (mode !== 'throw') {
      const error = mode === 'spawn' ? Object.assign(new Error('spawn failed'), {code: 'EACCES'}) :
        mode === 'missing' ? Object.assign(new Error('missing'), {code: 'ENOENT'}) : null;
      callback(error, mode === 'success' ? JSON.stringify({num_turns: 0, command: {name: 'usage', data: {
        groups: [{name: 'Gemini Models', buckets: [{window: 'weekly', remaining_fraction: .5}]}]}}}) :
        mode === 'unexpected' ? '{}' : mode === 'empty' ? '' : 'invalid output');
    }
    const result = await pending;
    english(result); english(logs); english(localResult(emptyState(), result, now));
  }
  const error = {type: 'timeout', message: t('error.timeout', 17)};
  const stored = localResult(emptyState(), {error}, now);
  setLocale('vi'); assert.equal(stored.error.message, 'Timed out (17 seconds).'); setLocale('en');
  const store = createStore({directory: 'unused', fs: {mkdir: async () => { throw new Error('disk unavailable'); }}});
  await assert.rejects(store.claim({}), {message: 'disk unavailable'});
});

test('Manifest: mọi tham chiếu có đủ hai bản dịch và tiếng Việt giữ nguyên', () => {
  const manifest = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const english = require('../package.nls.json');
  const vietnamese = require('../package.nls.vi.json');
  assert.deepEqual(Object.keys(english).sort(), Object.keys(vietnamese).sort());
  for (const [, key] of manifest.matchAll(/%([^%]+)%/g)) {
    assert.ok(Object.hasOwn(english, key), key);
    assert.ok(Object.hasOwn(vietnamese, key), key);
  }
  assert.equal(vietnamese['extension.name'], 'AI Quota Bar');
  assert.equal(vietnamese['extension.description'], 'Hiển thị quota Claude Code, Codex, Antigravity và DeepSeek trên thanh trạng thái.');
  for (const [key, value] of Object.entries(vietnamese)) {
    assert.equal(typeof value, 'string', key);
    assert.ok(value.length > 0, key);
  }
  for (const value of Object.values(english)) assert.doesNotMatch(value, accented);
});
