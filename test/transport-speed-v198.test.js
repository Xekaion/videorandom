const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { createLanAnalysis, sendRemoteAnalysis } = require('../lib/lan-analysis');

const CODE = 'owned-frame-fingerprint-test-123456';
const LOCAL_ID = 'a'.repeat(32), JOB_ID = 'b'.repeat(32);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
const OTHER_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 3, 1, 0xff, 0xd9]);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function ownedDirectory(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith(prefix));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function record(id = LOCAL_ID) {
  return { id, name: 'owned-transport-fixture.mp4', path: 'C:/owned-synthetic/transport.mp4', ext: 'MP4', size: 1,
    duration: 60, hasAudio: false, transcript: [], transcriptSource: 'none', warnings: [],
    frames: [{ filename: 'frame_001.jpg', timestamp: 10, caption: '' }] };
}

async function clientFixture(t, { capability = true, fingerprints = { 'frame_001.jpg': digest(JPEG) }, afterUpload,
  localBytes = JPEG, responseBytes = JPEG, frameDelayMs = 0, frameStatus = 200 } = {}) {
  const dataDir = await ownedDirectory(t, 'videorandom-fingerprint-client-');
  const filename = path.join(dataDir, 'frames', LOCAL_ID, 'frame_001.jpg');
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, localBytes);
  const calls = { statuses: 0, uploads: 0, frames: 0, cancels: 0 };
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + CODE) { res.writeHead(401).end('{}'); return; }
    if (req.url === '/v1/status') {
      calls.statuses++;
      res.end(JSON.stringify({ ready: true, protocol: 1, capabilities: ['subtitle-quality-v3',
        ...(capability ? ['original-frame-fingerprints-v1'] : [])] })); return;
    }
    if (req.url === '/v1/jobs' && req.method === 'POST') {
      calls.uploads++;
      for await (const ignored of req) { /* Owned multipart fixture only. */ }
      if (afterUpload) await afterUpload(filename);
      res.end(JSON.stringify({ id: JOB_ID, status: 'completed', frameFingerprints: fingerprints,
        result: { ...record(JOB_ID), status: 'completed', summary: '합성 전송 결과',
          frames: [{ filename: 'frame_001.jpg', timestamp: 10, caption: '합성 대표 이미지' }] } })); return;
    }
    if (req.url === `/v1/jobs/${JOB_ID}/frames/frame_001.jpg`) {
      calls.frames++;
      if (frameDelayMs) await new Promise(resolve => setTimeout(resolve, frameDelayMs));
      res.writeHead(frameStatus).end(frameStatus === 200 ? responseBytes : JSON.stringify({ error: 'owned image refusal' })); return;
    }
    if (req.url === `/v1/jobs/${JOB_ID}/cancel`) { calls.cancels++; res.end('{}'); return; }
    res.writeHead(404).end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  return { calls, filename, send: extra => sendRemoteAnalysis(record(), { dataDir,
    remoteUrl: `http://127.0.0.1:${server.address().port}`, connectionCode: CODE, ...extra }) };
}

test('matching terminal SHA-256 reuses the exact local JPEG without another image request or write', async t => {
  const f = await clientFixture(t);
  const before = await fs.stat(f.filename);
  const result = await f.send();
  assert.deepEqual(f.calls, { statuses: 1, uploads: 1, frames: 0, cancels: 0 });
  assert.equal(result.frames[0].caption, '합성 대표 이미지');
  assert.equal(result.path, record().path);
  assert.deepEqual(await fs.readFile(f.filename), JPEG);
  assert.equal((await fs.stat(f.filename)).mtimeMs, before.mtimeMs);
});

test('changed or missing client image falls back to the original image endpoint and restores exact bytes', async t => {
  for (const change of ['changed', 'missing']) await t.test(change, async t => {
    const f = await clientFixture(t, { afterUpload: filename => change === 'changed' ? fs.writeFile(filename, OTHER_JPEG) : fs.unlink(filename) });
    const result = await f.send();
    assert.equal(result.status, 'completed');
    assert.equal(f.calls.frames, 1);
    assert.deepEqual(await fs.readFile(f.filename), JPEG);
  });
});

