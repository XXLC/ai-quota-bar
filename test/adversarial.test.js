'use strict';
require('../src/i18n').setLocale('vi');
process.env.TZ = 'Asia/Ho_Chi_Minh';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const { parse, parseTsv, groupLabel, sanitize } = require('../src/parse');
const { configuration, level, transitions, isRefreshDue, intervalMs, isStale } = require('../src/thresholds');
const { display, countdown, resetTime, escapeMarkdown, safeText } = require('../src/format');
const { resolveAgy, createRunner } = require('../src/runner');
const { emptyState, validState, createStore } = require('../src/state');

// Đầu ra JSON thật nguyên văn từ đầu ra thật của agy 1.4.12 trên Windows 11 (đã sửa ký tự TAB thô trong chuỗi response thành \t hợp lệ JSON)
const REAL_AGY_JSON_4_1 = '{"conversation_id":"","status":"SUCCESS","response":"Gemini Models\\tWeekly Limit Remaining\\t60%\\t2026-11-06T23:24:21Z\\nGemini Models\\tFive Hour Limit Remaining\\t90%\\t2026-11-02T19:48:29Z\\nClaude and GPT models\\tWeekly Limit Remaining\\t50%\\t2026-11-09T10:05:03Z\\nClaude and GPT models\\tFive Hour Limit Remaining\\t84%\\t2026-11-02T22:16:04Z\\n","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},"command":{"name":"usage","data":{"description":"Within each group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to the cost of the tokens. Thus, limits will last longer with shorter tasks or using more cost-effective models. The 5-hour limit smooths out aggregate demand to fairly distribute global capacity across all users, while your weekly limit is tied directly to your individual tier.","groups":[{"name":"Gemini Models","description":"Models within this group: Gemini Flash, Gemini Pro","buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","description":"You have used some of your weekly limit, it will fully refresh in 4 days, 6 hours.","window":"weekly","remaining_fraction":0.6044580936431885,"reset_time":"2026-11-06T23:24:21Z"},{"id":"gemini-5h","name":"Five Hour Limit Remaining","description":"You have used some of your 5-hour limit, it will fully refresh in 2 hours, 24 minutes.","window":"5h","remaining_fraction":0.9020247459411621,"reset_time":"2026-11-02T19:48:29Z"}]},{"name":"Claude and GPT models","description":"Models within this group: Claude Opus, Claude Sonnet, GPT-OSS","buckets":[{"id":"3p-weekly","name":"Weekly Limit Remaining","description":"You have used some of your weekly limit, it will fully refresh in 6 days, 16 hours.","window":"weekly","remaining_fraction":0.5030984878540039,"reset_time":"2026-11-09T10:05:03Z"},{"id":"3p-5h","name":"Five Hour Limit Remaining","description":"You have used some of your 5-hour limit, it will fully refresh in 4 hours, 51 minutes.","window":"5h","remaining_fraction":0.8377018570899963,"reset_time":"2026-11-02T22:16:04Z"}]}]}}}\n';

// Đầu ra stream-json thật từ đầu ra thật của agy 1.4.12 trên Windows 11 (2 dòng NDJSON)
const REAL_AGY_STREAM_JSON_4_2 = '{"event":"command_result","command":{"name":"usage","data":{"description":"Within each group, models share a weekly limit and a 5-hour limit.","groups":[{"name":"Gemini Models","buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.6067376732826233,"reset_time":"2026-11-06T23:24:21Z"},{"id":"gemini-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":0.9103993773460388,"reset_time":"2026-11-02T19:48:29Z"}]}]}}}\n{"event":"result","result":{"conversation_id":"","status":"SUCCESS","response":"Gemini Models\\tWeekly Limit Remaining\\t61%\\t2026-11-06T23:24:21Z\\n","duration_seconds":0,"num_turns":0,"command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.6067376732826233,"reset_time":"2026-11-06T23:24:21Z"}]}]}}}}\n';

// Đầu ra thật khi chạy --disable-slash-commands từ đầu ra thật của agy 1.4.12 trên Windows 11
const REAL_DISABLE_SLASH_STDOUT_5_1 = [
  'Lệnh `/usage` không phải là slash command tích hợp sẵn trong Antigravity CLI (`agy`), nên đã được gửi trực tiếp vào phiên hội thoại.',
  '',
  '- Để xem danh sách các slash command hỗ trợ trong TUI của `agy`, bạn có thể gõ `/help`.',
  '- Nếu bạn đang muốn kiểm tra trạng thái hoạt động của phiên hiện tại: mình đang phản hồi bình thường (model hiện tại: **Gemini 4 Argon (Medium)**) và không gặp giới hạn quota.'
].join('\n');

const BASE_NOW = Date.parse('2026-11-03T00:00:00Z');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-quota-bar-'));
after(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));

function makeEnvelope(overrides = {}) {
  return {
    conversation_id: '',
    status: 'SUCCESS',
    response: '',
    duration_seconds: 0,
    num_turns: 0,
    command: { name: 'usage', data: { groups: [] } },
    ...overrides
  };
}

// ============================================================================
// 1. Kiểm thử đối kháng cho parse.js
// ============================================================================

test('JSON thật nguyên văn từ đầu ra thật của agy 1.4.12 trên Windows 11 ra đúng 4 mốc, làm tròn xuống từ remaining_fraction và đúng resetAt', () => {
  const result = parse(REAL_AGY_JSON_4_1);
  assert.equal(result.error, undefined);
  assert.equal(result.buckets.length, 4);

  // Thứ tự: nhóm theo thứ tự xuất hiện (Gemini rồi Claude/GPT); trong nhóm: 5 giờ trước, Tuần sau
  assert.deepEqual(
    result.buckets.map(b => ({
      groupName: b.groupName,
      groupLabel: b.groupLabel,
      windowKey: b.windowKey,
      windowLabel: b.windowLabel,
      percent: b.percent,
      resetAt: b.resetAt
    })),
    [
      {
        groupName: 'Gemini Models',
        groupLabel: 'Gemini',
        windowKey: '5h',
        windowLabel: '5 giờ',
        percent: 90, // 0.9020247459411621 -> 90
        resetAt: Date.parse('2026-11-02T19:48:29Z')
      },
      {
        groupName: 'Gemini Models',
        groupLabel: 'Gemini',
        windowKey: 'weekly',
        windowLabel: 'Tuần',
        percent: 60, // 0.6044580936431885 -> 60
        resetAt: Date.parse('2026-11-06T23:24:21Z')
      },
      {
        groupName: 'Claude and GPT models',
        groupLabel: 'Claude/GPT',
        windowKey: '5h',
        windowLabel: '5 giờ',
        percent: 83, // 0.8377018570899963 -> floor là 83 (dù bản TSV làm tròn thành 84%)
        resetAt: Date.parse('2026-11-02T22:16:04Z')
      },
      {
        groupName: 'Claude and GPT models',
        groupLabel: 'Claude/GPT',
        windowKey: 'weekly',
        windowLabel: 'Tuần',
        percent: 50, // 0.5030984878540039 -> 50
        resetAt: Date.parse('2026-11-09T10:05:03Z')
      }
    ]
  );

  // Kiểm thêm các giá trị thực tế sát ngưỡng làm tròn từ đầu ra thật của agy 1.4.12 trên Windows 11
  const boundaryPayload = makeEnvelope({
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { window: 'weekly', remaining_fraction: 0.5999577045440674, reset_time: '2026-11-06T23:24:21Z' },
              { window: '5h', remaining_fraction: 0.49986669421195984, reset_time: '2026-11-02T19:48:29Z' }
            ]
          }
        ]
      }
    }
  });
  const boundaryResult = parse(JSON.stringify(boundaryPayload));
  assert.deepEqual(boundaryResult.buckets.map(b => b.percent), [49, 59]);
});

