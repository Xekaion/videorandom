const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createLanAnalysis } = require('../lib/lan-analysis');
const { createUploadReceiptStore, sanitizeUploadReceipt } = require('../lib/upload-receipts');
const { httpFixtureResponse } = require('./http-json-fixture');

const CODE = 'owned-upload-receipt-code-123456789';
const ID = 'a'.repeat(32), OTHER = 'b'.repeat(32);
const JPEG = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
const PRIVATE = 'PRIVATE_PROVIDER_OR_SOURCE_CONTENT';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const metadata = (extra = {}) => ({ name: 'owned-train.mp4', ext: 'MP4', sizeMB: 1, duration: 60,
  transcript: [{ id: 'cue-1', start: 1, end: 3, text: '合成の列車案内です。' }],
  transcriptSource: 'sidecar:srt', frames: [{ timestamp: 5, filename: 'frame-01.jpg' }], transcribeAudio: false, ...extra });
function multipart(info = metadata(), bytes = JPEG) {
  const boundary = 'owned-upload-receipt-boundary';
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(info)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="frames"; filename="frame-01.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
}
async function until(operation) {
  for (let i = 0; i < 100; i++) { const value = await operation(); if (value) return value; await delay(10); }
  throw new Error('Owned upload fixture did not settle');
}
async function fixture(t, { io = fs, dropAccepted = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-owned-upload-v1935-'));
  const events = [], calls = [];
  let service, status;
  const options = { dataDir, journalIO: io, connectionStore: { async getHostCode() { return CODE; } },
    diagnosticsStore: { async append(value) { events.push(JSON.parse(JSON.stringify(value))); }, async flush() {} },
    diskSpace: { async assert() {}, async check() { return { known: false }; } },
    async processPackage({ record }) { calls.push(record.id); return { ...record, summary: '합성 열차 안내', status: 'completed' }; } };
  async function start() {
    service = createLanAnalysis(options);
    if (dropAccepted) {
      const original = service.app.response.json;
      let dropped = false;
      service.app.response.json = function (body) {
        if (!dropped && this.req.method === 'POST' && this.req.path === '/v1/jobs' && this.statusCode === 202) {
          dropped = true; this.destroy(); return this;
        }
        return original.call(this, body);
      };
    }
    status = await service.start({ port: 0, host: '127.0.0.1' });
  }
  await start();
  t.after(async () => {
    await service.stop();
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert(path.basename(dataDir).startsWith('videorandom-owned-upload-v1935-'));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const request = (endpoint, options = {}) => httpFixtureResponse(`http://127.0.0.1:${status.port}${endpoint}`, {
    ...options, headers: { Authorization: 'Bearer ' + CODE, ...options.headers } });
  return { dataDir, events, calls, request, get service() { return service; }, get port() { return status.port; },
    submit: (id = ID, info, bytes) => { const form = multipart(info, bytes); return request('/v1/jobs', {
      method: 'POST', body: form.body, headers: { ...form.headers, 'X-VideoRandom-Upload-Id': id } }); },
    restart: async () => { await service.stop(); await start(); } };
}

test('durable upload acceptance can recover a lost 202 without uploading or analyzing twice', async t => {
  const f = await fixture(t, { dropAccepted: true });
  await assert.rejects(f.submit(), error => error.code === 'ECONNRESET');
  const receipt = await until(async () => {
    const response = await f.request('/v1/uploads/' + ID);
    if (response.status !== 200) return null;
    const value = await response.json(); return value.phase === 'accepted' && value.job?.status === 'completed' ? value : null;
  });
  assert.equal(receipt.uploadId, ID); assert.equal(receipt.jobId, ID); assert.equal(receipt.job.id, ID);
  assert.equal(receipt.receivedBytes, receipt.expectedBytes);
  assert.deepEqual(f.calls, [ID]);
  const duplicate = await f.submit(); assert.equal(duplicate.status, 202);
  assert.equal((await duplicate.json()).id, ID); assert.deepEqual(f.calls, [ID]);
  const disk = await fs.readFile(path.join(f.dataDir, 'remote', 'uploads', ID + '.json'), 'utf8');
  assert.equal(JSON.parse(disk).phase, 'accepted');
  assert.doesNotMatch(disk, /owned-train|列車|transcript|summary|frames|connectionCode|Bearer/);
  await f.restart();
  const restored = await (await f.request('/v1/uploads/' + ID)).json();
  assert.equal(restored.phase, 'accepted'); assert.equal(restored.job.status, 'completed');
  assert.deepEqual(f.calls, [ID], 'restoring a receipt cannot replay a request');
});

test('an aborted multipart body leaves an interrupted technical receipt and starts no work', async t => {
  const f = await fixture(t), form = multipart();
  let req;
  const closed = new Promise(resolve => {
    req = http.request({ host: '127.0.0.1', port: f.port, path: '/v1/jobs', method: 'POST', agent: false,
      headers: { Authorization: 'Bearer ' + CODE, 'X-VideoRandom-Upload-Id': ID,
        ...form.headers, 'Content-Length': form.body.length + 1000 } });
    req.on('error', () => {}); req.on('close', resolve); req.write(form.body.subarray(0, 100));
  });
  await until(async () => (await f.request('/v1/uploads/' + ID)).status === 200);
  req.destroy(); await closed;
  const receipt = await until(async () => {
    const value = await (await f.request('/v1/uploads/' + ID)).json(); return value.phase === 'interrupted' ? value : null;
  });
  assert.equal(receipt.errorDiagnostic.code, 'NETWORK_UNREACHABLE');
  assert.equal(receipt.errorDiagnostic.systemCode, 'ECONNRESET');
  assert(receipt.receivedBytes > 0 && receipt.receivedBytes < receipt.expectedBytes);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.submit()).status, 409);
  assert.equal((await f.request('/v1/jobs/' + ID)).status, 404);
  assert(!f.events.some(value => value.videoName || value.clientName || value.recordId));
});

test('duplicate receiving headers cannot consume a second upload or remove the active upload directory', async t => {
  const f = await fixture(t), form = multipart();
  const req = http.request({ host: '127.0.0.1', port: f.port, path: '/v1/jobs', method: 'POST', agent: false,
    headers: { Authorization: 'Bearer ' + CODE, 'X-VideoRandom-Upload-Id': ID,
      ...form.headers, 'Content-Length': form.body.length } });
  req.on('error', () => {}); req.write(form.body.subarray(0, 100));
  t.after(() => req.destroy());
  await until(async () => (await f.request('/v1/uploads/' + ID)).status === 200);
  assert.equal((await f.submit()).status, 409);
  req.end(form.body.subarray(100));
  await until(async () => { const value = await (await f.request('/v1/uploads/' + ID)).json(); return value.job?.status === 'completed'; });
  assert.deepEqual(f.calls, [ID]);
});

test('invalid file signature is recorded as rejection without arbitrary source text and cannot be reposted', async t => {
  const f = await fixture(t);
  const response = await f.submit(ID, metadata(), Buffer.from(PRIVATE));
  assert.equal(response.status, 400);
  const receipt = await (await f.request('/v1/uploads/' + ID)).json();
  assert.equal(receipt.phase, 'rejected'); assert.equal(receipt.receivedBytes, receipt.expectedBytes);
  assert.equal((await f.submit()).status, 409); assert.deepEqual(f.calls, []);
  assert(!JSON.stringify(receipt).includes(PRIVATE)); assert(!JSON.stringify(f.events).includes(PRIVATE));
});

test('failed durable acceptance publishes no job and preserves its actual disk errno', async t => {
  const io = { ...fs, async open(filename, ...args) {
    const handle = await fs.open(filename, ...args);
    return { writeFile: async (contents, ...options) => {
      if (filename.includes(`${path.sep}uploads${path.sep}`) && JSON.parse(contents).phase === 'accepted') {
        throw Object.assign(new Error(PRIVATE), { code: 'ENOSPC' });
      }
      return handle.writeFile(contents, ...options);
    }, sync: () => handle.sync(), close: () => handle.close() };
  } };
  const f = await fixture(t, { io });
  const response = await f.submit(); assert.equal(response.status, 507);
  const receipt = await (await f.request('/v1/uploads/' + ID)).json();
  assert.equal(receipt.phase, 'rejected'); assert.equal(receipt.errorDiagnostic.code, 'STORAGE_SPACE_LOW');
  assert.equal(receipt.errorDiagnostic.systemCode, 'ENOSPC');
  assert.equal((await f.request('/v1/jobs/' + ID)).status, 404); assert.deepEqual(f.calls, []);
  assert(!JSON.stringify(receipt).includes(PRIVATE));
});

test('multipart destination failure retains the first real disk errno in receipt and host diagnostics', async t => {
  const nativeFs = require('node:fs'), { Writable } = require('node:stream');
  const f = await fixture(t), original = nativeFs.createWriteStream;
  nativeFs.createWriteStream = function (filename, ...args) {
    if (String(filename).startsWith(path.join(f.dataDir, 'remote', 'jobs') + path.sep)) return new Writable({
      write(_chunk, _encoding, callback) { callback(Object.assign(new Error(PRIVATE), { code: 'ENOSPC' })); }
    });
    return original.call(this, filename, ...args);
  };
  try {
    const response = await f.submit(); assert.equal(response.status, 507);
    const receipt = await (await f.request('/v1/uploads/' + ID)).json();
    assert.equal(receipt.phase, 'rejected'); assert.equal(receipt.errorDiagnostic.code, 'STORAGE_SPACE_LOW');
    assert.equal(receipt.errorDiagnostic.systemCode, 'ENOSPC'); assert.deepEqual(f.calls, []);
    const diagnostic = f.events.find(event => event.uploadState === 'rejected');
    assert.equal(diagnostic.systemCode, 'ENOSPC'); assert.equal(diagnostic.code, 'STORAGE_SPACE_LOW');
    assert(!JSON.stringify([receipt, f.events]).includes(PRIVATE));
  } finally { nativeFs.createWriteStream = original; }
});

test('server stop overlapping durable acceptance cancels that exact job and never queues work for a later start', async t => {
  let release, enter;
  const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { enter = resolve; });
  const io = { ...fs, async open(filename, ...args) {
    const handle = await fs.open(filename, ...args);
    return { writeFile: async (contents, ...options) => {
      if (filename.includes(`${path.sep}uploads${path.sep}`) && JSON.parse(contents).phase === 'accepted') {
        enter(); await gate;
      }
      return handle.writeFile(contents, ...options);
    }, sync: () => handle.sync(), close: () => handle.close() };
  } };
  const f = await fixture(t, { io });
  const pending = f.submit().catch(error => error); await entered;
  const stopping = f.service.stop();
  await delay(10); release(); await stopping; await pending;
  assert.equal(f.service.status().queued, 0); assert.deepEqual(f.calls, []);
  await f.restart();
  const receipt = await (await f.request('/v1/uploads/' + ID)).json();
  assert.equal(receipt.phase, 'accepted'); assert.equal(receipt.job.status, 'cancelled');
  assert.equal(f.service.status().queued, 0); assert.deepEqual(f.calls, []);
});

