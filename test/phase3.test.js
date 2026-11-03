'use strict';
process.env.TZ = 'Asia/Ho_Chi_Minh';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setLocale, t} = require('../src/i18n');
const claude = require('../src/providers/claude');
const codex = require('../src/providers/codex');
const {quotaBucket} = require('../src/providers/http');
const {display, escapeMarkdown} = require('../src/format');
const {isRefreshDue, transitions} = require('../src/thresholds');
const {createStore, emptyState} = require('../src/state');
const now = Date.parse('2026-11-03T00:00:00Z');
setLocale('vi');

test('Pha 3 mục 2: vượt 100% còn 0%, mức nghiêm trọng; loại âm và không hữu hạn', () => {
  for (const used of [100.4, 103, Number.MAX_VALUE]) {
    const bucket = quotaBucket('codex', 'Codex', '5h', '5 giờ', used, null);
    assert.equal(bucket.percent, 0); assert.equal(bucket.fraction, 0);
    assert.equal(display({buckets: [bucket]}, now).severity, 'critical');
    assert.equal(claude.parseUsage({five_hour: {utilization: used}})[0].percent, 0);
    assert.equal(claude.parseUsage({limits: [{kind: 'session', percent: used}]})[0].percent, 0);
  }
  for (const used of [-1, NaN, Infinity, -Infinity, undefined, null]) {
    assert.equal(quotaBucket('codex', 'Codex', '5h', '5 giờ', used, null), null);
  }
});

test('Pha 3 mục 5: bỏ retryAt hỏng hoặc đồng hồ lùi, giữ hạn chờ hợp lệ', async () => {
  for (const retryAt of [now + 3600001, 9e15, Infinity, 'sai']) {
    const stored = {...emptyState(), retryAt, lastAttemptAt: now + 1000};
    assert.equal(isRefreshDue(stored, now, {}), true);
    const store = createStore({directory: 'kho-giả', now: () => now, fs: {
      async mkdir() {}, async open() { return {async close() {}}; },
      async readFile() { return JSON.stringify(stored); },
      async writeFile() {}, async rename() {}, async unlink() {}
    }});
    const claim = await store.claim({}, true);
    assert.equal(claim.claimed, true); assert.equal(claim.state.retryAt, null);
    const automatic = await store.claim({});
    assert.equal(automatic.claimed, true); assert.equal(automatic.state.retryAt, null);
  }
  const stored = {...emptyState(), retryAt: now + 3600000, lastAttemptAt: now};
  assert.equal(isRefreshDue(stored, now, {refreshInterval: 60}), false);
  assert.equal(isRefreshDue({...stored, retryAt: now - 1, lastAttemptAt: now + 1}, now, {}), true);
});

test('Pha 3 mục 8: khóa Codex ổn định giữa ngôn ngữ và nhãn giờ, phút được làm tròn', () => {
  for (const [seconds, vi, en] of [[2700, '45 phút', '45 minutes'], [17999, '300 phút', '300 minutes'],
    [7200, '2 giờ', '2 hours'], [259200, '3 ngày', '3 days']]) {
    const input = {rate_limit: {primary_window: {used_percent: 95, limit_window_seconds: seconds}}};
    setLocale('vi'); const first = codex.parseUsage(input, now)[0];
    setLocale('en'); const second = codex.parseUsage(input, now)[0];
    assert.equal(first.windowKey, 'other:' + seconds + 's');
    assert.equal(second.windowKey, first.windowKey);
    assert.equal(first.windowLabel, vi); assert.equal(second.windowLabel, en);
    const previous = transitions([first], {}, now);
    assert.equal(transitions([second], previous.levels, now).events.length, 0);
  }
  setLocale('vi');
});

