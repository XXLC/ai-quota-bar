'use strict';
require('../src/i18n').setLocale('vi');
process.env.TZ = 'Asia/Ho_Chi_Minh';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const sourceRoot = path.resolve(__dirname, '../src');
const pause = () => new Promise(resolve => setTimeout(resolve, 2));
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail('Hết thời gian chờ điều kiện tích hợp.');
    await pause();
  }
}
function storage(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-tich-hop-'));
  context.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}
const usage = (percent, groupName = 'Nhóm') => JSON.stringify({
  status: 'SUCCESS', num_turns: 0, conversation_id: '', command: {name: 'usage', data: {groups: [
    {name: groupName, buckets: [{window: '5h', remaining_fraction: percent / 100,
      reset_time: '2099-01-01T00:00:00Z'}]}
  ]}}
});
function openWindow(context, directory, options = {}) {
  const commands = new Map();
  const messages = [];
  const logs = [];
  const errorLogs = [];
  const callbacks = [];
  const kills = [];
  const retryDelays = [];
  const updates = [];
  const executed = [];
  const credentialReads = [];
  const instances = [];
  const bar = {show() {}, dispose() { this.disposed = true; }};
  const bars = [];
  let changed;
  let tick;
  let quickItems;
  let quickOptions;
  let channelName;
  let errorActions;
  const disposable = {dispose() {}};
  const vscode = {
    env: {language: options.language ?? 'vi'},
    StatusBarAlignment: {Right: 2}, QuickPickItemKind: {Separator: -1},
    ConfigurationTarget: {Global: 1},
    ThemeColor: class {constructor(id) { this.id = id; }},
    MarkdownString: class {constructor(value) { this.value = value; }},
    workspace: {
      getConfiguration: () => ({
        get: key => options.values?.[key] ?? (key === 'agyPath' ? options.agyPath ?? process.execPath : !options.defaultProviders && (key === 'providers.claude.enabled' || key === 'providers.codex.enabled') ? false : undefined),
        async update(key, value, target) {
          await options.beforeUpdate?.(key, value, target);
          updates.push({key, value, target});
          options.values = {...options.values, [key]: value};
          options.afterUpdate?.(key, value);
          changed({affectsConfiguration: () => true});
        }
      }),
      onDidChangeConfiguration: callback => { changed = callback; return disposable; }
    },
    commands: {
      registerCommand: (name, callback) => { commands.set(name, callback); return disposable; },
      executeCommand: async (name, ...args) => {
        executed.push({name, args});
        return commands.get(name)?.(...args);
      }
    },
    window: {
      createStatusBarItem: (id, alignment, priority) => {
        const item = bars.length ? {show() {}, dispose() { this.disposed = true; }} : bar;
        item.id = id; item.alignment = alignment; item.priority = priority; bars.push(item); return item;
      },
      createOutputChannel: name => { channelName = name; return ({
        info: message => logs.push(message), warn: message => logs.push(message),
        error: message => { logs.push(message); errorLogs.push(message); }, show() {}, dispose() {}
      }); },
      showErrorMessage: async (message, ...actions) => { messages.push(message); errorActions = actions; },
      showWarningMessage: async message => { messages.push(message); },
      showInformationMessage: async message => { messages.push(message); },
      showQuickPick: async (items, settings) => {
        quickItems = items; quickOptions = settings;
        return options.quickPick?.(items, settings);
      }
    }
  };
  const childProcess = {
    execFile(file, args, settings, callback) {
      if (/taskkill\.exe$/i.test(file)) {
        kills.push({file, args, callback});
        if (!options.holdKill) setImmediate(() => callback(null));
      } else {
        callbacks.push(callback);
      }
      return {pid: 87654, stdin: {end() {}, on() {}}};
    }
  };
  // Mỗi cửa sổ có bộ nhớ mô-đun riêng; src/state và src/runner đều chạy mã thật.
  // Chỉ thay hai API bên ngoài; tiêm lịch hẹn để thử khóa không phải chờ thật.
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = {exports: {}};
    cache.set(filename, module);
    const sandbox = {
      module, exports: module.exports, process, Buffer, AbortController,
      fetch: options.fetch ?? (async () => { throw new Error('Kiểm thử không cho phép gọi mạng.'); }),
      setTimeout(callback, delay) {
        if (delay <= 400) {
          retryDelays.push(delay);
          options.onRetry?.(delay);
          if (options.realLockDelays) return setTimeout(callback, delay);
          return setImmediate(callback);
        }
        return setTimeout(callback, delay);
      },
      clearTimeout,
      setInterval: callback => { tick = callback; return 1; }, clearInterval() {},
      require(request) {
        if (request === 'vscode') return vscode;
        if (request === 'node:child_process') return childProcess;
        if (request === 'node:fs') return {...fs, promises: {...fs.promises,
          async rename(file, target) {
            await options.beforeRename?.(file, target);
            return fs.promises.rename(file, target);
          }, readFile(file, ...args) {
          if (['.credentials.json', 'auth.json'].includes(path.basename(file))) {
            credentialReads.push(path.basename(file));
            if (!options.credentials) throw new Error('Kiểm thử không đọc thông tin đăng nhập thật.');
            return Promise.resolve(JSON.stringify(options.credentials[path.basename(file)]));
          }
          return fs.promises.readFile(file, ...args);
        }}};
        const result = request.startsWith('.') ? request.endsWith('.json') ? require(path.resolve(path.dirname(filename), request)) :
          load(path.resolve(path.dirname(filename), request + '.js')) : require(request);
        if (filename === path.join(sourceRoot, 'extension.js') && request.startsWith('./providers/')) {
          return {...result, createProvider(deps) {
            const provider = result.createProvider(deps);
            const instance = {id: result.id, fetches: 0, disposals: 0};
            instances.push(instance);
            return {...provider,
              fetch(config) { instance.fetches++; return provider.fetch(config); },
              dispose() { instance.disposals++; return provider.dispose(); }
            };
          }};
        }
        return result;
      }
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, {filename});
    return module.exports;
  }
  const extension = load(path.join(sourceRoot, 'extension.js'));
  const subscriptions = [];
  extension.activate({globalStorageUri: {fsPath: directory}, subscriptions});
  context.after(async () => { await extension.deactivate(); });
  return {
    extension, bar, bars, messages, logs, errorLogs, callbacks, kills, retryDelays,
    commands, updates, executed, credentialReads, instances,
    manual: () => commands.get('aiQuota.refresh')(), tick: () => tick(),
    details: () => commands.get('aiQuota.showDetails')(),
    selectProviders: () => commands.get('aiQuota.selectProviders')(),
    items: () => quickItems,
    pickerOptions: () => quickOptions, channelName: () => channelName, errorActions: () => errorActions,
    change: values => { options.values = {...options.values, ...values}; changed({affectsConfiguration: () => true}); },
    read: (id = 'agy') => JSON.parse(fs.readFileSync(path.join(directory, 'state-' + id + '.json'), 'utf8')),
    finish: (percent = 20, index = callbacks.length - 1) => callbacks[index](null, usage(percent, options.groupName), '')
  };
}
test('Tích hợp: hai cửa sổ dùng một kho, chỉ một chạy agy và chỉ một thông báo', async context => {
  const directory = storage(context);
  const first = openWindow(context, directory);
  const second = openWindow(context, directory);
  await until(() => first.callbacks.length + second.callbacks.length === 1);
  const owner = first.callbacks.length ? first : second;
  const observer = owner === first ? second : first;
  owner.finish();
  await until(() => owner.bar.text === 'Nhóm 20% | --');
  await until(() => observer.retryDelays.length > 0 || !observer.bar.text.includes('sync~spin'));
  observer.tick();
  await until(() => observer.bar.text === 'Nhóm 20% | --');
  assert.equal(first.callbacks.length + second.callbacks.length, 1);
  assert.equal(first.messages.length + second.messages.length, 1);
  assert.equal(owner.read().levels['agy|Nhóm|5h'], 'warning');
  assert.equal(observer.messages.length, 0);
  await observer.details();
  assert.deepEqual(Array.from(observer.items().filter(item => item.action), item => item.action), ['refresh', 'log', 'selectProviders', 'settings']);
  assert.equal(observer.bar.tooltip.isTrusted, false);
  const cacheLines = () => observer.logs.filter(line => line.includes('nguồn: bộ nhớ đệm'));
  await until(() => cacheLines().length === 1);
  assert.match(cacheLines()[0], /cửa sổ khác, \d+ giây trước/);
  observer.tick();
  await pause();
  observer.tick();
  await pause();
  assert.equal(cacheLines().length, 1);
});
test('Tích hợp N1: hết năm lượt khóa khi complete vẫn hiển thị kết quả, bỏ spinner và ghi cảnh báo', async context => {
  const directory = storage(context);
  const window = openWindow(context, directory);
  await until(() => window.callbacks.length === 1);
  const lock = path.join(directory, 'state-agy.lock');
  fs.writeFileSync(lock, '');
  window.finish(57);
  await until(() => window.logs.some(line => line.includes('vẫn hiển thị kết quả cục bộ')));
  assert.equal(window.bar.text, 'Nhóm 57% | --');
  assert.deepEqual(window.retryDelays, [50, 100, 200, 400]);
  assert.equal(window.read().buckets.length, 0);
  fs.unlinkSync(lock);
  await window.tick();
  assert.equal(window.bar.text, 'Nhóm 57% | --');
});
test('Tích hợp N1: hết năm lượt khóa khi ghi lỗi vẫn giữ dữ liệu và dừng spinner', async context => {
  const directory = storage(context);
  const window = openWindow(context, directory);
  await until(() => window.callbacks.length === 1);
  window.finish(60);
  await until(() => window.bar.text === 'Nhóm 60% | --');
  const manual = window.manual();
  await until(() => window.callbacks.length === 2);
  const lock = path.join(directory, 'state-agy.lock');
  fs.writeFileSync(lock, '');
  window.callbacks[1](null, 'Đầu ra hỏng', '');
  await manual;
  assert.equal(window.bar.text, '$(history) Nhóm 60% | --');
  assert.match(window.bar.tooltip.value, /Đầu ra hỏng/);
  assert.ok(window.logs.some(line => line.includes('vẫn hiển thị kết quả cục bộ')));
  fs.unlinkSync(lock);
});
test('Tích hợp N2: lệnh thủ công thử lại khóa rồi chạy agy kể cả dữ liệu còn mới', async context => {
  const directory = storage(context);
  const lock = path.join(directory, 'state-agy.lock');
  const window = openWindow(context, directory, {
    onRetry(delay) { if (delay === 100) fs.unlinkSync(lock); }
  });
  await until(() => window.callbacks.length === 1);
  window.finish(60);
  await until(() => window.bar.text === 'Nhóm 60% | --');
  fs.writeFileSync(lock, '');
  const manual = window.manual();
  await until(() => window.callbacks.length === 2);
  assert.deepEqual(window.retryDelays, [50, 100]);
  assert.match(window.bar.text, /^\$\(sync~spin\) Nhóm 60% \| --$/);
  window.finish(29);
  await manual;
  assert.equal(window.bar.text, 'Nhóm 29% | --');
});
test('Tích hợp N2: khóa thủ công hết lượt ghi cảnh báo rõ, không giả làm bộ nhớ đệm', async context => {
  const directory = storage(context);
  const window = openWindow(context, directory);
  await until(() => window.callbacks.length === 1);
  window.finish(60);
  await until(() => window.bar.text === 'Nhóm 60% | --');
  const lock = path.join(directory, 'state-agy.lock');
  fs.writeFileSync(lock, '');
  await window.manual();
  assert.equal(window.callbacks.length, 1);
  assert.deepEqual(window.retryDelays, [50, 100, 200, 400]);
  assert.ok(window.logs.some(line => line.includes('chưa chạy lượt làm mới thủ công')));
  fs.unlinkSync(lock);
});
test('Tích hợp L3: đóng cửa sổ chờ giết cây và trả lease, không ghi lỗi dùng chung', async context => {
  const directory = storage(context);
  const window = openWindow(context, directory, {holdKill: true});
  await until(() => window.callbacks.length === 1);
  let finished = false;
  const closing = window.extension.deactivate().then(() => { finished = true; });
  assert.equal(window.kills.length, 1);
  assert.equal(finished, false);
  assert.deepEqual(Array.from(window.kills[0].args), ['/PID', '87654', '/T', '/F']);
  window.kills[0].callback(null);
  await closing;
  const state = window.read();
  assert.equal(state.runningSince, null);
  assert.equal(state.lastAttemptAt, null);
  assert.equal(state.consecutiveErrors, 0);
  assert.equal(state.error, undefined);
  assert.equal(window.messages.length, 0);
  const other = openWindow(context, directory);
  await until(() => other.callbacks.length === 1);
  other.finish(60);
  await until(() => other.bar.text === 'Nhóm 60% | --');
});
test('Tích hợp N5: lỗi resolveAgy được dùng chung trong tooltip, thông báo và nhật ký', async context => {
  const directory = storage(context);
  const window = openWindow(context, directory, {agyPath: path.join(directory, 'agy.cmd')});
  await until(() => window.messages.length === 1);
  const message = window.messages[0];
  assert.match(message, /chỉ hỗ trợ tệp .exe/);
  assert.ok(window.bar.tooltip.value.includes(message.replace(/^Antigravity: /, '')));
  assert.ok(window.logs.some(line => line.includes(message.replace(/^Antigravity: /, ''))));
  await window.manual();
  assert.equal(window.messages.length, 1);
  assert.equal(window.callbacks.length, 0);
});

