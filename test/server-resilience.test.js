const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const express = require('express');
const { asyncRoute, apiErrorHandler, scanInput, filePathInput } = require('../lib/http-route-utils');
const { acquireDataDirLease, dataStoreId, assertCompatibleInstances } = require('../lib/data-dir-lease');
const { startLocalServer } = require('../lib/app-server');

async function temporary(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'videorandom-server-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

function launchServer(dataDir, port = 0) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'), windowsHide: true,
    env: { ...process.env, PORT: String(port), VIDEORANDOM_DATA_DIR: dataDir, VIDEORANDOM_NO_OPEN: '1', VIDEORANDOM_START_HOST: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let settled = false;
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('Owned test server startup timed out: ' + output)); } }, 20000);
    const onData = chunk => {
      output = (output + chunk.toString('utf8')).slice(-8192);
      const match = /Local URL: http:\/\/localhost:(\d+)/.exec(output);
      if (match && !settled) { settled = true; clearTimeout(timer); resolve(Number(match[1])); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    exited.then(result => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`Owned test server exited ${result.code}: ${output}`)); } });
  });
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
  return { child, started, exited, stop, output: () => output };
}

test('malformed scan/open/play requests return JSON and the real owned app stays alive', async t => {
  const directory = await temporary(t);
  const owned = launchServer(directory);
  t.after(owned.stop);
  const port = await owned.started;
  const base = `http://127.0.0.1:${port}`;
  const cases = [
    ['/api/scan', {}], ['/api/scan', []], ['/api/scan', { directory: {} }],
    ['/api/scan', { directory, excludeDirs: [42] }], ['/api/scan', { directory, excludeDirs: [null] }],
    ['/api/scan', { directory, excludeDirs: 'cache' }], ['/api/scan', { directory, excludeDirs: ['bad\0name'] }],
    ['/api/scan', { directory: ', ,' }], ['/api/scan', { directory: '\0' }],
    ['/api/open', {}], ['/api/open', { filePath: {} }], ['/api/open', { filePath: ['file'] }],
    ['/api/open', { filePath: '\0' }], ['/api/play', { filePath: 42 }],
    ['/api/play', { filePath: null }], ['/api/play', { filePath: '  ' }], ['/api/play', []]
  ];
  for (const [endpoint, body] of cases) {
    const response = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 400, endpoint + ' ' + JSON.stringify(body));
    assert.equal(typeof (await response.json()).error, 'string');
    const health = await (await fetch(base + '/api/app-info')).json();
    assert.equal(health.application, 'videorandom');
    assert.equal(health.ready, true);
  }
  const malformed = await fetch(base + '/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /JSON/);
  const oversized = await fetch(base + '/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directory: 'x'.repeat(2 * 1024 * 1024) }) });
  assert.equal(oversized.status, 413);
  assert.equal(typeof (await oversized.json()).error, 'string');
  // A valid ordinary scan still works, without launching or analyzing media.
  const scan = await fetch(base + '/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directory }) });
  assert.equal(scan.status, 200);
  assert.equal((await scan.json()).filesCount, 0);
  assert.equal(owned.child.exitCode, null);
});

test('async route boundary catches synchronous and rejected errors without exposing internals', async t => {
  const app = express();
  app.get('/reject', asyncRoute(async () => { throw new Error('private provider credential'); }));
  app.get('/sync', asyncRoute(() => { throw new Error('private local path'); }));
  app.get('/health', (req, res) => res.json({ ready: true }));
  app.use(apiErrorHandler);
  const server = await startLocalServer(app, { port: 0 });
  t.after(() => new Promise(resolve => server.server.close(resolve)));
  for (const endpoint of ['/reject', '/sync']) {
    const response = await fetch(`http://127.0.0.1:${server.port}${endpoint}`);
    assert.equal(response.status, 500);
    assert.doesNotMatch((await response.json()).error, /private/);
  }
  assert.equal((await (await fetch(`http://127.0.0.1:${server.port}/health`)).json()).ready, true);
});

test('path and scan validation retain ordinary comma roots and exclusions', () => {
  assert.deepEqual(scanInput({ directory: ' C:\\, D:\\ ', excludeDirs: ['Cache', '  '] }), { paths: ['C:\\', 'D:\\'], excludeDirs: ['Cache', '  '] });
  assert.equal(filePathInput(' C:\\ordinary video.mp4 '), 'C:\\ordinary video.mp4');
  assert.throws(() => scanInput({ directory: 'C:\\', excludeDirs: Array(1001).fill('Cache') }), /제외 폴더/);
});

test('data directory ownership rejects duplicates and releases only its own nonce', async t => {
  const directory = await temporary(t);
  const lease = acquireDataDirLease(directory, { version: 'test' });
  t.after(() => lease.release());
  assert.equal(lease.dataStoreId, dataStoreId(directory));
  assert.throws(() => acquireDataDirLease(directory), { code: 'VIDEORANDOM_DATA_BUSY' });
  const lockDir = path.join(directory, '.app-owner');
  const name = (await fsp.readdir(lockDir))[0];
  const original = JSON.parse(await fsp.readFile(path.join(lockDir, name), 'utf8'));
  await fsp.writeFile(path.join(lockDir, name), JSON.stringify({ ...original, nonce: 'changed' }));
  lease.release();
  assert.equal((await fsp.readdir(lockDir)).length, 1);
  await fsp.writeFile(path.join(lockDir, name), JSON.stringify(original));
  await fsp.unlink(path.join(lockDir, name));
  await fsp.rmdir(lockDir);
  const next = acquireDataDirLease(directory);
  next.release();
  assert.equal(fs.existsSync(lockDir), false);
});

test('a crashed owned process lease recovers without touching any live process', async t => {
  const directory = await temporary(t);
  const leaseModule = path.resolve(__dirname, '../lib/data-dir-lease.js');
  const child = spawn(process.execPath, ['-e', 'require(process.argv[1]).acquireDataDirLease(process.argv[2]);', leaseModule, directory], { windowsHide: true, stdio: 'pipe' });
  const result = await new Promise(resolve => child.once('exit', code => resolve(code)));
  assert.equal(result, 0);
  const next = acquireDataDirLease(directory);
  next.release();
  assert.equal(fs.existsSync(path.join(directory, '.app-owner')), false);
});

test('fresh empty claims are protected and stale empty crash remnants recover', async t => {
  const directory = await temporary(t);
  const lockDir = path.join(directory, '.app-owner');
  await fsp.mkdir(lockDir);
  assert.throws(() => acquireDataDirLease(directory), { code: 'VIDEORANDOM_DATA_BUSY' });
  const staleTime = new Date(Date.now() - 60000);
  await fsp.utimes(lockDir, staleTime, staleTime);
  const lease = acquireDataDirLease(directory);
  lease.release();
  assert.equal(fs.existsSync(lockDir), false);
});

test('failure after atomic takeover releases only its exact claim and remains recoverable', async t => {
  const directory = await temporary(t);
  const leaseModule = path.resolve(__dirname, '../lib/data-dir-lease.js');
  const child = spawn(process.execPath, ['-e', 'require(process.argv[1]).acquireDataDirLease(process.argv[2]);', leaseModule, directory], { windowsHide: true, stdio: 'pipe' });
  assert.equal(await new Promise(resolve => child.once('exit', resolve)), 0);
  const lockDir = path.join(directory, '.app-owner');
  const readdir = fs.readdirSync;
  let reads = 0;
  fs.readdirSync = (...args) => {
    if (args[0] === lockDir && ++reads === 2) throw new Error('Synthetic verification failure');
    return readdir(...args);
  };
  try { assert.throws(() => acquireDataDirLease(directory), /Synthetic verification failure/); }
  finally { fs.readdirSync = readdir; }
  assert.deepEqual(await fsp.readdir(directory), []);
  const lease = acquireDataDirLease(directory);
  lease.release();
});

test('a crashed atomic takeover is recoverable with its immutable earlier provenance', async t => {
  const directory = await temporary(t);
  const leaseModule = path.resolve(__dirname, '../lib/data-dir-lease.js');
  const child = spawn(process.execPath, ['-e', 'require(process.argv[1]).acquireDataDirLease(process.argv[2]);', leaseModule, directory], { windowsHide: true, stdio: 'pipe' });
  assert.equal(await new Promise(resolve => child.once('exit', resolve)), 0);
  const takeover = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'pipe' });
  assert.equal(await new Promise(resolve => takeover.once('exit', resolve)), 0);
  const lockDir = path.join(directory, '.app-owner');
  const oldName = (await fsp.readdir(lockDir))[0];
  await fsp.rename(path.join(lockDir, oldName), path.join(lockDir, `owner-${takeover.pid}-${'b'.repeat(32)}.json`));
  const lease = acquireDataDirLease(directory);
  lease.release();
});

