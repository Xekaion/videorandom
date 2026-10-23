const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const crypto = require('node:crypto');
const { createNoKeyProvider } = require('../lib/no-key-provider');
const { processedSubtitleGaps } = require('../lib/subtitle-processing');
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

test('only an explicitly requested reviewed partial Korean prefix can be exported with its original timing', () => {
  const transcript = source().map((cue, index) => ({ ...cue, id: index + 1 }));
  const record = { transcript, subtitleTranslationPartial: [{ ...transcript[0], text: '안녕하세요.' }],
    subtitleTranslationProgress: { version: 1, language: 'ko', totalCues: 2, completedCues: 1, complete: false, sourceComplete: false,
      sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex') } };
  assert.throws(() => subtitleText(record, { language: 'ko' }));
  const text = subtitleText(record, { language: 'ko', partial: true });
  assert.match(text, /00:00:01,125 --> 00:00:02,400\n안녕하세요\./);
  assert.equal(text.includes('00:00:08'), false);
  assert.match(subtitleText(record, { language: 'ko', partial: true, format: 'vtt' }), /^WEBVTT/);
  assert.throws(() => subtitleText(record, { partial: true }));
  for (const changes of [
    { subtitleTranslationPartial: [{ ...record.subtitleTranslationPartial[0], id: 2 }] },
    { subtitleTranslationPartial: [{ ...record.subtitleTranslationPartial[0], end: 2.5 }] },
    { subtitleTranslationProgress: { ...record.subtitleTranslationProgress, completedCues: 2 } },
    { subtitleTranslationProgress: { ...record.subtitleTranslationProgress, complete: true } },
    { subtitleTranslationProgress: { ...record.subtitleTranslationProgress, sourceFingerprint: '0'.repeat(64) } },
    { subtitleTranslationProgress: { ...record.subtitleTranslationProgress, sourceComplete: 'false' } }
  ]) assert.throws(() => subtitleText({ ...record, ...changes }, { language: 'ko', partial: true }));
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
  const mocked = mockedProvider(call => (call.schema.properties.subtitles || call.schema.properties.approvedIndexes)
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
    if (!(call.schema.properties.subtitles || call.schema.properties.approvedIndexes)) return summary();
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

test('malformed translation rows preserve the original and valid tail after bounded missing-cue recovery', async t => {
  for (const [subtitles, retainedIndexes] of [[[{ index: 0, text: '안녕하세요.' }], [0]],
    [[{ index: 0, text: '중복' }, { index: 0, text: '대사' }], []], [[{ index: 0, text: '' }, { index: 1, text: '대사' }], [1]]]) {
    const { dataDir, record } = await fixture(t);
    const mocked = mockedProvider(call => (call.schema.properties.subtitles || call.schema.properties.approvedIndexes) ? { subtitles } : summary());
    const result = await mocked.provider.analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko' });
    assert.equal(result.status, 'partial');
    assert.equal(result.summary, summary().summary);
    assert.deepEqual(result.transcript, source());
    assert.equal(result.subtitleTranslation, undefined);
    assert.equal(result.subtitleError, null);
    assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
    assert.equal(result.subtitleTranslationProgress.processingComplete, true);
    assert.equal(result.subtitleTranslationProgress.processedCues, 2);
    assert.equal(result.subtitleTranslationProgress.completedCues, retainedIndexes.length);
    if (result.subtitleTranslationProgress.cueIndexes) assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, retainedIndexes);
    else assert.deepEqual(retainedIndexes, Array.from({ length: retainedIndexes.length }, (_, index) => index), 'only a contiguous prefix may omit sparse cue indexes');
    assert.deepEqual((result.subtitleTranslationPartial || []).map(cue => [cue.start, cue.end]),
      retainedIndexes.map(index => [source()[index].start, source()[index].end]));
    const requests = mocked.calls.filter(call => call.schema?.properties.subtitles);
    assert(requests.length > 1 && requests.length <= 5, 'row recovery is bounded and never accepts an ambiguous duplicate');
  }
});

test('full analysis orders a complete reversed translation by source index without regenerating it', async t => {
  const { dataDir, record } = await fixture(t);
  const mocked = mockedProvider(call => (call.schema.properties.subtitles || call.schema.properties.approvedIndexes)
    ? { subtitles: [{ index: 1, text: '역은 어디인가요?' }, { index: 0, text: '안녕하세요.' }] } : summary());
  const result = await mocked.provider.analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko' });
  assert.equal(result.status, 'completed', result.subtitleError);
  assert.deepEqual(result.transcript, source());
  assert.deepEqual(result.subtitleTranslation, source().map((cue, index) => ({ ...cue, text: index ? '역은 어디인가요?' : '안녕하세요.' })));
  assert.equal(mocked.calls.filter(call => call.schema?.properties.subtitles).length, 1);
});

test('translation quota failure retains summary and original timed subtitles without retry', async t => {
  const { dataDir, record } = await fixture(t);
  const mocked = mockedProvider(call => { if ((call.schema.properties.subtitles || call.schema.properties.approvedIndexes)) throw new Error('usage limit reached'); return summary(); });
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

test('content-addressed checkpoints resume fresh remote IDs with neighboring dialogue and stable names', async t => {
  const transcript = Array.from({ length: 165 }, (_, index) => ({ id: `line-${index}`, start: index * 10 + 0.125, end: index * 10 + 2.4, text: `太郎の普通の会話 ${index}` }));
  const { dataDir, record } = await fixture(t, { transcript });
  let batches = 0;
  const first = mockedProvider(call => {
    if (!(call.schema.properties.subtitles || call.schema.properties.approvedIndexes)) return summary();
    batches++;
    if (batches === 2) throw new Error('usage limit reached');
    const input = JSON.parse(call.input.slice(call.input.lastIndexOf('자료 JSON:\n') + '자료 JSON:\n'.length));
    return { subtitles: input.subtitles.map(cue => ({ index: cue.index, text: `타로의 일상 대화 ${cue.index}` })), terms: [{ source: '太郎', translation: '타로' }] };
  });
  const partial = await first.provider.analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko' });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.subtitleTranslation, undefined);
  assert.equal(partial.subtitleTranslationPartial.length, 80);
  assert.equal(partial.subtitleTranslationProgress.completedCues, 80);
  assert.equal(partial.subtitleTranslationProgress.totalCues, 165);
  assert.equal(partial.transcript.length, 165);
  const checkpoint = JSON.parse(await fs.readFile(path.join(dataDir, 'checkpoints', record.id + '-ko.json'), 'utf8'));
  assert.equal(checkpoint.subtitles.length, 80);
  const refusedId = 'd'.repeat(32);
  const refused = mockedProvider(() => { throw new Error('safety refusal: request cannot be completed'); });
  const refusal = await refused.provider.analyzeExtracted({ ...partial, id: refusedId, status: 'completed', warnings: [] },
    { dataDir, framesDir: path.join(dataDir, 'frames', record.id), subtitleLanguage: 'ko' });
  assert.match(refusal.summaryError, /safety refusal/);
  assert.equal(refused.calls.length, 1);
  assert.equal(await fs.stat(path.join(dataDir, 'checkpoints', refusedId + '-ko.json')).then(() => true).catch(() => false), false,
    'a cached translation never bypasses a new summary refusal');
  const resumedInputs = [];
  const second = mockedProvider(call => {
    if (!(call.schema.properties.subtitles || call.schema.properties.approvedIndexes)) return summary();
    const input = JSON.parse(call.input.slice(call.input.lastIndexOf('자료 JSON:\n') + '자료 JSON:\n'.length));
    resumedInputs.push(input);
    return { subtitles: input.subtitles.map(cue => ({ index: cue.index, text: `타로의 일상 대화 ${cue.index}` })), terms: [] };
  });
  const originalCheckpoint = await fs.readFile(path.join(dataDir, 'checkpoints', record.id + '-ko.json'), 'utf8');
  const repairedId = 'b'.repeat(32);
  const stages = [];
  const done = await second.provider.analyzeExtracted({ ...partial, id: repairedId, status: 'completed', warnings: [] },
    { dataDir, framesDir: path.join(dataDir, 'frames', record.id), subtitleLanguage: 'ko', onProgress: stage => stages.push(stage) });
  assert.equal(done.status, 'completed', done.error || done.subtitleError);
  assert.deepEqual(resumedInputs.map(input => input.subtitles[0].index), [80, 160]);
  assert.equal(resumedInputs[0].contextBefore.at(-1).index, 79);
  assert.equal(resumedInputs[0].contextAfter[0].index, 160);
  assert.equal(resumedInputs[0].previousTranslations.at(-1).index, 79);
  assert.deepEqual(resumedInputs[0].properNames, [{ source: '太郎', translation: '타로' }]);
  assert.equal(done.subtitleTranslation.at(-1).id, 'line-164');
  assert.equal(done.subtitleTranslationProgress.complete, true);
  assert.equal(done.subtitleTranslationPartial, undefined);
  assert.ok(stages.includes('한국어 자막 번역 80/165구간'));
  assert.ok(stages.includes('한국어 자막 번역 165/165구간'));
  assert.deepEqual(done.transcript, transcript);
  assert.equal(await fs.readFile(path.join(dataDir, 'checkpoints', record.id + '-ko.json'), 'utf8'), originalCheckpoint);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'checkpoints', repairedId + '-ko.json'), 'utf8')).subtitles.length, 165);
});

test('content checkpoint reuse rejects wrong prompt version, target, source text, cue ID and cue timing', async t => {
  for (const mutation of ['prompt-version', 'profile', 'review-passes', 'target', 'fingerprint', 'text', 'id', 'time']) {
    const transcript = Array.from({ length: 85 }, (_, index) => ({ id: `line-${index}`, start: index * 10 + 0.125, end: index * 10 + 2.4, text: `太郎の会話 ${index}` }));
    const { dataDir, record } = await fixture(t, { transcript });
    let batches = 0;
    const first = mockedProvider(call => {
      if (!(call.schema.properties.subtitles || call.schema.properties.approvedIndexes)) return summary();
      if (++batches === 2) throw new Error('usage limit reached');
      const input = JSON.parse(call.input.slice(call.input.lastIndexOf('자료 JSON:\n') + '자료 JSON:\n'.length));
      return { subtitles: input.subtitles.map(cue => ({ index: cue.index, text: `타로의 대화 ${cue.index}` })), terms: [] };
    });
    const partial = await first.provider.analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko' });
    assert.equal(partial.subtitleTranslationPartial.length, 80);
    const indexName = (await fs.readdir(path.join(dataDir, 'checkpoints'))).find(name => /-translation-ko-v\d+\.json$/.test(name));
    const indexPath = path.join(dataDir, 'checkpoints', indexName);
    const indexed = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    const changed = transcript.map(cue => ({ ...cue }));
    if (mutation === 'prompt-version') indexed.translationVersion += 1;
    if (mutation === 'profile') indexed.subtitleQuality = 'accurate';
    if (mutation === 'review-passes') indexed.reviewPasses = 2;
    if (mutation === 'target') indexed.targetLanguage = 'ja';
    if (mutation === 'fingerprint') indexed.sourceFingerprint = '0'.repeat(64);
    if (mutation === 'text') changed[0].text += '別の会話';
    if (mutation === 'id') changed[0].id = 'different-cue';
    if (mutation === 'time') changed[0].start += 0.01;
    await fs.writeFile(indexPath, JSON.stringify(indexed));
    const starts = [];
    const next = mockedProvider(call => {
      if (!(call.schema.properties.subtitles || call.schema.properties.approvedIndexes)) return summary();
      const input = JSON.parse(call.input.slice(call.input.lastIndexOf('자료 JSON:\n') + '자료 JSON:\n'.length));
      starts.push(input.subtitles[0].index);
      return { subtitles: input.subtitles.map(cue => ({ index: cue.index, text: `새 타로의 대화 ${cue.index}` })), terms: [] };
    });
    const result = await next.provider.analyzeExtracted({ ...partial, id: 'c'.repeat(32), transcript: changed, status: 'completed', warnings: [] },
      { dataDir, framesDir: path.join(dataDir, 'frames', record.id), subtitleLanguage: 'ko' });
    assert.equal(result.status, 'completed', result.subtitleError);
    assert.deepEqual(starts, [0, 80], mutation);
  }
});

test('cancelling a fully cached translation never returns completed Korean output or completed progress', async t => {
  const { dataDir, record } = await fixture(t);
  const first = mockedProvider(call => (call.schema.properties.subtitles || call.schema.properties.approvedIndexes)
    ? { subtitles: [{ index: 0, text: '안녕하세요.' }, { index: 1, text: '역은 어디인가요?' }], terms: [] } : summary());
  const complete = await first.provider.analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko' });
  assert.equal(complete.subtitleLanguage, 'ko');
  const controller = new AbortController();
  const second = mockedProvider(() => summary());
  await assert.rejects(second.provider.analyzeExtracted({ ...complete, id: 'e'.repeat(32), status: 'completed', warnings: [] },
    { dataDir, framesDir: path.join(dataDir, 'frames', record.id), subtitleLanguage: 'ko', signal: controller.signal,
      onCheckpoint: () => controller.abort() }), error => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.record.subtitleLanguage, undefined);
    assert.equal(error.record.subtitleTranslation, undefined);
    assert.equal(error.record.subtitleTranslationProgress.complete, false);
    assert.equal(error.record.subtitleTranslationPartial.length, source().length);
    return true;
  });
  assert.equal(second.calls.length, 1, 'cached text does not trigger another translation inference');
});

