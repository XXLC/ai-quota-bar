'use strict';
require('../src/i18n').setLocale('vi');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {display} = require('../src/format');
const now = Date.parse('2026-11-03T00:00:00Z');
const bucket = (windowKey, percent, overrides = {}) => ({
  groupName: 'codex', groupLabel: 'Codex', windowKey,
  windowLabel: windowKey.startsWith('other:') ? windowKey.slice(6) : windowKey,
  percent, resetAt: now + 3600000, ...overrides
});
const view = (buckets, state = {}, config = {}) =>
  display({buckets, lastSuccessAt: now, ...state}, now, config);

test('Pha 4: đủ hai cửa sổ luôn theo thứ tự 5 giờ rồi tuần, không chọn số thấp nhất', () => {
  const result = view([bucket('weekly', 29), bucket('5h', 84)]);
  assert.equal(result.text, 'Codex 84% | 29%');
  assert.equal(result.severity, 'warning');
});

for (const [name, buckets, expected] of [
  ['thiếu 5 giờ', [bucket('weekly', 96)], 'Codex -- | 96%'],
  ['thiếu tuần', [bucket('5h', 76)], 'Codex 76% | --'],
  ['5 giờ đã reset', [bucket('5h', 5, {resetAt: now}), bucket('weekly', 20)], 'Codex ?% | 20%'],
  ['tuần đã reset', [bucket('5h', 76), bucket('weekly', 5, {resetAt: now - 1})], 'Codex 76% | ?%'],
  ['cả hai đã reset', [bucket('5h', 5, {resetAt: now}), bucket('weekly', 5, {resetAt: now})], 'Codex ?% | ?%'],
  ['5 giờ đã reset và thiếu tuần', [bucket('5h', 5, {resetAt: now})], 'Codex ?% | --'],
  ['giá trị biên 0 và 100', [bucket('5h', 0), bucket('weekly', 100)], 'Codex 0% | 100%']
]) test('Pha 4: ' + name, () => assert.equal(view(buckets).text, expected));

test('Pha 4: nhiều nhóm Antigravity phân tách bằng dấu chấm giữa', () => {
  const buckets = [
    bucket('5h', 91, {groupName: 'Gemini Models', groupLabel: 'Gemini'}),
    bucket('weekly', 60, {groupName: 'Gemini Models', groupLabel: 'Gemini'}),
    bucket('5h', 80, {groupName: 'Claude and GPT models', groupLabel: 'Claude/GPT'}),
    bucket('weekly', 55, {groupName: 'Claude and GPT models', groupLabel: 'Claude/GPT'})
  ];
  assert.equal(view(buckets).text, 'Gemini 91% | 60% · Claude/GPT 80% | 55%');
});

for (const [percent, severity, suffix] of [
  [31, 'ok', ''], [30, 'warning', ' | Mô hình riêng 30%'], [10, 'critical', ' | Mô hình riêng 10%']
]) test('Pha 4: giới hạn phụ còn ' + percent + '% giữ mức nền và chỉ hiện khi cảnh báo', () => {
  const result = view([bucket('5h', 84), bucket('weekly', 55), bucket('other:Mô hình riêng', percent)]);
  assert.equal(result.text, 'Codex 84% | 55%' + suffix);
  assert.equal(result.severity, severity);
  assert.match(result.tooltip, new RegExp('Mô hình riêng \\| (?:\\*\\*)?' + percent + '%'));
  assert.ok(result.items.some(item => item.label.includes('Mô hình riêng: ' + percent + '%')));
});

test('Pha 4: chỉ giới hạn phụ xấu nhất nằm cuối đúng nhóm và đếm phần còn lại', () => {
  const result = view([
    bucket('5h', 84), bucket('other:Ngày', 20), bucket('other:Giới hạn ổn', 80),
    bucket('weekly', 55), bucket('other:Mô hình riêng', 5),
    bucket('weekly', 96, {groupName: 'claude', groupLabel: 'Claude'})
  ]);
  assert.equal(result.text, 'Codex 84% | 55% | Mô hình riêng 5% +2 · Claude -- | 96%');
  assert.equal(result.severity, 'critical');
});

test('Pha 4: giới hạn phụ đã reset vẫn hiện khi thiếu cửa sổ chính', () => {
  const result = view([bucket('5h', 84), bucket('other:Ngày', 5, {resetAt: now})]);
  assert.equal(result.text, 'Codex 84% | -- | Ngày ?%');
  assert.equal(result.severity, 'ok');
  assert.match(result.tooltip, /Ngày \| \?% \|/);
  assert.ok(result.items.some(item => item.label === 'Ngày: ?%'));
});

test('Pha 4: ngưỡng tùy chỉnh quyết định mức nền và giới hạn phụ cần hiện', () => {
  const buckets = [bucket('5h', 84), bucket('weekly', 55), bucket('other:Ngày', 40)];
  assert.equal(view(buckets).text, 'Codex 84% | 55%');
  const warning = view(buckets, {}, {warningThreshold: 50, criticalThreshold: 20});
  assert.equal(warning.text, 'Codex 84% | 55% | Ngày 40%');
  assert.equal(warning.severity, 'warning');
  const critical = view(buckets, {}, {warningThreshold: 50, criticalThreshold: 40});
  assert.equal(critical.text, warning.text);
  assert.equal(critical.severity, 'critical');
});

test('Pha 4: chỉ có giới hạn phụ giữ nhãn của mức thấp nhất còn hiệu lực và đếm phần còn lại', () => {
  const result = view([bucket('other:Ngày', 5, {resetAt: now}),
    bucket('other:Mô hình riêng', 20), bucket('other:Khác', 70)]);
  assert.equal(result.text, 'Codex Mô hình riêng 20% +2');
  assert.equal(result.severity, 'warning');
  assert.equal(view([bucket('other:Ngày', 5, {resetAt: now})]).text, 'Codex Ngày ?%');
  assert.equal(view([bucket('other:Ngày', 70), bucket('other:Khác', 60)]).text, 'Codex Khác 60% +1');
});

test('Pha 4: lỗi làm mới và dữ liệu quá hạn giữ tiền tố history, làm mới thủ công giữ spinner', () => {
  const buckets = [bucket('5h', 76), bucket('weekly', 96)];
  for (const state of [{lastSuccessAt: now - 600001}, {error: {type: 'network', message: 'Lỗi giả lập.'}}]) {
    assert.equal(view(buckets, state).text, '$(history) Codex 76% | 96%');
    assert.equal(view(buckets, {...state, manualRefresh: true}).text, '$(sync~spin) $(history) Codex 76% | 96%');
  }
});

test('Pha 4: mốc chính nghiêm trọng hoặc cảnh báo vẫn quyết định nền khi mốc còn lại đã reset', () => {
  for (const windowKey of ['5h', 'weekly']) for (const [percent, severity] of [[20, 'warning'], [5, 'critical']]) {
    const buckets = [bucket(windowKey, percent), bucket(windowKey === '5h' ? 'weekly' : '5h', 0, {resetAt: now})];
    assert.equal(view(buckets).severity, severity);
  }
  assert.equal(view([bucket('5h', 0, {resetAt: now}), bucket('weekly', 0, {resetAt: now})]).severity, 'ok');
});
