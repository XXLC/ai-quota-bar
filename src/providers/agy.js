'use strict';
const {createRunner} = require('../runner');
function createProvider(deps = {}) {
  const fs = require('node:fs');
  const runner = createRunner({
    execFile: require('node:child_process').execFile,
    exists: file => { try { return fs.statSync(file).isFile(); } catch { return false; } },
    homedir: require('node:os').homedir, ...deps
  });
  return {id: 'agy', name: 'Antigravity', async fetch(config) {
    const result = await runner.run(config);
    return result.buckets ? {...result, buckets: result.buckets.map(bucket => ({...bucket, provider: 'agy'}))} : result;
  }, dispose: () => runner.dispose()};
}
module.exports = {...createProvider(), createProvider};