test('receipt endpoints require authentication and strict header/lookup IDs', async t => {
  const f = await fixture(t);
  assert.equal((await httpFixtureResponse(`http://127.0.0.1:${f.port}/v1/uploads/${ID}`)).status, 401);
  for (const bad of ['../escape', 'A'.repeat(32), 'bad', PRIVATE]) assert.equal((await f.submit(bad)).status, 400);
  assert.equal((await f.request('/v1/uploads/bad')).status, 400);
  assert.equal((await f.request('/v1/uploads/' + OTHER)).status, 404);
  const status = await (await f.request('/v1/status')).json(); assert(status.capabilities.includes('upload-receipts-v1'));
  assert.deepEqual(f.calls, []);
});

test('receipt restart interrupts only receiving and never downgrades or replays accepted records', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-owned-receipt-store-'));
  t.after(async () => { await fs.rm(dataDir, { recursive: true, force: true }); });
  const store = createUploadReceiptStore({ dataDir });
  await store.begin(ID, 100); await store.begin(OTHER, 200);
  await store.finish(OTHER, { phase: 'accepted', receivedBytes: 200 });
  const restarted = createUploadReceiptStore({ dataDir }); await restarted.ready;
  const interrupted = await restarted.get(ID);
  assert.equal(interrupted.phase, 'interrupted');
  assert.equal(interrupted.errorDiagnostic.code, 'LAN_UPLOAD_DISCONNECTED');
  assert.equal(interrupted.errorDiagnostic.systemCode, undefined);
  const accepted = await restarted.get(OTHER); assert.equal(accepted.phase, 'accepted'); assert.equal(accepted.jobId, OTHER);
  assert.equal((await restarted.begin(OTHER, 200)).created, false);
  assert.equal((await restarted.finish(OTHER, { phase: 'rejected', receivedBytes: 0 })).phase, 'accepted');
  assert.equal(sanitizeUploadReceipt({ ...accepted, expectedBytes: -1 }), null);
  assert.equal(sanitizeUploadReceipt({ ...accepted, receivedBytes: 201 }), null);
  assert.equal(sanitizeUploadReceipt({ ...accepted, receivedBytes: 199 }), null);
  assert(!JSON.stringify(sanitizeUploadReceipt({ ...accepted, prompt: PRIVATE, path: PRIVATE })).includes(PRIVATE));
});

test('a damaged individual receipt stays fail-closed without preventing other uploads after restart', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-owned-receipt-corrupt-'));
  t.after(async () => { await fs.rm(dataDir, { recursive: true, force: true }); });
  const directory = path.join(dataDir, 'remote', 'uploads'); await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, ID + '.json'); await fs.writeFile(target, '{"schemaVersion":1');
  const store = createUploadReceiptStore({ dataDir }); await store.ready;
  await assert.rejects(store.get(ID)); await assert.rejects(store.begin(ID, 100));
  assert.equal(await fs.readFile(target, 'utf8'), '{"schemaVersion":1');
  const separate = await store.begin(OTHER, 100); assert.equal(separate.created, true);
  assert.equal((await store.get(OTHER)).phase, 'receiving');
});
