'use strict';
const clamp = (value, min, max, fallback) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
function configuration(config) {
  const values = config ?? {};
  const warningThreshold = clamp(values.warningThreshold, 0, 100, 30);
  return {
    ...values,
    refreshInterval: clamp(values.refreshInterval, 60, 3600, 300),
    timeout: clamp(values.timeout, 5, 300, 45),
    warningThreshold,
    criticalThreshold: Math.min(warningThreshold, clamp(values.criticalThreshold, 0, 100, 10)),
    notificationEnabled: values.notificationEnabled !== false
  };
}
function level(bucket, now, config) {
  const values = configuration(config);
  if (bucket.resetAt !== null && bucket.resetAt <= now) return 'unknown';
  if (bucket.percent <= values.criticalThreshold) return 'critical';
  return bucket.percent <= values.warningThreshold ? 'warning' : 'ok';
}
function worstLevel(levels) {
  return levels.includes('critical') ? 'critical' : levels.includes('warning') ? 'warning' : 'ok';
}
function transitions(buckets, previous, now, config = {}) {
  const levels = {};
  const events = [];
  for (const bucket of buckets) {
    const key = (bucket.provider || 'agy') + '|' + bucket.groupName + '|' + bucket.windowKey;
    const next = level(bucket, now, config);
    const old = (previous ?? {})[key];
    if (next === 'unknown') {
      if (old) levels[key] = old;
      continue;
    }
    Object.defineProperty(levels, key, {value: next, enumerable: true, configurable: true});
    if ((next === 'critical' && old !== 'critical') || (next === 'warning' && !old) ||
        (old === 'ok' && next === 'warning') || (next === 'ok' && old && old !== 'ok')) {
      events.push({bucket, level: next, recovered: next === 'ok'});
    }
  }
  return {
    levels,
    events: configuration(config).notificationEnabled ? events : [],
    severity: worstLevel(events.map(event => event.level))
  };
}
function intervalMs(state, config) {
  const values = configuration(config);
  return Math.max(Math.max(0, (state.retryAt || 0) - (state.lastAttemptAt || 0)), Math.min(3600, values.refreshInterval *
    2 ** Math.max(0, Math.min(20, (state.consecutiveErrors || 0) - 2))) * 1000);
}
function retryDeadline(state, now) {
  return Number.isFinite(state.retryAt) && state.retryAt <= now + 3600000 ? state.retryAt : null;
}
function isRefreshDue(state, now, config) {
  state = {...state, retryAt: retryDeadline(state, now)};
  if (state.retryAt > now) return false;
  // Lease dài hơn timeout 5 giây để cửa sổ khác chờ lượt đang chạy kết thúc.
  if (state.runningSince != null && now - state.runningSince >= 0 &&
      now - state.runningSince < (configuration(config).timeout + 5) * 1000) return false;
  if (state.retryAt != null && state.lastAttemptAt != null) return state.lastAttemptAt > now ||
    now - state.lastAttemptAt >= intervalMs(state, config) - 5000;
  return state.lastAttemptAt == null || state.lastAttemptAt > now ||
    now - state.lastAttemptAt >= intervalMs(state, config) - 5000 ||
    (state.buckets || []).some(bucket => bucket.resetAt !== null && bucket.resetAt <= now &&
      (state.lastAttemptAt ?? -Infinity) < bucket.resetAt);
}
const isStale = (state, now, config) => Boolean(state.error) ||
  state.lastSuccessAt != null && now - state.lastSuccessAt > 2 * configuration(config).refreshInterval * 1000;
module.exports = {configuration, level, worstLevel, transitions, intervalMs, isRefreshDue, isStale, retryDeadline};
