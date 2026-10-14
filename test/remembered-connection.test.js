const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const express = require('express');
const { createAnalysisService } = require('../lib/analysis-service');
const { createConnectionStore } = require('../lib/connection-store');

const code = 'fixture-remembered-code-123456789';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const codec = { name: 'fixture-protection-only', protect: async value => Buffer.from(value.map(byte => byte ^ 0x5a)), unprotect: async value => Buffer.from(value.map(byte => byte ^ 0x5a)) };
const record = file => ({ ...file, status: 'completed', summary: '저장된 분석', labels: [], frames: [], transcript: [], warnings: [], analyzedAt: new Date().toISOString() });

async function until(condition) {
  for (let attempt = 0; attempt < 200; attempt++) { const value = await condition(); if (value) return value; await sleep(10); }
  throw new Error('Expected analysis state did not arrive');
}
async function fixture(t, { analyze, deferAutoStart = false, failingSave = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-remembered-'));
  const filePath = path.join(dataDir, 'fixture.mp4');
  await fs.writeFile(filePath, 'owned test fixture');
  const connectionStore = createConnectionStore({ dataDir, protector: codec });
  const calls = [], closers = [];
  const engine = {
    getToolsStatus: async () => ({ available: true }),
    getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
    analyzeVideo: async (file, options, context) => { calls.push({ ...options }); return analyze ? analyze(file, options, context) : record(file); }
  };
  async function open(extra = {}) {
    let running = false;
    const store = failingSave ? { ...connectionStore, saveConnection: async () => { throw new Error('mock 연결 설정을 저장하지 못했습니다.'); } } : connectionStore;
    const service = createAnalysisService({ dataDir, engine, connectionStore: store, deferAutoStart, ...extra, lan: { status: () => ({ running }), start: async () => { running = true; return {}; }, stop: async () => { running = false; } } });
    await service.ready;
    service.registerFiles([{ path: filePath, name: path.basename(filePath), ext: 'MP4', size: 1 }]);
    const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
    const server = await new Promise(resolve => { const created = app.listen(0, '127.0.0.1', () => resolve(created)); });
    const base = `http://127.0.0.1:${server.address().port}/api/analysis`;
    const request = async (endpoint, body, method = body === undefined ? 'GET' : 'POST') => {
      const response = await fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    let closed = false;
    const close = async () => { if (closed) return; closed = true; await service.stop(); await until(async () => !(await request('/auto-pick')).data.activeJob); await new Promise(resolve => server.close(resolve)); };
    closers.push(close);
    return { service, request, close };
  }
  t.after(async () => { for (const close of closers) await close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { ...await open(), dataDir, filePath, connectionStore, calls, engine, open };
}
async function relay(t, onReady = async () => {}) {
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + code) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'invalid connection code' })); }
    await onReady();
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ready: true, protocol: 1, active: 0, queued: 0 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { remoteUrl: `http://127.0.0.1:${server.address().port}`, connectionCode: code };
}
async function finished(f, id) { return until(async () => { const job = (await f.request('/jobs/' + id)).data; return job.status !== 'running' ? job : null; }); }

test('successful connection check persists protected pairing and restores omitted code after restart', async t => {
  const f = await fixture(t), pair = await relay(t);
  const checked = await f.request('/remote/check', pair);
  assert.equal(checked.status, 200); assert.equal(checked.data.connection.remembered, true);
  assert.equal((await f.request('/config')).data.connection.connectionCode, code);
  const raw = await fs.readFile(path.join(f.connectionStore.directory, 'client.json'), 'utf8');
  assert.equal(raw.includes(code), false);
  await f.close();
  const reopened = await f.open();
  const started = await reopened.request('/jobs', { files: [f.filePath], options: { mode: 'remote', remoteUrl: pair.remoteUrl, connectionCode: '' } });
  assert.equal(started.status, 202);
  assert.equal((await finished(reopened, started.data.id)).status, 'completed');
  assert.equal(f.calls[0].connectionCode, code);
  for (const endpoint of ['/jobs/' + started.data.id, '/results', '/auto-pick']) assert.equal(JSON.stringify((await reopened.request(endpoint)).data).includes(code), false);
});

test('unverified auto settings and a failed connection check never overwrite a remembered pair', async t => {
  const f = await fixture(t), pair = await relay(t);
  await f.request('/remote/check', pair);
  const wrong = { ...pair, connectionCode: 'incorrect-new-code-123456789012' };
  assert.equal((await f.request('/auto-pick', { options: { mode: 'remote', ...wrong } }, 'PUT')).status, 200);
  assert.equal((await f.request('/remote/check', wrong)).status, 400);
  assert.equal((await f.request('/connection')).data.connectionCode, code);
  assert.equal((await f.request('/jobs', { files: [f.filePath], options: { mode: 'remote', remoteUrl: 'http://192.168.1.22:3001', connectionCode: '' } })).status, 400);
  assert.equal(f.calls.length, 0);
});

