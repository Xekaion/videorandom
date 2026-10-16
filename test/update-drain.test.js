const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const express = require('express');
const { createLanAnalysis, sendRemoteAnalysis } = require('../lib/lan-analysis');
const { createAnalysisService } = require('../lib/analysis-service');
const { createHistoryService } = require('../lib/history-service');

// These tests use only invented text, a JPEG signature and inert file bytes.
// No speech recognizer, model, real media decoder or external service runs.
const CODE = 'owned-update-fixture-code-12345678';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function until(read, predicate = Boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Owned update fixture did not reach its expected boundary');
}
async function directory(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-update-drain-'));
  t.after(async () => {
    assert.equal(path.dirname(dataDir), os.tmpdir());
    assert.ok(path.basename(dataDir).startsWith('videorandom-update-drain-'));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return dataDir;
}
const connectionStore = () => ({ getHostCode: async () => CODE });
function metadata(translationOnly = false) {
  return { name: 'owned-neutral.mp4', ext: 'MP4', sizeMB: 1, duration: 60,
    transcript: [{ id: 1, start: 1, end: 3, text: '합성 원문' }], transcriptSource: 'sidecar:srt', transcribeAudio: false,
    frames: translationOnly ? [] : [{ timestamp: 5, filename: 'frame_001.jpg' }],
    ...(translationOnly ? { operation: 'translation-only', subtitleLanguage: 'ko' } : {}) };
}
function multipart(info) {
  const boundary = 'owned-update-boundary';
  const chunks = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(info)}\r\n`)];
  if (info.frames.length) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="frames"; filename="frame_001.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), JPEG, Buffer.from('\r\n'));
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);
  return { body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) } };
}
async function host(t, dataDir, processPackage, options = {}) {
  const service = createLanAnalysis({ dataDir, processPackage, connectionStore: connectionStore(), ...options });
  const status = await service.start({ port: options.port || 0, host: '127.0.0.1' });
  t.after(() => service.stop());
  const base = `http://127.0.0.1:${status.port}`;
  const request = (endpoint, options = {}) => fetch(base + endpoint, { ...options, headers: { Authorization: 'Bearer ' + CODE, ...options.headers } });
  return { service, status, base, request, submit: (info = metadata()) => request('/v1/jobs', { method: 'POST', ...multipart(info) }) };
}
const terminal = (f, id) => until(async () => (await f.request('/v1/jobs/' + id)).json(), job => ['completed', 'failed', 'cancelled'].includes(job.status));
const complete = record => ({ ...record, status: 'completed', summary: '검증용 합성 요약', transcript: record.transcript || [], frames: record.frames || [], warnings: [], labels: [] });

test('managed drain protects both LAN lanes and queued work, then restores terminal results and frames on the same address', async t => {
  const dataDir = await directory(t), gates = [gate(), gate(), gate()], calls = [];
  t.after(() => gates.forEach(item => item.release()));
  const f = await host(t, dataDir, async (pkg, context) => {
    const index = calls.length;
    calls.push({ operation: pkg.operation, signal: context.signal });
    await gates[index].promise;
    return complete(pkg.record);
  });
  const first = await (await f.submit()).json();
  await until(() => calls.length === 1);
  const queued = await (await f.submit()).json();
  const translation = await (await f.submit(metadata(true))).json();
  await until(() => calls.length === 2);
  const draining = f.service.prepareUpdate();
  assert.deepEqual([draining.active, draining.queued, draining.uploading, draining.draining, draining.busy], [2, 1, 0, true, true]);
  const refused = await f.submit();
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get('retry-after'), '5');
  await assert.rejects(f.service.finishUpdate(), { status: 409 });
  assert.ok(calls.every(call => !call.signal.aborted));
  gates[0].release();
  await until(() => calls.length === 3);
  assert.equal(f.service.getUpdateStatus().active, 2, 'queued ASR work continues while the translation lane is active');
  gates[1].release(); gates[2].release();
  const before = await Promise.all([first, queued, translation].map(job => terminal(f, job.id)));
  await until(() => !f.service.getUpdateStatus().busy);
  assert.equal(f.service.getUpdateStatus().blocked, false);
  await f.service.finishUpdate();
  assert.equal(f.service.status().running, false);
  const restored = await host(t, dataDir, () => { throw new Error('A completed job must never execute again'); }, { port: f.status.port });
  assert.equal(restored.status.port, f.status.port);
  assert.equal(restored.status.connectionCode, CODE);
  for (const job of before) {
    assert.deepEqual(await (await restored.request('/v1/jobs/' + job.id)).json(), job);
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'remote', 'jobs', job.id, 'terminal.json'), 'utf8'));
    assert.equal(saved.schemaVersion, 1);
    assert.equal(JSON.stringify(saved).includes(CODE), false);
  }
  const image = await restored.request(`/v1/jobs/${first.id}/frames/frame_001.jpg`);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), JPEG);
});

