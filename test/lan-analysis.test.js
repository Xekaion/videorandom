const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createLanAnalysis, sendRemoteAnalysis, checkRemoteServer, privateAddress, validateRemoteUrl, resolveRemoteUrl, validateMetadata } = require('../lib/lan-analysis');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
const MP3 = Buffer.from('ID3tiny-transport-fixture');
const metadata = (changes = {}) => ({ name: '한글 영상.mp4', ext: 'MP4', sizeMB: 1, duration: 60,
  transcript: [{ start: 1, end: 3, text: '안녕하세요' }], transcriptSource: 'sidecar:srt',
  frames: [{ timestamp: 5, filename: 'frame_001.jpg' }], transcribeAudio: false, ...changes });

function multipart(info, files = [{ field: 'frames', name: 'frame_001.jpg', type: 'image/jpeg', bytes: JPEG }]) {
  const boundary = 'video-random-test-boundary';
  const chunks = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(info)}\r\n`)];
  for (const file of files) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.bytes, Buffer.from('\r\n'));
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);
  return { body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) } };
}

async function fixture(t, processPackage = async ({ record }) => ({ ...record, summary: '사람들이 인사한다.', labels: ['인사'], frames: record.frames.map(f => ({ ...f, caption: '인사 장면' })) })) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-lan-'));
  const service = createLanAnalysis({ dataDir, processPackage });
  assert.equal(service.status().running, false);
  const status = await service.start({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${status.port}`;
  const headers = { Authorization: 'Bearer ' + status.connectionCode };
  t.after(async () => { await service.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const request = (endpoint, options = {}) => fetch(base + endpoint, { ...options, headers: { ...headers, ...options.headers } });
  const submit = (info = metadata(), files) => request('/v1/jobs', { method: 'POST', ...multipart(info, files) });
  return { dataDir, service, status, base, headers, request, submit };
}

async function finished(f, id) {
  for (let index = 0; index < 100; index++) {
    const job = await (await f.request('/v1/jobs/' + id)).json();
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('LAN job did not finish');
}

test('private address validation rejects public and malformed addresses', async () => {
  for (const value of ['127.0.0.1', '10.1.2.3', '172.16.1.1', '172.31.255.2', '192.168.55.166', '169.254.1.3', '::1', '::ffff:192.168.1.1', 'fdab::1234', 'fc00::1']) assert.equal(privateAddress(value), true, value);
  for (const value of ['8.8.8.8', '172.32.0.1', '172.15.1.1', '100.64.1.1', '192.0.0.1', '0.0.0.0', '::', 'fe80::1', '2001:4860::1', 'localhost', 'garbage']) assert.equal(privateAddress(value), false, value);
  for (const value of ['https://192.168.1.1:3001', 'http://8.8.8.8', 'http://example.com', 'http://user:pass@192.168.1.1', 'http://192.168.1.1/path', 'http://192.168.1.1?code=secret']) assert.throws(() => validateRemoteUrl(value));
  const target = await resolveRemoteUrl('http://127.0.0.1:3001');
  assert.equal(target.hostname, '127.0.0.1');
  assert.equal(target.port, 3001);
  await assert.rejects(resolveRemoteUrl('http://8.8.8.8'));
});

test('metadata rejects injected paths, options, frame traversal and invalid transcript', () => {
  assert.equal(validateMetadata(metadata()).frames.length, 1);
  for (const changes of [{ path: 'C:/secret' }, { apiKey: 'secret' }, { model: 'x' }, { name: '../video.mp4' }, { duration: NaN }, { frames: [] },
    { frames: [{ timestamp: 5, filename: '../escape.jpg' }] }, { frames: [{ timestamp: 5, filename: 'CON.jpg' }] }, { frames: [{ timestamp: 80, filename: 'safe.jpg' }] },
    { frames: Array.from({ length: 21 }, (_, i) => ({ timestamp: i, filename: `frame_${i}.jpg` })) },
    { frames: [{ timestamp: 1, filename: 'f.jpg' }, { timestamp: 2, filename: 'F.jpg' }] },
    { transcript: [{ start: 4, end: 1, text: 'x' }] }, { transcript: [{ start: 1, end: 3, text: 'x', command: 'run' }] }]) assert.throws(() => validateMetadata(metadata(changes)));
});

test('relay starts only explicitly and requires private client plus bearer authentication', async t => {
  const f = await fixture(t);
  assert.ok(f.status.connectionCode.length >= 24);
  const status = await (await f.request('/v1/status')).json();
  assert.deepEqual(status, { ready: true, protocol: 1, active: 0, queued: 0 });
  assert.equal(JSON.stringify(status).includes(f.status.connectionCode), false);
  assert.equal((await fetch(f.base + '/v1/status')).status, 401);
  assert.equal((await f.request('/v1/status', { headers: { Authorization: 'Bearer ' + 'x'.repeat(32) } })).status, 401);
  assert.equal((await f.request('/v1/status?code=' + f.status.connectionCode)).status, 400);
  const same = await f.service.start({ port: 0 });
  assert.equal(same.connectionCode, f.status.connectionCode);
  await f.service.stop();
  assert.equal(f.service.status().running, false);
  assert.equal(f.service.status().connectionCode, '');
  const restarted = await f.service.start({ port: 0, host: '127.0.0.1' });
  assert.notEqual(restarted.connectionCode, f.status.connectionCode);
});

test('uploads process authenticated data without host paths and retains JPEG frames', async t => {
  let received;
  const f = await fixture(t, async (pkg, context) => {
    received = pkg;
    assert.deepEqual(await fs.readFile(pkg.audioPath), MP3);
    assert.deepEqual(await fs.readFile(path.join(pkg.framesDir, 'frame_001.jpg')), JPEG);
    context.onProgress('대사 인식', 55);
    pkg.record.apiKey = 'mutated-secret-should-never-escape';
    pkg.record.path = 'C:/host-private-mutated';
    return { ...pkg.record, apiKey: 'should-never-escape', path: 'C:/host-private', framesDir: pkg.framesDir,
      summary: '인사하는 장면', transcriptSource: 'audio:local', transcript: [{ start: 0, end: 3, text: '반갑습니다.' }],
      frames: [{ ...pkg.record.frames[0], caption: '대표 장면' }] };
  });
  const response = await f.submit(metadata({ transcribeAudio: true, hasAudio: true }), [
    { field: 'frames', name: 'frame_001.jpg', type: 'image/jpeg', bytes: JPEG },
    { field: 'audio', name: 'audio.mp3', type: 'audio/mpeg', bytes: MP3 }
  ]);
  assert.equal(response.status, 202, await response.clone().text());
  const submitted = await response.json();
  const job = await finished(f, submitted.id);
  assert.equal(job.status, 'completed');
  assert.equal(job.result.summary, '인사하는 장면');
  assert.equal(job.result.hasAudio, true);
  assert.equal(job.result.path, 'remote-upload://' + submitted.id);
  assert.equal(job.result.transcript[0].text, '반갑습니다.');
  assert.equal(JSON.stringify(job).includes('should-never-escape'), false);
  assert.equal(JSON.stringify(job).includes('host-private'), false);
  assert.equal(JSON.stringify(job).includes(f.dataDir), false);
  await assert.rejects(fs.stat(received.audioPath), { code: 'ENOENT' });
  const image = await f.request(`/v1/jobs/${submitted.id}/frames/frame_001.jpg`);
  assert.equal(image.status, 200);
  assert.match(image.headers.get('content-type'), /image\/jpeg/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), JPEG);
  assert.equal((await f.request(`/v1/jobs/${submitted.id}/frames/missing.jpg`)).status, 404);
  assert.equal((await f.request('/api/library')).status, 404);
});

test('invalid media and metadata are rejected and uploaded temporary files cleaned', async t => {
  const f = await fixture(t);
  const invalid = [
    [metadata({ path: 'C:/private.mp4' }), undefined],
    [metadata(), [{ field: 'frames', name: '../escape.jpg', type: 'image/jpeg', bytes: JPEG }]],
    [metadata(), [{ field: 'frames', name: 'frame_001.jpg', type: 'image/jpeg', bytes: Buffer.from('not-an-image') }]],
    [metadata(), [{ field: 'frames', name: 'different.jpg', type: 'image/jpeg', bytes: JPEG }]],
    [metadata({ transcribeAudio: true }), undefined],
    [metadata(), [{ field: 'frames', name: 'frame_001.jpg', type: 'image/jpeg', bytes: JPEG }, { field: 'audio', name: 'audio.mp3', type: 'audio/mpeg', bytes: MP3 }]],
    [metadata(), [{ field: 'frames', name: 'frame_001.jpg', type: 'image/jpeg', bytes: Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]) }]]
  ];
  for (const [info, files] of invalid) {
    const response = await f.submit(info, files);
    assert.ok(response.status === 400 || response.status === 413, await response.text());
  }
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'remote', 'jobs')), []);
});

