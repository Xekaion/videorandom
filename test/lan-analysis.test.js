const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { createLanAnalysis, sendRemoteAnalysis, checkRemoteServer, privateAddress, validateRemoteUrl, resolveRemoteUrl, validateMetadata } = require('../lib/lan-analysis');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
const MP3 = Buffer.from('ID3tiny-transport-fixture');
const FLAC = Buffer.from('fLaCtiny-lossless-transport-fixture');
const quality = (changes = {}) => ({ version: 1, source: 'audio', profile: 'accurate', model: 'large-v3', complete: true,
  language: 'ja', languageProbability: 0.99, duration: 60, processedUntil: 60, wordTimestamps: true,
  audit: { complete: true, speechSeconds: 2, uncoveredSpeechSeconds: 0, unresolved: [] }, warnings: [], ...changes });
const fingerprint = transcript => crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex');
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
  assert.deepEqual(status, { ready: true, protocol: 1, active: 0, queued: 0, capabilities: ['timed-subtitles-v1', 'subtitle-quality-v1'] });
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
  assert.equal(restarted.connectionCode, f.status.connectionCode);
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

test('accurate uploads require lossless FLAC and forward quality options instead of trusting sparse sidecars', async t => {
  let received;
  const f = await fixture(t, async pkg => {
    received = pkg;
    assert.equal(pkg.subtitleQuality, 'accurate');
    assert.equal(path.extname(pkg.audioPath), '.flac');
    assert.deepEqual(await fs.readFile(pkg.audioPath), FLAC);
    return { ...pkg.record, status: 'completed', summary: '전체 음성 인식 검증', transcriptSource: 'audio:faster-whisper large-v3',
      transcriptionQuality: quality(), transcript: [{ id: 0, start: 1, end: 3, text: 'こんにちは', confidence: 0.98,
        avgLogprob: -0.2, noSpeechProbability: 0.01, qualityFlags: [], words: [{ start: 1, end: 3, word: 'こんにちは', probability: 0.98 }] }] };
  });
  const info = metadata({ subtitleQuality: 'accurate', subtitleLanguage: 'ko', hasAudio: true, transcribeAudio: true });
  const files = audio => [{ field: 'frames', name: 'frame_001.jpg', type: 'image/jpeg', bytes: JPEG }, audio];
  const submitted = await f.submit(info, files({ field: 'audio', name: 'audio.flac', type: 'audio/flac', bytes: FLAC }));
  assert.equal(submitted.status, 202, await submitted.clone().text());
  const result = await finished(f, (await submitted.json()).id);
  assert.equal(result.result.transcriptionQuality.profile, 'accurate');
  assert.equal(result.result.transcript[0].words[0].probability, 0.98);
  assert.equal(result.result.transcript[0].confidence, 0.98);
  assert.equal(result.result.transcriptionQuality.complete, true);
  await assert.rejects(fs.stat(received.audioPath), { code: 'ENOENT' });
  assert.equal((await f.submit(info, files({ field: 'audio', name: 'audio.mp3', type: 'audio/mpeg', bytes: MP3 }))).status, 400);
  assert.equal((await f.submit(info, files({ field: 'audio', name: 'audio.flac', type: 'audio/flac', bytes: MP3 }))).status, 400);
});

test('accurate cached transcripts require complete large-model proof and sanitize diagnostics and word metadata', async t => {
  let received;
  const f = await fixture(t, async pkg => {
    received = pkg;
    return { ...pkg.record, summary: '재사용한 전체 대사', transcriptionQuality: { ...quality(), model: 'C:/host-private/models/large-v3', apiKey: 'private-quality-key' },
      transcript: pkg.record.transcript.map(cue => ({ ...cue, private: 'private-cue-key', words: cue.words.map(word => ({ ...word, token: 'private-word-key' })) })) };
  });
  const original = metadata({ subtitleQuality: 'accurate', subtitleLanguage: 'ko', hasAudio: true, transcriptSource: 'audio:faster-whisper large-v3',
    transcriptionQuality: quality(), transcript: [{ id: 'cue-1', start: 1, end: 3, text: 'こんにちは', confidence: 0.9,
      words: [{ start: 1, end: 3, word: 'こんにちは', probability: 0.9 }] }] });
  const submitted = await f.submit(original);
  assert.equal(submitted.status, 202, await submitted.clone().text());
  const job = await finished(f, (await submitted.json()).id);
  assert.equal(received.audioPath, null);
  assert.equal(received.record.hasAudio, true);
  assert.equal(job.result.transcriptionQuality.model, 'large-v3');
  assert.equal(job.result.transcript[0].words[0].probability, 0.9);
  assert.equal(JSON.stringify(job).includes('private-'), false);
  assert.equal(JSON.stringify(job).includes('host-private'), false);
  for (const changes of [{ transcriptionQuality: quality({ model: 'small' }) }, { transcriptionQuality: quality({ complete: false }) },
    { transcriptionQuality: quality({ processedUntil: 30 }) }, { transcriptSource: 'sidecar:sparse.srt' }]) {
    assert.equal((await f.submit({ ...original, ...changes })).status, 400);
  }
});