test('a completed LAN result stays nonterminal until its atomic recovery journal is durable', async t => {
  const dataDir = await directory(t), writing = gate(), release = gate();
  t.after(() => release.release());
  const journalIO = { ...fs, async rename(from, to) {
    if (path.basename(to) === 'terminal.json') { writing.release(); await release.promise; }
    return fs.rename(from, to);
  } };
  const f = await host(t, dataDir, async ({ record }) => complete(record), { journalIO });
  const accepted = await (await f.submit()).json();
  await writing.promise;
  f.service.prepareUpdate();
  const pending = await (await f.request('/v1/jobs/' + accepted.id)).json();
  assert.equal(pending.status, 'running');
  assert.equal(pending.result, null);
  assert.equal(f.service.getUpdateStatus().persisting, 1);
  assert.equal(f.service.getUpdateStatus().busy, true);
  await assert.rejects(f.service.finishUpdate(), { status: 409 });
  release.release();
  assert.equal((await terminal(f, accepted.id)).status, 'completed');
  await until(() => !f.service.getUpdateStatus().busy);
  await f.service.finishUpdate();
});

test('failed or malformed LAN terminal journals block managed exit while current clients can retain their result', async t => {
  const dataDir = await directory(t);
  const f = await host(t, dataDir, async ({ record }) => complete(record), { journalIO: { ...fs, async rename() { throw Object.assign(new Error('owned journal failure'), { code: 'EIO' }); } } });
  const accepted = await (await f.submit()).json();
  assert.equal((await terminal(f, accepted.id)).result.summary, '검증용 합성 요약');
  f.service.prepareUpdate();
  assert.equal(f.service.getUpdateStatus().blocked, true);
  await assert.rejects(f.service.finishUpdate(), { status: 409 });
  assert.equal(f.service.status().running, true);
  await f.service.stop();
  await fs.writeFile(path.join(dataDir, 'remote', 'jobs', accepted.id, 'terminal.json'), '{not valid json');
  const restored = await host(t, dataDir, async ({ record }) => complete(record));
  restored.service.prepareUpdate();
  assert.equal(restored.service.getUpdateStatus().blocked, true);
  await assert.rejects(restored.service.finishUpdate(), { status: 409 });
});

test('an upload accepted before drain finishes normally and remains busy through upload cleanup', async t => {
  const dataDir = await directory(t), f = await host(t, dataDir, async ({ record }) => complete(record));
  const payload = multipart(metadata());
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(f.base + '/v1/jobs', { method: 'POST', headers: { Authorization: 'Bearer ' + CODE, ...payload.headers } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    request.on('error', reject);
  });
  t.after(() => request.destroy());
  const split = Math.floor(payload.body.length / 2);
  request.write(payload.body.subarray(0, split));
  await until(() => f.service.getUpdateStatus().uploading === 1);
  f.service.prepareUpdate();
  assert.equal(f.service.getUpdateStatus().busy, true);
  await assert.rejects(f.service.finishUpdate(), { status: 409 });
  assert.equal((await f.submit()).status, 503);
  request.end(payload.body.subarray(split));
  const accepted = await response;
  assert.equal(accepted.status, 202);
  assert.equal((await terminal(f, accepted.body.id)).status, 'completed');
  await until(() => !f.service.getUpdateStatus().busy);
  f.service.cancelUpdate();
  assert.equal((await f.submit()).status, 202);
});