test('queue runs a single processor and cancellation removes queued audio', async t => {
  let running = 0;
  let maxRunning = 0;
  const gates = [];
  const f = await fixture(t, async ({ record }, { signal }) => {
    running++;
    maxRunning = Math.max(running, maxRunning);
    await new Promise(resolve => { gates.push(resolve); signal.addEventListener('abort', resolve, { once: true }); });
    running--;
    return record;
  });
  const first = await (await f.submit()).json();
  const second = await (await f.submit(metadata({ transcribeAudio: true }), [
    { field: 'frames', name: 'frame_001.jpg', type: 'image/jpeg', bytes: JPEG },
    { field: 'audio', name: 'audio.mp3', type: 'audio/mpeg', bytes: MP3 }
  ])).json();
  const queuedAudio = path.join(f.dataDir, 'remote', 'jobs', second.id, 'audio.mp3');
  assert.ok((await fs.stat(queuedAudio)).isFile());
  assert.equal((await (await f.request('/v1/jobs/' + second.id)).json()).status, 'queued');
  const cancelled = await (await f.request('/v1/jobs/' + second.id + '/cancel', { method: 'POST' })).json();
  assert.equal(cancelled.status, 'cancelled');
  await assert.rejects(fs.stat(queuedAudio), { code: 'ENOENT' });
  await f.submit();
  gates[0]();
  assert.equal((await finished(f, first.id)).status, 'completed');
  for (let i = 0; i < 100 && gates.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(maxRunning, 1);
  await f.service.stop();
  assert.equal(f.service.status().active, 0);
  assert.equal(running, 0);
});

test('relay caps pending work at 20 and converts processor failures to job errors', async t => {
  const f = await fixture(t, async ({ record }, { signal }) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return record;
  });
  for (let index = 0; index < 20; index++) assert.equal((await f.submit()).status, 202);
  assert.equal((await f.submit()).status, 429);
  assert.equal(f.service.status().queued, 19);
  await f.service.stop();
  assert.equal(f.service.status().queued, 0);
  assert.equal(f.service.status().active, 0);
  const failed = await fixture(t, async () => { throw new Error('로컬 음성 인식 도구를 찾을 수 없습니다.'); });
  const job = await finished(failed, (await (await failed.submit()).json()).id);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /로컬 음성 인식/);
});

