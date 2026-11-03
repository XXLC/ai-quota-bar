'use strict';
require('../src/i18n').setLocale('vi');
process.env.TZ = 'Asia/Ho_Chi_Minh';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {parse, parseTsv, sanitize, groupLabel} = require('../src/parse');
const {isRefreshDue, transitions, configuration} = require('../src/thresholds');
const {display, resetTime, escapeMarkdown, safeText, notification} = require('../src/format');
const {createStore, emptyState, validState} = require('../src/state');
const {createRunner, resolveAgy} = require('../src/runner');
const time = Date.parse('2026-11-03T00:00:00Z');
const sample = (percent = 20, resetAt = time + 3600000) => ({
  groupName: 'Nhóm', groupLabel: 'Nhóm', windowKey: '5h', windowLabel: '5 giờ',
  percent, fraction: percent / 100, resetAt
});
const envelope = overrides => JSON.stringify({
  num_turns: 0, conversation_id: '', status: 'SUCCESS',
  command: {name: 'usage', data: {groups: [{name: 'Nhóm', buckets: [{window: '5h', remaining_fraction: .2}]}]}},
  ...overrides
});
async function temporary(testContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-dot-d-'));
  testContext.after(() => fs.rm(directory, {recursive: true, force: true}));
  return directory;
}
test('L1: năm lỗi sau reset giữ backoff, reset chưa thử chỉ kích một lượt', () => {
  const state = {buckets: [sample(20, time)], lastSuccessAt: time - 1000,
    lastAttemptAt: time + 100, consecutiveErrors: 5};
  assert.equal(isRefreshDue(state, time + 60000, {}), false);
  state.lastAttemptAt = time - 1;
  assert.equal(isRefreshDue(state, time, {}), true);
  state.lastAttemptAt = time;
  assert.equal(isRefreshDue(state, time + 1, {}), false);
});
test('L2: quét toàn bộ phần trăm nguyên JSON và TSV, giữ phần thập phân TSV', () => {
  for (let percent = 0; percent <= 100; percent++) {
    const result = parse(envelope({command: {name: 'usage', data: {groups: [
      {name: 'Nhóm', buckets: [{window: '5h', remaining_fraction: percent / 100}]}]}}}));
    assert.equal(result.buckets[0].percent, percent);
    assert.equal(parseTsv('Nhóm\t5h\t' + percent + '%')[0].percent, percent);
  }
  assert.equal(parseTsv('Nhóm\t5h\t28.9999999999%')[0].percent, 28);
});
test('Argon 1, 2, 4, 5, 11: phong bì, nhãn, cấu hình và trạng thái thiếu an toàn', () => {
  assert.equal(parse(envelope({status: 'ERROR'})).error.type, 'unexpected');
  assert.equal(parse(envelope({num_turns: 1})).error.type, 'unexpected');
  assert.equal(parseTsv('Nhóm\t\t20%').length, 0);
  assert.equal(groupLabel('__proto__'), '__proto__');
  assert.equal(configuration(null).timeout, 45);
  assert.equal(validState({...emptyState(), levels: null}), false);
  assert.equal(validState({...emptyState(), consecutiveErrors: null}), false);
  assert.equal(transitions([sample()], null, time).events.length, 1);
});
test('G2, G15 và Argon 6, 8, 9: che bí mật, ký tự điều khiển, cắt code point và chống ReDoS', () => {
  assert.equal(sanitize('keyJar bị lỗi'), 'keyJar bị lỗi');
  assert.equal(sanitize('Basic abcd'), '[đã che]');
  for (const key of ['token', 'access_token', 'key', 'apikey', 'api_key', 'secret', 'password', 'auth', 'code']) {
    assert.ok(!sanitize('https://a.b/?' + key + '=bí_mật', 200).includes('bí_mật'));
  }
  assert.equal(sanitize('a\u202eb\u2066c\u0000d'), 'abcd');
  assert.equal(escapeMarkdown('a\u202eb\u2066c\u0000d\n'), 'abcd ');
  assert.equal(escapeMarkdown('$(gear)'), '\\$(gear)');
  assert.equal(safeText('[x](đường_dẫn)'), 'x(đường_dẫn)');
  const result = sanitize('𐐀 '.repeat(100), 8);
  assert.equal(result, '𐐀 𐐀 𐐀...');
  assert.equal(result.isWellFormed(), true);
  const started = performance.now();
  assert.ok(sanitize('A'.repeat(300000)).length <= 120);
  assert.ok(performance.now() - started < 50);
});
test('G6, G8 và Argon 7: giờ địa phương, đang tải, spinner giữ history, hiển thị mốc unknown', () => {
  assert.equal(resetTime(time), '07:00 T3 03/11');
  const loading = display({...emptyState(), runningSince: time}, time);
  assert.ok(!loading.items.some(item => item.label.includes('Không đọc được')));
  const model = display({buckets: [sample(5, time), {...sample(20), windowKey: 'weekly'}],
    lastSuccessAt: time, error: {message: 'Lỗi'}, manualRefresh: true}, time);
  assert.equal(model.text, '$(sync~spin) $(history) Nhóm ?% | 20%');
  assert.equal(model.severity, 'warning');
  assert.match(notification({events: [{bucket: {...sample(), groupLabel: '[x]'}, recovered: false}]}), /: x /);
});
function runnerHarness(options = {}) {
  const timers = [];
  const calls = [];
  let callback;
  const runner = createRunner({
    exists: () => true, homedir: () => os.tmpdir(), platform: 'win32',
    env: {PATH: 'C:\\agy', SystemRoot: 'C:\\Windows'},
    setTimer: (fn, delay) => { timers.push({fn, delay}); return timers.length; }, clearTimer() {},
    execFile(file, args, opts, cb) {
      calls.push({file, args, opts});
      if (file.endsWith('taskkill.exe')) cb(null);
      else callback = cb;
      return {pid: 9876, stdin: {end() {}, on() {}}};
    }, ...options
  });
  return {runner, timers, calls, finish: (...args) => callback(...args)};
}
test('N7, G12: timeout 45000, bảo vệ 2000 và đường dẫn taskkill tuyệt đối', async () => {
  const harness = runnerHarness();
  const pending = harness.runner.run();
  assert.equal(harness.timers[0].delay, 45000);
  harness.timers[0].fn();
  assert.equal(harness.timers[1].delay, 2000);
  assert.equal(harness.calls[1].file, 'C:\\Windows\\System32\\taskkill.exe');
  assert.deepEqual(harness.calls[1].args, ['/PID', '9876', '/T', '/F']);
  assert.equal((await pending).error.type, 'timeout');
});
test('N3, G7: giữ lỗi parse JSON, nhật ký ném lỗi vẫn kết thúc lượt chạy', async () => {
  const harness = runnerHarness({log() { throw new Error('Kênh đã đóng'); }});
  const pending = harness.runner.run();
  harness.finish(null, envelope({num_turns: 1, response: 'KHÔNG ĐƯỢC DÙNG'}));
  const result = await pending;
  assert.equal(result.error.type, 'unexpected');
  assert.match(result.error.message, /usage/);
  assert.doesNotMatch(result.error.message, /KHÔNG ĐƯỢC DÙNG/);
});
test('N3: JSON hợp lệ không có mốc giữ thông điệp response thay vì cả phong bì', async () => {
  const harness = runnerHarness();
  const pending = harness.runner.run();
  harness.finish(null, envelope({command: {name: 'usage'}, response: 'Không có quota.'}));
  assert.equal((await pending).error.message, 'Không có quota.');
});
test('G12 và Argon 10: bỏ PATH tương đối, từ chối cấu hình tương đối và đuôi khác', () => {
  const visited = [];
  assert.equal(resolveAgy({platform: 'win32', env: {PATH: '.;bin;C:\\bin'},
    exists: value => { visited.push(value); return true; }}).path, 'C:\\bin\\agy.exe');
  assert.deepEqual(visited, ['C:\\bin\\agy.exe']);
  for (const configPath of ['agy.exe', 'C:\\agy', 'C:\\agy.txt', 'C:\\agy.cmd']) {
    assert.ok(resolveAgy({platform: 'win32', configPath, exists: () => true}).error);
  }
});
test('G13: SIGKILL nhóm thất bại rơi về proc.kill, không sinh lệnh kill', async () => {
  let fallback = 0;
  const harness = runnerHarness({platform: 'linux', env: {PATH: '/bin'},
    kill(pid, signal) { assert.equal(pid, -23); assert.equal(signal, 'SIGKILL'); throw new Error('Đã thoát'); },
    execFile() { return {pid: 23, stdin: {end() {}}, kill(signal) { assert.equal(signal, 'SIGKILL'); fallback++; }}; }
  });
  const pending = harness.runner.run();
  harness.timers[0].fn();
  assert.equal((await pending).error.type, 'timeout');
  assert.equal(fallback, 1);
});
test('G9: lỗi của claim cũ không ghi đè thành công mới hơn', async context => {
  const directory = await temporary(context);
  let now = time;
  const first = createStore({directory, fs, now: () => now});
  const second = createStore({directory, fs, now: () => now});
  const claim = await first.claim({});
  now += 1000;
  const newer = await second.claim({}, true);
  now += 1000;
  await second.complete({buckets: [sample(50)]}, {}, newer);
  now += 1000;
  const result = await first.complete({error: {type: 'timeout', message: 'Lỗi cũ'}}, {}, claim);
  assert.equal(result.state.error, null);
  assert.equal(result.state.consecutiveErrors, 0);
  assert.equal((await first.read()).buckets[0].percent, 50);
});
test('G1, N1, N2: khóa 30 giây được đổi tên trước xóa; thử lại đúng 5 lượt có giãn', async context => {
  const directory = await temporary(context);
  const lock = path.join(directory, 'state-agy.lock');
  await fs.writeFile(lock, '');
  await fs.utimes(lock, new Date(time), new Date(time));
  const operations = [];
  const delays = [];
  let now = time + 30000;
  const store = createStore({directory, now: () => now,
    fs: {...fs, rename: async (a, b) => { operations.push(['đổi tên', a, b]); return fs.rename(a, b); },
      unlink: async value => { operations.push(['xóa', value]); return fs.unlink(value); }},
    setTimer: (callback, delay) => { delays.push(delay); callback(); }
  });
  assert.equal((await store.claim({}, true)).busy, true);
  assert.deepEqual(delays, [50, 100, 200, 400]);
  assert.deepEqual(operations, []);
  now++;
  assert.equal((await store.claim({}, true)).claimed, true);
  assert.equal(operations[0][0], 'đổi tên');
  assert.equal(operations[0][1], lock);
  assert.ok(operations[0][2].endsWith('.old'));
  assert.deepEqual(operations[1], ['xóa', operations[0][2]]);
});
test('L3: release khôi phục lần thử và không đụng lease của cửa sổ mới', async context => {
  const directory = await temporary(context);
  let now = time;
  const store = createStore({directory, fs, now: () => now});
  const claim = await store.claim({});
  await store.release(claim);
  assert.equal((await store.read()).lastAttemptAt, null);
  assert.equal((await store.read()).runningSince, null);
  now++;
  const newer = await store.claim({}, true);
  await store.release(claim);
  assert.equal((await store.read()).runningSince, newer.claimedAt);
  assert.equal((await store.read()).consecutiveErrors, 0);
});