test('JSON bị cắt ngang giữa chừng ở nhiều vị trí đều bị từ chối với lỗi exit', () => {
  for (const cutIndex of [1, 15, 120, 500, 1200, REAL_AGY_JSON_4_1.trim().length - 1]) {
    const truncated = REAL_AGY_JSON_4_1.slice(0, cutIndex);
    const result = parse(truncated);
    assert.ok(result.error, `Phải báo lỗi khi cắt tại byte ${cutIndex}`);
    assert.equal(result.error.type, 'exit');
  }
});

test('JSON hợp lệ nhưng bọc thêm dòng rác trước hoặc sau bị từ chối', () => {
  const cases = [
    'Đang kiểm tra bản cập nhật mới...\n' + REAL_AGY_JSON_4_1,
    REAL_AGY_JSON_4_1 + 'Hoàn tất lệnh.\n',
    'Cảnh báo cấu hình\n' + REAL_AGY_JSON_4_1 + 'Dòng thừa cuối\n'
  ];
  for (const raw of cases) {
    const result = parse(raw);
    assert.ok(result.error);
    assert.equal(result.error.type, 'exit');
  }
});

test('Đầu ra nhiều dòng JSON (stream-json) hoặc từng dòng sự kiện stream-json bị từ chối', () => {
  // Toàn bộ 2 dòng NDJSON
  const multiLine = parse(REAL_AGY_STREAM_JSON_4_2);
  assert.ok(multiLine.error);
  assert.equal(multiLine.error.type, 'exit');

  // Từng dòng riêng lẻ của stream-json cũng không thỏa cấu trúc JSON đơn của --output-format json
  const lines = REAL_AGY_STREAM_JSON_4_2.trim().split('\n');
  for (const line of lines) {
    const single = parse(line);
    assert.ok(single.error);
    assert.equal(single.error.type, 'unexpected');
  }
});

test('Trường status khác SUCCESS khi không có mốc hợp lệ trả về lỗi và làm sạch thông điệp', () => {
  const failed = makeEnvelope({
    status: 'ERROR',
    response: 'Failed to retrieve user quota summary: Bearer secret_token_value',
    command: { name: 'usage', data: { groups: [] } }
  });
  const result = parse(JSON.stringify(failed));
  assert.ok(result.error);
  assert.equal(result.error.type, 'unexpected');
  assert.doesNotMatch(result.error.message, /secret_token_value/);
  assert.match(result.error.message, /usage/);
});

test('JSON có status khác SUCCESS phải bị từ chối dù command.data.groups vẫn còn dữ liệu', () => {
  const parsedReal = JSON.parse(REAL_AGY_JSON_4_1);
  parsedReal.status = 'ERROR';
  const result = parse(JSON.stringify(parsedReal));
  assert.ok(result.error, 'Khi status khác SUCCESS thì không được coi là thành công');
});

test('Mảng groups rỗng và các biến thể remaining_fraction sai kiểu hoặc ngoài miền [0, 1] bị loại bỏ', () => {
  assert.equal(parse(JSON.stringify(makeEnvelope())).error.type, 'exit');

  const invalidFractions = ['0.5', '50%', null, undefined, true, false, -0.00001, -1, 1.00001, 100, {}, []];
  for (const bad of invalidFractions) {
    const payload = makeEnvelope({
      command: {
        name: 'usage',
        data: {
          groups: [{ name: 'Gemini Models', buckets: [{ window: '5h', remaining_fraction: bad }] }]
        }
      }
    });
    const res = parse(JSON.stringify(payload));
    assert.ok(res.error, `remaining_fraction = ${JSON.stringify(bad)} phải bị từ chối`);
  }

  // Kiểm trực tiếp NaN và Infinity qua luồng normalize/parseTsv hoặc đối tượng
  const rawWithNaN = '{"conversation_id":"","status":"SUCCESS","num_turns":0,"command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"window":"5h"}]}]}}}';
  assert.ok(parse(rawWithNaN).error);
});

test('Bucket thiếu cả window lẫn name hoặc dòng TSV thiếu tên cửa sổ phải bị loại bỏ', () => {
  const payload = makeEnvelope({
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [{ remaining_fraction: 0.5, reset_time: '2026-11-06T23:24:21Z' }]
          }
        ]
      }
    }
  });
  const jsonResult = parse(JSON.stringify(payload));
  assert.ok(jsonResult.error, 'Bucket không có cả window lẫn name không được tạo mốc rỗng nhãn');

  const tsvBuckets = parseTsv('Gemini Models\t\t60%\t2026-11-06T23:24:21Z');
  assert.equal(tsvBuckets.length, 0, 'Dòng TSV có cột cửa sổ rỗng phải bị bỏ qua');
});

test('Phần trăm nguyên 29%, 57%, 58% không bị tụt 1% do sai số dấu phẩy động IEEE 754 khi nhân/chia 100', () => {
  for (const exact of [29, 57, 58]) {
    const tsvRes = parseTsv(`Gemini Models\tFive Hour Limit Remaining\t${exact}%\t2026-11-06T23:24:21Z`);
    assert.equal(tsvRes[0].percent, exact, `TSV ${exact}% phải giữ đúng ${exact}% thay vì tụt xuống ${exact - 1}%`);

    const jsonRes = parse(
      JSON.stringify(
        makeEnvelope({
          command: {
            name: 'usage',
            data: {
              groups: [{ name: 'Gemini Models', buckets: [{ window: '5h', remaining_fraction: exact / 100 }] }]
            }
          }
        })
      )
    );
    assert.equal(jsonRes.buckets[0].percent, exact, `JSON fraction ${exact / 100} phải ra ${exact}%`);
  }
});

