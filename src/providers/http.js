'use strict';
const path = require('node:path');
const {t} = require('../i18n');
const {sanitize} = require('../parse');
const {configuration} = require('../thresholds');
const MAX_BYTES = 256 * 1024;
const USER_AGENT = 'ai-quota-bar/' + require('../../package.json').version;
const endpoints = Object.freeze({
  claude: 'https://api.anthropic.com/api/oauth/usage',
  codex: 'https://chatgpt.com/backend-api/wham/usage'
});
const failure = (type, key, ...args) => ({error: {type, message: sanitize(t(key, ...args), 200)}});
function retryAfter(value, now) {
  const seconds = /^\d+(?:\.\d+)?$/.test(String(value ?? '').trim()) ? Number(value) :
    (Date.parse(value) - now) / 1000;
  return Math.min(3600000, Math.max(60000, Number.isFinite(seconds) ? seconds * 1000 : 60000));
}
async function readBody(response) {
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error('size');
  }
  // Đọc theo khối để chặn cả phản hồi không khai báo kích thước hoặc khai báo sai.
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        void reader.cancel().catch(() => {});
        throw new Error('size');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}
const curlQuote = value => '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  .replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"';
function viaCurl(url, headers, signal, timeout, deps) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    // -q phải đứng đầu để bỏ qua curlrc; không theo chuyển hướng, không ghi tệp.
    const config = [
      'url = ' + curlQuote(url), 'request = "GET"', 'proto = "=https"',
      'max-redirs = 0', 'max-time = ' + timeout, 'max-filesize = ' + MAX_BYTES,
      'silent', 'show-error', 'include', 'write-out = "\\n__AI_QUOTA_STATUS__%{http_code}"',
      ...Object.entries(headers).map(([key, value]) => 'header = ' + curlQuote(key + ': ' + value))
    ].join('\n');
    let child;
    const abort = () => child?.kill();
    signal.addEventListener('abort', abort, {once: true});
    try {
      const rootKey = Object.keys(deps.env).find(key => key.toUpperCase() === 'SYSTEMROOT');
      const systemRoot = path.win32.isAbsolute(deps.env[rootKey] || '') ? deps.env[rootKey] : 'C:\\Windows';
      const executable = deps.platform === 'win32' ? path.win32.join(systemRoot, 'System32', 'curl.exe') : 'curl';
      child = deps.execFile(executable, ['-q', '--config', '-'], {
        windowsHide: true, shell: false, cwd: deps.platform === 'win32' ? systemRoot : '/', signal,
        timeout: Math.ceil(timeout * 1000), maxBuffer: MAX_BYTES, encoding: 'utf8'
      }, (error, stdout = '') => {
        signal.removeEventListener('abort', abort);
        // Không chuyển stderr, stdout hoặc lỗi tiến trình ra giao diện vì có thể chứa token.
        if (error) return reject(new Error(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'size' :
          error.code === 28 || error.code === 'ETIMEDOUT' ? 'timeout' : 'curl'));
        const match = /\n__AI_QUOTA_STATUS__(\d{3})$/.exec(stdout);
        if (!match || Buffer.byteLength(stdout) > MAX_BYTES) return reject(new Error('curl'));
        let body = stdout.slice(0, match.index);
        let retry = null;
        while (/^HTTP\/[\d.]+ \d{3}/.test(body)) {
          const boundary = /\r?\n\r?\n/.exec(body);
          if (!boundary) return reject(new Error('curl'));
          const head = body.slice(0, boundary.index);
          retry = /^retry-after:\s*(.+)$/im.exec(head)?.[1]?.trim() ?? null;
          body = body.slice(boundary.index + boundary[0].length);
        }
        resolve({status: Number(match[1]), body, retry});
      });
      child.stdin.on('error', () => {});
      child.stdin.end(config);
    } catch {
      signal.removeEventListener('abort', abort);
      try { child?.kill(); } catch { /* Tiến trình có thể đã thoát. */ }
      reject(new Error('curl'));
    }
  });
}
function expired(token, now) {
  try {
    const exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp;
    return Number.isFinite(exp) && exp * 1000 <= now;
  } catch { return false; }
}
function createHttpProvider(id, name, parse, injected = {}) {
  const deps = {
    fs: require('node:fs').promises, fetch: globalThis.fetch,
    execFile: require('node:child_process').execFile, homedir: require('node:os').homedir,
    env: process.env, platform: process.platform, now: Date.now,
    setTimer: setTimeout, clearTimer: clearTimeout, ...injected
  };
  const controllers = new Set();
  let disposed = false;
  async function fetchQuota(config = {}) {
    if (disposed) return {cancelled: true};
    const values = configuration(config);
    const controller = new AbortController();
    controllers.add(controller);
    const started = deps.now();
    let timer;
    const aborted = new Promise(resolve => {
      controller.signal.addEventListener('abort', () => resolve(disposed ? {cancelled: true} :
        failure('timeout', 'error.timeout', values.timeout)), {once: true});
      timer = deps.setTimer(() => controller.abort(), values.timeout * 1000);
    });
    const work = async () => {
      let auth;
      try {
        const directory = id === 'claude' ? values.claudeConfigDir?.trim() || deps.env.CLAUDE_CONFIG_DIR || path.join(deps.homedir(), '.claude') :
          values.codexHome?.trim() || deps.env.CODEX_HOME || path.join(deps.homedir(), '.codex');
        const text = await deps.fs.readFile(path.join(directory, id === 'claude' ? '.credentials.json' : 'auth.json'), 'utf8');
        auth = JSON.parse(text);
      } catch { return failure('auth', 'error.auth', id); }
      if (controller.signal.aborted) return {cancelled: true};
      const token = id === 'claude' ? auth?.claudeAiOauth?.accessToken : auth?.tokens?.access_token;
      const expiresAt = id === 'claude' ? auth?.claudeAiOauth?.expiresAt : null;
      if (typeof token !== 'string' || !token.trim() || /[\s\x00-\x1f\x7f]/.test(token) ||
          Number.isFinite(expiresAt) && expiresAt <= deps.now() || expired(token, deps.now())) {
        return failure('auth', 'error.auth', id);
      }
      const headers = {Authorization: 'Bearer ' + token, Accept: 'application/json', 'User-Agent': USER_AGENT};
      if (id === 'claude') headers['anthropic-beta'] = 'oauth-2025-04-20';
      else if (typeof auth.tokens.account_id === 'string' && auth.tokens.account_id && !/[\r\n\x00-\x1f\x7f]/.test(auth.tokens.account_id)) {
        headers['chatgpt-account-id'] = auth.tokens.account_id;
      }
      try {
        const response = await deps.fetch(endpoints[id], {method: 'GET', headers,
          signal: controller.signal, redirect: 'error'});
        let result = {status: response.status, body: '', retry: response.headers?.get('retry-after')};
        if (result.status >= 200 && result.status < 300 || id === 'claude' && result.status === 403) {
          try { result.body = await readBody(response); }
          catch (error) {
            if (result.status === 403) return failure('auth', 'error.auth', id);
            throw error;
          }
        } else {
          // Không cần đọc nội dung lỗi xác thực, giới hạn tần suất hoặc lỗi máy chủ.
          void response.body?.cancel().catch(() => {});
        }
        if (id === 'claude' && result.status === 403 && result.body.includes('Request not allowed')) {
          if (controller.signal.aborted) return {cancelled: true};
          result = await viaCurl(endpoints[id], headers, controller.signal,
            Math.max(0.001, values.timeout - (deps.now() - started) / 1000), deps);
        }
        if (controller.signal.aborted) return {cancelled: true};
        if (result.status === 401 || result.status === 403 && (id === 'claude' ||
            /^application\/(?:[\w.-]+\+)?json\s*(?:;|$)/i.test(response.headers?.get('content-type') || ''))) {
          return failure('auth', 'error.auth', id);
        }
        if (result.status === 429) return {...failure('http', 'error.rateLimit'),
          retryAfterMs: retryAfter(result.retry, deps.now())};
        if (result.status < 200 || result.status >= 300) return failure('http', 'error.http', result.status);
        let data;
        try { data = JSON.parse(result.body); }
        catch { return failure('http', 'error.invalidJson'); }
        const buckets = parse(data, deps.now());
        return buckets.length ? {buckets} : failure('http', 'error.noQuota');
      } catch (error) {
        if (error?.message === 'timeout') return failure('timeout', 'error.timeout', values.timeout);
        return failure(error?.message === 'size' ? 'http' : 'network',
          error?.message === 'size' ? 'error.responseSize' : 'error.network');
      }
    };
    try { return await Promise.race([work(), aborted]); }
    finally {
      deps.clearTimer(timer);
      controllers.delete(controller);
      controller.abort();
    }
  }
  return {id, name, fetch: fetchQuota, dispose() {
    disposed = true;
    for (const controller of controllers) controller.abort();
  }};
}
function quotaBucket(provider, label, windowKey, windowLabel, used, resetAt) {
  if (!Number.isFinite(used) || used < 0) return null;
  const remaining = 100 - Math.min(100, used);
  return {provider, groupName: label, groupLabel: label, windowKey, windowLabel,
    fraction: remaining / 100, percent: Math.floor(remaining),
    resetAt: Number.isFinite(resetAt) && Math.abs(resetAt) <= 8640000000000000 ? resetAt : null};
}
module.exports = {createHttpProvider, quotaBucket, retryAfter, MAX_BYTES};
