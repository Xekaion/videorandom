const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { sendRemoteAnalysis } = require('../lib/lan-analysis');
const { isLanUploadInterrupted } = require('../lib/diagnostics');

const CODE = 'owned-upload-client-fixture-123456';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-owned-upload-client-'));
  const id = 'a'.repeat(32), frame = { timestamp: 3, filename: 'frame-01.jpg' };
  const record = { id, name: 'owned-neutral-train.mp4', path: 'C:/owned-synthetic-only/train.mp4', ext: 'MP4',
    size: 1, duration: 60, hasAudio: false, transcript: [], transcriptSource: 'none', frames: [frame], warnings: [] };
  await fs.mkdir(path.join(dataDir, 'frames', id), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'frames', id, frame.filename), JPEG);
  const calls = { posts: 0, lookups: 0, statuses: 0, jobGets: 0, frameGets: 0, cancels: 0 };
  const diagnostics = [], accepted = [], progress = [], controller = new AbortController();
  let uploadId, expectedBytes;
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + CODE) { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/v1/status') {
      calls.statuses++;
      if (calls.statuses > 1 && options.healthStatus) { res.writeHead(options.healthStatus); res.end('{}'); return; }
      if (calls.statuses > 1 && options.healthDrop) { res.destroy(); return; }
      res.end(JSON.stringify({ ready: options.healthy !== false || calls.statuses === 1, protocol: 1,
        ...(calls.statuses > 1 && options.lowStorage ? { storage: { known: true, ok: false } } : {}),
        capabilities: ['timed-subtitles-v1', 'subtitle-quality-v3', ...(options.legacy ? [] : ['upload-receipts-v1'])] })); return;
    }
    if (req.url === '/v1/jobs' && req.method === 'POST') {
      calls.posts++; uploadId = req.headers['x-videorandom-upload-id']; expectedBytes = Number(req.headers['content-length']);
      if (options.postStatus) {
        res.writeHead(options.postStatus, { 'Content-Length': '100' }); res.flushHeaders(); setImmediate(() => res.destroy()); return;
      }
      for await (const ignored of req) { /* This is inert synthetic multipart. */ }
      res.destroy(); return;
    }
    if (req.url === '/v1/uploads/' + uploadId) {
      calls.lookups++;
      if (options.lookupStatus) { res.writeHead(options.lookupStatus); res.end('{}'); return; }
      if (options.lookupDrop) { res.destroy(); return; }
      const phase = options.phase || 'accepted';
      const job = { id: uploadId, status: 'completed', percent: 100,
        result: { ...record, id: uploadId, status: 'completed', summary: '합성 열차 안내', frames: [{ ...frame, caption: '합성 장면' }] } };
      const receipt = { schemaVersion: 1, uploadId, phase, expectedBytes, receivedBytes: phase === 'accepted' ? expectedBytes : 0, elapsedMs: 15,
        ...(phase === 'accepted' ? { jobId: uploadId, ...(options.missingJob ? {} : { job }) } : {}),
        ...(options.rejection ? { errorDiagnostic: options.rejection } : {}), privateRaw: 'PRIVATE_UPLOAD_PAYLOAD' };
      if (options.wrongId) receipt.uploadId = 'b'.repeat(32);
      if (options.wrongJob) receipt.job.id = 'b'.repeat(32);
      if (options.shortAccepted) receipt.receivedBytes = 0;
      res.end(JSON.stringify(receipt)); return;
    }
    if (req.url === '/v1/jobs/' + uploadId) { calls.jobGets++; res.writeHead(404); res.end('{}'); return; }
    if (req.url === `/v1/jobs/${uploadId}/frames/${frame.filename}`) { calls.frameGets++; res.end(JPEG); return; }
    if (req.url === `/v1/jobs/${uploadId}/cancel`) { calls.cancels++; res.end('{}'); return; }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const remoteUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    assert.equal(path.dirname(dataDir), os.tmpdir()); assert.ok(path.basename(dataDir).startsWith('videorandom-owned-upload-client-'));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { calls, record, diagnostics, accepted, progress, controller,
    send: extra => sendRemoteAnalysis(record, { dataDir, remoteUrl, connectionCode: CODE, signal: controller.signal,
      onDiagnostic: event => diagnostics.push(event), onRemoteJobAccepted: receipt => accepted.push(receipt),
      onProgress: stage => { progress.push(stage); options.onProgress?.(stage, controller); }, ...extra }) };
}