test('old subtitle hosts reject accurate requests before upload while fast requests retain legacy metadata', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-quality-legacy-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const id = 'c'.repeat(32), jobId = 'd'.repeat(32), code = 'e'.repeat(32);
  const framesDir = path.join(dataDir, 'frames', id);
  await fs.mkdir(framesDir, { recursive: true }); await fs.writeFile(path.join(framesDir, 'frame_001.jpg'), JPEG);
  let posts = 0, upload = '';
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/status') { res.end(JSON.stringify({ ready: true, protocol: 1, capabilities: ['timed-subtitles-v1'] })); return; }
    if (req.url === '/v1/jobs') {
      posts++; for await (const bytes of req) upload += bytes.toString('utf8');
      res.end(JSON.stringify({ id: jobId, status: 'completed', result: { ...metadata(), status: 'completed', summary: '기존 서버 검증' } })); return;
    }
    if (req.url.endsWith('/frames/frame_001.jpg')) { res.end(JPEG); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const options = { dataDir, connectionCode: code, remoteUrl: `http://127.0.0.1:${server.address().port}`, subtitleLanguage: 'ko' };
  const record = { id, path: 'C:/client/neutral.mp4', ...metadata(), size: 1 };
  await assert.rejects(sendRemoteAnalysis(record, { ...options, subtitleQuality: 'accurate' }), /분석 서버 PC도 새 버전으로 업데이트/);
  assert.equal(posts, 0);
  await sendRemoteAnalysis({ ...record, transcript: [{ start: 1, end: 3, text: '대사', words: [{ start: 1, end: 3, word: '대사', probability: 0.9 }] }] }, { ...options, subtitleQuality: 'fast' });
  assert.equal(posts, 1);
  assert.equal(upload.includes('"subtitleQuality"'), false);
  assert.equal(upload.includes('"transcriptionQuality"'), false);
  assert.equal(upload.includes('"words"'), false);
});

test('discarding invalid returned cues also clears the full-transcription proof', async t => {
  const f = await fixture(t, async ({ record }) => ({ ...record, status: 'completed', transcriptSource: 'audio:faster-whisper large-v3',
    transcriptionQuality: quality(), transcript: [{ start: 1, end: 3, text: '유효한 원문' }, { start: 5, end: 4, text: '잘못된 시점' }] }));
  const submitted = await f.submit();
  const job = await finished(f, (await submitted.json()).id);
  assert.equal(job.result.status, 'partial');
  assert.equal(job.result.transcriptionQuality.complete, false);
  assert.equal(job.result.transcript.length, 1);
  assert.match(job.result.warnings.join('\n'), /전체 인식 완료로 표시하지/);
});

test('LAN round trips exact-source partial translation progress without checkpoint paths or a complete Korean flag', async t => {
  const cues = [{ id: 'first', start: 1, end: 2, text: 'こんにちは' }, { id: 'second', start: 3, end: 4, text: '駅はどこ' }];
  const progress = { version: 1, sourceFingerprint: fingerprint(cues), totalCues: 2, completedCues: 1, language: 'ko', complete: false, sourceComplete: true };
  const f = await fixture(t, async ({ record }) => ({ ...record, status: 'partial', subtitleError: 'translation quota fixture',
    subtitleTranslationProgress: { ...progress, checkpointPath: 'C:/host-private/checkpoints/file.json', apiKey: 'private-progress-key' },
    subtitleTranslationPartial: [{ id: 'first', start: 1, end: 2, text: '안녕하세요', checkpoint: 'private-checkpoint-key' }] }));
  const id = 'f'.repeat(32), framesDir = path.join(f.dataDir, 'frames', id);
  await fs.mkdir(framesDir, { recursive: true }); await fs.writeFile(path.join(framesDir, 'frame_001.jpg'), JPEG);
  const result = await sendRemoteAnalysis({ id, path: 'C:/client/neutral.mp4', size: 1, ...metadata({ transcript: cues }) }, {
    remoteUrl: f.base, connectionCode: f.status.connectionCode, dataDir: f.dataDir
  });
  assert.deepEqual(result.subtitleTranslationProgress, progress);
  assert.deepEqual(result.subtitleTranslationPartial, [{ id: 'first', start: 1, end: 2, text: '안녕하세요' }]);
  assert.equal(result.subtitleLanguage, undefined);
  assert.equal(result.subtitleTranslation, undefined);
  assert.equal(result.status, 'partial');
  assert.equal(JSON.stringify(result).includes('private-'), false);
  assert.equal(JSON.stringify(result).includes('checkpoint'), false);
});