for (const language of ['en', 'vi']) {
  test('Tích hợp ngôn ngữ ' + language + ': thanh, thông báo, nhật ký và QuickPick', async context => {
    const window = openWindow(context, storage(context), {language, groupName: 'Gemini Models'});
    const english = language === 'en';
    await until(() => window.callbacks.length === 1);
    assert.equal(window.bar.text, '$(sync~spin) Antigravity');
    assert.equal(window.bar.name, 'Antigravity');
    assert.equal(window.channelName(), 'AI Quota Bar');
    window.finish(20);
    await until(() => window.messages.length === 1);
    assert.equal(window.bar.text, 'Gemini 20% | --');
    assert.match(window.messages[0], english ? /^Antigravity: Gemini \(5-hour\) 20% remaining, resets at / :/^Antigravity: Gemini \(5 giờ\) còn 20%, reset /);
    await window.details();
    assert.equal(window.items().at(-4).label, english ? '$(refresh) Refresh now' : '$(refresh) Làm mới ngay');
    assert.equal(window.pickerOptions().placeHolder, english ? 'Choose an action or press Esc to close' : 'Chọn một thao tác hoặc nhấn Esc để đóng');
    for (const percent of [5, 60]) {
      const pending = window.manual();
      await until(() => window.callbacks.length === (percent === 5 ? 2 : 3));
      window.finish(percent); await pending;
    }
    assert.equal(window.messages.length, 3);
    assert.match(window.messages[2], english ? /recovered, 60% remaining/ : /đã hồi phục, còn 60%/);
    assert.ok(window.logs.some(line => line.includes(english ? 'source: agy' : 'nguồn: agy')));
    if (english) {
      const strings = JSON.stringify([window.bar.text, window.bar.tooltip.value, window.messages, window.logs, window.items(), window.pickerOptions()]);
      assert.doesNotMatch(strings, /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i);
    }
  });
  test('Tích hợp ngôn ngữ ' + language + ': không tìm thấy agy và nút cài đặt', async context => {
    const directory = storage(context);
    const window = openWindow(context, directory, {language, agyPath: path.join(directory, 'agy.cmd')});
    await until(() => window.messages.length === 1);
    assert.equal(window.bar.text, language === 'en' ? '$(error) Antigravity: agy not found' : '$(error) Antigravity: không tìm thấy agy');
    assert.equal(window.errorActions()[0], language === 'en' ? 'Open settings' : 'Mở cài đặt');
  });
}