test('legacy same-store instances block updates; confirmed other data stores are isolated', () => {
  const current = 'a'.repeat(64);
  assert.throws(() => assertCompatibleInstances([{ port: 3000, version: '1.6.6' }], current), /기존 프로그램을 종료/);
  assert.throws(() => assertCompatibleInstances([{ port: 3000, version: '1.7.0', dataStoreId: current }], current), /기존 프로그램을 종료/);
  assert.doesNotThrow(() => assertCompatibleInstances([{ port: 3000, version: '1.7.0', dataStoreId: 'b'.repeat(64) }, { port: 3002, version: null }], current));
});

test('simultaneous stale-lease recovery elects one live owner', async t => {
  const directory = await temporary(t);
  const leaseModule = path.resolve(__dirname, '../lib/data-dir-lease.js');
  const stale = spawn(process.execPath, ['-e', 'require(process.argv[1]).acquireDataDirLease(process.argv[2]);', leaseModule, directory], { windowsHide: true, stdio: 'pipe' });
  assert.equal(await new Promise(resolve => stale.once('exit', resolve)), 0);
  const code = `
    const acquire = require(process.argv[1]).acquireDataDirLease;
    process.stdin.once('data', () => {
      try {
        const lease = acquire(process.argv[2]);
        process.stdout.write('owned\\n');
        process.stdin.once('data', () => { lease.release(); process.stdin.destroy(); });
      } catch (error) {
        if (error.code !== 'VIDEORANDOM_DATA_BUSY') process.stderr.write(String(error.stack || error) + '\\n');
        process.stdout.write(error.code === 'VIDEORANDOM_DATA_BUSY' ? 'busy\\n' : 'error\\n');
        process.exitCode = error.code === 'VIDEORANDOM_DATA_BUSY' ? 0 : 1;
        process.stdin.destroy();
      }
    });
    process.stdout.write('ready\\n');
  `;
  const contenders = Array.from({ length: 6 }, () => {
    const child = spawn(process.execPath, ['-e', code, leaseModule, directory], { windowsHide: true, stdio: 'pipe' });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    let output = '', errors = '';
    let readyResolve, outcomeResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    const outcome = new Promise(resolve => { outcomeResolve = resolve; });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('ready\n')) readyResolve();
      const match = /(?:^|\n)(owned|busy|error)\n/.exec(output);
      if (match) outcomeResolve(match[1]);
    });
    child.stderr.on('data', chunk => { errors += chunk; });
    // Process exit can precede the final stdout data event; close guarantees
    // the outcome written by the child has been consumed before fallback.
    const exited = new Promise(resolve => child.once('close', code => { readyResolve(); outcomeResolve('error'); resolve(code); }));
    return { child, ready, outcome, exited, errors: () => errors };
  });
  await Promise.all(contenders.map(item => item.ready));
  for (const item of contenders) item.child.stdin.write('go\n');
  const outcomes = await Promise.all(contenders.map(item => item.outcome));
  assert.equal(outcomes.filter(value => value === 'owned').length, 1, JSON.stringify(outcomes.map((outcome, index) => ({ outcome, error: contenders[index].errors() }))));
  assert.equal(outcomes.filter(value => value === 'busy').length, contenders.length - 1, JSON.stringify(outcomes.map((outcome, index) => ({ outcome, error: contenders[index].errors() }))));
  assert.equal((await fsp.readdir(path.join(directory, '.app-owner'))).length, 1);
  for (let index = 0; index < contenders.length; index++) if (outcomes[index] === 'owned') contenders[index].child.stdin.write('release\n');
  assert.deepEqual(await Promise.all(contenders.map(item => item.exited)), Array(contenders.length).fill(0));
});