async function client(t, dataDir, analyzeVideo, exporter) {
  const paths = ['first.mp4', 'second.mp4'].map(name => path.join(dataDir, name));
  await Promise.all(paths.map(filename => fs.writeFile(filename, 'inert owned fixture; never decoded')));
  const lan = createLanAnalysis({ dataDir, connectionStore: connectionStore(), processPackage: async ({ record }) => complete(record) });
  const service = createAnalysisService({ dataDir, engine: { getToolsStatus: async () => ({ available: true }), analyzeVideo }, exporter, lan });
  await service.ready;
  service.registerFiles(paths.map(filename => ({ path: filename, name: path.basename(filename), ext: 'MP4' })));
  const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
  const server = await new Promise(resolve => { const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate)); });
  t.after(async () => { await service.stop(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  const request = (endpoint, body, method = body === undefined ? 'GET' : 'POST') => fetch(`http://127.0.0.1:${server.address().port}/api/analysis` + endpoint,
    { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { service, lan, request, paths };
}
const localTerminal = (f, id) => until(async () => (await f.request('/jobs/' + id)).json(), job => !['running', 'cancelling'].includes(job.status));

test('local drain saves the active job, preserves the waiting queue and resumes it only after update cancellation', async t => {
  const dataDir = await directory(t), firstGate = gate(), secondGate = gate(), contexts = [];
  t.after(() => { firstGate.release(); secondGate.release(); });
  const f = await client(t, dataDir, async (file, options, context) => {
    const index = contexts.length; contexts.push(context);
    await (index ? secondGate : firstGate).promise;
    return complete(file);
  });
  const accepted = await (await f.request('/jobs', { files: [f.paths[0]], options: { mode: 'local' } })).json();
  await until(() => contexts.length === 1);
  assert.equal((await f.request('/auto-pick', { filePath: f.paths[1], options: { mode: 'local' } })).status, 202);
  const queueBefore = await fs.readFile(path.join(dataDir, 'auto-pick.json'), 'utf8');
  const draining = await f.service.prepareUpdate();
  assert.equal(draining.draining, true);
  assert.equal(draining.active, 1);
  await assert.rejects(f.service.finishUpdate(), { status: 409 });
  for (const [url, body, method] of [['/jobs', { files: [f.paths[1]] }], ['/export', { ids: [] }], ['/results/' + 'a'.repeat(32), {}, 'PUT'], ['/results/' + 'a'.repeat(32) + '/subtitles/repair', {}]]) {
    const refused = await f.request(url, body, method);
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get('retry-after'), '5');
  }
  assert.equal(contexts[0].signal.aborted, false);
  firstGate.release();
  const done = await localTerminal(f, accepted.id);
  assert.equal(done.status, 'completed');
  await until(() => !f.service.getUpdateStatus().busy);
  assert.equal(contexts.length, 1, 'a durable auto pick waits for the next version rather than starting during drain');
  assert.equal(await fs.readFile(path.join(dataDir, 'auto-pick.json'), 'utf8'), queueBefore);
  await f.service.cancelUpdate();
  await until(() => contexts.length === 2);
  secondGate.release();
  await until(async () => (await (await f.request('/results')).json()).results.length === 2);
  await until(() => !f.service.getUpdateStatus().busy);
  await f.service.prepareUpdate(); await f.service.finishUpdate();
  assert.ok(contexts.every(context => !context.signal.aborted));
});

test('update preparation and cancellation preserve a user pause and queue bytes exactly', async t => {
  const dataDir = await directory(t), filename = path.join(dataDir, 'second.mp4');
  const bytes = JSON.stringify({ schemaVersion: 1, enabled: true, paused: true, pauseReason: '사용자가 중지한 합성 대기열', pauseCause: { kind: 'user-cancel', path: filename },
    safeOptions: { mode: 'local', frameCount: 10, transcribeAudio: false, transcriptLanguage: 'auto', subtitleLanguage: 'original', subtitleQuality: 'fast', remoteUrl: '' },
    entries: [{ path: filename, name: 'second.mp4', ext: 'MP4', size: 1, queuedAt: new Date().toISOString() }] });
  await fs.writeFile(path.join(dataDir, 'auto-pick.json'), bytes);
  let calls = 0;
  const f = await client(t, dataDir, async file => { calls++; return complete(file); });
  await f.service.prepareUpdate(); await f.service.cancelUpdate();
  const queue = await (await f.request('/auto-pick')).json();
  assert.equal(queue.paused, true);
  assert.equal(queue.pauseCause.kind, 'user-cancel');
  assert.equal(queue.pendingCount, 1);
  assert.equal(calls, 0);
  assert.equal(await fs.readFile(path.join(dataDir, 'auto-pick.json'), 'utf8'), bytes);
});

test('a failed handoff can reopen the finished host at its original port with the same connection code', async t => {
  const dataDir = await directory(t), f = await client(t, dataDir, async file => complete(file));
  const original = await f.lan.start({ port: 0, host: '127.0.0.1' });
  const prepared = await f.service.prepareUpdate();
  assert.equal(prepared.remote.running, true);
  assert.equal(prepared.remote.port, original.port);
  assert.equal(JSON.stringify(prepared).includes(CODE), false);
  await f.service.finishUpdate();
  assert.equal(f.service.getUpdateStatus().remote.running, false);
  // The application owner would cancel its staged helper here after a failed
  // history flush. No global server, process or security setting is touched.
  const resumed = await f.service.cancelUpdate();
  assert.equal(resumed.draining, false);
  assert.equal(resumed.remote.running, true);
  assert.equal(resumed.remote.port, original.port);
  const response = await fetch(`http://127.0.0.1:${original.port}/v1/status`, { headers: { Authorization: 'Bearer ' + CODE } });
  assert.equal(response.status, 200);
});

test('a disconnected edit request still keeps its unfinished durable save busy during update drain', async t => {
  const dataDir = await directory(t), f = await client(t, dataDir, async file => complete(file));
  const accepted = await (await f.request('/jobs', { files: [f.paths[0]] })).json();
  const done = await localTerminal(f, accepted.id), entered = gate(), release = gate();
  const open = fs.open;
  t.after(() => { release.release(); fs.open = open; });
  fs.open = async (filename, ...args) => {
    if (path.dirname(filename) === path.join(dataDir, 'results')) { entered.release(); await release.promise; }
    return open(filename, ...args);
  };
  const controller = new AbortController();
  // request() intentionally has no arbitrary signal parameter; this one owned
  // PUT uses the existing fixture's app port obtained from its config response.
  const probe = await f.request('/config');
  const url = new URL(probe.url); url.pathname = '/api/analysis/results/' + done.results[0].id;
  const editing = fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plot: '완료까지 보존할 합성 수정' }), signal: controller.signal }).catch(error => error);
  await entered.promise; controller.abort(); await editing;
  await f.service.prepareUpdate();
  assert.equal(f.service.getUpdateStatus().busy, true);
  assert.ok(f.service.getUpdateStatus().mutating > 0);
  await assert.rejects(f.service.finishUpdate(), { status: 409 });
  release.release();
  await until(() => !f.service.getUpdateStatus().busy);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'results', done.results[0].id + '.json'), 'utf8'));
  assert.equal(saved.plot, '완료까지 보존할 합성 수정');
});