const credentials = {
  '.credentials.json': {claudeAiOauth: {accessToken: 'sk-ant-oat01-FAKE-CHI-DUNG-KIEM-THU'}},
  'auth.json': {tokens: {access_token: 'eyJhbGciOiJub25lIn0.eyJmYWtlIjp0cnVlfQ.FAKE'}}
};
const apiUsage = id => id === 'claude' ? {five_hour: {utilization: 80, resets_at: '2099-01-01T00:00:00Z'}} :
  {rate_limit: {primary_window: {used_percent: 95, limit_window_seconds: 18000, reset_at: 4070908800}}};
const disabledProviders = {
  'providers.claude.enabled': false, 'providers.codex.enabled': false, 'providers.agy.enabled': false
};
for (const id of ['claude', 'codex', 'agy']) {
  test('Pha 6: ba cửa sổ bật lại ' + id + ' dùng một lease, một lượt gọi và giữ số lỗi tới khi hoàn thành', async context => {
    const directory = storage(context);
    const key = 'providers.' + id + '.enabled';
    fs.writeFileSync(path.join(directory, 'state-' + id + '.json'), JSON.stringify({
      ...require('../src/state').emptyState(), lastAttemptAt: Date.now() - 1200001, consecutiveErrors: 4
    }));
    let calls = 0;
    let finishRequest;
    const windows = Array.from({length: 3}, () => openWindow(context, directory, {
      defaultProviders: true, credentials, values: {...disabledProviders}, realLockDelays: true,
      fetch: async () => {
        calls++;
        await new Promise(resolve => { finishRequest = resolve; });
        return new Response(JSON.stringify(apiUsage(id)));
      }
    }));
    for (const window of windows) window.change({[key]: true});
    try {
      await until(() => windows.some(window => window.instances[0].fetches > 0));
    } catch (error) {
      assert.fail(error.message + ' ' + JSON.stringify(windows.map(window => ({logs: window.logs, state: window.read(id)}))));
    }
    assert.equal(windows.reduce((sum, window) => sum + window.instances[0].fetches, 0), 1);
    await until(() => id === 'agy' ? windows.some(window => window.callbacks.length) : calls > 0);
    assert.equal(windows[0].read(id).consecutiveErrors, 4);
    assert.notEqual(windows[0].read(id).runningSince, null);
    if (id === 'agy') windows.find(window => window.callbacks.length).finish(80); else finishRequest();
    await Promise.all(windows.map(window => window.tick()));
    await Promise.all(windows.map(window => window.tick()));
    assert.equal(windows.reduce((sum, window) => sum + window.instances[0].fetches, 0), 1);
    assert.equal(calls, id === 'agy' ? 0 : 1);
    assert.equal(windows.reduce((sum, window) => sum + window.callbacks.length, 0), id === 'agy' ? 1 : 0);
    assert.equal(windows[0].read(id).consecutiveErrors, 0);
    const expected = id === 'claude' ? 'Claude 20% | --' : id === 'codex' ? 'Codex 5% | --' : 'Nhóm 80% | --';
    assert.ok(windows.every(window => window.bar.text === expected));
  });
}

