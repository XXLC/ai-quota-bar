'use strict';
const {t, setLocale, localeFor} = require('./i18n');
const vscode = require('vscode');
const fs = require('node:fs');
const {createStore, emptyState, localResult} = require('./state');
const {configuration, retryDeadline} = require('./thresholds');
const {display, notification, sanitize, clock} = require('./format');
const providers = [require('./providers/claude'), require('./providers/codex'), require('./providers/agy')];
const providerName = id => t(id === 'claude' ? 'provider.claude' : id === 'codex' ? 'provider.codex' : 'provider.agy');
let shutdown = () => Promise.resolve();
function createController(provider, bar, store, getConfig, log) {
  let state = {...emptyState(), runningSince: Date.now()};
  let busy = null;
  let closed = false;
  let notFoundShown = false;
  let pathRefreshPending = false;
  let lastCacheLoggedAt = -Infinity;
  let unpersistedState = null;
  let unpersistedRetryAt = null;
  function render() {
    if (closed) return;
    const model = display(state, Date.now(), getConfig(), provider);
    bar.text = model.text;
    bar.accessibilityInformation = {label: model.accessibilityLabel};
    bar.backgroundColor = model.severity === 'critical' ? new vscode.ThemeColor('statusBarItem.errorBackground') :
      model.severity === 'warning' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    const tooltip = new vscode.MarkdownString(model.tooltip, true);
    tooltip.isTrusted = false;
    bar.tooltip = tooltip;
    bar.show();
  }
  function notify(result) {
    if (closed || !result?.events?.length) return;
    const message = notification(result, provider);
    if (result.severity === 'critical') void vscode.window.showErrorMessage(message);
    else if (result.severity === 'warning') void vscode.window.showWarningMessage(message);
    else void vscode.window.showInformationMessage(message);
  }
  async function refresh(manual = false) {
    if (closed) return;
    if (busy) return busy;
    busy = (async () => {
      try {
        unpersistedRetryAt = retryDeadline({retryAt: unpersistedRetryAt}, Date.now());
        if (unpersistedRetryAt > Date.now()) {
          const shared = await store.read();
          if ((shared.lastSuccessAt ?? -Infinity) > (state.lastSuccessAt ?? -Infinity)) {
            state = shared;
            unpersistedState = null;
          }
          if (manual && !closed) log.info(t('log.retryWaiting', clock(unpersistedRetryAt)));
          return;
        }
        const claim = await store.claim(getConfig(), manual);
        const shared = claim.state;
        const keepLocal = !claim.claimed && unpersistedState &&
          (shared.lastSuccessAt ?? -Infinity) <= (unpersistedState.lastSuccessAt ?? -Infinity) &&
          (shared.lastAttemptAt ?? -Infinity) <= (unpersistedState.lastAttemptAt ?? -Infinity);
        if (!keepLocal) unpersistedState = null;
        state = {...(keepLocal ? unpersistedState : shared), manualRefresh: manual && claim.claimed};
        if (closed) {
          if (claim.claimed) await store.release(claim);
          return;
        }
        render();
        if (!claim.claimed) {
          // Chỉ cửa sổ thực sự gọi nhà cung cấp phát thông báo, sau khi lưu mức dưới khóa.
          if (claim.waitingUntil && manual) {
            log.info(t('log.retryWaiting', clock(claim.waitingUntil)));
          } else if (claim.busy && manual) {
            log.warn(t('log.lockBusy'));
          } else if (!keepLocal && state.lastSuccessAt != null && state.lastSuccessAt > lastCacheLoggedAt) {
            lastCacheLoggedAt = state.lastSuccessAt;
            const age = Math.max(0, Math.floor((Date.now() - state.lastSuccessAt) / 1000));
            log.info(t('log.cache', age));
          }
          return;
        }
        const result = await provider.fetch(getConfig());
        if (closed || result.cancelled) {
          const released = await store.release(claim);
          state = {...released.state, runningSince: null};
          return;
        }
        let completed;
        try {
          completed = await store.complete(result, getConfig(), claim);
        } catch (error) {
          completed = {busy: true};
          log.warn(t('log.writeFailed', sanitize(error?.message, 200)));
        }
        if (completed.busy) {
          state = localResult(claim.state, result, Date.now());
          unpersistedState = state;
          unpersistedRetryAt = state.retryAt;
          log.warn(t('log.localResult'));
        } else {
          state = completed.state;
          lastCacheLoggedAt = Math.max(lastCacheLoggedAt, state.lastSuccessAt ?? -Infinity);
          notify(completed.notification);
        }
        if (!closed && provider.id !== 'agy') {
          if (result.error) log.warn(t('log.failure', result.error.type, result.error.message));
          else log.info(t('log.providerSuccess', result.buckets.length));
        }
        if (result.error?.type === 'not-found' && !notFoundShown && !closed) {
          notFoundShown = true;
          void vscode.window.showErrorMessage(provider.name + ': ' + result.error.message, t('action.settings')).then(choice => {
            if (choice) void vscode.commands.executeCommand('workbench.action.openSettings', 'aiQuota.agyPath');
          });
        }
      } catch (error) {
        state = {...state, runningSince: null, manualRefresh: false,
          error: {type: 'spawn', message: sanitize(t('error.updateState', sanitize(error?.message, 200)), 200)}};
        if (!closed) log.error(state.error.message);
      } finally {
        busy = null;
        render();
        if (pathRefreshPending && !closed) {
          pathRefreshPending = false;
          void refresh(true);
        }
      }
    })();
    return busy;
  }
  return {
    render, refresh,
    model: () => display(state, Date.now(), getConfig(), provider),
    changed(pathChanged) {
      render();
      if (!pathChanged) return;
      if (busy) pathRefreshPending = true;
      else void refresh(true);
    },
    async dispose() {
      closed = true;
      bar.dispose();
      await Promise.allSettled([provider.dispose(), busy]);
    }
  };
}
function activate(context) {
  setLocale(localeFor(vscode.env?.language));
  const output = vscode.window.createOutputChannel(t('channel.name'), {log: true});
  const controllers = new Map();
  const stopping = new Set();
  let config;
  let closed = false;
  function readConfig() {
    const values = vscode.workspace.getConfiguration('aiQuota');
    const keys = ['agyPath', 'claudeConfigDir', 'codexHome', 'refreshInterval', 'timeout',
      'warningThreshold', 'criticalThreshold', 'notificationEnabled',
      'providers.claude.enabled', 'providers.codex.enabled', 'providers.agy.enabled'];
    config = configuration(Object.fromEntries(keys.map(key => [key, values.get(key)])));
  }
  function stop(controller) {
    const pending = controller.dispose();
    stopping.add(pending);
    void pending.finally(() => stopping.delete(pending));
  }
  function reconcile(previous = {}) {
    providers.forEach((definition, index) => {
      const id = definition.id;
      if (config['providers.' + id + '.enabled'] === false) {
        if (controllers.has(id)) stop(controllers.get(id));
        controllers.delete(id);
        return;
      }
      const pathKey = id === 'claude' ? 'claudeConfigDir' : id === 'codex' ? 'codexHome' : 'agyPath';
      if (controllers.has(id)) {
        controllers.get(id).changed(previous[pathKey] !== config[pathKey]);
        return;
      }
      const name = providerName(id);
      const log = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, message => {
        if (!closed) output[level](t('log.provider', name, sanitize(message, 1000)));
      }]));
      const provider = {...definition.createProvider({log: message => log.info(message)}),
        name, label: id === 'claude' ? 'Claude' : name};
      const bar = vscode.window.createStatusBarItem('aiQuota.' + id, vscode.StatusBarAlignment.Right, 100 - index);
      bar.name = name;
      bar.command = 'aiQuota.showDetails';
      const store = createStore({directory: context.globalStorageUri.fsPath, fs: fs.promises, name: id});
      const controller = createController(provider, bar, store, () => config, log);
      controllers.set(id, controller);
      controller.render();
      void controller.refresh(false);
    });
  }
  const refresh = manual => Promise.allSettled([...controllers.values()].map(controller => controller.refresh(manual)));
  async function selectProviders() {
    const items = providers.map(({id}) => ({
      id, label: providerName(id),
      description: t(id === 'claude' ? 'picker.source.claude' : id === 'codex' ? 'picker.source.codex' : 'picker.source.agy'),
      picked: config['providers.' + id + '.enabled'] !== false
    }));
    const selected = await vscode.window.showQuickPick(items, {
      title: t('action.selectProviders'), placeHolder: t('picker.providersPlaceholder'), canPickMany: true
    });
    if (selected === undefined) return;
    const enabled = new Set(selected.map(item => item.id));
    const values = vscode.workspace.getConfiguration('aiQuota');
    const written = [];
    try {
      for (const {id} of providers) {
        const key = 'providers.' + id + '.enabled';
        if ((values.get(key) !== false) !== enabled.has(id)) {
          await values.update(key, enabled.has(id), vscode.ConfigurationTarget.Global);
          written.push('aiQuota.' + key);
        }
      }
    } catch (error) {
      const message = t('error.providersUpdate', written.join(', ') || t('common.none'), sanitize(error?.message, 200));
      output.error(message);
      await vscode.window.showErrorMessage(message);
    }
    const effective = vscode.workspace.getConfiguration('aiQuota');
    if (providers.every(({id}) => effective.get('providers.' + id + '.enabled') === false)) {
      await vscode.window.showInformationMessage(t('notification.providersDisabled'));
    }
  }
  async function details() {
    const items = [];
    for (const definition of providers) {
      const controller = controllers.get(definition.id);
      if (!controller) continue;
      const name = providerName(definition.id);
      const model = controller.model();
      items.push({label: name, kind: vscode.QuickPickItemKind.Separator});
      items.push({label: model.updated});
      // Các giới hạn được gộp vào cùng một danh sách chọn.
      items.push(...model.items.filter(item => !item.separator && !item.action));
    }
    if (!controllers.size) items.push({label: t('picker.disabled')});
    items.push({label: '', kind: vscode.QuickPickItemKind.Separator},
      {label: t('action.refresh'), action: 'refresh'}, {label: t('action.log'), action: 'log'},
      {label: t('action.selectProviders'), action: 'selectProviders'}, {label: t('action.settings'), action: 'settings'});
    const selected = await vscode.window.showQuickPick(items, {
      title: t('picker.combinedTitle'), placeHolder: t('picker.placeholder')
    });
    if (selected?.action === 'refresh') await refresh(true);
    if (selected?.action === 'log') output.show();
    if (selected?.action === 'selectProviders') await vscode.commands.executeCommand('aiQuota.selectProviders');
    if (selected?.action === 'settings') await vscode.commands.executeCommand('workbench.action.openSettings', 'aiQuota.providers');
  }
  readConfig();
  reconcile();
  const interval = setInterval(() => {
    for (const controller of controllers.values()) controller.render();
    return refresh(false);
  }, 60000);
  context.subscriptions.push(output, {dispose: () => clearInterval(interval)},
    vscode.commands.registerCommand('aiQuota.refresh', () => refresh(true)),
    vscode.commands.registerCommand('aiQuota.showDetails', details),
    vscode.commands.registerCommand('aiQuota.showLog', () => output.show()),
    vscode.commands.registerCommand('aiQuota.selectProviders', selectProviders),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (closed || !event.affectsConfiguration('aiQuota')) return;
      const previous = config;
      readConfig();
      reconcile(previous);
    }));
  shutdown = () => {
    if (!closed) {
      closed = true;
      clearInterval(interval);
      for (const controller of controllers.values()) stop(controller);
      controllers.clear();
    }
    // Giữ trần thời gian đóng cửa sổ khi thao tác đĩa bị treo.
    return new Promise(resolve => {
      const timer = setTimeout(resolve, 2500);
      Promise.allSettled([...stopping]).then(() => { clearTimeout(timer); resolve(); });
    });
  };
  context.subscriptions.push({dispose: shutdown});
}
function deactivate() { return shutdown(); }
module.exports = {activate, deactivate};