test('translation isolates foreign-language copies after one correction while retaining the valid later cue', async t => {
  for (const text of ['これは翻訳されていない日本語です。', 'This is not a Korean subtitle.']) {
    const { dataDir, record } = await fixture(t);
    const mocked = mockedProvider(call => {
      if (!(call.schema.properties.subtitles || call.schema.properties.approvedIndexes)) return summary();
      const input = JSON.parse(call.input.split('자료 JSON:\n').at(-1));
      return { subtitles: input.subtitles.map(cue => ({ index: cue.index, text: cue.index === 0 ? text : '역은 어디인가요?' })), terms: [] };
    });
    const result = await mocked.provider.analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko' });
    assert.equal(result.status, 'partial'); assert.equal(result.subtitleError, null);
    assert.equal(result.subtitleLanguage, undefined); assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
    assert.equal(result.subtitleTranslationProgress.processingComplete, true); assert.equal(result.subtitleTranslationProgress.processedCues, 2);
    assert.equal(mocked.calls.filter(call => call.schema?.properties.subtitles).length, 2);
    assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, [1]);
    assert.deepEqual(result.subtitleTranslationPartial, [{ ...source()[1], text: '역은 어디인가요?' }]);
    assert.deepEqual(result.transcript, source());
  }
});