test('Pha 6: bật lại vẫn giữ khoảng lùi sau lỗi, không gọi nhà cung cấp hoặc xóa bộ đếm', async context => {
  const directory = storage(context);
  fs.writeFileSync(path.join(directory, 'state-codex.json'), JSON.stringify({
    ...require('../src/state').emptyState(), lastAttemptAt: Date.now() - 400000, consecutiveErrors: 5,
    error: {type: 'network', message: 'Lỗi giả lập'}
  }));
  const window = openWindow(context, directory, {defaultProviders: true, values: {...disabledProviders}});
  window.change({'providers.codex.enabled': true});
  await window.tick();
  assert.equal(window.instances[0].fetches, 0);
  assert.equal(window.credentialReads.length, 0);
  assert.equal(window.read('codex').consecutiveErrors, 5);
});

for (const language of ['en', 'vi']) for (const failAt of [0, 1]) {
  test('Pha 6: lỗi ghi cấu hình lần ' + (failAt + 1) + ' được che và báo khóa đã ghi bằng ' + language, async context => {
    const window = openWindow(context, storage(context), {defaultProviders: true, credentials, language,
      values: {'providers.agy.enabled': false},
      fetch: async url => new Response(JSON.stringify(apiUsage(url.includes('anthropic') ? 'claude' : 'codex'))),
      quickPick: () => [],
      beforeUpdate(key) {
        if (key === (failAt === 0 ? 'providers.claude.enabled' : 'providers.codex.enabled')) {
          throw new Error('Lỗi giả lập Bearer BI_MAT_GIA_LAP');
        }
      }
    });
    await window.selectProviders();
    assert.equal(window.updates.length, failAt);
    assert.equal(window.errorLogs.length, 1);
    const message = window.errorLogs[0];
    assert.ok(window.messages.includes(message));
    assert.doesNotMatch(message, /BI_MAT_GIA_LAP|Bearer/);
    assert.match(message, language === 'vi' ? /Các khóa đã ghi:/ : /Keys saved:/);
    if (failAt) assert.ok(message.includes('aiQuota.providers.claude.enabled'));
    else assert.match(message, language === 'vi' ? /Các khóa đã ghi: không có/ : /Keys saved: none/);
    assert.ok(!message.includes('aiQuota.providers.codex.enabled'));
    assert.ok(!window.messages.some(value => /thanh trạng thái sẽ trống|status bar will be empty/.test(value)));
  });
}

for (const effectiveEnabled of [true, false]) {
  test('Pha 6: thông báo tắt hết dựa trên giá trị hiệu lực sau khi ghi, còn bật: ' + effectiveEnabled, async context => {
    const options = {defaultProviders: true, values: {...disabledProviders},
      quickPick: items => effectiveEnabled ? [] : items.filter(item => item.id === 'agy'),
      afterUpdate() { options.values['providers.agy.enabled'] = effectiveEnabled; }};
    if (effectiveEnabled) options.values['providers.agy.enabled'] = true;
    const window = openWindow(context, storage(context), options);
    await window.selectProviders();
    assert.equal(window.messages.some(message => message.includes('thanh trạng thái sẽ trống')), !effectiveEnabled);
  });
}

test('Pha 6: nhãn trợ năng cập nhật khi làm mới và render, giữ tên các nhóm', async context => {
  const window = openWindow(context, storage(context));
  assert.equal(window.bar.accessibilityInformation.label, 'Antigravity');
  await until(() => window.callbacks.length === 1);
  window.finish(80);
  await until(() => window.bar.text === 'Nhóm 80% | --');
  assert.equal(window.bar.accessibilityInformation.label, 'Nhóm: 5 giờ 80%, Tuần không có');
  const pending = window.manual();
  await until(() => window.callbacks.length === 2);
  window.finish(20);
  await pending;
  assert.equal(window.bar.accessibilityInformation.label, 'Nhóm: 5 giờ 20%, Tuần không có');
  window.bar.accessibilityInformation = undefined;
  await window.tick();
  assert.equal(window.bar.accessibilityInformation.label, 'Nhóm: 5 giờ 20%, Tuần không có');
});

