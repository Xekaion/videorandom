const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { sendRemoteAnalysis } = require('../lib/lan-analysis');

const JOB_ID = 'b'.repeat(32);
const CODE = 'owned-reconnect-fixture-code-123456';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);

async function fixture(t, { poll, dropUpload = false, dropPreflight = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-reconnect-'));
  const id = 'a'.repeat(32), frame = { timestamp: 5, filename: 'frame-01.jpg' };
  const record = { id, name: 'owned-neutral.mp4', path: 'C:/synthetic-only/owned-neutral.mp4', ext: 'MP4', size: 1, duration: 60,
    hasAudio: false, transcript: [], transcriptSource: 'none', frames: [frame], warnings: [] };
  await fs.mkdir(path.join(dataDir, 'frames', id), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'frames', id, frame.filename), JPEG);
  const calls = { uploads: 0, polls: 0, cancels: 0, statuses: 0, requests: [] };
  const completed = { id: JOB_ID, status: 'completed', result: { ...record, id: JOB_ID, status: 'completed', summary: '합성 서버 결과',
    frames: [{ ...frame, caption: '합성 장면' }] } };
  const server = http.createServer(async (req, res) => {
    calls.requests.push({ method: req.method, url: req.url });
    if (req.headers.authorization !== 'Bearer ' + CODE) { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/v1/status') {
      calls.statuses++;
      if (dropPreflight) { res.destroy(); return; }
      res.end(JSON.stringify({ ready: true, protocol: 1, capabilities: ['timed-subtitles-v1', 'subtitle-quality-v3'] })); return;
    }
    if (req.url === '/v1/jobs' && req.method === 'POST') {
      calls.uploads++;
      for await (const ignored of req) { /* Consume only this owned multipart fixture. */ }
      if (dropUpload) { res.destroy(); return; }
      res.end(JSON.stringify({ id: JOB_ID, status: 'running', percent: 20, stage: '합성 서버 분석 중' })); return;
    }
    if (req.url === `/v1/jobs/${JOB_ID}` && req.method === 'GET') {
      calls.polls++;
      if (poll) { poll(calls.polls, req, res, completed); return; }
      res.end(JSON.stringify(completed)); return;
    }
    if (req.url === `/v1/jobs/${JOB_ID}/cancel` && req.method === 'POST') {
      calls.cancels++; res.end(JSON.stringify({ id: JOB_ID, status: 'cancelled' })); return;
    }
    if (req.url === `/v1/jobs/${JOB_ID}/frames/${frame.filename}`) { res.end(JPEG); return; }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const remoteUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    assert.equal(path.dirname(dataDir), os.tmpdir());
    assert.ok(path.basename(dataDir).startsWith('videorandom-reconnect-'));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { calls, record, remoteUrl,
    send: options => sendRemoteAnalysis(record, { dataDir, remoteUrl, connectionCode: CODE, ...options }) };
}

test('a Wi-Fi interruption retries only the accepted job GET and succeeds on the third bounded retry', async t => {
  const f = await fixture(t, { poll(attempt, req, res, completed) {
    if (attempt <= 3) { res.destroy(); return; }
    res.end(JSON.stringify(completed));
  } });
  const progress = [];
  const result = await f.send({ onProgress: (stage, percent) => progress.push({ stage, percent }) });
  assert.equal(result.summary, '합성 서버 결과');
  assert.equal(result.id, f.record.id);
  assert.equal(result.path, f.record.path);
  assert.equal(f.calls.uploads, 1, 'transport recovery cannot submit the analysis twice');
  assert.equal(f.calls.polls, 4);
  assert.equal(f.calls.cancels, 0);
  assert.equal(progress.filter(item => item.stage === '분석 서버 연결 복구 중').length, 3);
  assert.deepEqual([...new Set(f.calls.requests.filter(call => call.method === 'GET' && call.url.startsWith('/v1/jobs/') && !call.url.includes('/frames/'))
    .map(call => call.url))], [`/v1/jobs/${JOB_ID}`]);
  assert.ok(f.calls.requests.every(call => !call.url.includes(CODE)));
  assert.equal(JSON.stringify(progress).includes(CODE), false);
});

test('remote phase progress is forwarded without scaling its audio counters or exposing arbitrary fields', async t => {
  const f = await fixture(t, { poll(attempt, req, res, completed) {
    if (attempt === 1) {
      res.end(JSON.stringify({ id: JOB_ID, status: 'running', stage: 'transcription', percent: 45,
        phaseProgress: { phase: 'transcription', completedSeconds: 180, totalSeconds: 600, elapsedSeconds: 90,
          remainingSeconds: 210, sampleAgeSeconds: 12, transcript: 'private speech', path: 'C:/private' } }));
    } else res.end(JSON.stringify(completed));
  } });
  const progress = [];
  await f.send({ onProgress: (stage, percent, details) => progress.push({ stage, percent, details }) });
  const measured = progress.find(item => item.details);
  assert.equal(measured.percent, 64.75);
  assert.deepEqual(measured.details, { phase: 'transcription', completedSeconds: 180, totalSeconds: 600,
    elapsedSeconds: 90, remainingSeconds: 210, sampleAgeSeconds: 12 });
  assert.equal(JSON.stringify(progress).includes('private speech'), false);
});

test('an exhausted network recovery stops after three retries and explains that the server job may still be running', async t => {
  const f = await fixture(t, { poll(attempt, req, res) { res.destroy(); } });
  const progress = [];
  await assert.rejects(f.send({ onProgress: stage => progress.push(stage) }), error => {
    assert.equal(error.code, 'LAN_STATUS_RECONNECT_FAILED');
    assert.match(error.message, /3회.*복구하지 못/);
    assert.match(error.message, /Wi-Fi.*기존 작업이 계속/);
    assert.equal(error.message.includes(CODE), false);
    assert.equal(error.message.includes(f.remoteUrl), false);
    return true;
  });
  assert.deepEqual([f.calls.uploads, f.calls.polls, f.calls.cancels], [1, 4, 0]);
  assert.equal(progress.filter(stage => stage === '분석 서버 연결 복구 중').length, 3);
});

test('HTTP authentication, quota and service refusals are never treated as network recovery', async t => {
  for (const status of [401, 403, 429, 503]) await t.test(String(status), async t => {
    const f = await fixture(t, { poll(attempt, req, res) {
      res.writeHead(status); res.end(JSON.stringify({ error: `owned refusal ${status}` }));
    } });
    const progress = [];
    await assert.rejects(f.send({ onProgress: stage => progress.push(stage) }), error => {
      assert.equal(error.statusCode, status);
      assert.equal(error.message, `owned refusal ${status}`);
      return true;
    });
    assert.deepEqual([f.calls.uploads, f.calls.polls], [1, 1]);
    assert.equal(progress.includes('분석 서버 연결 복구 중'), false);
  });
});

test('a dropped body after authentication refusal headers does not retry that refused request', async t => {
  const f = await fixture(t, { poll(attempt, req, res) {
    res.writeHead(401, { 'Content-Length': 100 }); res.flushHeaders();
    setTimeout(() => res.destroy(), 10);
  } });
  await assert.rejects(f.send(), error => { assert.equal(error.statusCode, 401); return true; });
  assert.deepEqual([f.calls.uploads, f.calls.polls], [1, 1]);
});

test('terminal provider refusal is returned once without retrying status or resubmitting work', async t => {
  const f = await fixture(t, { poll(attempt, req, res) { res.end(JSON.stringify({ id: JOB_ID, status: 'failed', error: 'owned safety refusal' })); } });
  await assert.rejects(f.send(), /owned safety refusal/);
  assert.deepEqual([f.calls.uploads, f.calls.polls], [1, 1]);
});

test('abort interrupts reconnect backoff and sends only the existing cancellation request', async t => {
  const f = await fixture(t, { poll(attempt, req, res) { res.destroy(); } });
  const controller = new AbortController();
  let timer;
  await assert.rejects(f.send({ signal: controller.signal, onProgress(stage) {
    if (stage === '분석 서버 연결 복구 중') timer = setTimeout(() => controller.abort(), 20);
  } }), { name: 'AbortError' });
  clearTimeout(timer);
  assert.deepEqual([f.calls.uploads, f.calls.polls, f.calls.cancels], [1, 1, 1]);
});

test('uncertain upload acceptance and failed preflight are never replayed by status recovery', async t => {
  for (const options of [{ dropUpload: true }, { dropPreflight: true }]) await t.test(Object.keys(options)[0], async t => {
    const f = await fixture(t, options);
    await assert.rejects(f.send());
    assert.deepEqual([f.calls.statuses, f.calls.uploads, f.calls.polls], [1, options.dropUpload ? 1 : 0, 0]);
  });
});
