'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {display} = require('../src/format');
const {parse, parseTsv} = require('../src/parse');
const {setLocale} = require('../src/i18n');
const now = Date.parse('2026-11-03T00:00:00Z');
const bucket = (windowKey, percent, overrides = {}) => ({
  groupName: 'codex', groupLabel: 'Codex', windowKey,
  windowLabel: windowKey.startsWith('other:') ? windowKey.slice(6) : windowKey,
  percent, resetAt: now + 3600000, ...overrides
});
const view = buckets => display({buckets, lastSuccessAt: now}, now);
setLocale('vi');

for (const windowKey of ['5h', 'weekly']) {
  test('Pha 6: thiếu cửa sổ chính vẫn hiện giới hạn phụ ổn bên cạnh ' + windowKey, () => {
    const model = view([bucket(windowKey, 80), bucket('other:3 ngày', 60)]);
    assert.equal(model.text, windowKey === '5h' ? 'Codex 80% | -- | 3 ngày 60%' : 'Codex -- | 80% | 3 ngày 60%');
    assert.equal(model.severity, 'ok');
  });
  test('Pha 6: cửa sổ trùng ' + windowKey + ' hiển thị phần trăm thấp nhất ở mọi thứ tự', () => {
    for (const percents of [[80, 5], [5, 80]]) {
      const model = view(percents.map(percent => bucket(windowKey, percent)));
      assert.equal(model.text, windowKey === '5h' ? 'Codex 5% | --' : 'Codex -- | 5%');
      assert.equal(model.severity, 'critical');
      assert.ok(model.accessibilityLabel.includes('5%'));
      assert.ok(model.tooltip.includes('80%'));
      assert.ok(model.items.some(item => item.label.includes('80%')));
    }
  });
}

test('Pha 6: chỉ giới hạn phụ vẫn có nhãn và giữ đầy đủ dữ liệu chi tiết', () => {
  const model = view([bucket('other:Giới hạn', 60), bucket('other:3 ngày', 80)]);
  assert.equal(model.text, 'Codex Giới hạn 60% +1');
  assert.ok(model.tooltip.includes('3 ngày'));
  assert.ok(model.items.some(item => item.label === '3 ngày: 80%'));
  assert.equal(model.accessibilityLabel, 'Codex: 5 giờ không có, Tuần không có, Giới hạn 60%, 3 ngày 80%');
});

test('Pha 6: mỗi nhóm chỉ nối một giới hạn phụ xấu nhất, nhãn tối đa 16 ký tự Unicode', () => {
  const long = 'Mô hình chuyên biệt dành cho phân tích';
  const model = view([bucket('5h', 90), bucket('weekly', 50),
    bucket('other:' + long, 5), bucket('other:Giới hạn khác', 20), bucket('other:Giới hạn ổn', 80),
    bucket('5h', 70, {groupName: 'gemini', groupLabel: 'Gemini'}),
    bucket('other:Ngày', 60, {groupName: 'gemini', groupLabel: 'Gemini'})]);
  const short = [...long].slice(0, 15).join('') + '…';
  assert.equal([...short].length, 16);
  assert.equal(model.text, 'Codex 90% | 50% | ' + short + ' 5% +2 · Gemini 70% | -- | Ngày 60%');
  assert.ok(model.tooltip.includes(long));
  assert.ok(model.items.some(item => item.label.includes(long + ': 5%')));
  assert.ok(model.accessibilityLabel.includes(long + ' 5%'));
  assert.equal(model.severity, 'critical');
});

test('Pha 6: nhãn ngắn đúng 16 ký tự không bị cắt, nhãn dài không cắt đôi code point', () => {
  for (const label of ['M'.repeat(16), '𐐀 '.repeat(12)]) {
    const model = view([bucket('other:' + label, 60)]);
    const shown = [...label].length > 16 ? [...label].slice(0, 15).join('') + '…' : label;
    assert.equal(model.text, 'Codex ' + shown + ' 60%');
    assert.equal(model.text.isWellFormed(), true);
  }
});

for (const locale of ['en', 'vi']) {
  test('Pha 6: nhãn trợ năng đọc rõ cửa sổ, mức thiếu và mức đã reset bằng ' + locale, () => {
    setLocale(locale);
    try {
      assert.equal(view([bucket('weekly', 29), bucket('5h', 84)]).accessibilityLabel,
        locale === 'vi' ? 'Codex: 5 giờ 84%, Tuần 29%' : 'Codex: 5-hour 84%, Weekly 29%');
      assert.equal(view([bucket('5h', 5, {resetAt: now})]).accessibilityLabel,
        locale === 'vi' ? 'Codex: 5 giờ chưa rõ, Tuần không có' : 'Codex: 5-hour unknown, Weekly not available');
      const provider = {name: 'Codex'};
      const error = display({error: {type: 'auth', message: 'Lỗi giả lập'}}, now, {}, provider);
      assert.doesNotMatch(error.accessibilityLabel, /\$\(/);
      assert.match(error.accessibilityLabel, locale === 'vi' ? /chưa đăng nhập/ : /not signed in/);
    } finally { setLocale('vi'); }
  });
}

for (const label of ['Five-Hour', 'Five Hour', 'FiveHour', 'FIVE--HOUR', 'Five   Hour']) {
  test('Pha 6: nhận nhãn agy ' + label + ' từ JSON và TSV', () => {
    const json = JSON.stringify({status: 'SUCCESS', num_turns: 0, conversation_id: '',
      command: {name: 'usage', data: {groups: [{name: 'Gemini Models', buckets: [
        {name: label + ' Limit Remaining', remaining_fraction: 0.4},
        {name: 'Weekly Limit Remaining', remaining_fraction: 0.6}
      ]}]}}});
    const result = parse(json);
    assert.deepEqual(result.buckets.map(row => [row.windowKey, row.percent]), [['5h', 40], ['weekly', 60]]);
    assert.equal(view(result.buckets).text, 'Gemini 40% | 60%');
    const tsv = parseTsv('Gemini Models\t' + label + ' Limit Remaining\t40%');
    assert.equal(tsv[0].windowKey, '5h');
    assert.equal(tsv[0].windowLabel, '5 giờ');
  });
}