test('translation isolates unsafe subtitle formatting after one correction and retains its valid tail', async t => {
  for (const text of ['00:00:01 --> 00:00:02\n한국어', '```\n한국어\n```']) {
    const { dataDir, record } = await fixture(t);
    const mocked = mockedProvider(call => (call.schema.properties.subtitles || call.schema.properties.approvedIndexes)
      ? { subtitles: [{ index: 0, text }, { index: 1, text: '역은 어디인가요?' }], terms: [] } : summary());
    const result = await mocked.provider.analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko' });
    assert.equal(result.status, 'partial');
    assert.equal(result.subtitleLanguage, undefined);
    assert.equal(result.subtitleError, null);
    assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
    assert.equal(result.subtitleTranslationProgress.processingComplete, true);
    assert.equal(result.subtitleTranslationProgress.processedCues, 2);
    assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, [1]);
    assert.deepEqual(result.subtitleTranslationPartial, [{ ...source()[1], text: '역은 어디인가요?' }]);
    assert.equal(mocked.calls.filter(call => call.schema?.properties.subtitles).length, 2);
    assert.deepEqual(result.transcript, source());
  }
});

test('a full analysis clears an older failed repair marker before returning a newly processed partial translation', async t => {
  const { dataDir, record } = await fixture(t, { duration: 15, transcriptSource: 'audio:faster-whisper large-v3',
    subtitleRepairStatus: 'failed', subtitleError: 'owned previous attempt failure',
    subtitleDiagnostic: { code: 'PROVIDER_UNAVAILABLE', event: 'error', level: 'error' },
    transcriptionQuality: { version: 1, recognitionRevision: 3, source: 'audio', profile: 'accurate', model: 'large-v3',
      complete: true, duration: 15, processedUntil: 15, wordTimestamps: true, language: 'ja', languageProbability: 0.99,
      audit: { complete: true, speechSeconds: 10, uncoveredSpeechSeconds: 0, unresolved: [] }, warnings: [] } });
  const mocked = mockedProvider(call => {
    if (!(call.schema.properties.subtitles || call.schema.properties.approvedIndexes)) return summary();
    const input = JSON.parse(call.input.split('자료 JSON:\n').at(-1));
    return { subtitles: input.subtitles.map(cue => ({ index: cue.index,
      text: cue.index === 0 ? 'これは翻訳されていない日本語です。' : '역은 어디인가요?' })), terms: [] };
  });
  const result = await mocked.provider.analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko', subtitleQuality: 'accurate' });
  assert.equal(result.status, 'partial'); assert.equal(result.subtitleError, null);
  assert.equal(result.subtitleRepairStatus, undefined, 'an older failed text-only attempt cannot override this full-analysis result');
  assert.deepEqual(processedSubtitleGaps(result), { processingComplete: true, processedCues: 2, totalCues: 2, completedCues: 1, pendingCues: 1 });
  assert.deepEqual(result.subtitleTranslationPartial, [{ ...source()[1], text: '역은 어디인가요?' }]);
  assert.equal(mocked.calls.filter(call => call.schema?.properties.subtitles).length, 2);
});

