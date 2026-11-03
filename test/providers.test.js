'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claude = require('../src/providers/claude');
const codex = require('../src/providers/codex');
const {MAX_BYTES, retryAfter} = require('../src/providers/http');
const {setLocale} = require('../src/i18n');
const {createStore, emptyState, localResult, validState} = require('../src/state');
const {transitions, isRefreshDue, intervalMs} = require('../src/thresholds');
const {display, notification, sanitize} = require('../src/format');
setLocale('vi');
const now = Date.parse('2026-11-03T00:00:00Z');
const reset = '2099-01-01T00:00:00Z';
const fakeTokens = ['sk-ant-oat01-FAKE-CHI-DUNG-KIEM-THU', 'eyJhbGciOiJub25lIn0.eyJmYWtlIjp0cnVlfQ.FAKE'];
const payload = id => id === 'claude' ? {five_hour: {utilization: 27.2, resets_at: reset},
  seven_day: {utilization: 15, resets_at: reset}} : {rate_limit: {
  primary_window: {used_percent: 14.3, limit_window_seconds: 18000, reset_at: now / 1000 + 300},
  secondary_window: {used_percent: 5, limit_window_seconds: 604800, reset_after_seconds: 600}}};
function fixture(definition, options = {}) {
  const id = definition.id;
  const reads = [], calls = [], timers = [], curl = [];
  const token = options.token || fakeTokens[id === 'claude' ? 0 : 1];
  const auth = options.auth ?? (id === 'claude' ? {claudeAiOauth: {accessToken: token}} :
    {tokens: {access_token: token, account_id: 'tai-khoan-gia'}});
  const deps = {
    now: () => now, env: options.env || {}, homedir: () => '/nguoi-dung', platform: options.platform || 'win32',
    fs: {async readFile(file) {
      reads.push(file);
      if (options.readError) throw options.readError;
      return options.text ?? JSON.stringify(auth);
    }},
    setTimer(cb, ms) { timers.push({cb, ms}); return timers.length; }, clearTimer() {},
    async fetch(url, init) {
      calls.push({url, init});
      if (options.fetch) return options.fetch(url, init);
      return new Response(options.body ?? JSON.stringify(payload(id)), {status: options.status || 200, headers: options.headers});
    },
    execFile(file, argv, settings, callback) {
      const call = {file, argv, settings}; curl.push(call);
      const child = {stdin: {on() {}, end(config) {call.config = config;}}, kill() {call.killed = true;}};
      queueMicrotask(() => callback(options.curlError || null,
        options.curlOutput ?? 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n' +
        JSON.stringify(payload(id)) + '\n__AI_QUOTA_STATUS__200'));
      return child;
    }
  };
  return {provider: definition.createProvider(deps), reads, calls, timers, curl, token};
}
test('Claude phân tích đủ cửa sổ, bỏ null và chuyển phần trăm đã dùng thành còn lại', () => {
  const result = claude.parseUsage({...payload('claude'), seven_day_opus: {utilization: 0}, seven_day_sonnet: null});
  assert.deepEqual(result.map(b => [b.provider, b.windowKey, b.percent]),
    [['claude', '5h', 72], ['claude', 'weekly', 85], ['claude', 'other:Opus', 100]]);
  assert.equal(result[0].resetAt, Date.parse(reset));
  assert.equal(result[2].resetAt, null);
  assert.equal(result[0].fraction, 0.728);
  assert.deepEqual(claude.parseUsage({seven_day: {utilization: 99.9}}).map(b => b.percent), [0]);
  assert.equal(claude.parseUsage({seven_day_sonnet: {utilization: 10}})[0].windowKey, 'other:Sonnet');
});
test('Claude loại cửa sổ thiếu, null, sai kiểu và giá trị âm', () => {
  for (const value of [undefined, null, -1, '25', NaN, Infinity]) {
    assert.deepEqual(claude.parseUsage({five_hour: {utilization: value}}), []);
  }
  assert.deepEqual(claude.parseUsage(null), []);
  assert.equal(claude.parseUsage({five_hour: {utilization: 100, resets_at: 'sai'}})[0].percent, 0);
});
test('Claude chỉ có limits ánh xạ phiên và tuần, giữ cả mức dùng 0 và 100', () => {
  const result = claude.parseUsage({limits: [
    {kind: 'session', group: 'weekly', percent: 0, resets_at: reset, is_active: false},
    {kind: 'weekly_all', group: 'session', percent: 100, resets_at: 'sai', is_active: true}
  ]});
  assert.deepEqual(result.map(b => [b.provider, b.windowKey, b.windowLabel, b.percent, b.fraction, b.resetAt]),
    [['claude', '5h', '5 giờ', 100, 1, Date.parse(reset)], ['claude', 'weekly', 'Tuần', 0, 0, null]]);
});