test('client preflight and round trip preserve local identifiers, bytes and captions', async t => {
  const f = await fixture(t);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-lan-client-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const id = 'a'.repeat(32);
  const framesDir = path.join(dataDir, 'frames', id);
  await fs.mkdir(framesDir, { recursive: true });
  await fs.writeFile(path.join(framesDir, 'frame_001.jpg'), JPEG);
  const original = { id, name: '한글 영상.mp4', path: 'C:/my-videos/한글 영상.mp4', ext: 'MP4', size: 1, duration: 60,
    transcript: [{ start: 1, end: 3, text: '안녕하세요' }], transcriptSource: 'sidecar:srt', frames: [{ timestamp: 5, filename: 'frame_001.jpg', caption: '' }] };
  assert.equal((await checkRemoteServer({ remoteUrl: f.base, connectionCode: f.status.connectionCode })).ready, true);
  await assert.rejects(checkRemoteServer({ remoteUrl: f.base, connectionCode: 'x'.repeat(32) }), /연결 코드/);
  const progress = [];
  const result = await sendRemoteAnalysis(original, { remoteUrl: f.base, connectionCode: f.status.connectionCode, dataDir, onProgress: (stage, percent) => progress.push([stage, percent]) });
  assert.equal(result.id, id);
  assert.equal(result.path, original.path);
  assert.equal(result.summary, '사람들이 인사한다.');
  assert.equal(result.frames[0].caption, '인사 장면');
  assert.deepEqual(await fs.readFile(path.join(framesDir, 'frame_001.jpg')), JPEG);
  assert.deepEqual(progress.at(-1), ['completed', 100]);
});

test('cancelled client propagates abort to the active host processor', async t => {
  let receivedAbort = false;
  const f = await fixture(t, async ({ record }, { signal }) => {
    await new Promise(resolve => signal.addEventListener('abort', () => { receivedAbort = true; resolve(); }, { once: true }));
    return record;
  });
  const id = 'b'.repeat(32);
  const framesDir = path.join(f.dataDir, 'frames', id);
  await fs.mkdir(framesDir, { recursive: true });
  await fs.writeFile(path.join(framesDir, 'frame_001.jpg'), JPEG);
  const controller = new AbortController();
  const pending = sendRemoteAnalysis({ id, path: 'C:/original.mp4', ...metadata(), size: 1 }, { remoteUrl: f.base,
    connectionCode: f.status.connectionCode, dataDir: f.dataDir, signal: controller.signal, onProgress(stage) { if (stage === '이 PC에서 분석 중') controller.abort(); } });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(receivedAbort, true);
});

test('oversized content length is rejected before writing an upload', async t => {
  const f = await fixture(t);
  const response = await new Promise((resolve, reject) => {
    const request = http.request(f.base + '/v1/jobs', { method: 'POST', headers: { ...f.headers, 'Content-Length': String(400 * 1024 * 1024) } }, result => {
      result.resume();
      result.on('end', () => resolve(result.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(response, 413);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'remote', 'jobs')), []);
});
