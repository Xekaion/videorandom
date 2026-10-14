const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { createAnalysisService } = require('../lib/analysis-service');

const localOptions = { mode: 'local', frameCount: 10 };
const remoteOptions = { mode: 'remote', frameCount: 10, remoteUrl: 'http://192.168.1.10:3001', connectionCode: 'private-code-do-not-persist' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function record(file, status = 'completed') {
  return { ...file, status, duration: 60, summary: '저장된 줄거리', plot: '', dialogueSummary: '', labels: [], transcript: [], frames: [], warnings: [], analyzedAt: new Date().toISOString(), ...(status !== 'completed' ? { error: 'mock provider limit reached' } : {}) };
}

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { release, wait: signal => Promise.race([promise, new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); })]) };
}

async function fixture(t, analyze, toolsAvailable = true) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-auto-'));
  const files = ['A 영상.mp4', 'B 영상.mp4', 'C 영상.mp4'].map(name => path.join(dataDir, name));
  await Promise.all(files.map(file => fs.writeFile(file, 'video fixture')));
  const calls = [];
  const engine = {
    getToolsStatus: async () => ({ available: toolsAvailable }),
    getProviderStatus: async () => ({ codex: { available: true, loggedIn: true }, speech: { available: true } }),
    analyzeVideo: async (file, options, context) => { calls.push({ path: file.path, options: { ...options } }); return analyze ? analyze(file, options, context) : record(file); }
  };
  const closers = [];
  async function open(register = true) {
    const service = createAnalysisService({ dataDir, engine, exporter: {}, lan: { status: () => ({ running: false }), stop: async () => {} } });
    await service.ready;
    if (register) service.registerFiles(files.map(file => ({ path: file, name: path.basename(file), ext: 'MP4', size: 1 })));
    const app = express();
    app.use(express.json());
    app.use('/api/analysis', service.router);
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/analysis`;
    const request = async (url, body, method = body === undefined ? 'GET' : 'POST') => {
      const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await service.stop();
      await until(async () => !(await request('/auto-pick')).data.activeJob);
      await new Promise(resolve => server.close(resolve));
    };
    closers.push(close);
    return { service, request, close };
  }
  t.after(async () => { for (const close of closers) await close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { ...await open(), open, files, dataDir, engine, calls };
}

async function until(condition) {
  for (let i = 0; i < 250; i++) { const result = await condition(); if (result) return result; await delay(10); }
  throw new Error('Automatic queue did not reach expected state');
}

async function quiet(request) {
  return until(async () => { const queue = (await request('/auto-pick')).data; return !queue.activeJob && !queue.pendingCount ? queue : null; });
}

test('automatic analysis defaults on, stores completed results and skips an already completed winner', async t => {
  const f = await fixture(t);
  const initial = (await f.request('/auto-pick')).data;
  assert.equal(initial.enabled, true);
  assert.equal(initial.configured, false);
  assert.equal((await f.request('/config')).data.autoPick.enabled, true);
  const started = await f.request('/auto-pick', { filePath: f.files[0], options: localOptions });
  assert.equal(started.status, 202);
  assert.equal(started.data.status, 'queued');
  await quiet(f.request);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.request('/results')).data.results[0].summary, '저장된 줄거리');
  const alias = process.platform === 'win32' ? f.files[0].toUpperCase().replace(/\\/g, '/') : f.files[0];
  assert.equal((await f.request('/auto-pick', { filePath: alias })).data.status, 'already-completed');
  await delay(30);
  assert.equal(f.calls.length, 1);
});

test('automatic winners queue FIFO behind a manual job and rapid duplicate paths are ignored', async t => {
  const held = gate();
  const f = await fixture(t, async (file, options, context) => { if (file.name.startsWith('A')) await held.wait(context.signal); return record(file); });
  const manual = await f.request('/jobs', { files: [f.files[0]], options: localOptions });
  assert.equal(manual.data.source, 'manual');
  const collision = await f.request('/auto-pick', { filePath: f.files[0], options: localOptions });
  assert.equal(collision.data.status, 'already-queued');
  const alias = process.platform === 'win32' ? f.files[1].toUpperCase().replace(/\\/g, '/') : f.files[1];
  const duplicates = await Promise.all([f.request('/auto-pick', { filePath: f.files[1], options: localOptions }), f.request('/auto-pick', { filePath: alias, options: localOptions })]);
  assert.deepEqual(duplicates.map(result => result.data.status).sort(), ['already-queued', 'queued']);
  await f.request('/auto-pick', { filePath: f.files[2] });
  const waiting = (await f.request('/auto-pick')).data;
  assert.equal(waiting.pendingCount, 2);
  assert.equal(waiting.activeJob.id, manual.data.id);
  assert.match(waiting.waitingReason, /진행 중/);
  held.release();
  await quiet(f.request);
  assert.deepEqual(f.calls.map(call => call.path), f.files);
});

test('the job start lock prevents overlapping manual jobs during asynchronous validation', async t => {
  const held = gate();
  const f = await fixture(t, async (file, options, context) => { await held.wait(context.signal); return record(file); });
  f.engine.getToolsStatus = async () => { await delay(30); return { available: true }; };
  const starts = await Promise.all([f.request('/jobs', { files: [f.files[0]], options: localOptions }), f.request('/jobs', { files: [f.files[1]], options: localOptions })]);
  assert.deepEqual(starts.map(result => result.status).sort(), [202, 409]);
  held.release();
  await quiet(f.request);
  assert.equal(f.calls.length, 1);
});

test('a verified remembered remote pair resumes its queue after restart without rescanning or retyping', async t => {
  const f = await fixture(t, undefined, false);
  const saved = await f.request('/connection', remoteOptions, 'PUT');
  assert.equal(saved.status, 200);
  assert.equal(saved.data.remembered, true);
  await f.request('/auto-pick', { filePath: f.files[0], options: { ...remoteOptions, apiKey: 'also-never-persist' } });
  const serialized = await fs.readFile(path.join(f.dataDir, 'auto-pick.json'), 'utf8');
  assert.equal(serialized.includes(remoteOptions.connectionCode), false);
  assert.equal(serialized.includes('connectionCode'), false);
  assert.equal(serialized.includes('also-never-persist'), false);
  await f.close();
  f.engine.getToolsStatus = async () => ({ available: true });
  const reopened = await f.open(false);
  const restored = (await reopened.request('/auto-pick')).data;
  assert.equal(restored.mode, 'remote');
  assert.equal(restored.configured, true);
  assert.equal(JSON.stringify(restored).includes(remoteOptions.connectionCode), false);
  await quiet(reopened.request);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.mode, 'remote');
  assert.equal(f.calls[0].options.connectionCode, remoteOptions.connectionCode);
  assert.equal((await reopened.request('/config')).data.connection.connectionCode, remoteOptions.connectionCode);
});

test('an empty code preserves same-server credentials but clears them for a changed destination', async t => {
  const f = await fixture(t, undefined, false);
  await f.request('/auto-pick', { options: remoteOptions }, 'PUT');
  await f.request('/auto-pick', { options: { ...remoteOptions, connectionCode: '' } }, 'PUT');
  await f.request('/auto-pick', { filePath: f.files[0] });
  f.engine.getToolsStatus = async () => ({ available: true });
  await quiet(f.request);
  assert.equal(f.calls[0].options.connectionCode, remoteOptions.connectionCode);
  await f.request('/auto-pick', { options: { ...remoteOptions, remoteUrl: 'http://192.168.1.20:3001', connectionCode: '' } }, 'PUT');
  await f.request('/auto-pick', { filePath: f.files[1] });
  const waiting = (await f.request('/auto-pick')).data;
  assert.match(waiting.waitingReason, /연결 코드/);
  await delay(30);
  assert.equal(f.calls.length, 1);
});

test('disabling automatic analysis preserves waiting files and leaves the current manual job running', async t => {
  const held = gate();
  const f = await fixture(t, async (file, options, context) => { if (file.name.startsWith('A')) await held.wait(context.signal); return record(file); });
  const manual = await f.request('/jobs', { files: [f.files[0]], options: localOptions });
  await f.request('/auto-pick', { filePath: f.files[1], options: localOptions });
  await f.request('/auto-pick', { enabled: false }, 'PUT');
  assert.equal((await f.request('/jobs/' + manual.data.id)).data.status, 'running');
  assert.equal((await f.request('/auto-pick', { filePath: f.files[2] })).data.status, 'disabled');
  held.release();
  await until(async () => !(await f.request('/auto-pick')).data.activeJob);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.request('/auto-pick')).data.pendingCount, 1);
  await f.request('/auto-pick', { enabled: true }, 'PUT');
  await quiet(f.request);
  assert.equal(f.calls.length, 2);
});

test('cancelling automatic analysis pauses the queue until an explicit resume', async t => {
  const held = gate();
  const f = await fixture(t, async (file, options, context) => { if (file.name.startsWith('A')) await held.wait(context.signal); return record(file, context.signal.aborted ? 'partial' : 'completed'); });
  await f.request('/auto-pick', { filePath: f.files[0], options: localOptions });
  const active = await until(async () => (await f.request('/auto-pick')).data.activeJob);
  assert.equal(active.source, 'auto-pick');
  assert.equal((await f.request('/auto-pick')).data.pendingCount, 0);
  await f.request('/auto-pick', { filePath: f.files[1] });
  await f.request('/jobs/' + active.id + '/cancel', {});
  await until(async () => !(await f.request('/auto-pick')).data.activeJob);
  const paused = (await f.request('/auto-pick')).data;
  assert.equal(paused.paused, true);
  assert.equal(paused.pendingCount, 1);
  assert.equal(f.calls.length, 1);
  await f.request('/auto-pick', { resume: true }, 'PUT');
  await quiet(f.request);
  assert.equal(f.calls.length, 2);
});

test('a failed automatic attempt pauses other files and can be retried on a future pick', async t => {
  const f = await fixture(t, async file => record(file, file.name.startsWith('A') ? 'failed' : 'completed'), false);
  await f.request('/auto-pick', { filePath: f.files[0], options: localOptions });
  await f.request('/auto-pick', { filePath: f.files[1] });
  f.engine.getToolsStatus = async () => ({ available: true });
  const paused = await until(async () => { const queue = (await f.request('/auto-pick')).data; return queue.paused && !queue.activeJob ? queue : null; });
  assert.equal(paused.pendingCount, 1);
  assert.match(paused.waitingReason, /mock provider limit/);
  await delay(50);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.request('/auto-pick', { filePath: f.files[0] })).data.status, 'queued');
  assert.equal(f.calls.length, 1);
  await f.request('/auto-pick', { resume: true }, 'PUT');
  await until(async () => f.calls.length === 3 && (await f.request('/auto-pick')).data.paused);
  assert.deepEqual(f.calls.map(call => call.path), [f.files[0], f.files[1], f.files[0]]);
});

test('a missing queued file is removed and pauses the queue without blocking recovery', async t => {
  const f = await fixture(t, undefined, false);
  await f.request('/auto-pick', { filePath: f.files[0], options: localOptions });
  await f.request('/auto-pick', { filePath: f.files[1] });
  await fs.unlink(f.files[0]);
  f.engine.getToolsStatus = async () => ({ available: true });
  const paused = await until(async () => { const queue = (await f.request('/auto-pick')).data; return queue.paused ? queue : null; });
  assert.equal(paused.pendingCount, 1);
  assert.equal(f.calls.length, 0);
  await f.request('/auto-pick', { resume: true }, 'PUT');
  await quiet(f.request);
  assert.deepEqual(f.calls.map(call => call.path), [f.files[1]]);
});

test('an enqueue disk failure never starts analysis or mutates the accepted queue', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.dataDir, 'auto-pick.json'));
  const failed = await f.request('/auto-pick', { filePath: f.files[0], options: localOptions });
  assert.equal(failed.status, 400);
  assert.match(failed.data.error, /저장하지 못/);
  await delay(40);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request('/auto-pick')).data.pendingCount, 0);
  assert.equal((await f.request('/auto-pick')).data.configured, false);
});

test('a picked video is kept while the remote address is incomplete or unsafe', async t => {
  const f = await fixture(t);
  const queued = await f.request('/auto-pick', { filePath: f.files[0], options: { mode: 'remote', remoteUrl: '', connectionCode: '' } });
  assert.equal(queued.status, 202);
  assert.equal(queued.data.queue.configured, false);
  assert.equal(queued.data.queue.mode, 'remote');
  assert.match(queued.data.queue.waitingReason, /서버 주소/);
  await f.request('/auto-pick', { options: { ...remoteOptions, remoteUrl: 'http://example.com:3001' } }, 'PUT');
  await delay(40);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request('/auto-pick')).data.pendingCount, 1);
  await f.request('/auto-pick', { options: remoteOptions }, 'PUT');
  await quiet(f.request);
  assert.equal(f.calls[0].options.mode, 'remote');
});

test('credentials embedded in a URL are never written to the automatic queue journal', async t => {
  const f = await fixture(t);
  await f.request('/auto-pick', { filePath: f.files[0], options: { ...remoteOptions, remoteUrl: 'http://username:url-password@192.168.1.10:3001/?key=query-token' } });
  const serialized = await fs.readFile(path.join(f.dataDir, 'auto-pick.json'), 'utf8');
  for (const secret of ['url-password', 'query-token', remoteOptions.connectionCode]) assert.equal(serialized.includes(secret), false);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request('/auto-pick')).data.configured, false);
});

test('malformed credential-bearing server addresses are discarded while picked videos remain queued', async t => {
  const f = await fixture(t);
  const invalidAddresses = [
    'http://user:malformed-password@',
    'http://192.168.1.10:bad/?key=malformed-query-token',
    'not-url?key=unparsed-query-token',
    'user:unparsed-password@host',
    'http://192.168.1.10:3001/private-path-marker',
    'https://192.168.1.10:3001',
    'http://public-host-marker.example:3001'
  ];
  await f.request('/auto-pick', { filePath: f.files[0], options: { mode: 'remote', remoteUrl: invalidAddresses[0] } });
  for (const remoteUrl of invalidAddresses) {
    const updated = await f.request('/auto-pick', { options: { mode: 'remote', remoteUrl } }, 'PUT');
    assert.equal(updated.status, 200);
    assert.equal(updated.data.options.remoteUrl, '');
    assert.equal(updated.data.mode, 'remote');
    assert.equal(updated.data.configured, false);
    assert.equal(updated.data.pendingCount, 1);
    const serialized = await fs.readFile(path.join(f.dataDir, 'auto-pick.json'), 'utf8');
    assert.equal(serialized.includes(remoteUrl), false);
    for (const marker of ['malformed-password', 'malformed-query-token', 'unparsed-query-token', 'unparsed-password', 'private-path-marker', 'public-host-marker']) assert.equal(serialized.includes(marker), false);
  }
  assert.equal(f.calls.length, 0);
  await f.request('/auto-pick', { options: remoteOptions }, 'PUT');
  await quiet(f.request);
  assert.equal(f.calls[0].options.remoteUrl, remoteOptions.remoteUrl);
});

test('unavailable Codex waits without silently substituting local extraction', async t => {
  const f = await fixture(t);
  f.engine.getProviderStatus = async () => ({ codex: { loggedIn: false }, speech: { available: false } });
  await f.request('/auto-pick', { filePath: f.files[0], options: { mode: 'codex', frameCount: 10 } });
  await until(async () => /Codex 로그인/.test((await f.request('/auto-pick')).data.waitingReason));
  assert.equal(f.calls.length, 0);
  f.engine.getProviderStatus = async () => ({ codex: { loggedIn: true }, speech: { available: true } });
  await quiet(f.request);
  assert.equal(f.calls[0].options.mode, 'codex');
});

test('clearing waiting work preserves the journal entry and processing of a running automatic video', async t => {
  const held = gate();
  const f = await fixture(t, async (file, options, context) => { if (file.name.startsWith('A')) await held.wait(context.signal); return record(file); });
  await f.request('/auto-pick', { filePath: f.files[0], options: localOptions });
  const active = await until(async () => (await f.request('/auto-pick')).data.activeJob);
  await f.request('/auto-pick', { filePath: f.files[1] });
  const cleared = await f.request('/auto-pick/pending', undefined, 'DELETE');
  assert.equal(cleared.data.pendingCount, 0);
  assert.equal(cleared.data.activeJob.id, active.id);
  const journal = JSON.parse(await fs.readFile(path.join(f.dataDir, 'auto-pick.json'), 'utf8'));
  assert.deepEqual(journal.entries.map(entry => entry.path), [f.files[0]]);
  held.release();
  await quiet(f.request);
  assert.equal(f.calls.length, 1);
});

test('an interrupted process keeps its current automatic file recoverable after restart', async t => {
  const held = gate();
  let attempts = 0;
  const f = await fixture(t, async (file, options, context) => {
    attempts++;
    if (attempts === 1) await held.wait(context.signal);
    return record(file, context.signal.aborted ? 'partial' : 'completed');
  });
  await f.request('/auto-pick', { filePath: f.files[0], options: localOptions });
  await until(async () => (await f.request('/auto-pick')).data.activeJob);
  await f.close();
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dataDir, 'auto-pick.json'), 'utf8')).entries.length, 1);
  const reopened = await f.open(false);
  await quiet(reopened.request);
  assert.equal(attempts, 2);
  assert.equal((await reopened.request('/results')).data.results.some(result => result.status === 'completed'), true);
});

test('a result write failure retains the attempted file until an explicit successful recovery', async t => {
  const f = await fixture(t);
  const resultsPath = path.join(f.dataDir, 'results');
  await fs.rmdir(resultsPath);
  await fs.writeFile(resultsPath, 'temporarily inaccessible directory');
  await f.request('/auto-pick', { filePath: f.files[0], options: localOptions });
  const paused = await until(async () => { const queue = (await f.request('/auto-pick')).data; return queue.paused && !queue.activeJob ? queue : null; });
  assert.equal(paused.pendingCount, 1);
  assert.equal(f.calls.length, 1);
  await fs.unlink(resultsPath);
  await fs.mkdir(resultsPath);
  await f.request('/auto-pick', { resume: true }, 'PUT');
  await quiet(f.request);
  assert.equal(f.calls.length, 2);
  assert.equal((await f.request('/results')).data.results[0].status, 'completed');
});

test('restart removes a journal entry whose completed result was already durably saved', async t => {
  const f = await fixture(t);
  await f.request('/auto-pick', { filePath: f.files[0], options: localOptions });
  await quiet(f.request);
  const journalPath = path.join(f.dataDir, 'auto-pick.json');
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  journal.entries.push({ path: f.files[0], name: path.basename(f.files[0]), queuedAt: new Date().toISOString() });
  await fs.writeFile(journalPath, JSON.stringify(journal));
  await f.close();
  const reopened = await f.open(false);
  await quiet(reopened.request);
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(await fs.readFile(journalPath, 'utf8')).entries.length, 0);
});