test('Tên nhóm cực dài (10000 ký tự), chứa ký tự null \\u0000, chứa chuỗi giống token và trùng nhóm giữ bản ghi cuối', () => {
  const longName = 'Nhóm_Dài_' + 'A'.repeat(10000) + '\u0000_Bearer secret_jwt_token_123';
  const payload = makeEnvelope({
    command: {
      name: 'usage',
      data: {
        groups: [
          { name: longName, buckets: [{ window: '5h', remaining_fraction: 0.8 }] },
          { name: longName, buckets: [{ window: '5h', remaining_fraction: 0.25 }, { window: 'weekly', remaining_fraction: 0.6 }] }
        ]
      }
    }
  });
  const res = parse(JSON.stringify(payload));
  assert.equal(res.error, undefined);
  assert.equal(res.buckets.length, 2);
  assert.equal(res.buckets[0].percent, 25); // Bản ghi trùng (nhóm, 5h) giữ bản ghi cuối (0.25)
  assert.equal(res.buckets[1].percent, 60);

  // Khi đưa qua display(), nhãn nhóm phải được cắt <= 120 ký tự và che token Bearer
  const view = display({ buckets: res.buckets, lastSuccessAt: BASE_NOW }, BASE_NOW);
  assert.ok(view.text.length <= 150);
  assert.doesNotMatch(view.text, /secret_jwt_token_123/);
  assert.doesNotMatch(view.tooltip, /secret_jwt_token_123/);
});

