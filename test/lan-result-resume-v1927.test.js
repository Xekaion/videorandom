const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { sendRemoteAnalysis, resumeRemoteAnalysis } = require('../lib/lan-analysis');

const CODE = 'owned-receipt-fixture-code-123456';
const ID = 'a'.repeat(32), JOB = 'b'.repeat(32);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);

async function fixture(t, { translationOnly = false, poll, frameResponse } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-result-resume-'));
  const frame = { filename: 'frame-01.jpg', timestamp: 5 };
  const record = { id: ID, name: 'owned-neutral.mp4', path: 'C:/synthetic-only/owned-neutral.mp4', ext: 'MP4', size: 1,
    duration: 60, hasAudio: false, status: 'completed', transcriptSource: 'synthetic',
    transcript: translationOnly ? [{ id: 4, start: 1, end: 3, text: '電車が到着します。' }] : [],
    frames: [frame], warnings: [], summary: '보관된 합성 안내' };
  await fs.mkdir(path.join(dataDir, 'frames', ID), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'frames', ID, frame.filename), JPEG);
  const calls = { posts: 0, polls: 0, frames: 0, requests: [] };
  const completed = { id: JOB, status: 'completed', percent: 100, result: { ...record, id: JOB, path: 'remote-upload://' + JOB,
    summary: '합성 안내를 확인했습니다.', frames: [{ ...frame, caption: '기차역 합성 표지' }],
    ...(translationOnly ? { subtitleRepairStatus: 'completed', subtitleLanguage: 'ko',
      subtitleTranslation: [{ id: 4, start: 1, end: 3, text: '열차가 도착합니다.' }] } : {}) } };
  const server = http.createServer(async (req, res) => {
    calls.requests.push({ method: req.method, url: req.url });
    if (req.headers.authorization !== 'Bearer ' + CODE) { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/v1/status') {
      res.end(JSON.stringify({ ready: true, protocol: 1, appVersion: '1.9.26', capabilities: ['timed-subtitles-v1', 'subtitle-quality-v3',
        'subtitle-translation-only-v1', 'sparse-subtitles-v1', CODE] })); return;
    }
    if (req.method === 'POST' && req.url === '/v1/jobs') {
      calls.posts++;
      for await (const ignored of req) { /* Consume owned neutral multipart fixture only. */ }
      res.end(JSON.stringify({ id: JOB, status: 'running', percent: 20 })); return;
    }
    if (req.method === 'GET' && req.url === '/v1/jobs/' + JOB) {
      calls.polls++;
      if (poll) { poll(calls.polls, req, res, completed); return; }
      res.end(JSON.stringify(completed)); return;
    }
    if (req.method === 'GET' && req.url === `/v1/jobs/${JOB}/frames/${frame.filename}`) {
      calls.frames++;
      if (frameResponse) { frameResponse(calls.frames, req, res); return; }
      res.end(JPEG); return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    assert.equal(path.dirname(dataDir), os.tmpdir());
    assert.ok(path.basename(dataDir).startsWith('videorandom-result-resume-'));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const remoteUrl = `http://127.0.0.1:${server.address().port}`;
  const options = { remoteUrl, connectionCode: CODE, dataDir, subtitleQuality: 'fast', ...(translationOnly ? { operation: 'translation-only' } : {}) };
  return { dataDir, record, options, calls, completed, remoteUrl,
    async capture(extra = {}) {
      let receipt, snapshot;
      await assert.rejects(sendRemoteAnalysis({ ...record, ...extra }, { ...options, onRemoteJobAccepted(saved, source) {
        receipt = saved; snapshot = source;
        throw new Error('Stop owned fixture after durable receipt capture');
      } }), error => {
        assert.equal(error.code, 'LAN_RECEIPT_SAVE_FAILED');
        assert.equal(error.remoteJobRecoverable, false);
        assert.equal(error.remoteJobId, JOB);
        assert.deepEqual(error.remoteJob, receipt);
        return true;
      });
      return { receipt, snapshot };
    },
    resume: (receipt, extra = {}, source = record) => resumeRemoteAnalysis(source, { ...options, ...extra }, receipt) };
}

test('accepted receipt callback is awaited before any poll and exposes no credentials or raw cues in the receipt', async t => {
  const f = await fixture(t);
  const { receipt, snapshot } = await f.capture({ connectionCode: CODE, apiKey: 'synthetic-unused-secret', token: 'unused' });
  assert.equal(f.calls.posts, 1);
  assert.equal(f.calls.polls, 0);
  assert.equal(receipt.serverOrigin, f.remoteUrl);
  assert.equal(receipt.serverJobId, JOB);
  assert.equal(receipt.recordId, ID);
  assert.equal(receipt.operation, 'analysis');
  assert.equal(receipt.serverVersion, '1.9.26');
  assert.match(receipt.sourceIdentity, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(receipt, 'transcript'), false);
  assert.equal(JSON.stringify(receipt).includes(CODE), false);
  assert.equal(Object.hasOwn(snapshot, 'connectionCode'), false);
  assert.equal(Object.hasOwn(snapshot, 'apiKey'), false);
  assert.equal(Object.hasOwn(snapshot, 'token'), false);
  assert.equal(snapshot.path, f.record.path);
  assert.notEqual(snapshot.frames, f.record.frames);
});

test('full result and frames resume from one accepted job using GET only and restore client identity', async t => {
  const f = await fixture(t);
  const { receipt, snapshot } = await f.capture();
  const start = f.calls.requests.length, progress = [];
  const result = await f.resume(JSON.parse(JSON.stringify(receipt)), { onProgress: (stage, percent) => progress.push({ stage, percent }) }, snapshot);
  assert.equal(result.summary, '합성 안내를 확인했습니다.');
  assert.equal(result.id, ID);
  assert.equal(result.path, f.record.path);
  assert.equal(result.frames.length, 1);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'frames', ID, 'frame-01.jpg')), JPEG);
  assert.ok(progress.some(item => /접수된.*복구/.test(item.stage)));
  assert.equal(progress.at(-1).percent, 100);
  assert.deepEqual([f.calls.posts, f.calls.polls, f.calls.frames], [1, 1, 1]);
  assert.ok(f.calls.requests.slice(start).every(item => item.method === 'GET'));
  assert.ok(f.calls.requests.every(item => !item.url.includes(CODE)));
});