test('Pha 3 mục 8: Codex nhận chuỗi số hữu hạn, thiếu độ dài vẫn giữ hai vị trí', () => {
  const buckets = codex.parseUsage({rate_limit: {
    primary_window: {used_percent: '42', reset_at: String(now / 1000 + 120), reset_after_seconds: '1'},
    secondary_window: {used_percent: '100.4', reset_after_seconds: '60'}
  }}, now);
  assert.deepEqual(buckets.map(b => [b.windowKey, b.windowLabel, b.percent, b.resetAt]), [
    ['other:primary', 'Giới hạn', 58, now + 120000], ['other:secondary', 'Giới hạn', 0, now + 60000]
  ]);
  const bucket = codex.parseUsage({rate_limit: {primary_window: {
    used_percent: '25', limit_window_seconds: '18000', reset_at: 'không hợp lệ', reset_after_seconds: '90'
  }}}, now)[0];
  assert.equal(bucket.windowKey, '5h'); assert.equal(bucket.resetAt, now + 90000);
  for (const value of ['', ' ', 'Infinity', 'NaN', {}, [], false]) {
    const result = codex.parseUsage({rate_limit: {primary_window: {used_percent: value}}}, now);
    assert.deepEqual(result, []);
  }
});

test('Pha 3 mục 10 và 11: lỗi đăng nhập bỏ nền quota cũ, lỗi agy nêu tên', () => {
  const bucket = quotaBucket('codex', 'Codex', '5h', '5 giờ', 95, null);
  for (const id of ['claude', 'codex']) {
    const model = display({...emptyState(), buckets: [bucket], lastSuccessAt: now,
      error: {type: 'auth', message: 'Cần đăng nhập lại.'}}, now, {}, {id, name: id});
    assert.match(model.text, /chưa đăng nhập/); assert.equal(model.severity, 'ok');
    assert.match(model.tooltip, /5%/);
  }
  for (const language of ['vi', 'en']) {
    setLocale(language);
    for (const type of ['not-found', 'network']) {
      const model = display({...emptyState(), error: {type, message: 'Lỗi giả.'}}, now, {},
        {id: 'agy', name: 'Antigravity'});
      assert.equal(model.text, '$(error) Antigravity: ' + (type === 'not-found' ?
        language === 'vi' ? 'không tìm thấy agy' : 'agy not found' : language === 'vi' ? 'lỗi' : 'error'));
    }
  }
  setLocale('vi');
});

test('Pha 3 mục 12: tooltip chặn URL trần và www, giữ định dạng thời gian', () => {
  assert.equal(escapeMarkdown('https://evil.example/x http://evil.example www.evil.example WWW.evil.example'),
    'https\\://evil.example/x http\\://evil.example www\\.evil.example WWW\\.evil.example');
  assert.equal(escapeMarkdown('cập nhật 07:00'), 'cập nhật 07:00');
  const bucket = quotaBucket('agy', 'Gemini https://evil.example www.evil.example', '5h', '5 giờ', 20, null);
  const model = display({buckets: [bucket]}, now);
  assert.match(model.tooltip, /https\\:\/\/evil/);
  assert.match(model.tooltip, /www\\\.evil/);
});

test('Pha 3 mục 13: chu kỳ 60 giây có dung sai 5 giây, không vượt hạn Retry-After', () => {
  const state = {...emptyState(), lastAttemptAt: now + 10};
  assert.equal(isRefreshDue(state, now + 55009, {refreshInterval: 60}), false);
  assert.equal(isRefreshDue(state, now + 55010, {refreshInterval: 60}), true);
  assert.equal(isRefreshDue(state, now + 60000, {refreshInterval: 60}), true);
  state.retryAt = now + 60010;
  assert.equal(isRefreshDue(state, now + 60000, {refreshInterval: 60}), false);
  assert.equal(isRefreshDue(state, now + 60010, {refreshInterval: 60}), true);
});

test('Pha 3 mục 14: mô tả agyPath tiếng Việt đủ ba ý', () => {
  const value = require('../package.nls.vi.json')['configuration.agyPath'];
  assert.match(value, /Đường dẫn tuyệt đối/);
  assert.match(value, /để trống để tự dò/);
  assert.match(value, /Windows chỉ hỗ trợ tệp \.exe/);
  assert.equal(t('log.retryWaiting', '07:30'), 'Đang chờ giới hạn tần suất tới 07:30.');
});