test('local drain waits for an in-flight workbook and refuses managed exit after failed result persistence', async t => {
  const dataDir = await directory(t), exportEntered = gate(), exportRelease = gate();
  t.after(() => exportRelease.release());
  const f = await client(t, dataDir, async file => complete(file), { async createCatalogWorkbook() { exportEntered.release(); await exportRelease.promise; return Buffer.from('owned workbook fixture'); } });
  const accepted = await (await f.request('/jobs', { files: [f.paths[0]], options: { mode: 'local' } })).json();
  const done = await localTerminal(f, accepted.id);
  const exporting = f.request('/export', { ids: [done.results[0].id] });
  await exportEntered.promise;
  await f.service.prepareUpdate();
  assert.equal(f.service.getUpdateStatus().exporting, true);
  await assert.rejects(f.service.finishUpdate(), { status: 409 });
  exportRelease.release();
  assert.equal((await exporting).status, 200);
  await until(() => !f.service.getUpdateStatus().busy);
  await f.service.cancelUpdate();
  // A failure is induced only in an invented result, not in any real data.
  const bad = await client(t, await directory(t), async file => { const result = complete(file); result.ownedCircularFixture = result; return result; });
  const started = await (await bad.request('/jobs', { files: [bad.paths[0]] })).json();
  assert.equal((await localTerminal(bad, started.id)).status, 'failed');
  await bad.service.prepareUpdate();
  assert.equal(bad.service.getUpdateStatus().blocked, true);
  await assert.rejects(bad.service.finishUpdate(), { status: 409 });
});