test('translation-only resume restores exact retained cue times without uploading or fetching frames', async t => {
  const f = await fixture(t, { translationOnly: true });
  const { receipt } = await f.capture();
  const result = await f.resume(receipt);
  assert.equal(result.subtitleTranslation[0].text, '열차가 도착합니다.');
  assert.deepEqual(result.transcript, f.record.transcript);
  assert.equal(result.summary, f.record.summary);
  assert.deepEqual(result.frames, f.record.frames);
  assert.equal(result.subtitleTranslation[0].id, 4);
  assert.equal(result.subtitleTranslation[0].start, 1);
  assert.equal(result.subtitleTranslation[0].end, 3);
  assert.deepEqual([f.calls.posts, f.calls.polls, f.calls.frames], [1, 1, 0]);
});

for (const [label, mutate, extra, source] of [
  ['different origin', value => ({ ...value, serverOrigin: 'http://127.0.0.1:9' })],
  ['different job identifier', value => ({ ...value, serverJobId: '../other-job' })],
  ['different record identifier', value => ({ ...value, recordId: 'c'.repeat(32) })],
  ['different source digest', value => ({ ...value, sourceIdentity: '0'.repeat(64) })],
  ['invalid operation', value => ({ ...value, operation: 'provider-retry' })],
  ['different requested operation', value => value, { operation: 'translation-only' }],
  ['changed local file path', value => value, {}, value => ({ ...value, path: 'C:/synthetic-only/other.mp4' })],
  ['changed duration', value => value, {}, value => ({ ...value, duration: 61 })],
  ['changed frame time', value => value, {}, value => ({ ...value, frames: [{ filename: 'frame-01.jpg', timestamp: 6 }] })],
  ['unsafe frame path', value => value, {}, value => ({ ...value, frames: [{ filename: '../outside.jpg', timestamp: 5 }] })]
]) test('receipt mismatch rejects before any network request: ' + label, async t => {
  const f = await fixture(t), { receipt } = await f.capture();
  const requestCount = f.calls.requests.length;
  await assert.rejects(f.resume(mutate(receipt), extra || {}, source ? source(f.record) : f.record), { code: 'LAN_RECEIPT_MISMATCH' });
  assert.equal(f.calls.requests.length, requestCount);
  assert.equal(f.calls.posts, 1);
});