test('Claude ưu tiên limits khi có cả hai dạng, không trộn kể cả khi thiếu cửa sổ cũ', () => {
  for (const used of [27.2, 80]) {
    const result = claude.parseUsage({...payload('claude'), seven_day_opus: {utilization: 90}, limits: [
      {kind: 'session', percent: used}, {kind: 'weekly_all', percent: 45}
    ]});
    assert.deepEqual(result.map(b => [b.windowKey, b.percent]), [['5h', Math.floor(100 - used)], ['weekly', 55]]);
  }
  const result = claude.parseUsage({...payload('claude'), limits: [
    {kind: 'weekly_scoped', percent: 95, scope: {model: {display_name: 'Mô hình mới'}}}
  ]});
  assert.deepEqual(result.map(b => [b.windowKey, b.percent]), [['other:Mô hình mới', 5]]);
});

test('Claude scoped lấy tên model trước surface và có nhãn dự phòng khi thiếu scope', () => {
  const result = claude.parseUsage({limits: [
    {kind: 'weekly_scoped', group: 'session', percent: 16, scope: {model: {display_name: 'Mô hình mới'}, surface: 'Bề mặt phụ'}},
    {kind: 'weekly_scoped', percent: 25, scope: {surface: 'Bề mặt riêng'}},
    {kind: 'weekly_scoped', percent: 50, scope: null},
    {kind: 'weekly_scoped', percent: 60, scope: {model: {display_name: 123}, surface: 'Bề mặt dự phòng'}},
    {kind: 'weekly_scoped', percent: 70, scope: {model: {display_name: '  '}, surface: 'Bề mặt khác'}},
    {kind: 'weekly_scoped', percent: 80, scope: {model: {display_name: '*_[]*'}, surface: 'Tên_sạch'}}
  ]});
  const names = ['Mô hình mới', 'Bề mặt riêng', 'Tuần (weekly_scoped)', 'Bề mặt dự phòng', 'Bề mặt khác', 'Tên_sạch'];
  assert.deepEqual(result.map(b => [b.windowKey, b.windowLabel]), names.map(name => ['other:' + name, name]));
  assert.deepEqual(result.map(b => b.percent), [84, 75, 50, 40, 30, 20]);
  assert.ok(result.every(b => b.resetAt === null));
});

test('Claude kind lạ dùng group và giữ kind thô trong nhãn tuần không có scope', () => {
  const result = claude.parseUsage({limits: [
    {kind: 'session_future', group: 'session', percent: 20},
    {kind: 'weekly_future', group: 'weekly', percent: 30, scope: {model: {display_name: 'Mô hình khác'}}},
    {kind: 'weekly_extra', group: 'weekly', percent: 40, scope: {}},
    {group: 'weekly', percent: 50},
    {kind: 'unknown', group: 'unknown', percent: 60}
  ]});
  assert.deepEqual(result.map(b => [b.windowKey, b.windowLabel, b.percent]), [
    ['5h', '5 giờ', 80], ['other:Mô hình khác', 'Mô hình khác', 70],
    ['other:Tuần (weekly_extra)', 'Tuần (weekly_extra)', 60], ['other:Tuần', 'Tuần', 50]
  ]);
});

