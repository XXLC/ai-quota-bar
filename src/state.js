'use strict';
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {isRefreshDue, transitions, retryDeadline} = require('./thresholds');
function emptyState() {
  return {
    buckets: [], lastAttemptAt: null, lastSuccessAt: null, runningSince: null,
    consecutiveErrors: 0, levels: {}, notifiedAt: null
  };
}
function validState(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.buckets)) return false;
  if (value.consecutiveErrors === null || value.levels === null) return false;
  if (value.consecutiveErrors !== undefined &&
      (!Number.isFinite(value.consecutiveErrors) || value.consecutiveErrors < 0)) return false;
  if (value.levels !== undefined && (typeof value.levels !== 'object' || Array.isArray(value.levels) ||
      !Object.values(value.levels).every(level => ['ok', 'warning', 'critical'].includes(level)))) return false;
  if (value.error != null && (typeof value.error.message !== 'string' ||
      !['not-found', 'timeout', 'exit', 'spawn', 'unexpected', 'auth', 'network', 'http'].includes(value.error.type))) return false;
  return ['lastAttemptAt', 'lastSuccessAt', 'runningSince', 'notifiedAt', 'retryAt'].every(key =>
    value[key] == null || Number.isFinite(value[key])) && value.buckets.every(bucket =>
    bucket && typeof bucket.groupName === 'string' && typeof bucket.groupLabel === 'string' &&
    typeof bucket.windowKey === 'string' && typeof bucket.windowLabel === 'string' &&
    Number.isFinite(bucket.percent) && bucket.percent >= 0 && bucket.percent <= 100 &&
    (bucket.resetAt === null || Number.isFinite(bucket.resetAt)));
}
// Thông điệp lỗi giữ bản dịch tại thời điểm lưu, kể cả khi đổi ngôn ngữ sau đó.
function localResult(state, result, time) {
  return result.error ? {
    ...state, runningSince: null, manualRefresh: false, error: result.error,
    consecutiveErrors: (state.consecutiveErrors || 0) + 1,
    retryAt: Number.isFinite(result.retryAfterMs) ? time + Math.min(3600000, Math.max(60000, result.retryAfterMs)) : null
  } : {
    ...state, buckets: result.buckets, lastSuccessAt: time, runningSince: null,
    manualRefresh: false, error: null, consecutiveErrors: 0, retryAt: null
  };
}
function createStore({directory, fs, now = Date.now, id = String(process.pid), setTimer = setTimeout, name = 'agy'}) {
  const file = path.join(directory, 'state-' + name + '.json');
  const lock = path.join(directory, 'state-' + name + '.lock');
  async function read() {
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      return validState(value) ? {...emptyState(), ...value} : emptyState();
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return emptyState();
      throw error;
    }
  }
  async function write(state) {
    await fs.mkdir(directory, {recursive: true});
    const temporary = file + '.' + id + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify(state), 'utf8');
      await fs.rename(temporary, file);
    } finally {
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  async function transaction(change) {
    await fs.mkdir(directory, {recursive: true});
    const delays = [50, 100, 200, 400];
    for (let attempt = 0; attempt < 5; attempt++) {
      let handle;
      try {
        handle = await fs.open(lock, 'wx');
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const info = await fs.stat(lock).catch(() => null);
        // Giao dịch chỉ giữ khóa vài mili giây; sau 30 giây coi là khóa mồ côi.
        if (info && now() - info.mtimeMs > 30000) {
          const retired = lock + '.' + randomUUID() + '.old';
          // Cách ly bằng tên duy nhất trước khi xóa, không xóa trực tiếp tên khóa chung.
          await fs.rename(lock, retired).then(() => fs.unlink(retired)).catch(() => {});
        }
        if (attempt < delays.length) {
          await new Promise(resolve => setTimer(resolve, delays[attempt]));
          continue;
        }
        return {busy: true, state: await read()};
      }
      try {
        const state = await read();
        const result = await change(state);
        if (result.write) await write(result.state);
        return result;
      } finally {
        await handle.close();
        await fs.unlink(lock);
      }
    }
  }
  async function claim(config, manual = false) {
    return transaction(state => {
      const time = now();
      state.retryAt = retryDeadline(state, time);
      if (state.retryAt > time) return {state, claimed: false, waitingUntil: state.retryAt};
      if (!manual && !isRefreshDue(state, time, config)) return {state, claimed: false};
      const claimId = randomUUID();
      return {
        write: true, claimed: true, claimedAt: time, claimId,
        previousLastAttemptAt: state.lastAttemptAt,
        state: {
          ...state, claimId, runningSince: time, lastAttemptAt: time,
          consecutiveErrors: manual ? 0 : state.consecutiveErrors
        }
      };
    });
  }
  async function release(claim) {
    return transaction(state => {
      if (state.claimId !== claim.claimId) return {state};
      return {write: true, state: {
        ...state, runningSince: null, lastAttemptAt: claim.previousLastAttemptAt
      }};
    });
  }
  async function complete(result, config, claim) {
    return transaction(state => {
      const time = now();
      if (claim && state.lastSuccessAt > claim.claimedAt) return {state};
      const next = localResult(state, result, time);
      // Không xóa lease của lượt thủ công mới hơn đang chạy ở cửa sổ khác.
      if (claim && state.claimId !== claim.claimId) next.runningSince = state.runningSince;
      if (result.error) return {write: true, state: next};
      const changed = transitions(next.buckets, state.levels, time, config);
      return {
        write: true, state: {...next, levels: changed.levels, notifiedAt: time}, notification: changed
      };
    });
  }
  return {read, claim, complete, release};
}
module.exports = {emptyState, validState, createStore, localResult};