for (const [label, mutate] of [
  ['job envelope', value => ({ ...value, id: 'c'.repeat(32) })],
  ['result identifier', value => ({ ...value, result: { ...value.result, id: ID } })],
  ['result name', value => ({ ...value, result: { ...value.result, name: 'other.mp4' } })],
  ['result extension', value => ({ ...value, result: { ...value.result, ext: 'WMV' } })],
  ['result duration', value => ({ ...value, result: { ...value.result, duration: 61 } })],
  ['result size', value => ({ ...value, result: { ...value.result, size: 2 } })]
]) test('wrong saved result is never accepted or retried: ' + label, async t => {
  const f = await fixture(t, { poll(attempt, req, res, value) { res.end(JSON.stringify(mutate(value))); } });
  const { receipt } = await f.capture();
  await assert.rejects(f.resume(receipt), error => {
    assert.equal(error.code, label === 'job envelope' ? 'LAN_JOB_IDENTITY_MISMATCH' : 'LAN_RESULT_IDENTITY_MISMATCH');
    assert.equal(error.remoteJobRecoverable, false);
    assert.equal(error.remoteJobId, JOB);
    return true;
  });
  assert.deepEqual([f.calls.posts, f.calls.polls, f.calls.frames], [1, 1, 0]);
});

for (const status of [401, 403, 404, 429, 503]) test('HTTP ' + status + ' remains a hard stop without a new request', async t => {
  const f = await fixture(t, { poll(attempt, req, res) { res.writeHead(status); res.end(JSON.stringify({ error: 'owned technical HTTP response ' + CODE })); } });
  const { receipt } = await f.capture();
  await assert.rejects(f.resume(receipt), error => {
    assert.equal(error.code, status === 404 ? 'LAN_REMOTE_JOB_NOT_FOUND' : 'LAN_HTTP_ERROR');
    assert.equal(error.statusCode, status);
    assert.equal(error.remoteJobRecoverable, false);
    assert.equal(error.message.includes(CODE), false);
    assert.equal(error.stack.includes(CODE), false);
    assert.equal(JSON.stringify(error).includes(CODE), false);
    return true;
  });
  assert.equal(f.calls.polls, 1);
  assert.equal(f.calls.posts, 1);
});

for (const status of ['failed', 'cancelled']) test('terminal ' + status + ' is read once and never resubmitted', async t => {
  const f = await fixture(t, { poll(attempt, req, res) { res.end(JSON.stringify({ id: JOB, status, error: 'owned terminal response; no provider invoked' })); } });
  const { receipt } = await f.capture();
  await assert.rejects(f.resume(receipt), error => {
    assert.equal(error.code, status === 'failed' ? 'LAN_REMOTE_JOB_FAILED' : 'LAN_REMOTE_JOB_CANCELLED');
    assert.equal(error.remoteJobRecoverable, false);
    return true;
  });
  assert.equal(f.calls.polls, 1);
  assert.equal(f.calls.posts, 1);
});

test('incomplete status JSON retries only the accepted GET and receives its completed result', async t => {
  const f = await fixture(t, { poll(attempt, req, res, value) { res.end(attempt <= 2 ? '{"id":' : JSON.stringify(value)); } });
  const { receipt } = await f.capture();
  const result = await f.resume(receipt);
  assert.equal(result.summary, '합성 안내를 확인했습니다.');
  assert.deepEqual([f.calls.posts, f.calls.polls], [1, 3]);
});

test('bounded JSON failure preserves the receipt so a later read resumes the same job', async t => {
  let available = false;
  const f = await fixture(t, { poll(attempt, req, res, value) { res.end(available ? JSON.stringify(value) : '{'); } });
  const { receipt } = await f.capture();
  let saved;
  await assert.rejects(f.resume(receipt), error => {
    assert.equal(error.code, 'LAN_STATUS_RECONNECT_FAILED');
    assert.equal(error.transportCode, 'LAN_INVALID_JSON');
    assert.equal(error.remoteJobRecoverable, true);
    assert.equal(error.remoteJob.serverJobId, JOB);
    saved = error.remoteJob;
    return true;
  });
  assert.equal(f.calls.polls, 4);
  available = true;
  assert.equal((await f.resume(saved)).summary, '합성 안내를 확인했습니다.');
  assert.deepEqual([f.calls.posts, f.calls.polls], [1, 5]);
});