test('invalid translation counters, source fingerprints, prefix intervals and IDs never become completion claims', async t => {
  const cues = [{ id: 1, start: 1, end: 2, text: '原文一' }, { id: 2, start: 3, end: 4, text: '原文二' }];
  const progress = { version: 1, sourceFingerprint: fingerprint(cues), totalCues: 2, completedCues: 1, language: 'ko', complete: false, sourceComplete: true };
  let changes = {};
  const f = await fixture(t, async ({ record }) => ({ ...record, status: 'completed', subtitleTranslationProgress: progress,
    subtitleTranslationPartial: [{ id: 1, start: 1, end: 2, text: '첫 원문' }], ...changes }));
  const cases = [{ subtitleTranslationProgress: { ...progress, totalCues: 3 } }, { subtitleTranslationProgress: { ...progress, completedCues: 3 } },
    { subtitleTranslationProgress: { ...progress, completedCues: 0 } }, { subtitleTranslationProgress: { ...progress, sourceFingerprint: '0'.repeat(64) } },
    { subtitleTranslationProgress: { ...progress, language: 'ja' } }, { subtitleTranslationProgress: { ...progress, complete: true } },
    { subtitleTranslationPartial: [{ id: 99, start: 1, end: 2, text: '첫 원문' }] },
    { subtitleTranslationPartial: [{ id: 1, start: 1, end: 2.1, text: '첫 원문' }] }];
  for (changes of cases) {
    const submitted = await f.submit(metadata({ transcript: cues }));
    const job = await finished(f, (await submitted.json()).id);
    assert.equal(job.result.subtitleTranslationProgress, undefined);
    assert.equal(job.result.subtitleTranslationPartial, undefined);
    assert.equal(job.result.subtitleLanguage, undefined);
    assert.equal(job.result.status, 'partial');
  }
});

test('partial and full translations share one bounded payload budget with rich original cues', async t => {
  const cues = Array.from({ length: 400 }, (_, index) => ({ id: index, start: index / 20, end: index / 20 + 0.04, text: 'あ'.repeat(2000) }));
  let full = false;
  const f = await fixture(t, async ({ record }) => full ? { ...record, status: 'completed', subtitleLanguage: 'ko',
    subtitleTranslation: cues.map(cue => ({ ...cue, text: '가'.repeat(4000) })) } : {
    ...record, status: 'partial', subtitleTranslationProgress: { version: 1, sourceFingerprint: fingerprint(cues), totalCues: cues.length,
      completedCues: 200, language: 'ko', complete: false, sourceComplete: true },
    subtitleTranslationPartial: cues.slice(0, 200).map(cue => ({ ...cue, text: '가'.repeat(4000) }))
  });
  for (full of [false, true]) {
    const submitted = await f.submit(metadata({ transcript: cues }));
    assert.equal(submitted.status, 202, await submitted.clone().text());
    const job = await finished(f, (await submitted.json()).id);
    assert.equal(job.result.transcript.length, cues.length);
    assert.equal(job.result.subtitleTranslationPartial, undefined);
    assert.equal(job.result.subtitleTranslationProgress, undefined);
    assert.equal(job.result.subtitleTranslation, undefined);
    assert.equal(job.result.subtitleLanguage, undefined);
    assert.equal(job.result.status, 'partial');
    assert.match(job.result.subtitleError, /응답 크기 제한/);
    assert.ok(Buffer.byteLength(JSON.stringify(job.result.transcript)) < 4 * 1024 * 1024);
  }
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