for (const id of ['claude', 'codex']) {
  test('Pha 6: tắt ' + id + ' trong lúc complete không ghi nhật ký thành công sau khi đóng controller', async context => {
    const directory = storage(context);
    let writes = 0;
    let finishWrite;
    const key = 'providers.' + id + '.enabled';
    const window = openWindow(context, directory, {defaultProviders: true, credentials,
      values: {...disabledProviders, [key]: true},
      fetch: async () => new Response(JSON.stringify(apiUsage(id))),
      async beforeRename(file, target) {
        if (target.endsWith('state-' + id + '.json') && ++writes === 2) {
          await new Promise(resolve => { finishWrite = resolve; });
        }
      }});
    await until(() => finishWrite);
    window.change({[key]: false});
    assert.equal(window.bar.disposed, true);
    finishWrite();
    await until(() => window.read(id).lastSuccessAt != null && !fs.existsSync(path.join(directory, 'state-' + id + '.lock')));
    await pause();
    assert.ok(!window.logs.some(message => message.includes('Làm mới: thành công')));
    assert.equal(window.messages.length, 0);
  });
}

for (const language of ['vi', 'en']) {
  test('Pha 5: chọn nhà cung cấp ghi đúng mục thay đổi ở cấu hình toàn cục, ngôn ngữ ' + language, async context => {
    let offered, settings;
    const window = openWindow(context, storage(context), {defaultProviders: true, credentials, language,
      values: {'providers.codex.enabled': false},
      fetch: async () => new Response(JSON.stringify(apiUsage('claude'))),
      quickPick(items, options) {
        offered = items; settings = options;
        return items.filter(item => item.id !== 'agy');
      }});
    await until(() => window.callbacks.length === 1 && window.bar.text === 'Claude 20% | --');
    await window.selectProviders();
    assert.equal(settings.canPickMany, true);
    assert.equal(settings.title, language === 'vi' ? 'Chọn nhà cung cấp hiển thị' : 'Choose providers to show');
    assert.deepEqual(Array.from(offered, item => [item.id, item.label, item.picked, item.description]), [
      ['claude', 'Claude Code', true, language === 'vi' ? 'API Claude Code' : 'Claude Code API'],
      ['codex', 'Codex', false, language === 'vi' ? 'API Codex' : 'Codex API'],
      ['agy', 'Antigravity', true, 'agy /usage']
    ]);
    assert.deepEqual(window.updates, [
      {key: 'providers.codex.enabled', value: true, target: 1},
      {key: 'providers.agy.enabled', value: false, target: 1}
    ]);
    assert.equal(window.bars.find(bar => bar.id === 'aiQuota.agy').disposed, true);
    assert.equal(window.messages.filter(message => message.includes('thanh trạng thái sẽ trống') || message.includes('status bar will be empty')).length, 0);
  });

  test('Pha 5: tắt hết chỉ thông báo một lần và vẫn có lệnh để bật lại, ngôn ngữ ' + language, async context => {
    const window = openWindow(context, storage(context), {defaultProviders: true, credentials, language,
      fetch: async url => new Response(JSON.stringify(apiUsage(url.includes('anthropic') ? 'claude' : 'codex'))),
      quickPick: () => []});
    await until(() => window.callbacks.length === 1 && window.bars[1].text === 'Codex 5% | --');
    window.finish(80);
    await until(() => window.bars[2].text === 'Nhóm 80% | --');
    const count = window.messages.length;
    await window.selectProviders();
    assert.deepEqual(window.updates, ['claude', 'codex', 'agy'].map(id => ({key: 'providers.' + id + '.enabled', value: false, target: 1})));
    assert.equal(window.messages.length, count + 1);
    assert.match(window.messages.at(-1), language === 'vi' ? /thanh trạng thái sẽ trống/ : /status bar will be empty/);
    assert.match(window.messages.at(-1), language === 'vi' ? /Chọn nhà cung cấp hiển thị.*Cài đặt/ : /Choose providers to show.*Settings/);
    assert.ok(window.bars.every(bar => bar.disposed));
    assert.ok(window.instances.every(instance => instance.disposals === 1));
    assert.ok(window.commands.has('aiQuota.selectProviders'));
    await window.manual();
    assert.equal(window.bars.length, 3);
  });
}

test('Pha 5: Esc không ghi cấu hình, không thông báo cả khi đang tắt hết', async context => {
  for (const values of [undefined, disabledProviders]) {
    const window = openWindow(context, storage(context), {defaultProviders: true, credentials, values,
      fetch: async url => new Response(JSON.stringify(apiUsage(url.includes('anthropic') ? 'claude' : 'codex')))});
    const count = window.messages.length;
    await window.selectProviders();
    assert.deepEqual(window.updates, []);
    assert.equal(window.messages.length, count);
    assert.equal(window.pickerOptions().canPickMany, true);
    assert.ok(window.commands.has('aiQuota.selectProviders'));
  }
});

test('Pha 5: giữ nguyên lựa chọn không ghi lại cấu hình hay thông báo', async context => {
  const window = openWindow(context, storage(context), {defaultProviders: true, credentials,
    fetch: async url => new Response(JSON.stringify(apiUsage(url.includes('anthropic') ? 'claude' : 'codex'))),
    quickPick: items => items.filter(item => item.picked)});
  await window.selectProviders();
  assert.deepEqual(window.updates, []);
  assert.equal(window.messages.length, 0);
});

