const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createNoKeyProvider } = require('../lib/no-key-provider');
const { normalizeLanguageHint, normalizeSubtitleLanguage, subtitleText, validateTranslation } = require('../lib/subtitle-utils');
const { createLanAnalysis, sendRemoteAnalysis, validateMetadata } = require('../lib/lan-analysis');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
const source = () => [{ start: 1.125, end: 2.4, text: 'こんにちは。' }, { start: 8.52, end: 11.9, text: '駅はどこですか。' }];
const summary = () => ({ summary: '길을 묻는 대화다.', plot: '두 사람이 인사하고 역으로 가는 길을 묻는다.', dialogueSummary: '인사와 길 안내.', labels: ['길 안내'], frames: [{ index: 0, caption: '거리' }], limitations: [] });

async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-subtitles-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const record = { id: 'a'.repeat(32), name: 'neutral-trip.mp4', path: 'C:/neutral/trip.mp4', ext: 'MP4', size: 1,
    duration: 3000, hasAudio: true, status: 'completed', transcriptSource: 'sidecar:test.srt', transcriptLanguage: 'ja',
    transcript: source(), frames: [{ timestamp: 5, filename: 'frame_001.jpg', caption: '' }], warnings: [], error: null, ...overrides };
  const framesDir = path.join(dataDir, 'frames', record.id);
  await fs.mkdir(framesDir, { recursive: true });
  await fs.writeFile(path.join(framesDir, 'frame_001.jpg'), JPEG);
  return { dataDir, record };
}

function mockedProvider(handler) {
  const calls = [];
  const spawnImpl = (binary, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const buffers = [];
    child.stdin.on('data', bytes => buffers.push(bytes));
    let closed = false;
    const close = code => { if (!closed) { closed = true; child.emit('close', code); } };
    child.kill = () => { queueMicrotask(() => close(null)); };
    child.stdin.on('finish', () => queueMicrotask(async () => {
      try {
        if (args.includes('login')) child.stderr.write('Logged in using ChatGPT');
        else if (args.includes('import faster_whisper; print("ready")')) child.stdout.write('ready');
        else {
          const call = { args, input: Buffer.concat(buffers).toString('utf8'), child };
          calls.push(call);
          if (args[0] === 'exec') {
            call.schema = JSON.parse(await fs.readFile(args[args.indexOf('--output-schema') + 1], 'utf8'));
            const answer = await handler(call);
            await fs.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(answer));
          } else await handler(call);
        }
        close(0);
      } catch (error) { child.stderr.write(error.message); close(1); }
    }));
    return child;
  };
  return { calls, provider: createNoKeyProvider({ spawnImpl, environment: { VIDEORANDOM_CODEX: 'mock-codex', VIDEORANDOM_PYTHON: 'mock-python' }, platform: 'win32', statusCacheMs: 0 }) };
}

test('subtitle options reject unknown language hints and formats', () => {
  assert.equal(normalizeLanguageHint(), 'auto');
  assert.equal(normalizeSubtitleLanguage(), 'original');
  for (const value of ['en', '--tool', null, 1]) assert.throws(() => normalizeLanguageHint(value));
  for (const value of ['ja', 'zh', null, 1]) assert.throws(() => normalizeSubtitleLanguage(value));
  assert.throws(() => subtitleText({ transcript: source() }, { format: 'html' }));
  assert.throws(() => subtitleText({ transcript: [] }));
});

test('SRT and VTT preserve nonuniform original timings and escape cue markup', () => {
  const record = { transcript: [...source(), { start: 3599.9996, end: 3601.009, text: '<script>\n\n駅 & 道\u0000' }] };
  const srt = subtitleText(record);
  assert.match(srt, /1\n00:00:01,125 --> 00:00:02,400\nこんにちは。/);
  assert.match(srt, /2\n00:00:08,520 --> 00:00:11,900/);
  assert.match(srt, /3\n01:00:00,000 --> 01:00:01,009\n&lt;script&gt;\n駅 &amp; 道/);
  assert.equal(srt.includes('\u0000'), false);
  assert.match(subtitleText(record, { format: 'vtt' }), /^WEBVTT\n\n1\n00:00:01\.125 --> 00:00:02\.400/);
});

test('translated subtitles must match every original cue and its exact interval', () => {
  const transcript = source();
  const subtitles = transcript.map(cue => ({ ...cue, text: '한국어 대사' }));
  assert.deepEqual(validateTranslation(subtitles, transcript), subtitles);
  assert.throws(() => validateTranslation(subtitles.slice(0, 1), transcript));
  assert.throws(() => validateTranslation([{ ...subtitles[0], end: 5 }, subtitles[1]], transcript));
  assert.throws(() => subtitleText({ transcript, subtitleLanguage: 'ko' }, { language: 'ko' }));
  assert.match(subtitleText({ transcript, subtitleLanguage: 'ko', subtitleTranslation: subtitles }, { language: 'ko' }), /한국어 대사/);
});