test('exhausted network reads keep the technical system code and resume without uploading again', async t => {
  let available = false;
  const f = await fixture(t, { poll(attempt, req, res, value) { if (!available) return res.destroy(); res.end(JSON.stringify(value)); } });
  const { receipt } = await f.capture();
  let saved;
  await assert.rejects(f.resume(receipt), error => {
    assert.equal(error.code, 'LAN_STATUS_RECONNECT_FAILED');
    assert.equal(error.systemCode, 'ECONNRESET');
    assert.equal(error.remoteJobRecoverable, true);
    saved = error.remoteJob;
    return true;
  });
  available = true;
  assert.equal((await f.resume(saved)).summary, '합성 안내를 확인했습니다.');
  assert.deepEqual([f.calls.posts, f.calls.polls], [1, 5]);
});

test('aborting resume interrupts a network backoff without sending cancellation or another POST', async t => {
  const f = await fixture(t, { poll(attempt, req, res) { res.destroy(); } });
  const { receipt } = await f.capture();
  const controller = new AbortController();
  await assert.rejects(f.resume(receipt, { signal: controller.signal, onProgress(stage) {
    if (stage === '분석 서버 연결 복구 중') controller.abort();
  } }), error => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.remoteJobRecoverable, false);
    return true;
  });
  assert.deepEqual([f.calls.posts, f.calls.polls], [1, 1]);
  assert.equal(f.calls.requests.some(item => item.url.endsWith('/cancel')), false);
});

test('frame transport failure keeps received text and can restore images from the same saved job', async t => {
  let available = false;
  const f = await fixture(t, { frameResponse(attempt, req, res) { if (!available) return res.destroy(); res.end(JPEG); } });
  const { receipt } = await f.capture();
  await assert.rejects(f.resume(receipt), error => {
    assert.equal(error.code, 'ECONNRESET');
    assert.equal(error.remoteJobRecoverable, true);
    assert.equal(error.record.summary, '합성 안내를 확인했습니다.');
    assert.equal(error.record.status, 'partial');
    assert.equal(error.record.frames.length, 1);
    return true;
  });
  available = true;
  assert.equal((await f.resume(receipt)).frames.length, 1);
  assert.deepEqual([f.calls.posts, f.calls.polls, f.calls.frames], [1, 2, 2]);
});

test('invalid image payload remains a typed hard stop with received text preserved', async t => {
  const f = await fixture(t, { frameResponse(attempt, req, res) { res.end('invalid synthetic bytes'); } });
  const { receipt } = await f.capture();
  await assert.rejects(f.resume(receipt), error => {
    assert.equal(error.code, 'LAN_FRAME_INVALID');
    assert.equal(error.remoteJobRecoverable, false);
    assert.equal(error.record.summary, '합성 안내를 확인했습니다.');
    return true;
  });
  assert.deepEqual([f.calls.posts, f.calls.polls, f.calls.frames], [1, 1, 1]);
});

test('image storage failure is never mistaken for a transport reconnection', async t => {
  const f = await fixture(t), { receipt } = await f.capture();
  const destination = path.join(f.dataDir, 'frames', ID);
  await fs.rm(destination, { recursive: true });
  await fs.writeFile(destination, 'owned obstruction');
  await assert.rejects(f.resume(receipt), error => {
    assert.ok(['EEXIST', 'ENOTDIR'].includes(error.code));
    assert.equal(error.remoteJobRecoverable, false);
    assert.equal(error.record.summary, '합성 안내를 확인했습니다.');
    return true;
  });
  assert.deepEqual([f.calls.posts, f.calls.polls, f.calls.frames], [1, 1, 0]);
});