test('Claude limits rỗng, sai kiểu hoặc toàn phần tử không hợp lệ rơi về trường cũ', () => {
  const old = payload('claude');
  const expected = claude.parseUsage(old);
  for (const limits of [undefined, null, {}, 'sai', [], [null, {}, 1, 'sai'],
    [{kind: 'unknown', group: 'unknown', percent: 25}],
    [{kind: 'session', percent: '25'}, {kind: 'weekly_all', percent: -1}]]) {
    assert.deepEqual(claude.parseUsage({...old, limits}), expected);
    assert.deepEqual(claude.parseUsage({limits}), []);
  }
});

test('Claude limits bỏ percent sai kiểu, không hữu hạn hoặc âm mà không ép kiểu', () => {
  for (const percent of [undefined, null, '25', '', true, false, {}, [], NaN, Infinity, -Infinity, -1]) {
    const bad = {kind: 'session', percent};
    assert.deepEqual(claude.parseUsage({limits: [bad]}), []);
    assert.deepEqual(claude.parseUsage({...payload('claude'), limits: [bad]}), claude.parseUsage(payload('claude')));
    const result = claude.parseUsage({...payload('claude'), limits: [bad, {kind: 'weekly_all', percent: 27.2}]});
    assert.equal(result.length, 1); assert.equal(result[0].windowKey, 'weekly');
    assert.equal(result[0].percent, 72); assert.equal(result[0].fraction, 0.728);
  }
});

test('Claude scoped trùng tên giữ mức dùng cao nhất bất kể thứ tự và nguồn tên', () => {
  const values = [
    {kind: 'weekly_scoped', percent: 20, scope: {model: {display_name: 'Mô hình chung'}}},
    {kind: 'weekly_scoped', percent: 80, resets_at: reset, scope: {surface: 'Mô hình chung'}},
    {kind: 'weekly_scoped', percent: 50, scope: {model: {display_name: 'Mô hình chung'}}}
  ];
  for (const limits of [values, [...values].reverse()]) {
    const result = claude.parseUsage({limits});
    assert.equal(result.length, 1); assert.equal(result[0].windowKey, 'other:Mô hình chung');
    assert.equal(result[0].percent, 20); assert.equal(result[0].resetAt, Date.parse(reset));
  }
});

test('Claude scoped trùng tên so sánh trước khi làm tròn phần trăm còn lại', () => {
  for (const values of [[90.1, 90.8], [90.8, 90.1]]) {
    const result = claude.parseUsage({limits: values.map(percent => ({
      kind: 'weekly_scoped', percent, resets_at: percent === 90.8 ? reset : 'sai',
      scope: {model: {display_name: 'Mô hình chung'}}
    }))});
    assert.equal(result.length, 1); assert.equal(result[0].percent, 9);
    assert.equal(result[0].fraction, (100 - 90.8) / 100); assert.equal(result[0].resetAt, Date.parse(reset));
  }
});