test('a lost 202 response reads its durable upload receipt and receives the same accepted result without another POST', async t => {
  const f = await fixture(t);
  const result = await f.send();
  assert.equal(result.summary, '합성 열차 안내'); assert.equal(result.id, f.record.id); assert.equal(result.path, f.record.path);
  assert.deepEqual(f.calls, { posts: 1, lookups: 1, statuses: 1, jobGets: 0, frameGets: 1, cancels: 0 });
  assert.equal(f.accepted.length, 1); assert.match(f.accepted[0].serverJobId, /^[a-f0-9]{32}$/);
  assert.equal(f.accepted[0].recordId, f.record.id);
  assert.doesNotMatch(JSON.stringify([f.diagnostics, f.progress]), /PRIVATE_UPLOAD_PAYLOAD|Bearer|owned-upload-client-fixture/);
});

for (const options of [{ phase: 'interrupted' }, { phase: 'receiving' }, { legacy: true }, { lookupStatus: 404 }, { lookupDrop: true }]) {
  test(`an unconfirmed upload never replays and permits only independent continuation after fresh server health: ${JSON.stringify(options)}`, async t => {
    const f = await fixture(t, options);
    await assert.rejects(f.send(), error => { assert.equal(error.code, 'LAN_UPLOAD_INTERRUPTED'); assert.equal(isLanUploadInterrupted(error), true); return true; });
    assert.equal(f.calls.posts, 1); assert.equal(f.calls.statuses, 2); assert.equal(f.calls.jobGets, 0); assert.equal(f.calls.frameGets, 0);
    assert.equal(f.accepted.length, 0); assert.equal(f.calls.cancels, 0);
  });
}

for (const status of [401, 403, 429, 503, 507]) {
  test(`POST HTTP ${status} headers cannot be hidden by a dropped response body`, async t => {
    const f = await fixture(t, { postStatus: status });
    await assert.rejects(f.send(), error => error.statusCode === status);
    assert.equal(f.calls.posts, 1); assert.equal(f.calls.statuses, 1); assert.equal(f.calls.lookups, 0);
  });
  test(`receipt lookup HTTP ${status} stops recovery without a health-based continuation marker`, async t => {
    const f = await fixture(t, { lookupStatus: status });
    await assert.rejects(f.send(), error => error.statusCode === status && !isLanUploadInterrupted(error));
    assert.equal(f.calls.posts, 1); assert.equal(f.calls.lookups, 1); assert.equal(f.calls.statuses, 1);
  });
}

for (const options of [{ healthy: false }, { healthDrop: true }, { healthStatus: 401 }, { healthStatus: 429 }]) {
  test(`unhealthy or unauthorized follow-up cannot release the queue: ${JSON.stringify(options)}`, async t => {
    const f = await fixture(t, { phase: 'interrupted', ...options });
    await assert.rejects(f.send(), error => !isLanUploadInterrupted(error));
    assert.equal(f.calls.posts, 1); assert.equal(f.accepted.length, 0);
  });
}

for (const options of [{ wrongId: true }, { wrongJob: true }, { shortAccepted: true }]) {
  test(`mismatched receipt identity cannot fetch or accept another job: ${JSON.stringify(options)}`, async t => {
    const f = await fixture(t, options);
    await assert.rejects(f.send(), error => error.code === 'LAN_UPLOAD_RECEIPT_INVALID');
    assert.equal(f.calls.posts, 1); assert.equal(f.accepted.length, 0); assert.equal(f.calls.frameGets, 0);
  });
}

test('an accepted receipt whose job is unavailable is persisted as accepted rather than replayed or called unconfirmed', async t => {
  const f = await fixture(t, { missingJob: true });
  await assert.rejects(f.send(), error => Boolean(error.code === 'LAN_REMOTE_JOB_NOT_FOUND' && error.remoteJob?.serverJobId));
  assert.equal(f.accepted.length, 1); assert.equal(f.calls.posts, 1); assert.equal(f.calls.jobGets, 1);
});

test('a durable upload rejection preserves the storage failure and never grants network continuation', async t => {
  const f = await fixture(t, { phase: 'rejected', rejection: { code: 'STORAGE_SPACE_LOW', httpStatus: 507, systemCode: 'ENOSPC' } });
  await assert.rejects(f.send(), error => error.code === 'STORAGE_SPACE_LOW' && error.storageLocation === 'remote' && !isLanUploadInterrupted(error));
  assert.equal(f.calls.posts, 1); assert.equal(f.calls.statuses, 1);
});