for (const enabled of [true, false]) for (const action of ['selectProviders', 'settings']) {
  test('Pha 5: QuickPick gộp gọi ' + action + ' khi ' + (enabled ? 'có nguồn bật' : 'đã tắt hết'), async context => {
    let selectionOpened = false;
    const window = openWindow(context, storage(context), {values: enabled ? undefined : disabledProviders,
      quickPick(items, settings) {
        if (settings.canPickMany) { selectionOpened = true; return undefined; }
        assert.deepEqual(Array.from(items.filter(item => item.action), item => item.action), ['refresh', 'log', 'selectProviders', 'settings']);
        assert.equal(items.some(item => item.label === 'Chưa bật nhà cung cấp nào.'), !enabled);
        assert.equal(items.find(item => item.action === 'selectProviders').label, 'Chọn nhà cung cấp hiển thị');
        assert.equal(items.find(item => item.action === 'settings').label, 'Mở cài đặt');
        return items.find(item => item.action === action);
      }});
    await window.details();
    assert.deepEqual(window.executed, action === 'settings' ?
      [{name: 'workbench.action.openSettings', args: ['aiQuota.providers']}] :
      [{name: 'aiQuota.selectProviders', args: []}]);
    assert.equal(selectionOpened, action === 'selectProviders');
    assert.deepEqual(window.updates, []);
    if (!enabled) {
      assert.equal(window.bars.length, 0);
      assert.equal(window.instances.length, 0);
      assert.equal(window.credentialReads.length, 0);
    }
  });
}

for (const id of ['claude', 'codex', 'agy']) {
  test('Pha 5: tắt rồi bật ' + id + ' giữ kho, ngừng đọc và chỉ làm mới khi đến hạn hoặc thủ công', async context => {
    const directory = storage(context);
    const key = 'providers.' + id + '.enabled';
    let finishRequest;
    let calls = 0;
    const window = openWindow(context, directory, {defaultProviders: true, credentials,
      values: {...disabledProviders, [key]: true},
      fetch: async () => {
        calls++;
        if (calls === 2) await new Promise(resolve => { finishRequest = resolve; });
        return new Response(JSON.stringify(apiUsage(id)));
      }});
    if (id === 'agy') {
      await until(() => window.callbacks.length === 1);
      window.finish(80);
    }
    const expected = id === 'claude' ? 'Claude 20% | --' : id === 'codex' ? 'Codex 5% | --' : 'Nhóm 80% | --';
    await until(() => window.bar.text === expected);
    const stateFile = path.join(directory, 'state-' + id + '.json');
    const before = fs.readFileSync(stateFile, 'utf8');
    const messages = window.messages.length;
    window.change({[key]: false});
    assert.equal(window.bar.disposed, true);
    assert.equal(window.instances[0].disposals, 1);
    await window.manual();
    await window.tick();
    window.change({agyPath: process.execPath, claudeConfigDir: '/đường-dẫn-giả', codexHome: '/đường-dẫn-giả'});
    await window.manual();
    assert.equal(window.instances.length, 1);
    assert.equal(window.instances[0].fetches, 1);
    assert.equal(window.callbacks.length, id === 'agy' ? 1 : 0);
    assert.equal(calls, id === 'agy' ? 0 : 1);
    assert.deepEqual(window.credentialReads, id === 'agy' ? [] : [id === 'claude' ? '.credentials.json' : 'auth.json']);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
    assert.equal(window.messages.length, messages);
    window.change({[key]: true});
    await window.tick();
    assert.equal(window.bars[1].text, expected);
    assert.equal(window.instances[1].fetches, 0);
    assert.equal(calls, id === 'agy' ? 0 : 1);
    assert.equal(window.callbacks.length, id === 'agy' ? 1 : 0);
    const manual = window.manual();
    await until(() => id === 'agy' ? window.callbacks.length === 2 : calls === 2);
    assert.equal(window.bars.length, 2);
    assert.equal(window.instances[1].fetches, 1);
    assert.equal(window.instances[1].disposals, 0);
    assert.equal(window.bars[1].text, '$(sync~spin) ' + expected);
    assert.deepEqual(window.read(id).buckets, JSON.parse(before).buckets);
    assert.equal(window.credentialReads.length, id === 'agy' ? 0 : 2);
    if (id === 'agy') window.finish(80); else finishRequest();
    await manual;
    await until(() => window.bars[1].text === expected);
    assert.equal(window.instances[0].fetches, 1);
    assert.equal(window.instances[0].disposals, 1);
  });

  test('Pha 5: tắt ' + id + ' đang chạy hủy lượt, trả lease và giữ dữ liệu đệm', async context => {
    const directory = storage(context);
    const key = 'providers.' + id + '.enabled';
    let signal;
    let calls = 0;
    const window = openWindow(context, directory, {defaultProviders: true, credentials,
      values: {...disabledProviders, [key]: true},
      fetch: async (url, init) => {
        calls++;
        if (calls === 2) { signal = init.signal; return new Promise(() => {}); }
        return new Response(JSON.stringify(apiUsage(id)));
      }});
    if (id === 'agy') {
      await until(() => window.callbacks.length === 1);
      window.finish(80);
    }
    await until(() => !window.bar.text.includes('sync~spin'));
    const before = window.read(id);
    const pending = window.manual();
    await until(() => id === 'agy' ? window.callbacks.length === 2 : calls === 2);
    window.change({[key]: false});
    await pending;
    assert.equal(window.bar.disposed, true);
    assert.equal(window.instances[0].disposals, 1);
    if (id === 'agy') assert.equal(window.kills.length, 1); else assert.equal(signal.aborted, true);
    const after = window.read(id);
    assert.equal(after.runningSince, null);
    for (const field of ['buckets', 'lastSuccessAt', 'lastAttemptAt', 'levels', 'consecutiveErrors', 'error']) {
      assert.deepEqual(after[field], before[field], field);
    }
    await window.manual();
    await window.tick();
    assert.equal(window.instances[0].fetches, 2);
    assert.equal(window.credentialReads.length, id === 'agy' ? 0 : 2);
    assert.equal(calls, id === 'agy' ? 0 : 2);
  });
}