test('a valid but different host image is downloaded and never hidden by local reuse', async t => {
  const f = await clientFixture(t, { fingerprints: { 'frame_001.jpg': digest(OTHER_JPEG) }, responseBytes: OTHER_JPEG });
  await f.send();
  assert.equal(f.calls.frames, 1);
  assert.deepEqual(await fs.readFile(f.filename), OTHER_JPEG);
});

test('downloaded bytes that contradict the terminal fingerprint are rejected once before replacing a local image', async t => {
  const f = await clientFixture(t, { fingerprints: { 'frame_001.jpg': digest(OTHER_JPEG) }, responseBytes: JPEG });
  const before = await fs.stat(f.filename);
  await assert.rejects(f.send(), error => {
    assert.equal(error.code, 'LAN_FRAME_FINGERPRINT_MISMATCH');
    assert.equal(error.record.status, 'partial');
    assert.equal(error.record.summary, '합성 전송 결과');
    assert.equal(error.record.frames.length, 1);
    return true;
  });
  assert.deepEqual(f.calls, { statuses: 1, uploads: 1, frames: 1, cancels: 0 });
  assert.deepEqual(await fs.readFile(f.filename), JPEG);
  assert.equal((await fs.stat(f.filename)).mtimeMs, before.mtimeMs);
});

test('legacy, missing, malformed or unexpected-path fingerprint metadata keeps ordinary transfer behavior', async t => {
  for (const [label, options] of [
    ['legacy capability', { capability: false }], ['missing digest', { fingerprints: {} }],
    ['invalid digest', { fingerprints: { 'frame_001.jpg': 'invalid' } }],
    ['foreign path', { fingerprints: { '../other.jpg': digest(JPEG) } }],
    ['array', { fingerprints: ['frame_001.jpg', digest(JPEG)] }]
  ]) await t.test(label, async t => {
    const f = await clientFixture(t, options);
    await f.send();
    assert.equal(f.calls.frames, 1);
    assert.deepEqual(await fs.readFile(f.filename), JPEG);
  });
});

test('fingerprint optimization does not accept a corrupt local file even when its digest matches', async t => {
  const bad = Buffer.from('not-a-jpeg');
  const f = await clientFixture(t, { localBytes: bad, fingerprints: { 'frame_001.jpg': digest(bad) } });
  await assert.rejects(f.send(), error => {
    assert.equal(error.code, 'LAN_FRAME_FINGERPRINT_MISMATCH');
    assert.equal(error.record.status, 'partial');
    assert.equal(error.record.frames.length, 0);
    return true;
  });
  assert.equal(f.calls.frames, 1);
  assert.deepEqual(await fs.readFile(f.filename), bad);
});

test('fallback image refusal is returned once with the received text preserved', async t => {
  const f = await clientFixture(t, { fingerprints: {}, frameStatus: 403 });
  await assert.rejects(f.send(), error => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.record.summary, '합성 전송 결과');
    assert.equal(error.record.status, 'partial');
    return true;
  });
  assert.deepEqual(f.calls, { statuses: 1, uploads: 1, frames: 1, cancels: 0 });
});

test('host fingerprints actual postprocessing image bytes and persists them across its owned restart', async t => {
  const dataDir = await ownedDirectory(t, 'videorandom-fingerprint-host-');
  const clientDir = await ownedDirectory(t, 'videorandom-fingerprint-roundtrip-');
  const original = record(), localFilename = path.join(clientDir, 'frames', LOCAL_ID, original.frames[0].filename);
  await fs.mkdir(path.dirname(localFilename), { recursive: true });
  await fs.writeFile(localFilename, JPEG);
  let serverId;
  const service = createLanAnalysis({ dataDir, connectionStore: { getHostCode: async () => CODE },
    async processPackage(pkg) {
      serverId = pkg.record.id;
      await fs.writeFile(path.join(pkg.framesDir, original.frames[0].filename), OTHER_JPEG);
      return { ...pkg.record, status: 'completed', summary: '합성 결과', frames: [{ ...pkg.record.frames[0], caption: '합성 이미지' }] };
    } });
  t.after(() => service.stop());
  const started = await service.start({ host: '127.0.0.1', port: 0 });
  const remoteUrl = `http://127.0.0.1:${started.port}`;
  const result = await sendRemoteAnalysis(original, { dataDir: clientDir, remoteUrl, connectionCode: CODE });
  assert.equal(result.summary, '합성 결과');
  assert.deepEqual(await fs.readFile(localFilename), OTHER_JPEG);
  const terminal = JSON.parse(await fs.readFile(path.join(dataDir, 'remote', 'jobs', serverId, 'terminal.json'), 'utf8'));
  assert.deepEqual(terminal.frameFingerprints, { 'frame_001.jpg': digest(OTHER_JPEG) });
  await service.stop();
  const restarted = await service.start({ host: '127.0.0.1', port: 0 });
  const restored = await fetch(`http://127.0.0.1:${restarted.port}/v1/jobs/${serverId}`, { headers: { Authorization: 'Bearer ' + CODE } }).then(response => response.json());
  assert.deepEqual(restored.frameFingerprints, terminal.frameFingerprints);
  assert.equal(restored.result.summary, result.summary);
});