test('a responding server with known low storage is not treated as healthy queue continuation', async t => {
  const f = await fixture(t, { legacy: true, lowStorage: true });
  await assert.rejects(f.send(), error => error.code === 'STORAGE_SPACE_LOW' && error.storageLocation === 'remote' && !isLanUploadInterrupted(error));
  assert.equal(f.calls.posts, 1); assert.equal(f.calls.statuses, 2);
});

for (const code of ['STORAGE_SPACE_LOW', 'STORAGE_WRITE_FAILED', 'PROVIDER_AUTH', 'PROVIDER_QUOTA', 'PROVIDER_REFUSAL', 'ANALYSIS_CANCELLED']) {
  test(`an interrupted upload receipt cannot hide competing ${code} evidence`, async t => {
    const f = await fixture(t, { phase: 'interrupted', rejection: { code, ...(code === 'STORAGE_SPACE_LOW' ? { systemCode: 'ENOSPC' } : {}) } });
    await assert.rejects(f.send(), error => error.code === code && !isLanUploadInterrupted(error));
    assert.equal(f.calls.posts, 1); assert.equal(f.calls.statuses, 1); assert.equal(f.accepted.length, 0);
  });
}

for (const phase of ['interrupted', 'receiving']) {
  for (const code of ['PROVIDER_UNKNOWN', 'DIAGNOSTIC_UNKNOWN', 'ANALYSIS_BUSY', 'FILE_NOT_FOUND', 'SUBTITLE_BATCH_INVALID']) {
    test(`${phase} receipt retains explicit ${code} rather than replacing it with a healthy-server marker`, async t => {
      const f = await fixture(t, { phase, rejection: { code } });
      await assert.rejects(f.send(), error => error.code === code && !isLanUploadInterrupted(error));
      assert.equal(f.calls.posts, 1); assert.equal(f.calls.statuses, 1); assert.equal(f.calls.lookups, 1);
      assert.equal(f.accepted.length, 0);
    });
  }
}

for (const rejection of [
  { code: 'LAN_UPLOAD_DISCONNECTED', causeCode: 'PROVIDER_AUTH' },
  { code: 'LAN_UPLOAD_DISCONNECTED', providerErrorType: 'quota' },
  { code: 'LAN_UPLOAD_DISCONNECTED', systemCode: 'ENOSPC' },
  { code: 'NETWORK_UNREACHABLE', systemCode: 'ECONNRESET', diagnostic: { code: 'PROVIDER_REFUSAL' } },
  { code: 'NETWORK_UNREACHABLE', systemCode: 'ECONNRESET', httpStatus: 401 },
  { code: 'LAN_UPLOAD_DISCONNECTED', message: 'PRIVATE_UPLOAD_PAYLOAD' }
]) {
  test(`conflicting transport receipt evidence never authorizes queue continuation: ${Object.keys(rejection).join(',')}`, async t => {
    const f = await fixture(t, { phase: 'interrupted', rejection });
    await assert.rejects(f.send(), error => !isLanUploadInterrupted(error));
    assert.equal(f.calls.posts, 1); assert.equal(f.calls.statuses, 1); assert.equal(f.calls.lookups, 1);
    assert.equal(f.accepted.length, 0);
  });
}

for (const rejection of [{ code: 'LAN_UPLOAD_DISCONNECTED' }, { code: 'NETWORK_UNREACHABLE', systemCode: 'ECONNRESET' }]) {
  test(`a canonical transport-only interrupted receipt can follow a fresh health probe: ${rejection.code}`, async t => {
    const f = await fixture(t, { phase: 'interrupted', rejection });
    await assert.rejects(f.send(), error => isLanUploadInterrupted(error));
    assert.equal(f.calls.posts, 1); assert.equal(f.calls.statuses, 2); assert.equal(f.calls.lookups, 1);
    assert.equal(f.accepted.length, 0);
  });
}

test('cancellation interrupts receipt backoff without accepting, replaying or unpausing', async t => {
  const f = await fixture(t, { phase: 'receiving', onProgress(stage, controller) {
    if (stage === '자료 전송 연결 복구 · 서버 접수 여부 확인 중') controller.abort();
  } });
  await assert.rejects(f.send(), { name: 'AbortError' });
  assert.equal(f.calls.posts, 1); assert.equal(f.calls.lookups, 1); assert.equal(f.calls.statuses, 1); assert.equal(f.accepted.length, 0);
});
