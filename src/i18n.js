'use strict';
const {en, vi} = require('./messages');
let locale = 'en';
const localeFor = language => /^vi\b/i.test(language) ? 'vi' : 'en';
function setLocale(value) { locale = localeFor(value); }
function getLocale() { return locale; }
function t(key, ...args) {
  const messages = locale === 'vi' ? vi : en;
  const value = Object.hasOwn(messages, key) ? messages[key] : Object.hasOwn(en, key) ? en[key] : key;
  return value.replace(/\{(\d+)\}/g, (match, index) => index < args.length ? String(args[index]) : match);
}
module.exports = {setLocale, getLocale, localeFor, t};