for (const [remaining, background] of [[31, undefined], [30, 'statusBarItem.warningBackground'], [10, 'statusBarItem.errorBackground']]) {
  test('Pha 4 tích hợp: giới hạn phụ còn ' + remaining + '% áp dụng đúng nền thanh VS Code', async context => {
    const window = openWindow(context, storage(context), {defaultProviders: true, credentials,
      values: {'providers.codex.enabled': false, 'providers.agy.enabled': false},
      fetch: async () => new Response(JSON.stringify({limits: [
        {kind: 'session', percent: 16, resets_at: '2099-01-01T00:00:00Z'},
        {kind: 'weekly_all', percent: 29, resets_at: '2099-01-01T00:00:00Z'},
        {kind: 'weekly_scoped', percent: 100 - remaining, resets_at: '2099-01-01T00:00:00Z', scope: {surface: 'Mô hình riêng'}}
      ]}))});
    const expected = 'Claude 84% | 71%' + (background ? ' | Mô hình riêng ' + remaining + '%' : '');
    await until(() => window.bar.text === expected);
    assert.equal(window.bar.backgroundColor?.id, background);
    assert.ok(window.bar.tooltip.value.includes('Mô hình riêng'));
    await window.details();
    assert.ok(window.items().some(item => item.label.includes('Mô hình riêng: ' + remaining + '%')));
  });
}

test('Đa nhà cung cấp: thứ tự, màu riêng, QuickPick gộp, làm mới tất cả và nhật ký có tiền tố', async context => {
  const calls = [];
  const window = openWindow(context, storage(context), {defaultProviders: true, credentials,
    fetch: async url => {
      const id = url.includes('anthropic') ? 'claude' : 'codex'; calls.push(id);
      return new Response(JSON.stringify(apiUsage(id)));
    }});
  await until(() => window.callbacks.length === 1 && window.bars[0].text === 'Claude 20% | --' && window.bars[1].text === 'Codex 5% | --');
  window.finish(80);
  await until(() => window.bars[2].text === 'Nhóm 80% | --');
  assert.deepEqual(window.bars.map(b => b.priority), [100, 99, 98]);
  assert.deepEqual(window.bars.map(b => b.id), ['aiQuota.claude', 'aiQuota.codex', 'aiQuota.agy']);
  assert.ok(window.bars.every(b => b.alignment === 2));
  assert.deepEqual(window.bars.map(b => b.name), ['Claude Code', 'Codex', 'Antigravity']);
  assert.equal(window.bars[0].backgroundColor.id, 'statusBarItem.warningBackground');
  assert.equal(window.bars[1].backgroundColor.id, 'statusBarItem.errorBackground');
  assert.equal(window.bars[2].backgroundColor, undefined);
  for (const bar of window.bars) { assert.equal(bar.command, 'aiQuota.showDetails'); assert.equal(bar.tooltip.isTrusted, false); }
  assert.match(window.bars[0].tooltip.value, /Quota Claude Code/);
  assert.match(window.bars[1].tooltip.value, /Quota Codex/);
  assert.ok(window.messages.some(m => m.startsWith('Claude Code: ')));
  assert.ok(window.messages.some(m => m.startsWith('Codex: ')));
  await window.details();
  assert.deepEqual(Array.from(window.items().filter(i => i.kind === -1), i => i.label), ['Claude Code', 'Codex', 'Antigravity', '']);
  assert.deepEqual(Array.from(window.items().slice(-4), i => i.action), ['refresh', 'log', 'selectProviders', 'settings']);
  const pending = window.manual();
  await until(() => window.callbacks.length === 2 && calls.length === 4);
  window.finish(80); await pending;
  assert.ok(window.logs.every(line => /^\[(Claude Code|Codex|Antigravity)\] /.test(line)));
  const visible = JSON.stringify([window.bars, window.items(), window.messages, window.logs,
    window.read('claude'), window.read('codex'), window.read('agy')]);
  for (const token of [credentials['.credentials.json'].claudeAiOauth.accessToken, credentials['auth.json'].tokens.access_token]) assert.ok(!visible.includes(token));
});
test('Đa nhà cung cấp: lỗi xác thực hoặc ném ngoại lệ không ngăn nhà cung cấp khác', async context => {
  const directory = storage(context);
  const window = openWindow(context, directory, {defaultProviders: true, credentials,
    fetch: async url => url.includes('anthropic') ?
      new Response(JSON.stringify({error: credentials['.credentials.json'].claudeAiOauth.accessToken}), {status: 401}) :
      new Response(JSON.stringify(apiUsage('codex')))});
  await until(() => window.callbacks.length === 1 && window.bars[0].text.includes('chưa đăng nhập') && window.bars[1].text === 'Codex 5% | --');
  assert.equal(window.read('claude').error.type, 'auth');
  assert.equal(window.bars[0].backgroundColor, undefined);
  window.finish(70); await until(() => window.bars[2].text === 'Nhóm 70% | --');
  assert.ok(!JSON.stringify([window.bars, window.logs, window.read('claude')]).includes(credentials['.credentials.json'].claudeAiOauth.accessToken));
  // Buộc claim của Claude lỗi ở hệ thống tệp, rồi xác nhận lệnh làm mới chung vẫn chờ Codex và agy.
  fs.unlinkSync(path.join(directory, 'state-claude.json'));
  fs.mkdirSync(path.join(directory, 'state-claude.json'));
  const pending = window.manual();
  await until(() => window.callbacks.length === 2);
  window.finish(60); const results = await pending;
  assert.equal(results.length, 3); assert.equal(window.bars[2].text, 'Nhóm 60% | --');
  assert.ok(window.logs.some(line => line.startsWith('[Claude Code] ') && line.includes('Không cập nhật được trạng thái')));
});
test('Đa nhà cung cấp: tắt không tạo mục hay gọi; bật/tắt khi đang chạy hủy lượt riêng', async context => {
  let calls = 0;
  const window = openWindow(context, storage(context), {defaultProviders: true, credentials,
    values: {'providers.claude.enabled': false, 'providers.codex.enabled': false, 'providers.agy.enabled': false},
    fetch: () => {calls++; return new Promise(() => {});}});
  await window.manual(); assert.equal(window.bars.length, 0); assert.equal(calls, 0); assert.equal(window.callbacks.length, 0);
  await window.details(); assert.match(window.items()[0].label, /Chưa bật/);
  window.change({'providers.claude.enabled': true});
  await until(() => calls === 1);
  assert.equal(window.bars.length, 1);
  window.change({'providers.claude.enabled': false, 'providers.agy.enabled': true});
  await until(() => window.callbacks.length === 1 && window.read('claude').runningSince === null);
  assert.equal(window.bars[0].disposed, true);
  assert.equal(window.read('claude').consecutiveErrors, 0);
  assert.equal(calls, 1); window.finish(80);
  await until(() => window.bars[1].text === 'Nhóm 80% | --');
});
test('Đa nhà cung cấp: Claude chậm vẫn cho Codex cập nhật ngay', async context => {
  const window = openWindow(context, storage(context), {defaultProviders: true, credentials,
    values: {'providers.agy.enabled': false},
    fetch: url => url.includes('anthropic') ? new Promise(() => {}) : Promise.resolve(new Response(JSON.stringify(apiUsage('codex'))))});
  await until(() => window.bars[1].text === 'Codex 5% | --');
  assert.match(window.bars[0].text, /sync~spin/);
  await window.extension.deactivate();
  assert.equal(window.read('claude').runningSince, null);
});