test('matching versions with different confirmed data stores use separate owned listeners', async t => {
  const version = require('../package.json').version;
  const old = http.createServer((req, res) => { res.end(JSON.stringify({ application: 'videorandom', version, features: ['catalog', 'history'], dataStoreId: 'b'.repeat(64) })); });
  await new Promise(resolve => old.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => old.close(resolve)));
  const next = await startLocalServer((req, res) => res.end('isolated'), { port: old.address().port, version, dataStoreId: 'a'.repeat(64), fallbackPorts: [0] });
  t.after(() => new Promise(resolve => next.server.close(resolve)));
  assert.equal(next.reused, false);
  assert.notEqual(next.port, old.address().port);
  assert.equal(next.conflicts[0].dataStoreId, 'b'.repeat(64));
  assert.doesNotThrow(() => assertCompatibleInstances(next.conflicts, 'a'.repeat(64)));
});

test('same-version real app is reused without constructing another service or changing its lease', async t => {
  const directory = await temporary(t);
  const first = launchServer(directory);
  t.after(first.stop);
  const port = await first.started;
  const leaseBefore = await fsp.readdir(path.join(directory, '.app-owner'));
  const second = launchServer(directory, port);
  t.after(second.stop);
  assert.equal(await second.started, port);
  assert.equal((await second.exited).code, 0);
  assert.match(second.output(), /already running/);
  assert.deepEqual(await fsp.readdir(path.join(directory, '.app-owner')), leaseBefore);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/app-info`)).json()).ready, true);
});

test('a second owned listener with the same store exits before it can change queue data', async t => {
  const directory = await temporary(t);
  const first = launchServer(directory);
  t.after(first.stop);
  const port = await first.started;
  const second = launchServer(directory);
  t.after(second.stop);
  await assert.rejects(second.started, /같은 저장 폴더/);
  assert.equal((await second.exited).code, 1);
  assert.equal((await fsp.readdir(path.join(directory, '.app-owner'))).length, 1);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/app-info`)).json()).ready, true);
});

test('legacy-version owned listener is preserved and new app exits before creating storage', async t => {
  const directory = await temporary(t);
  const old = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ application: 'videorandom', version: '0.0.0-test', features: ['catalog', 'history'] })); });
  await new Promise(resolve => old.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => old.close(resolve)));
  const port = old.address().port;
  const owned = launchServer(directory, port);
  t.after(owned.stop);
  await assert.rejects(owned.started, /기존 프로그램을 종료/);
  assert.equal((await owned.exited).code, 1);
  assert.deepEqual(await fsp.readdir(directory), []);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/app-info`)).json()).version, '0.0.0-test');
});