test('forgetting while a connection check is in flight prevents late credential resurrection', async t => {
  const f = await fixture(t);
  let release, arrived;
  const hold = new Promise(resolve => { release = resolve; }), accepted = new Promise(resolve => { arrived = resolve; });
  const pair = await relay(t, async () => { arrived(); await hold; });
  const checking = f.request('/remote/check', pair);
  await accepted;
  assert.equal((await f.request('/connection', undefined, 'DELETE')).status, 200);
  release();
  const checked = await checking;
  assert.equal(checked.data.ready, true); assert.equal(checked.data.connection, undefined);
  assert.equal((await f.request('/connection')).data.remembered, false);
});

test('forgetting during an active analysis preserves its result while remaining remote queue waits', async t => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { analyze: async (file, options, context) => { await Promise.race([hold, new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }))]); return record(file); } });
  const pair = { remoteUrl: 'http://192.168.1.11:3001', connectionCode: code };
  await f.request('/connection', pair, 'PUT');
  await f.connectionStore.setHostCode('fixture-host-identity-1234567890'); await f.connectionStore.setHostEnabled(true);
  const secondPath = path.join(f.dataDir, 'second.mp4'); await fs.writeFile(secondPath, 'second fixture'); f.service.registerFiles([{ path: secondPath, name: 'second.mp4', ext: 'MP4' }]);
  await f.request('/auto-pick', { filePath: f.filePath, options: { mode: 'remote', ...pair } });
  await until(() => f.calls.length === 1);
  await f.request('/auto-pick', { filePath: secondPath });
  await f.request('/connection', undefined, 'DELETE');
  release();
  const waiting = await until(async () => { const queue = (await f.request('/auto-pick')).data; return !queue.activeJob && queue.pendingCount === 1 ? queue : null; });
  assert.match(waiting.waitingReason, /연결 코드/);
  assert.equal((await f.request('/connection')).data.remembered, false);
  assert.equal((await f.request('/results')).data.results[0].status, 'completed');
  assert.equal((await f.connectionStore.getHostState()).enabled, true);
  assert.equal(f.calls.length, 1);
});

test('corrupt pairing leaves saved catalog accessible and explicit forget recovers the store', async t => {
  const f = await fixture(t);
  const id = 'a'.repeat(32); await fs.writeFile(path.join(f.dataDir, 'results', id + '.json'), JSON.stringify({ ...record({ path: f.filePath, name: 'fixture.mp4' }), id }));
  await f.connectionStore.saveConnection({ remoteUrl: 'http://192.168.1.11:3001', connectionCode: code });
  await fs.writeFile(path.join(f.connectionStore.directory, 'client.json'), 'corrupt protected pairing');
  await f.close();
  const reopened = await f.open();
  assert.equal((await reopened.request('/results')).data.results.length, 1);
  assert.match((await reopened.request('/config')).data.connection.error, /읽지 못했습니다/);
  assert.equal((await reopened.request('/connection', undefined, 'DELETE')).status, 200);
  assert.equal((await reopened.request('/config')).data.connection.remembered, false);
});

test('restored queue remains inert until startup confirms ownership of the local server', async t => {
  const f = await fixture(t, { deferAutoStart: true });
  const pair = { remoteUrl: 'http://192.168.1.11:3001', connectionCode: code };
  await f.request('/connection', pair, 'PUT');
  await f.request('/auto-pick', { filePath: f.filePath, options: { mode: 'remote', ...pair } });
  await sleep(30); assert.equal(f.calls.length, 0);
  await f.close();
  const reopened = await f.open();
  await sleep(30); assert.equal(f.calls.length, 0); assert.equal((await reopened.request('/auto-pick')).data.pendingCount, 1);
  await reopened.service.activateAutoAnalysis();
  await until(async () => (await reopened.request('/auto-pick')).data.savedCount === 1);
  assert.equal(f.calls.length, 1);
});

test('host enabled intent survives runtime shutdown and changes only on explicit stop', async t => {
  const f = await fixture(t);
  assert.equal(await f.service.getHostAutoStart(), false);
  assert.equal((await f.request('/host/start', {})).status, 200);
  const host = await f.connectionStore.getHostState(); assert.equal(host.enabled, true);
  await f.close();
  const reopened = await f.open(); assert.equal(await reopened.service.getHostAutoStart(), true);
  assert.equal((await reopened.request('/host/stop', {})).status, 200);
  assert.deepEqual(await f.connectionStore.getHostState(), { enabled: false, connectionCode: host.connectionCode });
});

test('credential save failure cannot convert an already saved successful analysis into a failed job', async t => {
  const f = await fixture(t, { failingSave: true });
  const options = { mode: 'remote', remoteUrl: 'http://192.168.1.11:3001', connectionCode: code };
  const started = await f.request('/jobs', { files: [f.filePath], options });
  const completed = await finished(f, started.data.id);
  assert.equal(completed.status, 'completed'); assert.equal(completed.results.length, 1);
  assert.equal((await f.request('/results')).data.results[0].status, 'completed');
  assert.match((await f.request('/config')).data.connection.error, /저장하지 못했습니다/);
});