async function hostFixture(t, { diskSpace, processPackage } = {}) {
  const { createLanAnalysis } = require('../lib/lan-analysis');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-host-resume-'));
  let processed = 0;
  const service = createLanAnalysis({ dataDir, diskSpace,
    processPackage: async (input, context) => { processed++; return processPackage ? processPackage(input, context) : { ...input.record, status: 'completed', summary: '합성 안내 완료' }; } });
  const state = await service.start({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await service.stop();
    assert.equal(path.dirname(dataDir), os.tmpdir());
    assert.ok(path.basename(dataDir).startsWith('videorandom-host-resume-'));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, service, state, processed: () => processed, url: `http://127.0.0.1:${state.port}` };
}

test('host rejects a known upload space shortage before writing any body files and returns safe typed 507', async t => {
  const checks = [];
  const host = await hostFixture(t, { diskSpace: { async assert(options) {
    checks.push(options);
    throw Object.assign(new Error('Synthetic insufficient space'), { code: 'STORAGE_SPACE_LOW', known: true, availableBytes: 1,
      requiredBytes: options.requiredBytes, reserveBytes: options.reserveBytes, totalRequiredBytes: options.requiredBytes + options.reserveBytes,
      privatePath: 'DO_NOT_RETURN_PRIVATE_PATH', authorization: CODE });
  } } });
  const client = await fixture(t);
  await assert.rejects(sendRemoteAnalysis(client.record, { ...client.options, remoteUrl: host.url, connectionCode: host.state.connectionCode }), error => {
    assert.equal(error.code, 'STORAGE_SPACE_LOW');
    assert.equal(error.statusCode, 507);
    assert.equal(error.storageLocation, 'remote');
    assert.equal(error.availableBytes, 1);
    assert.equal(error.reserveBytes, 512 * 1024 * 1024);
    assert.ok(error.requiredBytes > JPEG.length);
    assert.equal(error.totalRequiredBytes, error.requiredBytes + error.reserveBytes);
    assert.equal(Object.hasOwn(error, 'remoteJob'), false);
    assert.equal(JSON.stringify(error).includes('DO_NOT_RETURN_PRIVATE_PATH'), false);
    assert.equal(JSON.stringify(error).includes(CODE), false);
    return true;
  });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].path, host.dataDir);
  assert.equal(host.processed(), 0);
  assert.deepEqual(await fs.readdir(path.join(host.dataDir, 'remote', 'jobs')), []);
});

test('unknown disk probe permits the owned upload and reserves only bounded incoming data plus safety margin', async t => {
  const checks = [];
  const host = await hostFixture(t, { diskSpace: { async assert(options) { checks.push(options); return { known: false, ok: true }; } } });
  const client = await fixture(t);
  const result = await sendRemoteAnalysis(client.record, { ...client.options, remoteUrl: host.url, connectionCode: host.state.connectionCode });
  assert.equal(result.summary, '합성 안내 완료');
  assert.equal(host.processed(), 1);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].reserveBytes, 512 * 1024 * 1024);
  assert.ok(checks[0].requiredBytes > JPEG.length && checks[0].requiredBytes < 10 * 1024);
});

test('streamed upload ENOSPC becomes typed 507 and never runs processing', async t => {
  const stream = require('node:stream'), nativeFs = require('node:fs');
  const host = await hostFixture(t, { diskSpace: { async assert() { return { known: false, ok: true }; } } });
  const client = await fixture(t);
  const original = nativeFs.createWriteStream;
  nativeFs.createWriteStream = function(filename, ...args) {
    if (String(filename).startsWith(path.join(host.dataDir, 'remote', 'jobs') + path.sep)) return new stream.Writable({
      write(chunk, encoding, callback) { callback(Object.assign(new Error('Owned synthetic ENOSPC'), { code: 'ENOSPC' })); } });
    return original.call(this, filename, ...args);
  };
  try {
    await assert.rejects(sendRemoteAnalysis(client.record, { ...client.options, remoteUrl: host.url, connectionCode: host.state.connectionCode }), error => {
      assert.equal(error.code, 'STORAGE_SPACE_LOW');
      assert.equal(error.systemCode, 'ENOSPC');
      assert.equal(error.statusCode, 507);
    assert.equal(error.storageLocation, 'remote');
      assert.equal(Object.hasOwn(error, 'remoteJob'), false);
      return true;
    });
  } finally { nativeFs.createWriteStream = original; }
  assert.equal(host.processed(), 0);
});