test('history flush waits for queued writes and reports a failed durable write instead of allowing update exit', async t => {
  const dataDir = await directory(t), service = createHistoryService({ dataDir }), entered = gate(), release = gate();
  await service.ready;
  const appendFile = fs.appendFile;
  t.after(() => { release.release(); fs.appendFile = appendFile; });
  let fail = false, block = true;
  fs.appendFile = async (filename, ...args) => {
    if (filename === service.logPath) {
      if (block) { entered.release(); await release.promise; }
      if (fail) throw new Error('owned append failure');
    }
    return appendFile(filename, ...args);
  };
  const video = { path: path.join(dataDir, 'first.mp4'), name: 'first.mp4', ext: 'MP4', size: 1 };
  const writing = service.recordPick(video);
  await entered.promise;
  let flushed = false;
  const flushing = service.flush().then(() => { flushed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(flushed, false);
  release.release(); await writing; await flushing;
  assert.equal(JSON.parse((await fs.readFile(service.logPath, 'utf8')).trim()).name, 'first.mp4');
  block = false; fail = true;
  await assert.rejects(service.recordPick(video), /owned append failure/);
  await assert.rejects(service.flush(), /히스토리 저장/);
  fail = false;
  await service.recordPick(video); await service.flush();
});

test('managed-update hosts extend only accepted-job network recovery beyond the legacy three retries', async t => {
  const dataDir = await directory(t), id = 'a'.repeat(32), remoteId = 'b'.repeat(32);
  const record = { id, name: 'owned-neutral.mp4', path: path.join(dataDir, 'owned-neutral.mp4'), ext: 'MP4', duration: 60, size: 1,
    transcript: [{ id: 1, start: 1, end: 3, text: '합성 원문' }], frames: [], warnings: [] };
  let posts = 0, polls = 0;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + CODE);
    if (req.url === '/v1/status') return res.end(JSON.stringify({ ready: true, protocol: 1, capabilities: ['timed-subtitles-v1', 'subtitle-quality-v3', 'subtitle-translation-only-v1', 'managed-update-v1'] }));
    if (req.url === '/v1/jobs' && req.method === 'POST') {
      posts++; for await (const ignored of req) { /* Owned text fixture only. */ }
      return res.end(JSON.stringify({ id: remoteId, status: 'running', percent: 10 }));
    }
    if (req.url === '/v1/jobs/' + remoteId) {
      if (++polls <= 4) return res.destroy();
      return res.end(JSON.stringify({ id: remoteId, status: 'completed', result: { ...record, id: remoteId, subtitleLanguage: 'ko', subtitleTranslation: [{ id: 1, start: 1, end: 3, text: '검증한 합성 번역' }] } }));
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const result = await sendRemoteAnalysis(record, { dataDir, remoteUrl: `http://127.0.0.1:${server.address().port}`, connectionCode: CODE,
    operation: 'translation-only', subtitleQuality: 'fast' });
  assert.equal(result.subtitleTranslation[0].text, '검증한 합성 번역');
  assert.deepEqual([posts, polls], [1, 5]);
});

test('managed handoff finishes an in-flight image response and resumes the remaining images after terminal restoration', async t => {
  const dataDir = await directory(t), clientDir = path.join(dataDir, 'client'), hostDir = path.join(dataDir, 'host');
  const id = 'c'.repeat(32), firstImageEntered = gate(), firstImageRelease = gate(), reconnectObserved = gate();
  t.after(() => firstImageRelease.release());
  const frames = [{ filename: 'frame_001.jpg', timestamp: 5 }, { filename: 'frame_002.jpg', timestamp: 15 }];
  await fs.mkdir(path.join(clientDir, 'frames', id), { recursive: true });
  await Promise.all(frames.map(frame => fs.writeFile(path.join(clientDir, 'frames', id, frame.filename), JPEG)));
  let analyses = 0;
  const f = await host(t, hostDir, async ({ record }) => { analyses++; return complete(record); });
  const sendFile = f.service.app.response.sendFile;
  f.service.app.response.sendFile = function (filename, ...args) {
    if (path.basename(filename) !== frames[0].filename) return sendFile.call(this, filename, ...args);
    this.setHeader('Content-Type', 'image/jpeg');
    this.setHeader('Content-Length', String(JPEG.length));
    this.write(JPEG.subarray(0, 3));
    firstImageEntered.release();
    firstImageRelease.promise.then(() => this.end(JPEG.subarray(3)));
    return this;
  };
  const original = { id, name: 'owned-neutral.mp4', path: path.join(clientDir, 'owned-neutral.mp4'), ext: 'MP4', size: 1, duration: 60,
    transcript: [{ id: 1, start: 1, end: 3, text: '업데이트 중 보존할 합성 대사' }], frames, labels: [], warnings: [] };
  const receiving = sendRemoteAnalysis(original, { dataDir: clientDir, remoteUrl: f.base, connectionCode: CODE, subtitleQuality: 'fast',
    onProgress(stage) { if (stage === '분석 서버 이미지 연결 복구 중') reconnectObserved.release(); } });
  await firstImageEntered.promise;
  f.service.prepareUpdate();
  let closed = false;
  const closing = f.service.finishUpdate().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(closed, false, 'managed shutdown cannot truncate the already accepted JPEG body');
  firstImageRelease.release();
  await closing;
  await reconnectObserved.promise;
  const replacement = await host(t, hostDir, () => { throw new Error('A terminal analysis cannot be resubmitted after handoff'); }, { port: f.status.port });
  assert.equal(replacement.status.port, f.status.port);
  const result = await receiving;
  assert.equal(analyses, 1);
  assert.equal(result.summary, '검증용 합성 요약');
  assert.equal(result.status, 'completed');
  assert.equal(result.id, original.id);
  assert.equal(result.path, original.path);
  assert.deepEqual(result.transcript, original.transcript);
  assert.equal(result.frames.length, 2);
  for (const frame of frames) assert.deepEqual(await fs.readFile(path.join(clientDir, 'frames', id, frame.filename)), JPEG);
});

test('a stalled image times out managed close, reopens the same host, and finishes later without clearing its replacement', async t => {
  const dataDir = await directory(t), entered = gate(), release = gate(), oldSocketClosed = gate();
  t.after(() => release.release());
  const f = await host(t, dataDir, async ({ record }) => complete(record), { managedCloseTimeoutMs: 40 });
  const accepted = await (await f.submit()).json();
  const completed = await terminal(f, accepted.id);
  const sendFile = f.service.app.response.sendFile;
  let holdFirst = true;
  f.service.app.response.sendFile = function (filename, ...args) {
    if (!holdFirst) return sendFile.call(this, filename, ...args);
    holdFirst = false;
    this.setHeader('Content-Type', 'image/jpeg'); this.setHeader('Content-Length', String(JPEG.length));
    this.socket.once('close', () => oldSocketClosed.release());
    this.write(JPEG.subarray(0, 3));
    entered.release(); release.promise.then(() => this.end(JPEG.subarray(3)));
    return this;
  };
  const response = await f.request(`/v1/jobs/${accepted.id}/frames/frame_001.jpg`);
  const stalledBody = response.arrayBuffer();
  await entered.promise;
  f.service.prepareUpdate();
  await assert.rejects(f.service.finishUpdate(), error => { assert.equal(error.code, 'UPDATE_LAN_CLOSE_TIMEOUT'); assert.equal(error.status, 409); return true; });
  assert.equal(f.service.getUpdateStatus().busy, false, 'the expired close promise cannot keep restart waiting forever');
  const resumed = await f.service.cancelUpdate();
  assert.equal(resumed.running, true);
  assert.equal(resumed.port, f.status.port);
  assert.equal(f.service.status().connectionCode, CODE);
  assert.equal((await f.request('/v1/status')).status, 200);
  assert.deepEqual(await (await f.request('/v1/jobs/' + accepted.id)).json(), completed);
  assert.deepEqual(Buffer.from(await (await f.request(`/v1/jobs/${accepted.id}/frames/frame_001.jpg`)).arrayBuffer()), JPEG);
  release.release();
  assert.deepEqual(Buffer.from(await stalledBody), JPEG, 'timing out an update must leave the earlier body intact');
  await oldSocketClosed.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.status().running, true, 'late completion of the old close cannot clear the replacement listener');
  assert.equal(f.service.status().port, f.status.port);
  assert.equal(f.service.status().connectionCode, CODE);
  assert.equal((await f.request('/v1/status')).status, 200);
});

async function imageRecoveryHost(t, { managed = true, frameResponse } = {}) {
  const dataDir = await directory(t), id = 'd'.repeat(32), remoteId = 'e'.repeat(32), frame = { filename: 'frame_001.jpg', timestamp: 5 };
  await fs.mkdir(path.join(dataDir, 'frames', id), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'frames', id, frame.filename), JPEG);
  const record = { id, name: 'owned-neutral.mp4', path: path.join(dataDir, 'owned-neutral.mp4'), ext: 'MP4', size: 1, duration: 60,
    transcript: [], frames: [frame], warnings: [], labels: [] };
  const counts = { posts: 0, frames: 0, cancels: 0 };
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + CODE) { res.writeHead(401); return res.end('{}'); }
    if (req.url === '/v1/status') return res.end(JSON.stringify({ ready: true, protocol: 1, capabilities: ['timed-subtitles-v1', 'subtitle-quality-v3', ...(managed ? ['managed-update-v1'] : [])] }));
    if (req.url === '/v1/jobs' && req.method === 'POST') {
      counts.posts++; for await (const ignored of req) { /* Owned multipart fixture only. */ }
      return res.end(JSON.stringify({ id: remoteId, status: 'completed', percent: 100, result: complete({ ...record, id: remoteId }) }));
    }
    if (req.url === `/v1/jobs/${remoteId}/frames/${frame.filename}`) { counts.frames++; return frameResponse(counts.frames, res); }
    if (req.url === `/v1/jobs/${remoteId}/cancel`) { counts.cancels++; return res.end('{}'); }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { counts, record, send: options => sendRemoteAnalysis(record, { dataDir, remoteUrl: `http://127.0.0.1:${server.address().port}`,
    connectionCode: CODE, subtitleQuality: 'fast', ...options }) };
}

