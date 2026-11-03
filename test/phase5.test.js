'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../package.json');
const en = require('../package.nls.json');
const vi = require('../package.nls.vi.json');
const messages = require('../src/messages');

test('Pha 5: Settings xếp ba công tắc đầu tiên, các mục còn lại có thứ tự sau', () => {
  const properties = manifest.contributes.configuration.properties;
  const sorted = Object.entries(properties).sort((a, b) => a[1].order - b[1].order);
  assert.deepEqual(sorted.slice(0, 3).map(([key]) => key), [
    'aiQuota.providers.claude.enabled', 'aiQuota.providers.codex.enabled', 'aiQuota.providers.agy.enabled'
  ]);
  assert.equal(new Set(sorted.map(([, value]) => value.order)).size, sorted.length);
  sorted.forEach(([, value], index) => assert.equal(value.order, index + 1));
  for (const [index, id] of ['claude', 'codex', 'agy'].entries()) {
    const key = 'configuration.providers.' + id + '.enabled';
    const setting = properties['aiQuota.providers.' + id + '.enabled'];
    assert.equal(setting.type, 'boolean');
    assert.equal(setting.default, true);
    assert.equal(setting.scope, 'application');
    assert.equal(setting.order, index + 1);
    assert.equal(setting.markdownDescription, '%' + key + '%');
    assert.equal(setting.description, undefined);
    assert.match(vi[key], /thanh trạng thái.*Tắt nếu không còn dùng/);
    assert.match(en[key], /status bar.*Turn off if you no longer use it/);
    if (id === 'agy') {
      assert.match(vi[key], /không chạy agy/);
      assert.match(en[key], /does not run agy/);
    } else {
      assert.match(vi[key], /không đọc thông tin đăng nhập.*không gọi API/);
      assert.match(en[key], /does not read .* credentials or call its API/);
    }
  }
});

test('Pha 5: lệnh luôn có trong manifest, đủ khóa đối xứng và bản dịch không có biểu tượng', () => {
  assert.equal(manifest.version, '0.1.1');
  const command = manifest.contributes.commands.find(item => item.command === 'aiQuota.selectProviders');
  assert.deepEqual(command, {
    command: 'aiQuota.selectProviders', title: '%command.selectProviders%', category: '%command.category%'
  });
  assert.deepEqual(Object.keys(en).sort(), Object.keys(vi).sort());
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages.vi).sort());
  assert.equal(en['command.selectProviders'], 'Choose providers to show');
  assert.equal(vi['command.selectProviders'], 'Chọn nhà cung cấp hiển thị');
  for (const locale of ['en', 'vi']) {
    const nls = locale === 'vi' ? vi : en;
    assert.equal(messages[locale]['action.selectProviders'], nls['command.selectProviders']);
    for (const key of ['action.selectProviders', 'picker.providersPlaceholder', 'picker.source.claude',
      'picker.source.codex', 'picker.source.agy', 'notification.providersDisabled']) {
      assert.equal(typeof messages[locale][key], 'string', key);
      assert.ok(messages[locale][key].length > 0, key);
      assert.doesNotMatch(messages[locale][key], /\p{Extended_Pictographic}|\$\(/u, key);
    }
  }
});