test('cancellation during optional host fingerprinting retains produced cues in its cancelled durable result', async t => {
  const dataDir = await ownedDirectory(t, 'videorandom-fingerprint-cancel-host-');
  const clientDir = await ownedDirectory(t, 'videorandom-fingerprint-cancel-client-');
  const localFilename = path.join(clientDir, 'frames', LOCAL_ID, 'frame_001.jpg');
  await fs.mkdir(path.dirname(localFilename), { recursive: true });
  await fs.writeFile(localFilename, JPEG);
  const cues = [{ id: 1, start: 1, end: 3, text: '合成試験' }];
  let serverId, notifyHash, releaseHash;
  const hashEntered = new Promise(resolve => { notifyHash = resolve; });
  const hashGate = new Promise(resolve => { releaseHash = resolve; });
  const service = createLanAnalysis({ dataDir, connectionStore: { getHostCode: async () => CODE },
    async processPackage(pkg) {
      serverId = pkg.record.id;
      return { ...pkg.record, status: 'completed', transcript: cues, summary: '보관할 합성 결과' };
    } });
  t.after(() => service.stop());
  const started = await service.start({ host: '127.0.0.1', port: 0 });
  const remoteUrl = `http://127.0.0.1:${started.port}`;
  const originalOpen = fs.open;
  const openMock = t.mock.method(fs, 'open', async (filename, ...args) => {
    const handle = await originalOpen(filename, ...args);
    if (typeof filename === 'string' && filename.startsWith(path.join(dataDir, 'remote', 'jobs') + path.sep)
      && path.basename(filename) === 'frame_001.jpg') {
      notifyHash();
      await hashGate;
    }
    return handle;
  });
  const clientTask = sendRemoteAnalysis(record(), { dataDir: clientDir, remoteUrl, connectionCode: CODE }).then(
    value => ({ value }), error => ({ error }));
  try {
    await hashEntered;
    const headers = { Authorization: 'Bearer ' + CODE };
    const cancelling = await fetch(`${remoteUrl}/v1/jobs/${serverId}/cancel`, { method: 'POST', headers }).then(response => response.json());
    assert.equal(cancelling.status, 'cancelling');
    assert.equal(cancelling.result, null);
    releaseHash();
    const client = await clientTask;
    assert.match(client.error.message, /분석을 중지/);
    const done = await fetch(`${remoteUrl}/v1/jobs/${serverId}`, { headers }).then(response => response.json());
    assert.equal(done.status, 'cancelled');
    assert.equal(done.stage, '분석 중지됨');
    assert.deepEqual(done.result.transcript, cues);
    assert.equal(done.result.summary, '보관할 합성 결과');
    assert.equal(done.frameFingerprints, undefined);
    const journal = JSON.parse(await fs.readFile(path.join(dataDir, 'remote', 'jobs', serverId, 'terminal.json'), 'utf8'));
    assert.equal(journal.status, 'cancelled');
    assert.deepEqual(journal.result.transcript, cues);
    assert.equal(journal.result.summary, done.result.summary);
  } finally { releaseHash(); openMock.mock.restore(); await clientTask; }
});