test('managed image GET recovery crosses the legacy retry limit without repeating analysis', async t => {
  const f = await imageRecoveryHost(t, { frameResponse(attempt, res) { if (attempt <= 4) return res.destroy(); res.end(JPEG); } });
  const result = await f.send();
  assert.equal(result.frames.length, 1);
  assert.equal(result.summary, '검증용 합성 요약');
  assert.deepEqual(f.counts, { posts: 1, frames: 5, cancels: 0 });
});

test('image HTTP refusals and legacy image network failures are never replayed', async t => {
  for (const status of [401, 403, 404, 429, 503]) await t.test('HTTP ' + status, async t => {
    const f = await imageRecoveryHost(t, { frameResponse(attempt, res) { res.writeHead(status); res.end(JSON.stringify({ error: 'owned image refusal' })); } });
    await assert.rejects(f.send(), error => {
      assert.equal(error.statusCode, status);
      assert.equal(error.record.summary, '검증용 합성 요약', 'Already received text must remain available');
      return true;
    });
    assert.deepEqual(f.counts, { posts: 1, frames: 1, cancels: 0 });
  });
  await t.test('legacy network failure', async t => {
    const f = await imageRecoveryHost(t, { managed: false, frameResponse(attempt, res) { res.destroy(); } });
    await assert.rejects(f.send(), error => { assert.equal(error.record.summary, '검증용 합성 요약'); return true; });
    assert.deepEqual(f.counts, { posts: 1, frames: 1, cancels: 0 });
  });
});

test('aborting managed image recovery stops backoff and preserves received text without resubmitting work', async t => {
  const controller = new AbortController();
  const f = await imageRecoveryHost(t, { frameResponse(attempt, res) { res.destroy(); } });
  await assert.rejects(f.send({ signal: controller.signal, onProgress(stage) {
    if (stage === '분석 서버 이미지 연결 복구 중') controller.abort();
  } }), error => { assert.equal(error.name, 'AbortError'); assert.equal(error.record.summary, '검증용 합성 요약'); return true; });
  assert.deepEqual(f.counts, { posts: 1, frames: 1, cancels: 1 });
});