test('new chunk name drift keeps the validated prefix while concise valid cues are retained with an advisory', async t => {
  const transcript = Array.from({ length: 85 }, (_, index) => ({ start: index * 10, end: index * 10 + 3, text: `太郎は言いました ${index}` }));
  const { dataDir, record } = await fixture(t, { transcript });
  let batch = 0;
  const mocked = mockedProvider(call => {
    if (!(call.schema.properties.subtitles || call.schema.properties.approvedIndexes)) return summary();
    const input = JSON.parse(call.input.slice(call.input.lastIndexOf('자료 JSON:\n') + '자료 JSON:\n'.length));
    batch++;
    return { subtitles: input.subtitles.map(cue => ({ index: cue.index, text: '타로가 말했다.' })), terms: [{ source: '太郎', translation: batch === 1 ? '타로' : '다로' }] };
  });
  const partial = await mocked.provider.analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko' });
  assert.equal(partial.subtitleTranslationPartial.length, 80);
  assert.equal(partial.subtitleLanguage, undefined);
  assert.match(partial.subtitleError, /표기가 앞 구간과 일치하지 않/);
  const shortFixture = await fixture(t, { transcript: [{ start: 1, end: 9, text: '明日の会議では現在の計画について最初から最後まで詳しく説明し質問にも一つずつ順番に答える予定です。' }] });
  const short = mockedProvider(call => (call.schema.properties.subtitles || call.schema.properties.approvedIndexes) ? { subtitles: [{ index: 0, text: '네.' }], terms: [] } : summary());
  const retained = await short.provider.analyzeExtracted(shortFixture.record, { dataDir: shortFixture.dataDir, subtitleLanguage: 'ko' });
  assert.equal(retained.subtitleLanguage, 'ko');
  assert.equal(retained.subtitleDiagnostic, undefined);
  assert.equal(retained.subtitleError, null);
  assert.equal(retained.subtitleTranslationProgress.translationComplete, true);
  assert.deepEqual(retained.subtitleTranslation.map(cue => [cue.start, cue.end, cue.text]), [[1, 9, '네.']]);
  assert(retained.warnings.some(warning => warning.includes('길이 차이') && warning.includes('보관')));
  assert.equal(short.calls.filter(call => call.schema?.properties.subtitles).length, 1, 'length alone never starts another request');
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