test('Japanese speech language hint is passed to Whisper and actual detected language is retained', async t => {
  const { dataDir, record } = await fixture(t, { transcript: [], transcriptSource: 'none' });
  const audioPath = path.join(dataDir, 'audio.mp3'); await fs.writeFile(audioPath, 'ID3mock');
  const mocked = mockedProvider(call => {
    if (call.args.includes('--audio')) {
      call.child.stdout.write([{ type: 'info', language: 'ja', duration: 30 },
        ...source().map(cue => ({ type: 'segment', ...cue })), { type: 'complete' }].map(event => JSON.stringify(event)).join('\n') + '\n');
    } else return summary();
  });
  const result = await mocked.provider.analyzeExtracted(record, { dataDir, audioPath, transcriptLanguage: 'ja' });
  const speech = mocked.calls.find(call => call.args.includes('--audio'));
  assert.equal(speech.args[speech.args.indexOf('--language') + 1], 'ja');
  assert.equal(result.transcriptLanguage, 'ja');
  assert.deepEqual(result.transcript, source());
});

test('Korean translation uses only source cue indexes and preserves source transcript and timestamps', async t => {
  const { dataDir, record } = await fixture(t);
  const mocked = mockedProvider(call => call.schema.properties.subtitles
    ? { subtitles: [{ index: 0, text: '안녕하세요.' }, { index: 1, text: '역은 어디인가요?' }] } : summary());
  const result = await mocked.provider.analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko' });
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(result.transcript, source());
  assert.deepEqual(result.subtitleTranslation, source().map((cue, index) => ({ ...cue, text: index ? '역은 어디인가요?' : '안녕하세요.' })));
  assert.equal(result.subtitleLanguage, 'ko');
  const call = mocked.calls.find(call => call.schema?.properties.subtitles);
  assert.equal(call.args.includes('--image'), false);
  assert.equal(call.input.includes(record.path), false);
});

test('long translations are chunked at cue boundaries and preserve the global cue indexes', async t => {
  const transcript = Array.from({ length: 165 }, (_, index) => ({ start: index * 10 + 0.125, end: index * 10 + 2.4, text: `普通の会話 ${index}` }));
  const { dataDir, record } = await fixture(t, { transcript });
  const chunks = [];
  const mocked = mockedProvider(call => {
    if (!call.schema.properties.subtitles) return summary();
    const input = JSON.parse(call.input.slice(call.input.lastIndexOf('자료 JSON:\n') + '자료 JSON:\n'.length)).subtitles;
    chunks.push(input);
    return { subtitles: input.map(cue => ({ index: cue.index, text: `일상 대화 ${cue.index}` })) };
  });
  const result = await mocked.provider.analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko' });
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(chunks.map(cues => cues.length), [80, 80, 5]);
  assert.deepEqual(result.subtitleTranslation.map(cue => [cue.start, cue.end]), transcript.map(cue => [cue.start, cue.end]));
  assert.equal(result.subtitleTranslation.at(-1).text, '일상 대화 164');
});

test('malformed translation indexes, empty text and missing cues preserve original without retry', async t => {
  for (const subtitles of [[{ index: 0, text: '안녕하세요.' }], [{ index: 1, text: '뒤바뀜' }, { index: 0, text: '대사' }],
    [{ index: 0, text: '중복' }, { index: 0, text: '대사' }], [{ index: 0, text: '' }, { index: 1, text: '대사' }]]) {
    const { dataDir, record } = await fixture(t);
    const mocked = mockedProvider(call => call.schema.properties.subtitles ? { subtitles } : summary());
    const result = await mocked.provider.analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko' });
    assert.equal(result.status, 'partial');
    assert.equal(result.summary, summary().summary);
    assert.deepEqual(result.transcript, source());
    assert.equal(result.subtitleTranslation, undefined);
    assert.match(result.subtitleError, /대사|번호/);
    assert.equal(mocked.calls.filter(call => call.schema?.properties.subtitles).length, 1);
  }
});

test('translation quota failure retains summary and original timed subtitles without retry', async t => {
  const { dataDir, record } = await fixture(t);
  const mocked = mockedProvider(call => { if (call.schema.properties.subtitles) throw new Error('usage limit reached'); return summary(); });
  const result = await mocked.provider.analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko' });
  assert.equal(result.status, 'partial');
  assert.equal(result.summary, summary().summary);
  assert.deepEqual(result.transcript, source());
  assert.equal(result.subtitleTranslation, undefined);
  assert.match(result.subtitleError, /usage limit/);
  assert.equal(mocked.calls.filter(call => call.schema?.properties.subtitles).length, 1);
});