test('Pha 3 mục 3: QuickPick giữ tiêu đề chung, từng nguồn có giờ cập nhật và dấu dữ liệu cũ', async context => {
  for (const language of ['vi', 'en']) {
    const window = openWindow(context, storage(context), {defaultProviders: true, credentials, language,
      fetch: async url => new Response(JSON.stringify(apiUsage(url.includes('anthropic') ? 'claude' : 'codex')))});
    await until(() => window.callbacks.length === 1 && window.bars[0].text === 'Claude 20% | --' && window.bars[1].text === 'Codex 5% | --');
    window.finish(60); await until(() => window.bars[2].text === 'Nhóm 60% | --');
    await window.details();
    assert.equal(window.pickerOptions().title, 'AI Quota Bar');
    const items = window.items();
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === -1 && items[i].label) {
        assert.match(items[i + 1].label, language === 'vi' ? /^cập nhật \d{2}:\d{2}$/ : /^last updated: \d{2}:\d{2}$/);
        assert.equal(items[i + 1].action, undefined);
      }
    }
    const pending = window.manual();
    await until(() => window.callbacks.length === 2);
    window.callbacks[1](null, 'Đầu ra hỏng', ''); await pending;
    await window.details();
    const index = window.items().findIndex(item => item.label === 'Antigravity');
    assert.match(window.items()[index + 1].label, language === 'vi' ? /\(dữ liệu cũ\)$/ : /\(stale data\)$/);
  }
});

test('Pha 3 mục 6: làm mới thủ công trong Retry-After ghi đúng một dòng, không gọi API', async context => {
  for (const language of ['vi', 'en']) {
    let calls = 0;
    const window = openWindow(context, storage(context), {defaultProviders: true, credentials, language,
      values: {'providers.claude.enabled': false, 'providers.agy.enabled': false},
      fetch: async () => { calls++; return new Response('', {status: 429, headers: {'Retry-After': '900'}}); }});
    await until(() => window.logs.some(line => line.includes(language === 'vi' ? 'Quá nhiều yêu cầu' : 'Too many requests')));
    const count = window.logs.length;
    await window.manual();
    assert.equal(calls, 1); assert.equal(window.logs.length, count + 1);
    assert.match(window.logs.at(-1), language === 'vi' ? /Đang chờ giới hạn tần suất tới \d{2}:\d{2}/ :
      /Waiting for the rate limit until \d{2}:\d{2}/);
  }
});

test('Pha 3 mục 7: Retry-After chưa lưu vẫn nhận thành công mới hơn và tiếp tục chặn API', async context => {
  const directory = storage(context);
  const lock = path.join(directory, 'state-codex.lock');
  let firstCalls = 0;
  const first = openWindow(context, directory, {defaultProviders: true, credentials,
    values: {'providers.claude.enabled': false, 'providers.agy.enabled': false},
    fetch: async () => {
      firstCalls++;
      if (firstCalls === 1) return new Response(JSON.stringify(apiUsage('codex')));
      fs.writeFileSync(lock, '');
      return new Response('', {status: 429, headers: {'Retry-After': '3600'}});
    }});
  await until(() => first.bar.text === 'Codex 5% | --');
  await first.manual();
  assert.equal(first.bar.text, '$(history) Codex 5% | --');
  assert.ok(first.logs.some(line => line.includes('vẫn hiển thị kết quả cục bộ')));
  fs.unlinkSync(lock);
  await first.tick();
  assert.equal(first.bar.text, '$(history) Codex 5% | --');
  let secondCalls = 0;
  const second = openWindow(context, directory, {defaultProviders: true, credentials,
    values: {'providers.claude.enabled': false, 'providers.agy.enabled': false},
    fetch: async () => { secondCalls++; return new Response(JSON.stringify({rate_limit: {
      primary_window: {used_percent: 20, limit_window_seconds: 18000, reset_at: 4070908800}
    }})); }});
  await until(() => second.bar.text === 'Codex 5% | --');
  await second.manual();
  assert.equal(secondCalls, 1);
  assert.equal(second.bar.text, 'Codex 80% | --');
  await first.tick();
  assert.equal(first.bar.text, 'Codex 80% | --');
  assert.equal(firstCalls, 2);
  const count = first.logs.length;
  await first.manual();
  assert.equal(first.bar.text, 'Codex 80% | --'); assert.equal(firstCalls, 2);
  assert.equal(first.logs.length, count + 1);
  assert.match(first.logs.at(-1), /Đang chờ giới hạn tần suất tới \d{2}:\d{2}/);
});