test('Khóa __proto__ và constructor trong JSON/TSV không gây ô nhiễm Object.prototype', () => {
  const protoPayload = '{"conversation_id":"","status":"SUCCESS","num_turns":0,"__proto__":{"polluted":true},"command":{"name":"usage","data":{"groups":[{"name":"__proto__","buckets":[{"window":"5h","remaining_fraction":0.5,"__proto__":{"pollutedBucket":true}}]},{"name":"constructor","buckets":[{"window":"weekly","remaining_fraction":0.4}]}]}}}';
  parse(protoPayload);
  parseTsv('__proto__\tFive Hour Limit Remaining\t50%\t2026-11-06T23:24:21Z\nconstructor\tWeekly Limit Remaining\t40%\t2026-11-06T23:24:21Z');

  assert.equal(({}).polluted, undefined);
  assert.equal(({}).pollutedBucket, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test('groupLabel với tên nhóm trùng thuộc tính Object.prototype (__proto__, constructor, toString) phải trả về chuỗi', () => {
  for (const specialName of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    const label = groupLabel(specialName);
    assert.equal(typeof label, 'string', `groupLabel("${specialName}") phải trả về string chứ không phải ${typeof label}`);
    assert.equal(label, specialName);
  }
});

test('TSV dự phòng với dòng 5 cột, dấu cách thay TAB và Unicode lạ', () => {
  // Dấu cách thay vì TAB phải bị từ chối hoàn toàn
  const spacesOnly = [
    'Gemini Models    Weekly Limit Remaining    60%    2026-11-06T23:24:21Z',
    'Claude and GPT models    Five Hour Limit Remaining    84%    2026-11-02T22:16:04Z'
  ].join('\n');
  assert.equal(parseTsv(spacesOnly).length, 0);
  assert.equal(parse(JSON.stringify(makeEnvelope({ command: { name: 'usage' }, response: spacesOnly }))).error.type, 'exit');

  // Dòng 5 cột bị lệch cột (cột 3 không phải phần trăm) phải bị bỏ qua
  const shiftedFiveCols = '1\tGemini Models\tWeekly Limit Remaining\t60%\t2026-11-06T23:24:21Z';
  assert.equal(parseTsv(shiftedFiveCols).length, 0);

  // Unicode tổ hợp, chữ tượng hình, chữ Ả Rập, khoảng trắng độ rộng 0 (ZWJ)
  const unicodeTsv = 'Mô\u0302 hi\u0300nh \u65e5\u672c\u8a9e\u200d\u0627\u0644\u0639\u0631\u0628\u064a\u0629 Models\tGiới hạn Đặc biệt Limit Remaining\t75%\t2026-11-06T23:24:21Z';
  const buckets = parseTsv(unicodeTsv);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].percent, 75);
  assert.equal(buckets[0].windowLabel, 'Giới hạn Đặc biệt');
  assert.doesNotMatch(buckets[0].groupLabel, /Models$/);
});

// ============================================================================
// 2. Chống nhầm lệnh bị gửi cho model (--disable-slash-commands)
// ============================================================================

test('Chống nhầm lệnh bị gửi cho model: từ chối mọi biến thể ở cả đường JSON và đường TSV dự phòng', () => {
  // 1. Văn xuôi tiếng Việt thật từ đầu ra thật của agy 1.4.12 trên Windows 11 và văn xuôi tiếng Anh
  assert.equal(parse(REAL_DISABLE_SLASH_STDOUT_5_1).error.type, 'exit');
  assert.equal(parseTsv(REAL_DISABLE_SLASH_STDOUT_5_1).length, 0);
  assert.equal(parse('The `/usage` slash command is disabled. How can I help you today?').error.type, 'exit');

  // 2. JSON có response là văn xuôi hoặc thậm chí có bảng TSV giả do model sinh ra, nhưng num_turns > 0
  const validTsv = 'Gemini Models\tFive Hour Limit Remaining\t90%\t2026-11-02T19:48:29Z\n';
  for (const badTurns of [1, 2, 10, -1, null, undefined, '0']) {
    const withGroups = JSON.parse(REAL_AGY_JSON_4_1);
    withGroups.num_turns = badTurns;
    assert.equal(parse(JSON.stringify(withGroups)).error?.type, 'unexpected', `Phải chặn num_turns=${badTurns} ở đường JSON`);

    const withTsv = { conversation_id: '', status: 'SUCCESS', num_turns: badTurns, command: { name: 'usage' }, response: validTsv };
    assert.equal(parse(JSON.stringify(withTsv)).error?.type, 'unexpected', `Phải chặn num_turns=${badTurns} ở đường TSV`);
  }

  // 3. JSON có conversation_id khác rỗng (dùng UUID giả để mô phỏng hội thoại mới)
  for (const convId of ['00000000-0000-4000-8000-000000000001', ' ', '0']) {
    const withGroups = JSON.parse(REAL_AGY_JSON_4_1);
    withGroups.conversation_id = convId;
    assert.equal(parse(JSON.stringify(withGroups)).error?.type, 'unexpected', `Phải chặn conversation_id="${convId}" ở đường JSON`);

    const withTsv = { conversation_id: convId, status: 'SUCCESS', num_turns: 0, command: { name: 'usage' }, response: validTsv };
    assert.equal(parse(JSON.stringify(withTsv)).error?.type, 'unexpected', `Phải chặn conversation_id="${convId}" ở đường TSV`);
  }

  // 4. JSON có command.name khác "usage" hoặc thiếu command
  for (const cmd of [undefined, null, {}, { name: '' }, { name: 'quota' }, { name: 'USAGE' }, { name: 'help' }]) {
    const withGroups = JSON.parse(REAL_AGY_JSON_4_1);
    withGroups.command = cmd ? { data: withGroups.command.data, ...cmd } : cmd;
    assert.equal(parse(JSON.stringify(withGroups)).error?.type, 'unexpected');

    const withTsv = { conversation_id: '', status: 'SUCCESS', num_turns: 0, command: cmd, response: validTsv };
    assert.equal(parse(JSON.stringify(withTsv)).error?.type, 'unexpected');
  }
});

// ============================================================================
// 3. Kiểm thử đối kháng cho thresholds.js và format.js
// ============================================================================

test('Ranh giới bằng đúng ngưỡng, ngưỡng đảo, ngưỡng không phải số và cấu hình NaN/chuỗi/âm', () => {
  const mkBucket = (percent, resetAt = BASE_NOW + 3600000) => ({
    groupName: 'Gemini Models',
    groupLabel: 'Gemini',
    windowKey: '5h',
    windowLabel: '5 giờ',
    fraction: percent / 100,
    percent,
    resetAt
  });

  // Ranh giới đúng bằng ngưỡng mặc định (warning = 30, critical = 10)
  assert.equal(level(mkBucket(10), BASE_NOW, {}), 'critical');
  assert.equal(level(mkBucket(11), BASE_NOW, {}), 'warning');
  assert.equal(level(mkBucket(30), BASE_NOW, {}), 'warning');
  assert.equal(level(mkBucket(31), BASE_NOW, {}), 'ok');

  // Ranh giới resetAt === now là unknown, resetAt === now + 1 vẫn tính theo ngưỡng
  assert.equal(level(mkBucket(5, BASE_NOW), BASE_NOW, {}), 'unknown');
  assert.equal(level(mkBucket(5, BASE_NOW + 1), BASE_NOW, {}), 'critical');

  // Ngưỡng đảo: criticalThreshold > warningThreshold -> criticalThreshold bị kẹp bằng warningThreshold
  const inverted = configuration({ warningThreshold: 15, criticalThreshold: 40 });
  assert.equal(inverted.warningThreshold, 15);
  assert.equal(inverted.criticalThreshold, 15);
  assert.equal(level(mkBucket(15), BASE_NOW, inverted), 'critical');
  assert.equal(level(mkBucket(16), BASE_NOW, inverted), 'ok');

  // Khi chỉ đặt warningThreshold = 5 (nhỏ hơn criticalThreshold mặc định 10), criticalThreshold cũng phải hạ xuống 5
  const lowWarn = configuration({ warningThreshold: 5 });
  assert.equal(lowWarn.criticalThreshold, 5);

  // Cấu hình NaN, chuỗi, Infinity, âm, vượt trần
  for (const invalid of [NaN, '20', 'abc', null, undefined, Infinity, -Infinity, {}, []]) {
    const cfg = configuration({
      refreshInterval: invalid,
      timeout: invalid,
      warningThreshold: invalid,
      criticalThreshold: invalid
    });
    assert.equal(cfg.refreshInterval, 300);
    assert.equal(cfg.timeout, 45);
    assert.equal(cfg.warningThreshold, 30);
    assert.equal(cfg.criticalThreshold, 10);
  }

  const negativeCfg = configuration({
    refreshInterval: -100,
    timeout: -5,
    warningThreshold: -10,
    criticalThreshold: -20
  });
  assert.equal(negativeCfg.refreshInterval, 60);
  assert.equal(negativeCfg.timeout, 5);
  assert.equal(negativeCfg.warningThreshold, 0);
  assert.equal(negativeCfg.criticalThreshold, 0);
});

test('configuration(null) không ném ngoại lệ khi nhận tham số null', () => {
  assert.doesNotThrow(() => configuration(null));
  assert.equal(configuration(null).refreshInterval, 300);
});

test('Đếm ngược countdown ở sát các ranh giới 59m59s, 1h, 23h59m, 1 ngày', () => {
  const cases = [
    [-1000, 'đã đến giờ reset'],
    [0, 'đã đến giờ reset'],
    [1, 'dưới 1 phút'],
    [59 * 1000 + 999, 'dưới 1 phút'],
    [60 * 1000, '1 phút'],
    [(59 * 60 + 59) * 1000, '59 phút'],
    [(59 * 60 + 59) * 1000 + 999, '59 phút'],
    [60 * 60 * 1000, '1 giờ 0 phút'],
    [(60 * 60 + 59) * 1000 + 999, '1 giờ 0 phút'],
    [(23 * 60 + 59) * 60 * 1000, '23 giờ 59 phút'],
    [(23 * 60 + 59) * 60 * 1000 + 59999, '23 giờ 59 phút'],
    [24 * 60 * 60 * 1000, '1 ngày 0 giờ'],
    [(24 * 60 + 59) * 60 * 1000 + 59999, '1 ngày 0 giờ']
  ];
  for (const [deltaMs, expected] of cases) {
    assert.equal(countdown(BASE_NOW + deltaMs, BASE_NOW), expected, `Sai tại deltaMs = ${deltaMs}`);
  }
});

test('Giờ reset qua nửa đêm, qua tháng/năm (31/12 sang 01/01) và ngày nhuận 29/02', () => {
  // Qua nửa đêm theo múi giờ +07:00: 2026-11-02 19:48 UTC -> 02:48 sáng Thứ Ba 03/11
  assert.equal(resetTime(Date.parse('2026-11-02T19:48:29Z')), '02:48 T3 03/11');

  // Qua tháng và qua năm mới: 2026-12-31 18:30 UTC -> 2027-01-01 01:30 sáng Thứ Sáu (T6) 01/01
  assert.equal(resetTime(Date.parse('2026-12-31T18:30:00Z')), '01:30 T6 01/01');

  // Năm nhuận 2028: 2028-02-28 20:00 UTC -> 2028-02-29 03:00 sáng Thứ Ba (T3) 29/02
  assert.equal(resetTime(Date.parse('2028-02-28T20:00:00Z')), '03:00 T3 29/02');

  // Kiểm parseReset qua parseTsv với ngày 29/02 năm nhuận (2028, 2000) và năm không nhuận (2026, 2100)
  assert.equal(
    parseTsv('Gemini Models\tWeekly Limit Remaining\t50%\t2028-02-29T12:00:00Z')[0].resetAt,
    Date.parse('2028-02-29T12:00:00Z')
  );
  assert.equal(
    parseTsv('Gemini Models\tWeekly Limit Remaining\t50%\t2000-02-29T12:00:00Z')[0].resetAt,
    Date.parse('2000-02-29T12:00:00Z')
  );
  assert.equal(parseTsv('Gemini Models\tWeekly Limit Remaining\t50%\t2026-02-29T12:00:00Z')[0].resetAt, null);
  assert.equal(parseTsv('Gemini Models\tWeekly Limit Remaining\t50%\t2100-02-29T12:00:00Z')[0].resetAt, null);
});

test('Tooltip thoát ký tự Markdown và HTML nguy hiểm (|, backtick, liên kết javascript:, thẻ img onerror, xuống dòng)', () => {
  const maliciousNames = [
    'Nhóm | Phá cột | 100%',
    'Nhóm `rm -rf /` ```খối```',
    'Nhóm [x](javascript:alert(1))',
    'Nhóm <img src=x onerror=alert(1)>',
    'Nhóm dòng 1\r\n| Giả cột | 0% |'
  ];

  const buckets = maliciousNames.map((name, idx) => ({
    groupName: name,
    groupLabel: name,
    windowKey: '5h',
    windowLabel: 'Cửa sổ | <script> `x`\nDòng 2',
    fraction: 0.5,
    percent: 50,
    resetAt: BASE_NOW + (idx + 1) * 3600000
  }));

  const view = display({ buckets, lastSuccessAt: BASE_NOW }, BASE_NOW, {});

  // Không được còn thẻ <img hay <script chưa thoát dấu <
  assert.doesNotMatch(view.tooltip, /(?<!\\)<img\b/i);
  assert.doesNotMatch(view.tooltip, /(?<!\\)<script\b/i);
  assert.match(view.tooltip, /\\<img src=x onerror=alert\(1\)\\>/);
  // Không được còn cú pháp liên kết Markdown [x](javascript:...) chưa thoát dấu ngoặc vuông
  assert.doesNotMatch(view.tooltip, /(?<!\\)\[x(?<!\\)\]\(javascript:/i);
  assert.match(view.tooltip, /\\\[x\\\]\(javascript:alert\(1\)\)/);
  // Mọi dòng dữ liệu và tiêu đề của bảng trong tooltip phải có đúng 6 dấu | không thoát (tức 5 cột bảng Markdown)
  const tableLines = view.tooltip.split('\n').filter(line => line.startsWith('| '));
  assert.equal(tableLines.length, maliciousNames.length + 1); // dòng tiêu đề + N dòng dữ liệu
  for (const line of tableLines) {
    const unescapedPipes = line.replace(/\\\|/g, '').split('|').length - 1;
    assert.equal(unescapedPipes, 6, `Dòng bảng bị vỡ cột: ${line}`);
  }
});

test('Tooltip và thanh trạng thái loại bỏ ký tự đảo chiều văn bản Bidi \\u202e', () => {
  const rtlBucket = {
    groupName: 'Nhóm \u202e001% (an toàn)',
    groupLabel: 'Nhóm \u202e001% (an toàn)',
    windowKey: '5h',
    windowLabel: '5 giờ \u202e',
    fraction: 0.05,
    percent: 5,
    resetAt: BASE_NOW + 3600000
  };
  const view = display({ buckets: [rtlBucket], lastSuccessAt: BASE_NOW }, BASE_NOW, {});
  assert.equal(view.tooltip.includes('\u202e'), false, 'Tooltip không được chứa ký tự điều khiển Bidi \\u202e chưa lọc');
  assert.equal(view.text.includes('\u202e'), false, 'Thanh trạng thái không được chứa ký tự điều khiển Bidi \\u202e');
});

test('Thanh trạng thái không để mốc đã qua giờ reset (unknown) che khuất mốc cảnh báo hoặc nghiêm trọng còn hiệu lực', () => {
  const buckets = [
    {
      groupName: 'Gemini Models',
      groupLabel: 'Gemini',
      windowKey: '5h',
      windowLabel: '5 giờ',
      fraction: 0.05,
      percent: 5,
      resetAt: BASE_NOW - 1000 // Đã qua giờ reset -> mức unknown (?%)
    },
    {
      groupName: 'Gemini Models',
      groupLabel: 'Gemini',
      windowKey: 'weekly',
      windowLabel: 'Tuần',
      fraction: 0.2,
      percent: 20,
      resetAt: BASE_NOW + 86400000 // Còn hiệu lực -> mức warning (20%)
    }
  ];
  const view = display({ buckets, lastSuccessAt: BASE_NOW - 5000 }, BASE_NOW, {});
  assert.equal(view.severity, 'warning', 'Mốc 5h đã hết hạn (unknown) không được làm mất mức cảnh báo của mốc Tuần đang còn hiệu lực');
});

test('Hàm sanitize che đúng email, JWT giả 3 đoạn, ya29., Bearer, AIza 39 ký tự, hex 40 ký tự, ranh giới 23 vs 24 ký tự và cắt đúng độ dài', () => {
  const jwt3Parts = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const googleOAuth = 'ya29.a0AfH6SMBx9_test_token_value_1234567890';
  const bearerToken = 'Bearer secret_abc_123';
  const apiKeyAIza = 'AIza' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r'; // 4 + 35 = 39 ký tự
  const hex40 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4'; // 40 ký tự hex
  const urlLongToken = 'https://example.com/callback?token=abcdef0123456789ABCDEF0123456789';

  assert.equal(apiKeyAIza.length, 39);
  assert.equal(hex40.length, 40);

  for (const [label, secretLine, leakedPart] of [
    ['email', 'Lỗi tài khoản: user.name+quota@sub.domain.vn không hợp lệ', 'user.name+quota@sub.domain.vn'],
    ['JWT 3 đoạn', `Token ${jwt3Parts} hết hạn`, 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'],
    ['ya29.', `OAuth ${googleOAuth} lỗi`, 'a0AfH6SMBx9_test_token_value_1234567890'],
    ['Bearer', `Header Authorization: ${bearerToken}`, 'secret_abc_123'],
    ['AIza 39 ký tự', `Khóa API ${apiKeyAIza} bị từ chối`, apiKeyAIza],
    ['hex 40 ký tự', `Commit/secret ${hex40} không hợp lệ`, hex40],
    ['URL có ?token= dài', `Truy cập ${urlLongToken} thất bại`, 'abcdef0123456789ABCDEF0123456789']
  ]) {
    const cleaned = sanitize(secretLine, 200);
    assert.match(cleaned, /\[đã che\]/, `Phải che mẫu ${label}`);
    assert.equal(cleaned.includes(leakedPart), false, `Không được để lộ phần nhạy cảm của ${label}`);
  }

  // Ranh giới 23 ký tự (không che) vs 24 ký tự (che)
  const token23 = 'Ab1_-./+=' + 'x'.repeat(14); // 9 + 14 = 23 ký tự
  const token24 = token23 + 'y'; // 24 ký tự
  assert.equal(token23.length, 23);
  assert.equal(token24.length, 24);
  assert.equal(sanitize(`Mã: ${token23}`), `Mã: ${token23}`);
  assert.equal(sanitize(`Mã: ${token24}`), 'Mã: [đã che]');

  // Độ dài cắt đúng ở ranh giới maxLen (120 và 200)
  for (const maxLen of [120, 200]) {
    const exactStr = 'a '.repeat(maxLen / 2).trimEnd().padEnd(maxLen, 'b');
    assert.equal(exactStr.length, maxLen);
    assert.equal(sanitize(exactStr, maxLen), exactStr);

    const overByOne = exactStr + 'c';
    const truncated = sanitize(overByOne, maxLen);
    assert.equal(truncated.length, maxLen);
    assert.equal(truncated, exactStr.slice(0, maxLen - 3) + '...');
  }
});

test('Hàm sanitize phải che giá trị nhạy cảm trong tham số URL ?token= ngay cả khi token ngắn hơn 18 ký tự', () => {
  const urlWithShortToken = 'Lỗi kết nối https://api.example.com/v1/quota?token=mySecret123';
  const cleaned = sanitize(urlWithShortToken, 200);
  assert.equal(cleaned.includes('mySecret123'), false, `Không được để lộ token trong URL: ${cleaned}`);
});

test('Hàm sanitize không bị suy giảm hiệu năng bậc hai O(N^2) (ReDoS) trên dòng dài không có ký tự @', () => {
  // Chuỗi 25.000 ký tự chữ liền nhau không có @ khiến biểu thức /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g quay lui bậc hai
  const longWordLine = 'Loi_dau_ra_' + 'A'.repeat(25000);
  const start = performance.now();
  const result = sanitize(longWordLine, 120);
  const elapsedMs = performance.now() - start;
  assert.equal(result.length <= 120, true);
  assert.equal(elapsedMs < 50, true, `sanitize mất ${elapsedMs.toFixed(1)} ms (> 50 ms) do ReDoS quay lui bậc hai`);
});

// ============================================================================
// 4. Kiểm thử đối kháng cho runner.js
// ============================================================================

function createTestHarness(overrides = {}) {
  const calls = [];
  const logs = [];
  const scheduledTimers = [];
  const clearedTimers = [];
  let execCallback = null;
  let nextTimerId = 1;

  const child = {
    pid: 4567,
    stdin: Object.assign(new EventEmitter(), {
      ended: false,
      end() {
        this.ended = true;
      }
    }),
    killed: false,
    kill() {
      this.killed = true;
    }
  };

  const execFile = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    if (file === 'taskkill.exe' || file === 'kill') {
      cb(null, '', '');
      return child;
    }
    execCallback = cb;
    return child;
  };

  const runner = createRunner({
    execFile,
    exists: () => true,
    homedir: () => 'C:\\Users\\TestUser',
    platform: 'win32',
    env: { PATH: 'C:\\agy\\bin' },
    now: () => 1000,
    setTimer: (fn, delay) => {
      const id = nextTimerId++;
      scheduledTimers.push({ id, fn, delay });
      return id;
    },
    clearTimer: id => {
      clearedTimers.push(id);
    },
    log: msg => logs.push(msg),
    ...overrides
  });

  return {
    runner,
    calls,
    logs,
    scheduledTimers,
    clearedTimers,
    child,
    invokeCallback: (...args) => execCallback(...args)
  };
}

test('Runner đặt timeout đúng lúc và kết thúc Promise đúng một lần dù callback gọi lặp nhiều lần', async () => {
  const h = createTestHarness();
  const promise = h.runner.run({ timeout: 37 });

  assert.equal(h.scheduledTimers.length, 1);
  assert.equal(h.scheduledTimers[0].delay, 37000);

  // Gọi callback lần 1 (thành công), sau đó gọi tiếp lần 2 (lỗi) và lần 3 (thành công), rồi kích hoạt cả timer timeout
  h.invokeCallback(null, REAL_AGY_JSON_4_1, '');
  h.invokeCallback({ code: 'ENOENT' }, '', 'Lỗi muộn');
  h.invokeCallback(null, REAL_AGY_JSON_4_1, '');
  h.scheduledTimers[0].fn();

  const res = await promise;
  assert.equal(res.error, undefined);
  assert.equal(res.buckets.length, 4);
  assert.equal(h.logs.length, 1, 'Chỉ được ghi nhật ký đúng một lần cho một lượt chạy');
  assert.ok(h.clearedTimers.includes(h.scheduledTimers[0].id));
});

test('Runner khi timeout đúng lúc sẽ giết cây tiến trình và bỏ qua mọi callback đến muộn sau đó', async () => {
  const h = createTestHarness();
  const promise = h.runner.run({ timeout: 15 });

  assert.equal(h.scheduledTimers[0].delay, 15000);
  // Kích hoạt timeout
  h.scheduledTimers[0].fn();
  // Callback của agy gọi muộn sau khi đã bắt đầu dừng
  h.invokeCallback(null, REAL_AGY_JSON_4_1, '');

  const res = await promise;
  assert.equal(res.error.type, 'timeout');
  assert.match(res.error.message, /15 giây/);
  assert.equal(h.calls[1].file, 'taskkill.exe');
  assert.deepEqual(h.calls[1].args, ['/PID', '4567', '/T', '/F']);
  assert.equal(h.logs.length, 1);
});

test('Runner khi callback gọi lỗi ENOENT rồi gọi tiếp vẫn chỉ kết thúc một lần và xóa bộ nhớ đệm đường dẫn', async () => {
  let fileStillExists = false;
  const h = createTestHarness({ exists: p => (p.includes('agy') ? fileStillExists : true) });

  fileStillExists = true;
  const promise = h.runner.run({});
  // Lúc callback ENOENT nổ ra, tệp đã bị xóa
  fileStillExists = false;
  h.invokeCallback({ code: 'ENOENT' }, '', '');
  // Callback bất thường gọi tiếp lần thứ hai với dữ liệu thành công
  h.invokeCallback(null, REAL_AGY_JSON_4_1, '');

  const res = await promise;
  assert.equal(res.error.type, 'not-found');
  assert.equal(h.logs.length, 1);
});

test('Runner xử lý stdout vượt maxBuffer trả về lỗi spawn đã làm sạch', async () => {
  const h = createTestHarness();
  const promise = h.runner.run({});
  const hugeStdout = 'Lỗi tràn bộ đệm với Bearer secret_overflow_token_999 ' + 'X '.repeat(140000);
  h.invokeCallback(
    { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', message: 'stdout maxBuffer length exceeded' },
    hugeStdout,
    ''
  );

  const res = await promise;
  assert.equal(res.error.type, 'spawn');
  assert.ok(res.error.message.length <= 200);
  assert.equal(res.error.message.includes('secret_overflow_token_999'), false);
  assert.match(res.error.message, /\[đã che\]/);
});

test('resolveAgy xử lý PATH có mục rỗng, dấu ngoặc kép, khoảng trắng đầu/cuối và tên biến Path/tệp AGY.EXE trên Windows', () => {
  // Mục rỗng, khoảng trắng ngoài dấu ngoặc kép, biến môi trường viết hoa thường Path
  const resolvedFromPath = resolveAgy({
    platform: 'win32',
    env: {
      Path: ' ; "" ;  "C:\\Program Files\\Antigravity\\bin"  ; C:\\Other\\bin ; '
    },
    exists: candidate => candidate === 'C:\\Program Files\\Antigravity\\bin\\agy.exe'
  });
  assert.equal(resolvedFromPath.path, 'C:\\Program Files\\Antigravity\\bin\\agy.exe');

  // Đường dẫn cấu hình có phần mở rộng viết hoa AGY.EXE trên Windows
  const resolvedUpperExe = resolveAgy({
    platform: 'win32',
    configPath: 'C:\\Tools\\AGY.EXE',
    env: {},
    exists: candidate => candidate.toUpperCase() === 'C:\\TOOLS\\AGY.EXE'
  });
  assert.equal(resolvedUpperExe.path, 'C:\\Tools\\AGY.EXE');
});

test('resolveAgy trên Windows phải từ chối configPath là thư mục (không có đuôi .exe)', () => {
  const dirResult = resolveAgy({
    platform: 'win32',
    configPath: 'C:\\Users\\user\\AppData\\Local\\agy\\bin',
    env: {},
    exists: () => true
  });
  assert.ok(dirResult.error, 'configPath trỏ tới thư mục trên Windows không được chấp nhận làm tệp thực thi .exe');
});

// ============================================================================
// 5. Kiểm thử đối kháng cho state.js
// ============================================================================

function createAsyncMemoryFs(getNow = () => 1000) {
  const files = new Map();
  const locks = new Map();
  let failWrite = false;
  let failRename = false;

  return {
    files,
    locks,
    setFailWrite(v) {
      failWrite = v;
    },
    setFailRename(v) {
      failRename = v;
    },
    async mkdir() {},
    async readFile(p) {
      if (!files.has(p)) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return files.get(p);
    },
    async writeFile(p, data) {
      if (failWrite) {
        // Mô phỏng lỗi đĩa đầy sau khi tạo tệp tạm nửa vời
        files.set(p, data.slice(0, 10));
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      }
      files.set(p, data);
    },
    async rename(from, to) {
      if (failRename) {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      if (locks.has(from)) {
        locks.set(to, locks.get(from));
        locks.delete(from);
      } else {
        files.set(to, files.get(from));
        files.delete(from);
      }
    },
    async unlink(p) {
      if (!files.has(p) && !locks.has(p)) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      files.delete(p);
      locks.delete(p);
    },
    async open(p, flags) {
      if (flags === 'wx') {
        if (locks.has(p)) {
          throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        }
        locks.set(p, { mtimeMs: getNow() });
      }
      return {
        async close() {}
      };
    },
    async stat(p) {
      if (!locks.has(p)) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return locks.get(p);
    }
  };
}

test('Tệp trạng thái hỏng (rỗng, JSON cụt, kiểu sai, mức catastrophic, số lỗi âm/NaN, runningSince tương lai xa) khôi phục an toàn', async () => {
  const memFs = createAsyncMemoryFs();
  const dir = '/kho-kiem-thu';
  const stateFile = path.join(dir, 'state-agy.json');
  let currentTime = BASE_NOW;
  const store = createStore({ directory: dir, fs: memFs, now: () => currentTime, id: 'test' });

  const corruptedPayloads = [
    '',
    '   ',
    '{"buckets":[{"groupName":"Gemini',
    'null',
    '[]',
    '"chuỗi"',
    '12345',
    JSON.stringify({ ...emptyState(), buckets: 'không phải mảng' }),
    JSON.stringify({ ...emptyState(), levels: { 'agy|Gemini Models|5h': 'catastrophic' } }),
    JSON.stringify({ ...emptyState(), levels: ['ok'] }),
    JSON.stringify({ ...emptyState(), consecutiveErrors: -1 }),
    '{"buckets":[],"consecutiveErrors":NaN}',
    JSON.stringify({ ...emptyState(), error: { type: 'catastrophic', message: 'Lỗi lạ' } }),
    JSON.stringify({
      ...emptyState(),
      buckets: [{ groupName: 'G', groupLabel: 'G', windowKey: '5h', windowLabel: '5 giờ', percent: 105, resetAt: null }]
    }),
    JSON.stringify({
      ...emptyState(),
      buckets: [{ groupName: 'G', groupLabel: 'G', windowKey: '5h', windowLabel: '5 giờ', percent: -5, resetAt: null }]
    })
  ];

  for (const raw of corruptedPayloads) {
    memFs.files.set(stateFile, raw);
    const state = await store.read();
    assert.deepEqual(state, emptyState(), `Phải khôi phục emptyState cho dữ liệu hỏng: ${raw}`);
  }

  // Kiểm tra trực tiếp validState với consecutiveErrors là NaN hoặc Infinity
  assert.equal(validState({ ...emptyState(), consecutiveErrors: NaN }), false);
  assert.equal(validState({ ...emptyState(), consecutiveErrors: Infinity }), false);
  assert.equal(validState({ ...emptyState(), consecutiveErrors: -0.1 }), false);
  assert.equal(validState({ ...emptyState(), levels: { 'G|5h': 'catastrophic' } }), false);

  // runningSince ở tương lai xa không được làm treo vĩnh viễn việc làm mới
  const futureState = { ...emptyState(), runningSince: BASE_NOW + 365 * 86400000, lastAttemptAt: BASE_NOW + 365 * 86400000 };
  memFs.files.set(stateFile, JSON.stringify(futureState));
  assert.equal(isRefreshDue(await store.read(), BASE_NOW, {}), true);
  const claimed = await store.claim({});
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.state.runningSince, BASE_NOW);
});

test('Tệp trạng thái có levels: null hoặc consecutiveErrors: null không được làm sập complete() và read()', async () => {
  const memFs = createAsyncMemoryFs();
  const dir = '/kho-null-fields';
  const stateFile = path.join(dir, 'state-agy.json');
  memFs.files.set(
    stateFile,
    JSON.stringify({
      buckets: [],
      lastAttemptAt: null,
      lastSuccessAt: null,
      runningSince: null,
      consecutiveErrors: null,
      levels: null,
      notifiedAt: null
    })
  );

  const store = createStore({ directory: dir, fs: memFs, now: () => BASE_NOW, id: 'null-test' });
  const sampleBucket = {
    groupName: 'Gemini Models',
    groupLabel: 'Gemini',
    windowKey: '5h',
    windowLabel: '5 giờ',
    fraction: 0.1,
    percent: 10,
    resetAt: BASE_NOW + 3600000
  };

  await assert.doesNotReject(
    () => store.complete({ buckets: [sampleBucket] }, {}),
    'store.complete không được ném TypeError khi tệp trạng thái có levels: null'
  );
  await assert.doesNotReject(
    () => store.read(),
    'store.read không được ném TypeError khi tệp trạng thái có levels: null'
  );
});

test('Hai bên claim đồng thời lặp 200 lần chỉ đúng một bên thắng mỗi lượt (cả hệ tệp giả và thư mục tạm thật)', async () => {
  // 1. Lặp 200 lần trên hệ tệp giả trong bộ nhớ
  let simTime = 1000000;
  const memFs = createAsyncMemoryFs(() => simTime);
  const storeA = createStore({ directory: '/kho-dua', fs: memFs, now: () => simTime, id: 'cua-so-A' });
  const storeB = createStore({ directory: '/kho-dua', fs: memFs, now: () => simTime, id: 'cua-so-B' });

  for (let i = 0; i < 200; i++) {
    simTime += 400000; // Tiến thời gian vượt quá refreshInterval và timeout để lượt mới luôn đến hạn
    const [resA, resB] = await Promise.all([storeA.claim({}), storeB.claim({})]);
    const winners = [resA, resB].filter(r => r.claimed === true);
    assert.equal(winners.length, 1, `Lượt ${i} (memoryFs): phải có đúng 1 bên thắng claim, thực tế = ${winners.length}`);
  }

  // 2. Lặp 200 lần trên hệ tệp thật trong thư mục tạm của hệ điều hành
  const realDir = path.join(TMP_ROOT, 'claim-race-' + process.pid);
  fs.rmSync(realDir, { recursive: true, force: true });
  try {
    const stateFile = path.join(realDir, 'state-agy.json');
    const realA = createStore({ directory: realDir, fs: fs.promises, now: Date.now, id: 'real-A' });
    const realB = createStore({ directory: realDir, fs: fs.promises, now: Date.now, id: 'real-B' });

    for (let i = 0; i < 200; i++) {
      // Đặt lại trạng thái đến hạn làm mới trước mỗi lượt đua đồng thời
      fs.rmSync(stateFile, { force: true });
      const [resA, resB] = await Promise.all([realA.claim({}), realB.claim({})]);
      const winners = [resA, resB].filter(r => r.claimed === true);
      assert.equal(winners.length, 1, `Lượt ${i} (fs thật): phải có đúng 1 bên thắng claim, thực tế = ${winners.length}`);
    }
  } finally {
    fs.rmSync(realDir, { recursive: true, force: true });
  }
});

test('Khóa cũ state-agy.lock chỉ bị thu hồi khi vượt đúng ngưỡng 30000 ms', async () => {
  const memFs = createAsyncMemoryFs();
  const dir = '/kho-lock';
  const lockPath = path.join(dir, 'state-agy.lock');
  memFs.locks.set(lockPath, { mtimeMs: 1000 });

  let currentNow = 1000 + 30000; // Đúng bằng ngưỡng 30000 ms (chưa vượt quá)
  const store = createStore({ directory: dir, fs: memFs, now: () => currentNow, id: 'lock-test', setTimer: callback => callback() });

  const atBoundary = await store.claim({});
  assert.equal(atBoundary.busy, true);
  assert.equal(memFs.locks.has(lockPath), true, 'Ở đúng 30000 ms khóa chưa bị xóa');

  // Tăng thêm 1 ms -> 30001 ms (> 30000 ms): khóa cũ bị thu hồi và lần gọi kế tiếp lấy được khóa
  currentNow = 1000 + 30001;
  const pastBoundary = await store.claim({});
  assert.equal(pastBoundary.claimed, true);
  assert.equal(memFs.locks.has(lockPath), false, 'Ở 30001 ms khóa cũ phải bị thu hồi');

  const nextClaim = await store.claim({});
  assert.equal(nextClaim.claimed, false);
});

test('Ghi trạng thái không bao giờ để lại tệp nửa vời hoặc tệp tạm khi lỗi giữa chừng (cả hệ tệp giả và thư mục tạm thật)', async () => {
  const memFs = createAsyncMemoryFs();
  const dir = '/kho-nguyen-tu';
  let currentNow = 1000;
  const store = createStore({ directory: dir, fs: memFs, now: () => currentNow, id: 'atomic' });

  const sampleBucket = {
    groupName: 'Gemini Models',
    groupLabel: 'Gemini',
    windowKey: '5h',
    windowLabel: '5 giờ',
    fraction: 0.75,
    percent: 75,
    resetAt: 500000
  };

  // Ghi thành công trạng thái ban đầu
  await store.claim({});
  await store.complete({ buckets: [sampleBucket] }, {});
  const validSnapshot = memFs.files.get(path.join(dir, 'state-agy.json'));
  assert.ok(validSnapshot);

  // Mô phỏng lỗi ghi nửa vời (ENOSPC trong writeFile)
  currentNow = 500000;
  memFs.setFailWrite(true);
  await assert.rejects(() => store.claim({}, true), /ENOSPC/);
  memFs.setFailWrite(false);

  // Không còn tệp .tmp hay .lock sót lại, và state-agy.json vẫn nguyên vẹn
  assert.equal([...memFs.files.keys()].some(k => k.endsWith('.tmp')), false);
  assert.equal(memFs.locks.size, 0);
  assert.equal(memFs.files.get(path.join(dir, 'state-agy.json')), validSnapshot);
  assert.equal((await store.read()).buckets[0].percent, 75);

  // Mô phỏng lỗi khi đổi tên (EPERM trong rename)
  memFs.setFailRename(true);
  await assert.rejects(() => store.claim({}, true), /EPERM/);
  memFs.setFailRename(false);

  assert.equal([...memFs.files.keys()].some(k => k.endsWith('.tmp')), false);
  assert.equal(memFs.locks.size, 0);
  assert.equal(memFs.files.get(path.join(dir, 'state-agy.json')), validSnapshot);

  // Kiểm trên thư mục tạm thật trong thư mục tạm của hệ điều hành
  const realDir = path.join(TMP_ROOT, 'atomic-real-' + process.pid);
  fs.rmSync(realDir, { recursive: true, force: true });
  try {
    const realStore = createStore({ directory: realDir, fs: fs.promises, now: () => currentNow, id: 'real-atomic' });
    await realStore.claim({}, true);
    await realStore.complete({ buckets: [sampleBucket] }, {});
    const entries = fs.readdirSync(realDir);
    assert.deepEqual(entries, ['state-agy.json']);
    const onDisk = JSON.parse(fs.readFileSync(path.join(realDir, 'state-agy.json'), 'utf8'));
    assert.equal(onDisk.buckets[0].percent, 75);
  } finally {
    fs.rmSync(realDir, { recursive: true, force: true });
  }
});
