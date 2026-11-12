'use strict';
const {sanitize} = require('../parse');
const {createHttpProvider} = require('./http');
const finiteNumber = value => (typeof value === 'number' || typeof value === 'string' && value.trim()) &&
  Number.isFinite(Number(value)) ? Number(value) : null;
function formatMoney(currency, amount) {
  const sign = amount < 0 ? '-' : '';
  const fixed = Math.abs(amount).toFixed(2);
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : currency + ' ';
  return sign + symbol + fixed;
}
const currencyRank = currency => currency === 'USD' ? 0 : currency === 'CNY' ? 1 : 2;
function parseUsage(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  if (typeof data.is_available !== 'boolean' && !Array.isArray(data.balance_infos)) return [];
  const byCurrency = new Map();
  for (const entry of Array.isArray(data.balance_infos) ? data.balance_infos : []) {
    if (!entry || typeof entry !== 'object') continue;
    const currency = typeof entry.currency === 'string' ?
      sanitize(entry.currency, 16).replace(/[^A-Za-z0-9]/g, '').toUpperCase() : '';
    const total = finiteNumber(entry.total_balance);
    const granted = entry.granted_balance === undefined ? 0 : finiteNumber(entry.granted_balance);
    const toppedUp = entry.topped_up_balance === undefined ? 0 : finiteNumber(entry.topped_up_balance);
    if (!currency || total === null || total < 0 || granted === null || granted < 0 || toppedUp === null || toppedUp < 0) continue;
    if (!byCurrency.has(currency) || total < byCurrency.get(currency).total) {
      byCurrency.set(currency, {currency, total, granted, toppedUp});
    }
  }
  if (!byCurrency.size) {
    if (data.is_available === false) {
      byCurrency.set('USD', {currency: 'USD', total: 0, granted: 0, toppedUp: 0});
    } else return [];
  }
  const entries = [...byCurrency.values()].sort((a, b) => currencyRank(a.currency) - currencyRank(b.currency));
  const anyPositive = data.is_available !== false && entries.some(item => item.total > 0);
  return entries.map(({currency, total, granted, toppedUp}) => {
    const available = data.is_available !== false && (total > 0 || anyPositive);
    return {
      provider: 'deepseek',
      groupName: 'DeepSeek',
      groupLabel: 'DeepSeek',
      windowKey: 'balance:' + currency,
      windowLabel: currency,
      currency,
      balance: total,
      totalBalance: formatMoney(currency, total),
      toppedUpBalance: formatMoney(currency, toppedUp),
      grantedBalance: formatMoney(currency, granted),
      available,
      fraction: available ? 1 : 0,
      percent: available ? 100 : 0,
      resetAt: null
    };
  });
}
const createProvider = deps => createHttpProvider('deepseek', 'DeepSeek', parseUsage, deps);
module.exports = {...createProvider(), createProvider, parseUsage, formatMoney};