test('a failed summary never triggers a translation fallback', async t => {
  const { dataDir, record } = await fixture(t);
  const mocked = mockedProvider(() => { throw new Error('request cannot be completed'); });
  const result = await mocked.provider.analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko' });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.transcript, source());
  assert.equal(mocked.calls.length, 1);
  assert.equal(mocked.calls[0].schema.properties.subtitles, undefined);
});

test('LAN transports language options and aligned Korean subtitle text without host paths', async t => {
  const { dataDir, record } = await fixture(t);
  let received;
  const service = createLanAnalysis({ dataDir, processPackage: async pkg => {
    received = pkg;
    return { ...pkg.record, status: 'completed', summary: '길 안내', transcriptLanguage: 'zh', subtitleLanguage: 'ko',
      subtitleTranslation: pkg.record.transcript.map(cue => ({ ...cue, text: '길을 알려 주세요.' })) };
  } });
  t.after(() => service.stop());
  const host = await service.start({ port: 0, host: '127.0.0.1' });
  const result = await sendRemoteAnalysis(record, { dataDir, remoteUrl: `http://127.0.0.1:${host.port}`, connectionCode: host.connectionCode,
    transcriptLanguage: 'zh', subtitleLanguage: 'ko' });
  assert.equal(received.transcriptLanguage, 'zh');
  assert.equal(received.subtitleLanguage, 'ko');
  assert.equal(result.transcriptLanguage, 'zh');
  assert.equal(result.path, record.path);
  assert.equal(result.subtitleLanguage, 'ko');
  assert.deepEqual(result.subtitleTranslation.map(cue => [cue.start, cue.end]), source().map(cue => [cue.start, cue.end]));
  assert.equal(JSON.stringify(result).includes('remote/jobs'), false);
});

test('LAN rejects mismatched translation timings while preserving valid original dialogue', async t => {
  const { dataDir, record } = await fixture(t);
  const service = createLanAnalysis({ dataDir, processPackage: async pkg => ({ ...pkg.record, status: 'completed', subtitleLanguage: 'ko',
    subtitleTranslation: pkg.record.transcript.map(cue => ({ ...cue, end: cue.end + 1, text: '잘못된 시간' })) }) });
  t.after(() => service.stop());
  const host = await service.start({ port: 0, host: '127.0.0.1' });
  const result = await sendRemoteAnalysis(record, { dataDir, remoteUrl: `http://127.0.0.1:${host.port}`, connectionCode: host.connectionCode });
  assert.equal(result.status, 'partial');
  assert.equal(result.subtitleTranslation, undefined);
  assert.deepEqual(result.transcript, source());
  assert.match(result.subtitleError, /시간/);
});

test('old LAN hosts receive legacy metadata and unsupported subtitle features request a host update', async t => {
  const { dataDir, record } = await fixture(t);
  const code = 'a'.repeat(32), jobId = 'b'.repeat(32);
  let uploaded = '', posts = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/status') { res.end(JSON.stringify({ ready: true, protocol: 1, active: 0, queued: 0 })); return; }
    if (req.url === '/v1/jobs' && req.method === 'POST') {
      posts++;
      for await (const chunk of req) uploaded += chunk.toString('utf8');
      res.end(JSON.stringify({ id: jobId, status: 'completed', result: record })); return;
    }
    if (req.url.endsWith('/frames/frame_001.jpg')) { res.end(JPEG); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const remoteUrl = `http://127.0.0.1:${server.address().port}`;
  await sendRemoteAnalysis(record, { dataDir, remoteUrl, connectionCode: code });
  assert.equal(uploaded.includes('"subtitleLanguage"'), false);
  assert.equal(uploaded.includes('"transcriptLanguage"'), false);
  await assert.rejects(sendRemoteAnalysis(record, { dataDir, remoteUrl, connectionCode: code, subtitleLanguage: 'ko' }), /분석 서버 PC도 새 버전으로 업데이트/);
  await assert.rejects(sendRemoteAnalysis(record, { dataDir, remoteUrl, connectionCode: code, transcriptLanguage: 'ja' }), /분석 서버 PC도 새 버전으로 업데이트/);
  assert.equal(posts, 1);
});

test('LAN metadata validates only supported language hints and subtitle destinations', () => {
  const metadata = { name: 'neutral.mp4', ext: 'MP4', duration: 60, transcript: source(), frames: [{ timestamp: 5, filename: 'frame_001.jpg' }] };
  assert.equal(validateMetadata({ ...metadata, transcriptLanguage: 'ja', subtitleLanguage: 'ko' }).subtitleLanguage, 'ko');
  assert.throws(() => validateMetadata({ ...metadata, transcriptLanguage: 'en' }));
  assert.throws(() => validateMetadata({ ...metadata, subtitleLanguage: 'zh' }));
});
