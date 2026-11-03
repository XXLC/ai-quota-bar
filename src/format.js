'use strict';
const {t} = require('./i18n');
const {sanitize, removeControls} = require('./parse');
const {level, isStale, configuration, worstLevel} = require('./thresholds');
const escapeMarkdown = text => removeControls(text)
  .replace(/[\\`*_[\]<>|#]/g, '\\$&').replace(/:\/\//g, '\\://')
  .replace(/\b(www)\./gi, '$1\\.').replace(/\$\(/g, '\\$(');
const labelText = text => sanitize(String(text), 120).replace(/\$\(/g, '＄(');
const safeText = text => labelText(text).replace(/[\[\]]/g, '');
const lowest = items => items.reduce((a, b) => !a || b.percent < a.percent ? b : a, undefined);
const compactLabel = text => [...text].length > 16 ? [...text].slice(0, 15).join('') + '…' : text;
const pad = value => String(value).padStart(2, '0');
const levelLabel = severity => severity === 'critical' ? t('level.critical') :
  severity === 'warning' ? t('level.warning') : '';
const levelIcon = severity => severity === 'critical' ? '$(error) ' :
  severity === 'warning' ? '$(warning) ' : '';
const clock = value => {
  const date = new Date(value);
  return pad(date.getHours()) + ':' + pad(date.getMinutes());
};
function resetTime(value) {
  if (value == null) return t('time.unknown');
  const date = new Date(value);
  return t('time.reset', clock(value), t('time.days').split(',')[date.getDay()],
    pad(date.getDate()), t('time.months').split(',')[date.getMonth()]);
}
function countdown(reset, now) {
  if (reset == null) return t('time.unknown');
  const milliseconds = reset - now;
  const minutes = Math.floor(milliseconds / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  return milliseconds <= 0 ? t('time.reached') : days ? t('time.remainingDays', days, hours % 24) :
    hours ? t('time.remainingHours', hours, minutes % 60) : minutes ? t('time.remainingMinutes', minutes) : t('time.underMinute');
}
const ago = (time, now) => now - time < 60000 ? t('time.justNow') :
  t('time.ago', Math.floor(Math.max(0, now - time) / 60000));
function display(state, now, config = {}, provider) {
  const values = configuration(config);
  const stale = isStale(state, now, values);
  const rows = (state.buckets || []).map(bucket => {
    const severity = level(bucket, now, values);
    return {
      ...bucket, groupLabel: labelText(bucket.groupLabel), windowLabel: labelText(bucket.windowKey === '5h' ? t('window.fiveHour') :
        bucket.windowKey === 'weekly' ? t('window.weekly') : bucket.windowLabel),
      severity, value: severity === 'unknown' ? '?%' : bucket.percent + '%',
      reset: resetTime(bucket.resetAt), remaining: countdown(bucket.resetAt, now)
    };
  });
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.groupName)) groups.set(row.groupName, []);
    groups.get(row.groupName).push(row);
  }
  const selected = [...groups.values()].map(items => {
    const valid = items.filter(item => item.severity !== 'unknown');
    return lowest(valid.length ? valid : items);
  });
  let severity = worstLevel(selected.map(bucket => bucket.severity));
  const summaries = [...groups.values()].map(items => {
    const fiveHour = lowest(items.filter(row => row.windowKey === '5h'));
    const weekly = lowest(items.filter(row => row.windowKey === 'weekly'));
    const others = items.filter(row => row.windowKey.startsWith('other:'));
    const candidates = others.filter(row => !fiveHour || !weekly ||
      row.severity === 'warning' || row.severity === 'critical');
    const valid = candidates.filter(row => row.severity !== 'unknown');
    const extra = lowest(valid.length ? valid : candidates);
    const suffix = extra ? compactLabel(extra.windowLabel) + ' ' + extra.value +
      (others.length > 1 ? ' +' + (others.length - 1) : '') : '';
    const text = items[0].groupLabel + ' ' + (fiveHour || weekly ?
      (fiveHour?.value || '--') + ' | ' + (weekly?.value || '--') + (suffix ? ' | ' + suffix : '') : suffix);
    const spokenValue = row => !row ? t('accessibility.missing') :
      row.severity === 'unknown' ? t('accessibility.unknown') : row.value;
    const label = t('accessibility.group', items[0].groupLabel, t('window.fiveHour'), spokenValue(fiveHour),
      t('window.weekly'), spokenValue(weekly)) + others.map(row => ', ' + row.windowLabel + ' ' + spokenValue(row)).join('');
    return {text, label};
  });
  let text = summaries.map(group => group.text).join(' · ');
  if (!text) {
    text = state.runningSince != null ? provider?.name || t('channel.name') :
      state.error?.type === 'not-found' ? t('bar.notFound', provider?.name || t('provider.agy')) :
      provider ? t('bar.providerError', provider.label || provider.name) : t('bar.error');
  }
  if (provider && state.error?.type === 'auth') {
    text = t('bar.auth', provider.label || provider.name);
    severity = 'ok';
  }
  text = (stale && rows.length ? '$(history) ' : !rows.length && state.runningSince == null ? '$(error) ' : '') + text;
  if (state.manualRefresh || (!rows.length && state.runningSince != null)) text = '$(sync~spin) ' + text;
  const accessibilityLabel = !rows.length || state.error?.type === 'auth' ? text.replace(/\$\([^)]+\)\s*/g, '') :
    summaries.map(group => group.label).join('; ');
  const loading = !rows.length && state.runningSince != null && !state.error;
  const error = sanitize(state.error?.message || t('error.readQuota'), 200);
  let tooltip = provider ? t('tooltip.providerHeader', escapeMarkdown(provider.name)) : t('tooltip.header');
  if (stale && rows.length) {
    tooltip += t('tooltip.stale') + (state.error ? t('tooltip.refreshFailed', state.lastAttemptAt == null ? '' : t('time.at', clock(state.lastAttemptAt)), escapeMarkdown(error)) : t('tooltip.expired')) + '\n\n';
  }
  if (!rows.length) {
    tooltip += loading ? t('tooltip.loading') : '$(error) ' + escapeMarkdown(error) +
      t('tooltip.openLog');
  } else {
    tooltip += t('tooltip.columns');
    for (const row of rows) {
      const value = escapeMarkdown(row.value + levelLabel(row.severity));
      tooltip += '| ' + [escapeMarkdown(row.groupLabel), escapeMarkdown(row.windowLabel),
        row.severity === 'critical' ? '**' + value + '**' : value,
        escapeMarkdown(row.reset), escapeMarkdown(row.remaining)].join(' | ') + ' |\n';
    }
    tooltip += t('tooltip.updated', clock(state.lastSuccessAt), ago(state.lastSuccessAt, now), values.warningThreshold, values.criticalThreshold);
  }
  const items = [];
  for (const group of groups.values()) {
    items.push({label: group[0].groupLabel, separator: true});
    for (const row of group) {
      items.push({
        label: levelIcon(row.severity) + (provider && groups.size > 1 ? row.groupLabel + ' ' : '') +
          row.windowLabel + ': ' + row.value + levelLabel(row.severity),
        description: t('picker.limit', row.reset, row.remaining)
      });
    }
  }
  if (!rows.length && !loading) items.push({label: '$(error) ' + safeText(error)});
  items.push({label: '', separator: true}, {label: t('action.refresh'), action: 'refresh'},
    {label: t('action.log'), action: 'log'});
  return {
    text, tooltip, items, severity, stale, accessibilityLabel,
    updated: t('picker.updated', state.lastSuccessAt == null ? t('time.never') : clock(state.lastSuccessAt), stale ? t('picker.stale') : ''),
    title: t('picker.title', state.lastSuccessAt == null ? t('time.never') : clock(state.lastSuccessAt), stale ? t('picker.stale') : '')
  };
}
function notification(result, provider) {
  return (provider ? provider.name + ': ' : t('notification.prefix')) + result.events.map(({bucket, recovered}) =>
    safeText(bucket.groupLabel) + ' (' + safeText(bucket.windowKey === '5h' ? t('window.fiveHour') : bucket.windowKey === 'weekly' ? t('window.weekly') : bucket.windowLabel) + ') ' +
    (recovered ? t('notification.recovered', bucket.percent) :
      t('notification.remaining', bucket.percent, resetTime(bucket.resetAt)))).join('; ') + '.';
}
module.exports = {escapeMarkdown, safeText, resetTime, countdown, ago, display, notification, sanitize, clock};