test('Claude làm sạch tên model, surface và kind có Markdown, điều khiển hoặc rất dài', () => {
  const inputs = ['**Mô_hình**|[nhãn](https://gia.invalid) `mã` <b> $(zap)\u0000\u007f\u0085\u202e\u2066\nphần bỏ',
    '\u001b[31mMô hình\u001b[0m', '\u0000\u007f\u0085\u202e\u2066Tên\t\nphần bỏ',
    '_Tên_ **đậm** `mã` | $(zap)', 'Mô hình rất dài '.repeat(500)];
  for (const name of inputs) for (const source of ['model', 'surface', 'kind']) {
    const entry = {kind: 'weekly_scoped', percent: 25};
    if (source === 'model') entry.scope = {model: {display_name: name}};
    else if (source === 'surface') entry.scope = {surface: name};
    else { entry.kind = name; entry.group = 'weekly'; }
    const result = claude.parseUsage({limits: [entry]});
    assert.equal(result.length, 1);
    const label = result[0].windowLabel;
    assert.ok([...label].length > 0 && [...label].length <= 40);
    assert.doesNotMatch(label, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\\`*[\]<>|#!~]|\$\(/);
    assert.doesNotMatch(label, /(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/u);
    assert.equal(result[0].windowKey, 'other:' + label);
    if (name.includes('phần bỏ')) assert.ok(!label.includes('phần bỏ'));
    if (name.length > 2000) assert.ok(label.endsWith('...'));
  }
  const result = claude.parseUsage({limits: [
    {kind: 'weekly_scoped', percent: 20, scope: {model: {display_name: '**Tên chung**'}}},
    {kind: 'weekly_scoped', percent: 80, scope: {surface: 'Tên chung'}}
  ]});
  assert.equal(result.length, 1); assert.equal(result[0].windowLabel, 'Tên chung'); assert.equal(result[0].percent, 20);
});

test('Claude scoped có thể là giới hạn ràng buộc trên thanh trạng thái', () => {
  const buckets = claude.parseUsage({limits: [
    {kind: 'session', percent: 8, resets_at: reset},
    {kind: 'weekly_all', percent: 8, resets_at: reset},
    {kind: 'weekly_scoped', percent: 96, resets_at: reset, scope: {model: {display_name: 'Mô hình mới'}}}
  ]});
  const model = display({...emptyState(), buckets, lastSuccessAt: now}, now, {}, {id: 'claude', name: 'Claude Code'});
  assert.equal(model.text, 'Claude 92% | 92% | Mô hình mới 4%'); assert.equal(model.severity, 'critical');
  assert.ok(model.tooltip.includes('Mô hình mới')); assert.ok(model.tooltip.includes('4%'));
});

test('Claude đọc phản hồi chỉ có limits qua bộ HTTP giả lập', async () => {
  const h = fixture(claude, {body: JSON.stringify({limits: [
    {kind: 'session', percent: 20, resets_at: reset},
    {kind: 'weekly_scoped', percent: 90, scope: {surface: 'Bề mặt mới'}}
  ]})});
  const result = await h.provider.fetch();
  assert.deepEqual(result.buckets.map(b => [b.windowKey, b.percent]), [['5h', 80], ['other:Bề mặt mới', 10]]);
  assert.equal(h.reads.length, 1); assert.equal(h.calls.length, 1); assert.equal(h.curl.length, 0);
});

test('Codex ánh xạ 5 giờ, tuần, giờ và ngày; ưu tiên reset tuyệt đối', () => {
  const result = codex.parseUsage(payload('codex'), now);
  assert.deepEqual(result.map(b => [b.provider, b.windowKey, b.percent, b.resetAt]),
    [['codex', '5h', 85, now + 300000], ['codex', 'weekly', 95, now + 600000]]);
  for (const [seconds, label] of [[7200, '2 giờ'], [172800, '2 ngày']]) {
    const b = codex.parseUsage({rate_limit: {primary_window: {used_percent: 50, limit_window_seconds: seconds}}}, now)[0];
    assert.equal(b.windowKey, 'other:' + seconds + 's');
    assert.equal(b.windowLabel, label); assert.equal(b.resetAt, null);
  }
  const b = codex.parseUsage({rate_limit: {secondary_window: {used_percent: 100, limit_window_seconds: 18000, reset_at: 0, reset_after_seconds: 10}}}, now)[0];
  assert.equal(b.resetAt, 0); assert.equal(b.percent, 0);
});
test('Codex loại cửa sổ thiếu, null, sai kiểu và ngoài khoảng', () => {
  for (const used_percent of [undefined, null, -1, '', 'sai', NaN, Infinity, true, {}, []]) {
    assert.deepEqual(codex.parseUsage({rate_limit: {primary_window: {used_percent, limit_window_seconds: 18000}}}), []);
  }
  for (const limit_window_seconds of [-1, 0, '', 'sai', Infinity, true, {}, []]) {
    assert.deepEqual(codex.parseUsage({rate_limit: {primary_window: {used_percent: 50, limit_window_seconds}}}), []);
  }
  assert.deepEqual(codex.parseUsage(null), []);
});
for (const definition of [claude, codex]) {
  test(definition.name + ': đọc đúng tệp, chỉ GET tới host cố định và không chuyển hướng', async () => {
    const h = fixture(definition);
    const result = await h.provider.fetch();
    assert.equal(result.buckets.length, 2);
    assert.equal(h.reads.length, 1); assert.equal(h.calls.length, 1);
    const call = h.calls[0];
    assert.equal(call.url, definition.id === 'claude' ? 'https://api.anthropic.com/api/oauth/usage' : 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(call.init.method, 'GET'); assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.headers.Authorization, 'Bearer ' + h.token);
    assert.ok(call.init.signal instanceof AbortSignal);
    if (definition.id === 'claude') assert.equal(call.init.headers['anthropic-beta'], 'oauth-2025-04-20');
    else assert.equal(call.init.headers['chatgpt-account-id'], 'tai-khoan-gia');
    assert.equal(h.reads[0], path.join('/nguoi-dung', definition.id === 'claude' ? '.claude/.credentials.json' : '.codex/auth.json'));
  });
  test(definition.name + ': ưu tiên cấu hình rồi biến môi trường, không ghi tệp', async () => {
    const key = definition.id === 'claude' ? 'claudeConfigDir' : 'codexHome';
    const envKey = definition.id === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
    const h = fixture(definition, {env: {[envKey]: '/bien-moi-truong'}});
    await h.provider.fetch({[key]: '/cau-hinh'}); await h.provider.fetch({[key]: ''});
    assert.equal(path.dirname(h.reads[0]), path.normalize('/cau-hinh'));
    assert.equal(path.dirname(h.reads[1]), path.normalize('/bien-moi-truong'));
    assert.equal(h.reads.length, 2);
  });
  for (const [label, options] of [['thiếu tệp', {readError: Object.assign(new Error('gia'), {code: 'ENOENT'})}],
    ['tệp hỏng', {text: '{'}], ['thiếu token', {auth: {}}], ['token rỗng', {token: ' '}],
    ['token có xuống dòng', {token: 'gia\r\nX: gia'}]]) {
    test(definition.name + ': ' + label + ' hướng dẫn đăng nhập, không gọi mạng', async () => {
      const h = fixture(definition, options); const result = await h.provider.fetch();
      assert.equal(result.error.type, 'auth'); assert.ok(result.error.message.includes(definition.id));
      assert.equal(h.calls.length, 0); assert.equal(h.curl.length, 0);
    });
  }
  for (const status of [401, 403, 429, 500, 503, 302]) {
    test(definition.name + ': HTTP ' + status + ' không lặp và không lộ token trong lỗi máy chủ', async () => {
      const h = fixture(definition, {status, body: JSON.stringify({error: fakeTokens.join(' ')})});
      const result = await h.provider.fetch();
      assert.equal(result.error.type, status === 401 || status === 403 && definition.id === 'claude' ? 'auth' : 'http');
      assert.equal(h.calls.length, 1); assert.equal(h.curl.length, 0);
      const state = localResult(emptyState(), result, now);
      const model = display(state, now, {}, {id: definition.id, name: definition.name});
      const visible = JSON.stringify([state, model, sanitize(result.error.message)]);
      for (const token of fakeTokens) assert.ok(!visible.includes(token));
      if (status === 429) assert.equal(result.retryAfterMs, 60000);
    });
  }
  for (const [label, options, type] of [
    ['JSON hỏng', {body: '{' + fakeTokens.join(' ')}, 'http'],
    ['không có cửa sổ', {body: '{}'}, 'http'],
    ['quá lớn không có độ dài', {body: 'a'.repeat(MAX_BYTES + 1)}, 'http'],
    ['quá lớn có độ dài', {body: '{}', headers: {'content-length': String(MAX_BYTES + 1)}}, 'http'],
    ['mạng', {fetch: async () => {throw new Error(fakeTokens.join(' '));}}, 'network'],
    ['chuyển hướng bị từ chối', {fetch: async (url, init) => {assert.equal(init.redirect, 'error'); throw new TypeError('redirect ' + fakeTokens.join(' '));}}, 'network']
  ]) {
    test(definition.name + ': ' + label + ' được làm sạch', async () => {
      const h = fixture(definition, options); const result = await h.provider.fetch();
      assert.equal(result.error.type, type);
      for (const token of fakeTokens) assert.ok(!JSON.stringify(result).includes(token));
    });
  }
  test(definition.name + ': timeout áp dụng cả phản hồi treo và hủy không báo lỗi', async () => {
    const h = fixture(definition, {fetch: () => new Promise(() => {})});
    const pending = h.provider.fetch({timeout: 7});
    await new Promise(setImmediate); assert.equal(h.timers[0].ms, 7000);
    h.timers[0].cb();
    assert.equal((await pending).error.type, 'timeout'); assert.ok(h.calls[0].init.signal.aborted);
    const other = fixture(definition, {fetch: () => new Promise(() => {})});
    const cancelled = other.provider.fetch(); await new Promise(setImmediate); other.provider.dispose();
    assert.deepEqual(await cancelled, {cancelled: true});
    assert.deepEqual(await other.provider.fetch(), {cancelled: true});
  });
  test(definition.name + ': timeout khi thân phản hồi đang treo', async () => {
    const h = fixture(definition, {fetch: async () => new Response(new ReadableStream({start() {}}))});
    const pending = h.provider.fetch(); await new Promise(setImmediate); h.timers[0].cb();
    assert.equal((await pending).error.type, 'timeout');
  });
  test(definition.name + ': bỏ token JWT hết hạn, không làm mới', async () => {
    const token = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({exp: now / 1000 - 1})).toString('base64url') + '.FAKE';
    const h = fixture(definition, {token});
    assert.equal((await h.provider.fetch()).error.type, 'auth'); assert.equal(h.calls.length, 0);
  });
  test(definition.name + ': Retry-After của máy chủ được truyền về kho', async () => {
    for (const [value, expected] of [['120', 120000], ['7200', 3600000], ['sai', 60000], ['0', 60000],
      [new Date(now + 180000).toUTCString(), 180000]]) {
      const h = fixture(definition, {status: 429, headers: {'Retry-After': value}});
      assert.equal((await h.provider.fetch()).retryAfterMs, expected);
    }
  });
  test(definition.name + ': 401/429 không đọc thân lỗi treo hoặc quá lớn', async () => {
    for (const status of [401, 429]) {
      let cancelled = false;
      const h = fixture(definition, {fetch: async () => new Response(new ReadableStream({
        start() {}, cancel() {cancelled = true;}
      }), {status, headers: {'Retry-After': '180', 'content-length': String(MAX_BYTES * 2)}})});
      const result = await h.provider.fetch();
      assert.equal(result.error.type, status === 401 ? 'auth' : 'http');
      if (status === 429) assert.equal(result.retryAfterMs, 180000);
      assert.equal(cancelled, true);
    }
  });
}
test('Claude kiểm tra expiresAt trước khi gửi token', async () => {
  const h = fixture(claude, {auth: {claudeAiOauth: {accessToken: fakeTokens[0], expiresAt: now - 1}}});
  assert.equal((await h.provider.fetch()).error.type, 'auth'); assert.equal(h.calls.length, 0);
});
test('Codex bỏ header tài khoản khi không có hoặc chứa ký tự điều khiển', async () => {
  for (const account_id of [undefined, '', 'gia\r\nX: gia']) {
    const h = fixture(codex, {auth: {tokens: {access_token: fakeTokens[1], account_id}}});
    assert.ok((await h.provider.fetch()).buckets); assert.equal(h.calls[0].init.headers['chatgpt-account-id'], undefined);
  }
});
test('Claude dự phòng TLS bằng curl với cấu hình stdin, token không có trong argv', async () => {
  const h = fixture(claude, {status: 403, body: 'Request not allowed'});
  assert.equal((await h.provider.fetch()).buckets.length, 2);
  assert.equal(h.curl.length, 1); const call = h.curl[0];
  assert.equal(call.file, 'C:\\Windows\\System32\\curl.exe'); assert.deepEqual(call.argv, ['-q', '--config', '-']);
  assert.equal(call.settings.shell, false); assert.equal(call.settings.windowsHide, true);
  assert.ok(call.config.includes('Authorization: Bearer ' + h.token));
  assert.ok(call.config.includes('max-redirs = 0')); assert.ok(call.config.includes('proto = "=https"'));
  assert.ok(!JSON.stringify([call.argv, call.settings]).includes(h.token));
});
test('Claude curl trên POSIX, 401/403/429/5xx/chuyển hướng và lỗi đều an toàn, không lặp', async () => {
  for (const status of [401, 403, 429, 500, 302]) {
    const h = fixture(claude, {status: 403, body: 'Request not allowed', platform: 'linux',
      curlOutput: 'HTTP/1.1 ' + status + ' Lỗi\r\nRetry-After: 120\r\n\r\n' + fakeTokens.join(' ') + '\n__AI_QUOTA_STATUS__' + status});
    const result = await h.provider.fetch();
    assert.equal(h.curl[0].file, 'curl'); assert.equal(h.curl.length, 1);
    assert.equal(result.error.type, status === 401 || status === 403 ? 'auth' : 'http');
    if (status === 429) assert.equal(result.retryAfterMs, 120000);
    for (const token of fakeTokens) assert.ok(!JSON.stringify(result).includes(token));
  }
  for (const options of [{curlError: new Error(fakeTokens[0])}, {curlOutput: fakeTokens[1]},
    {curlError: Object.assign(new Error(fakeTokens[0]), {code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'})}]) {
    const h = fixture(claude, {status: 403, body: 'Request not allowed', ...options});
    const result = await h.provider.fetch(); assert.ok(result.error);
    for (const token of fakeTokens) assert.ok(!JSON.stringify(result).includes(token));
  }
});
test('Claude nhận diện timeout curl và vẫn hủy tiến trình khi đóng', async () => {
  const h = fixture(claude, {status: 403, body: 'Request not allowed',
    curlError: Object.assign(new Error(fakeTokens[0]), {code: 28})});
  assert.equal((await h.provider.fetch()).error.type, 'timeout');
  let child;
  const deps = {
    fs: {readFile: async () => JSON.stringify({claudeAiOauth: {accessToken: fakeTokens[0]}})},
    fetch: async () => new Response('Request not allowed', {status: 403}),
    execFile(file, argv, settings, callback) {
      child = {stdin: {on() {}, end() {}}, kill() { this.killed = true; callback(new Error(fakeTokens[0])); }};
      return child;
    }
  };
  const provider = claude.createProvider(deps);
  const pending = provider.fetch(); await new Promise(setImmediate);
  assert.ok(child); provider.dispose();
  assert.deepEqual(await pending, {cancelled: true}); assert.equal(child.killed, true);
});
test('Mức cảnh báo dùng khóa chứa nhà cung cấp khi tên nhóm và cửa sổ trùng nhau', () => {
  const a = {...claude.parseUsage(payload('claude'))[0], groupName: 'Chung', percent: 5};
  const b = {...a, provider: 'codex', percent: 80};
  const result = transitions([a, b], {}, now);
  assert.deepEqual(result.levels, {'claude|Chung|5h': 'critical', 'codex|Chung|5h': 'ok'});
  assert.equal(result.events.length, 1); assert.match(notification(result, {name: 'Claude Code'}), /^Claude Code:/);
});
test('Lỗi đăng nhập hiện rõ trên thanh cả khi còn quota được lưu từ lần trước', () => {
  const state = {...emptyState(), buckets: claude.parseUsage(payload('claude')), lastSuccessAt: now,
    error: {type: 'auth', message: 'Mở claude để đăng nhập lại.'}};
  const model = display(state, now, {}, {id: 'claude', name: 'Claude Code', label: 'Claude'});
  assert.equal(model.text, '$(history) Claude: chưa đăng nhập');
  assert.ok(model.tooltip.includes('Mở claude để đăng nhập lại.'));
  assert.ok(model.tooltip.includes('72%'));
});
test('Kho và khóa tách theo nhà cung cấp; 429 chặn cả làm mới thủ công và cửa sổ khác', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-nha-cung-cap-'));
  context.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  let time = now;
  const options = {directory, fs: fs.promises, now: () => time};
  const first = createStore({...options, name: 'claude'}), other = createStore({...options, name: 'codex'});
  fs.writeFileSync(path.join(directory, 'state-claude.lock'), '');
  const codexClaim = await other.claim({}); assert.ok(codexClaim.claimed);
  fs.unlinkSync(path.join(directory, 'state-claude.lock'));
  const claim = await first.claim({}); assert.ok(claim.claimed);
  await first.complete({error: {type: 'http', message: 'Quá nhiều yêu cầu.'}, retryAfterMs: 120000}, {}, claim);
  assert.equal((await first.claim({}, true)).claimed, false);
  const second = createStore({...options, name: 'claude'});
  assert.equal((await second.claim({})).claimed, false);
  time += 120000; assert.equal((await second.claim({})).claimed, false);
  time = now + 300000; assert.equal((await second.claim({})).claimed, true);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['state-claude.json', 'state-codex.json']);
  assert.equal((await other.read()).consecutiveErrors, 0);
});
test('Retry-After không làm nhịp tự động nhanh hơn và bị chặn tối đa một giờ', () => {
  assert.equal(retryAfter('-1', now), 60000);
  const state = {...emptyState(), lastAttemptAt: now, retryAt: now + 60000,
    buckets: [{resetAt: now + 1}], consecutiveErrors: 4};
  assert.equal(intervalMs(state, {}), 1200000);
  assert.equal(isRefreshDue(state, now + 61000, {}), false);
  for (const type of ['auth', 'network', 'http']) assert.equal(validState({...emptyState(), error: {type, message: 'Lỗi giả.'}}), true);
  assert.equal(validState({...emptyState(), retryAt: 'sai'}), false);
});

test('Pha 3 mục 4: curl Windows dùng SystemRoot tuyệt đối; thư mục chạy không thuộc workspace', async () => {
  for (const env of [{sYsTeMrOoT: 'D:\\Windows'}, {}, {sYsTeMrOoT: 'tương-đối'}]) {
    const h = fixture(claude, {status: 403, body: 'Request not allowed', env});
    assert.ok((await h.provider.fetch()).buckets);
    const root = path.win32.isAbsolute(env.sYsTeMrOoT || '') ? env.sYsTeMrOoT : 'C:\\Windows';
    assert.equal(h.curl[0].file, path.win32.join(root, 'System32', 'curl.exe'));
    assert.equal(h.curl[0].settings.cwd, root);
  }
  const h = fixture(claude, {status: 403, body: 'Request not allowed', platform: 'linux'});
  assert.ok((await h.provider.fetch()).buckets);
  assert.equal(h.curl[0].file, 'curl'); assert.equal(h.curl[0].settings.cwd, '/');
});

test('Pha 3 mục 9: User-Agent được gửi qua fetch và curl', async () => {
  const agent = 'ai-quota-bar/' + require('../package.json').version;
  for (const definition of [claude, codex]) {
    const h = fixture(definition);
    await h.provider.fetch();
    assert.equal(h.calls[0].init.headers['User-Agent'], agent);
  }
  const h = fixture(claude, {status: 403, body: 'Request not allowed'});
  await h.provider.fetch();
  assert.ok(h.curl[0].config.includes('User-Agent: ' + agent));
});

test('Pha 3 mục 9: Codex 403 JSON là lỗi xác thực, HTML hoặc thiếu loại là HTTP 403', async () => {
  for (const contentType of ['application/json', 'application/json; charset=utf-8', 'Application/Problem+JSON',
    'text/html', '', 'application/jsonp', 'text/application/json']) {
    let cancelled = false;
    const h = fixture(codex, {fetch: async () => new Response(new ReadableStream({
      start() {}, cancel() { cancelled = true; }
    }), {status: 403, headers: {'content-type': contentType}})});
    const result = await h.provider.fetch();
    const json = contentType.toLowerCase().startsWith('application/json') && contentType !== 'application/jsonp' ||
      contentType === 'Application/Problem+JSON';
    assert.equal(result.error.type, json ? 'auth' : 'http');
    if (!json) assert.match(result.error.message, /HTTP 403/);
    assert.equal(cancelled, true); assert.equal(h.curl.length, 0);
  }
});