test('safe host exception diagnostic survives terminal save, restart, and same-job GET without running processing twice', async t => {
  const { createLanAnalysis } = require('../lib/lan-analysis');
  const { httpFixtureResponse } = require('./http-json-fixture');
  const marker = 'PRIVATE_UNSTRUCTURED_PROVIDER_PAYLOAD';
  const host = await hostFixture(t, { diskSpace: { async assert() { return { known: false, ok: true }; } }, processPackage() {
    throw Object.assign(new Error('Owned transport exception'), { code: 'PROVIDER_UNAVAILABLE', httpStatus: 503, systemCode: 'ECONNRESET', rawResponse: marker });
  } });
  const client = await fixture(t);
  let receipt;
  await assert.rejects(sendRemoteAnalysis(client.record, { ...client.options, remoteUrl: host.url, connectionCode: host.state.connectionCode,
    onRemoteJobAccepted(value) { receipt = value; } }), error => {
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(error.httpStatus, 503);
    assert.equal(error.systemCode, 'ECONNRESET');
    assert.equal(error.remoteJobTerminalStatus, 'failed');
    assert.equal(error.remoteJobRecoverable, false);
    assert.equal(JSON.stringify(error).includes(marker), false);
    return true;
  });
  const saved = JSON.parse(await fs.readFile(path.join(host.dataDir, 'remote', 'jobs', receipt.serverJobId, 'terminal.json'), 'utf8'));
  assert.equal(saved.errorDiagnostic.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(saved.errorDiagnostic.httpStatus, 503);
  assert.equal(saved.errorDiagnostic.systemCode, 'ECONNRESET');
  assert.equal(JSON.stringify(saved).includes(marker), false);
  await host.service.stop();
  const restored = createLanAnalysis({ dataDir: host.dataDir, diskSpace: { async assert() { throw new Error('No upload on restoration'); } },
    processPackage() { throw new Error('Never reprocess an already accepted terminal job'); } });
  const state = await restored.start({ port: 0, host: '127.0.0.1' });
  t.after(() => restored.stop());
  const response = await httpFixtureResponse(`http://127.0.0.1:${state.port}/v1/jobs/${receipt.serverJobId}`, { headers: { Authorization: 'Bearer ' + state.connectionCode } });
  const job = await response.json();
  assert.equal(job.status, 'failed');
  assert.equal(job.errorDiagnostic.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(job.errorDiagnostic.httpStatus, 503);
  assert.equal(job.errorDiagnostic.systemCode, 'ECONNRESET');
  assert.equal(JSON.stringify(job).includes(marker), false);
  assert.equal(host.processed(), 1);
});

for (const [label, probe, expected] of [
  ['known low', async () => ({ known: true, availableBytes: 1, path: 'PRIVATE_VOLUME_PATH', token: CODE }),
    { known: true, availableBytes: 1, ok: false }],
  ['known available', async () => ({ known: true, availableBytes: 4 * 1024 * 1024 * 1024, path: 'PRIVATE_VOLUME_PATH', token: CODE }),
    { known: true, availableBytes: 4 * 1024 * 1024 * 1024, ok: true }],
  ['unknown', async () => ({ known: false, availableBytes: null, path: 'PRIVATE_VOLUME_PATH', token: CODE }),
    { known: false, availableBytes: null, ok: true }],
  ['probe failure', async () => { throw Object.assign(new Error('PRIVATE_VOLUME_PATH'), { token: CODE }); },
    { known: false, availableBytes: null, ok: true }]
]) test('authenticated host status exposes only bounded technical storage fields: ' + label, async t => {
  const { checkRemoteServer } = require('../lib/lan-analysis');
  const checks = [];
  const host = await hostFixture(t, { diskSpace: { assert: async () => ({ ok: true }), async check(options) { checks.push(options); return probe(); } } });
  const status = await checkRemoteServer({ remoteUrl: host.url, connectionCode: host.state.connectionCode });
  assert.deepEqual(status.storage, { ...expected, requiredBytes: 32 * 1024 * 1024, reserveBytes: 512 * 1024 * 1024 });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].path, host.dataDir);
  assert.equal(checks[0].requiredBytes, 32 * 1024 * 1024);
  assert.equal(checks[0].reserveBytes, 512 * 1024 * 1024);
  assert.equal(JSON.stringify(status).includes('PRIVATE_VOLUME_PATH'), false);
  assert.equal(JSON.stringify(status).includes(CODE), false);
  assert.equal(host.processed(), 0);
});
