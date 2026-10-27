const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createNoKeyProvider, TRANSLATION_PROMPT_VERSION } = require('../lib/no-key-provider');

const workspace = path.resolve(__dirname, '..', '.test-data', 'subtitle-batch-recovery-tests');
const JAPANESE = '合成の列車が到着します。安全のためにホームの内側で待ち、案内と出発時間を確認してください。';
const KOREAN = '합성 열차가 도착합니다. 안전을 위해 승강장 안쪽에서 기다리고 안내와 출발 시간을 확인하세요.';
const RETAINED = '보관된 합성 열차 안내입니다. 승강장 안쪽에서 기다리세요.';
const fingerprint = source => crypto.createHash('sha256').update(JSON.stringify(source.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex');
const responseFor = (entries, changes = {}) => ({ subtitles: entries.map(cue => ({ index: cue.index, text: KOREAN })), terms: [], ...changes });

function assertRequestSchema(item) {
  const indexes = item.input.subtitles.map(cue => cue.index);
  if (item.review) {
    const { approvedIndexes, corrections } = item.schema.properties;
    assert.equal(approvedIndexes.minItems, 0); assert.equal(approvedIndexes.maxItems, item.count);
    assert.equal(corrections.minItems, 0); assert.equal(corrections.maxItems, item.count);
    assert.deepEqual(approvedIndexes.items.enum, indexes);
    assert.deepEqual(corrections.items.properties.index.enum, indexes);
    assert.deepEqual(item.schema.required, ['approvedIndexes', 'corrections', 'terms']);
    assert.deepEqual(item.input.draftSubtitles.map(cue => cue.index), indexes);
  } else {
    const subtitles = item.schema.properties.subtitles;
    assert.equal(subtitles.minItems, item.count); assert.equal(subtitles.maxItems, item.count);
    assert.deepEqual(subtitles.items.properties.index.enum, indexes);
  }
}

function mockSpawn(handler) {
  const calls = [];
  const spawnImpl = (binary, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    const chunks = [], call = { binary, args, options, child, input: '' };
    calls.push(call); child.stdin.on('data', chunk => chunks.push(chunk));
    child.kill = () => { if (!child.killed) { child.killed = true; queueMicrotask(() => child.emit('close', null)); } };
    child.stdin.on('finish', () => queueMicrotask(async () => {
      call.input = Buffer.concat(chunks).toString('utf8');
      try { await handler(call); if (!child.killed) child.emit('close', 0); }
      catch (error) {
        if (typeof error.exitCode === 'number') { child.stderr.write(error.message); child.emit('close', error.exitCode); }
        else child.emit('error', error);
      }
    }));
    return child;
  };
  return { spawnImpl, calls };
}

async function fixture(t, { count = 80, respond, afterResponse } = {}) {
  await fs.mkdir(workspace, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(workspace, 'owned-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(dataDir)), workspace); await fs.rm(dataDir, { recursive: true, force: true }); });
  const source = Array.from({ length: count }, (_, index) => ({ id: `source-${index}`, start: index * 13 + 0.25, end: index * 13 + 3.75, text: JAPANESE }));
  const duration = count * 13 + 5;
  const record = { id: 'owned-batch-film', name: '합성 열차 안내.mp4', path: 'owned-synthetic-video-not-opened.mp4', duration, hasAudio: true,
    status: 'completed', summary: '보관된 합성 열차 안내', plot: '합성 열차의 출발 안내입니다.', frames: [], warnings: [], transcript: source,
    transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3', transcriptionQuality: { version: 1, recognitionRevision: 3,
      source: 'audio', profile: 'accurate', model: 'large-v3', complete: true, duration, processedUntil: duration, wordTimestamps: true,
      language: 'ja', languageProbability: 0.99, audit: { complete: true, speechSeconds: 10, uncoveredSpeechSeconds: 0, unresolved: [] }, warnings: [] } };
  const requests = [];
  const mocked = mockSpawn(async call => {
    assert.equal(call.args[0], 'exec', 'all requests must be synthetic translation calls; no status, speech, decode or summary invocation');
    const input = JSON.parse(call.input.split('자료 JSON:\n').at(-1));
    assert.ok(Array.isArray(input.subtitles) && input.subtitles.length);
    const schema = JSON.parse(await fs.readFile(call.args[call.args.indexOf('--output-schema') + 1], 'utf8'));
    const item = { input, schema, start: input.subtitles[0].index, count: input.subtitles.length, review: Boolean(input.draftSubtitles) };
    requests.push(item);
    const response = respond ? await respond(item, requests) : undefined;
    await fs.writeFile(call.args[call.args.indexOf('--output-last-message') + 1], JSON.stringify(response === undefined ? responseFor(input.subtitles) : response), 'utf8');
    if (afterResponse) await afterResponse(item);
  });
  const instance = createNoKeyProvider({ spawnImpl: mocked.spawnImpl, environment: { VIDEORANDOM_CODEX: 'mock-codex', VIDEORANDOM_PYTHON: 'mock-python' }, platform: 'win32', statusCacheMs: 0 });
  return { dataDir, source, record, requests, mocked,
    run: options => instance.translateKoreanOnly(record, { dataDir, subtitleQuality: 'accurate', ...options }) };
}

async function seedPrefix(f, version, count) {
  const hash = fingerprint(f.source);
  const saved = { version: 1, translationVersion: version, targetLanguage: 'ko', subtitleQuality: 'accurate', reviewPasses: 2,
    language: 'ko', sourceFingerprint: hash, totalCues: f.source.length, completedCues: count, complete: false,
    sourceComplete: true, translationComplete: false,
    subtitles: f.source.slice(0, count).map((cue, index) => ({ index, ...cue, text: RETAINED })), terms: [] };
  const id = crypto.createHash('sha256').update(`videorandom-subtitles\0${version}\0ko\0accurate\0${hash}`).digest('hex');
  const directory = path.join(f.dataDir, 'checkpoints'); await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, `${id}-translation-ko-v${version}.json`), bytes = JSON.stringify(saved);
  await fs.writeFile(filename, bytes);
  return { filename, bytes };
}

async function assertCompleted(f, result) {
  assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
  assert.equal(result.subtitleTranslation.length, f.source.length);
  assert.deepEqual(result.transcript, f.source);
  assert.deepEqual(result.subtitleTranslation.map(cue => [cue.id, cue.start, cue.end]), f.source.map(cue => [cue.id, cue.start, cue.end]));
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints', `${f.record.id}-ko.json`), 'utf8'));
  assert.equal(saved.translationVersion, TRANSLATION_PROMPT_VERSION);
  assert.equal(saved.reviewPasses, 2);
  assert.equal(saved.completedCues, f.source.length);
  assert.equal(saved.sourceFingerprint, fingerprint(f.source));
  assert.deepEqual(saved.subtitles.map(cue => [cue.id, cue.start, cue.end]), f.source.map(cue => [cue.id, cue.start, cue.end]));
  return saved;
}

test('each draft and review schema bounds its cue count and exact index set while valid reversed rows normalize into source order', async t => {
  const f = await fixture(t, { count: 81, respond: item => responseFor([...item.input.subtitles].reverse()) });
  const result = await f.run(); await assertCompleted(f, result);
  assert.equal(f.requests.length, 4);
  for (const item of f.requests) assertRequestSchema(item);
});

for (const phase of ['draft', 'review']) test(`a 241-cue ${phase} batch returning 37 of 80 recovers only its missing 43 cues and preserves the first 160`, async t => {
  let shortened = false;
  const f = await fixture(t, { count: 241, respond: item => {
    if (!shortened && item.start === 160 && item.count === 80 && item.review === (phase === 'review')) {
      shortened = true; return responseFor(item.input.subtitles.slice(0, 37));
    }
  } });
  const checkpoints = [], diagnostics = [];
  const result = await f.run({ onCheckpoint: record => checkpoints.push(record.subtitleTranslationProgress?.completedCues || 0), onDiagnostic: item => diagnostics.push(item) });
  await assertCompleted(f, result);
  assert.equal(f.requests.length, 11);
  const repairs = f.requests.filter(item => item.start >= 197 && item.start < 240);
  assert.deepEqual(repairs.map(item => [item.start, item.count, item.review]), [[197, 20, phase === 'review'], [217, 20, phase === 'review'], [237, 3, phase === 'review']]);
  assert.equal(f.requests.filter(item => item.start === 160 && item.review).length, 1, 'draft gaps receive one whole-batch review; review gaps do not re-review accepted rows');
  assert.ok(checkpoints.includes(80) && checkpoints.includes(160) && checkpoints.includes(240) && checkpoints.includes(241));
  assert.deepEqual([...checkpoints].sort((a, b) => a - b), checkpoints, 'committed prefix never shrinks');
  assert.equal(diagnostics.some(item => item.event === 'committed' && item.stage === 'translation_draft'), false);
});

for (const version of [3, 4]) test(`a reviewed version-${version} prefix migrates to version 5 and retains exact original cue IDs, times and earlier checkpoint bytes`, async t => {
  const f = await fixture(t, { count: 161 });
  const old = await seedPrefix(f, version, 160);
  const result = await f.run();
  const saved = await assertCompleted(f, result);
  assert.deepEqual(f.requests.map(item => [item.start, item.count, item.review]), [[160, 1, false], [160, 1, true]]);
  assert.ok(result.subtitleTranslation.slice(0, 160).every(cue => cue.text === RETAINED));
  assert.ok(saved.subtitles.slice(0, 160).every(cue => cue.text === RETAINED));
  assert.equal(await fs.readFile(old.filename, 'utf8'), old.bytes);
});

test('a resumed 160-cue prefix survives a 37-row response and reaches the end without requesting earlier source again', async t => {
  let shortened = false;
  const f = await fixture(t, { count: 241, respond: item => {
    if (!shortened && !item.review && item.count === 80) { shortened = true; return responseFor(item.input.subtitles.slice(0, 37)); }
  } });
  const old = await seedPrefix(f, 4, 160);
  const result = await f.run(); await assertCompleted(f, result);
  assert.equal(f.requests.length, 7);
  assert.ok(f.requests.every(item => item.start >= 160));
  assert.ok(result.subtitleTranslation.slice(0, 160).every(cue => cue.text === RETAINED));
  assert.equal(await fs.readFile(old.filename, 'utf8'), old.bytes);
});

for (const phase of ['draft', 'review']) test(`a ${phase} subset with only one valid row is supplemented at most four times with at most 20 requested cues each`, async t => {
  let shortened = false;
  const f = await fixture(t, { respond: item => {
    if (!shortened && item.count === 80 && item.review === (phase === 'review')) { shortened = true; return responseFor(item.input.subtitles.slice(0, 1)); }
  } });
  const result = await f.run(); await assertCompleted(f, result);
  const requests = f.requests.filter(item => item.review === (phase === 'review'));
  assert.deepEqual(requests.map(item => item.count), [80, 20, 20, 20, 19]);
  assert.deepEqual(requests.slice(1).flatMap(item => item.input.subtitles.map(cue => cue.index)), Array.from({ length: 79 }, (_, index) => index + 1));
});

for (const phase of ['draft', 'review']) test(`a deficient ${phase} supplement preserves exact reviewed indexes and leaves unresolved rows as gaps`, async t => {
  const f = await fixture(t, { respond: item => {
    if (item.review === (phase === 'review')) return responseFor(item.input.subtitles.slice(0, item.count === 80 ? 40 : item.count - 1));
  } });
  const result = await f.run();
  assert.equal(result.subtitleRepairStatus, 'partial');
  assert.equal(f.requests.length, 6);
  assert.equal(result.subtitleTranslationPartial?.length || 0, 78,
    'explicitly reviewed tails survive missing rows; an unreviewed draft is never committed');
  assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
  const indexes = Array.from({ length: 80 }, (_, index) => index).filter(index => index !== 59 && index !== 79);
  assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, indexes);
  assert.deepEqual(result.subtitleTranslationPartial.map(cue => [cue.id, cue.start, cue.end]), indexes.map(index =>
    [f.source[index].id, f.source[index].start, f.source[index].end]));
});

test('a concise review supplement is retained after the three missing-only calls', async t => {
  const f = await fixture(t, { respond: item => {
    if (item.review && item.count === 80) return responseFor(item.input.subtitles.slice(0, 79));
    if (item.review && item.count === 1) return responseFor(item.input.subtitles, { subtitles: [{ index: item.input.subtitles[0].index, text: '네.' }] });
  } });
  const result = await f.run();
  assert.equal(result.subtitleRepairStatus, 'completed');
  assert.equal(f.requests.length, 3, 'a concise supplement cannot trigger a whole-batch length retry');
  assert.equal(result.subtitleTranslation.length, 80);
  assert.equal(result.subtitleTranslation.at(-1).text, '네.');
});

for (const phase of ['draft', 'review']) test(`a ${phase} subset with a concise row receives only a missing-index correction`, async t => {
  const f = await fixture(t, { respond: item => {
    if (item.review === (phase === 'review')) {
      const response = responseFor(item.input.subtitles.slice(0, 79));
      response.subtitles[0].text = '네.';
      return response;
    }
  } });
  const result = await f.run();
  assert.equal(f.requests.length, 3);
  if (phase === 'draft') {
    await assertCompleted(f, result);
    assert.deepEqual(f.requests.map(item => [item.start, item.count, item.review]), [[0, 80, false], [79, 1, false], [0, 80, true]]);
    assert.deepEqual(f.requests[2].input.omissionCheckIndexes, [0, 79], 'both short draft cues still require source review');
  } else {
    assert.equal(result.subtitleRepairStatus, 'completed');
    assert.equal(result.subtitleDiagnostic, undefined);
    assert.deepEqual(f.requests[2].input.subtitles.map(cue => cue.index), [79], 'only the missing reviewed cue is requested again');
    assert.equal(result.subtitleTranslation.length, 80);
    assert.equal(result.subtitleTranslation[0].text, '네.');
    assert.equal(result.subtitleTranslation[79].text, '네.');
    assert.equal(result.subtitleTranslationProgress.version, 1);
    assert.equal(result.subtitleTranslationProgress.complete, true);
    assert(result.subtitleTranslation.slice(1, 79).every(cue => cue.text.replace(/\s+/g, ' ').trim() === KOREAN));
  }
});

for (const phase of ['draft', 'review']) test(`a ${phase} supplement receives the other source cues as context and already accepted same-stage terminology`, async t => {
  const term = { source: '合成駅', translation: '합성역' };
  let shortened = false;
  const f = await fixture(t, { respond: item => {
    const entries = !shortened && item.count === 80 && item.review === (phase === 'review')
      ? (shortened = true, item.input.subtitles.slice(0, 60)) : item.input.subtitles;
    return responseFor(entries, { terms: [term] });
  } });
  const result = await f.run(); await assertCompleted(f, result);
  const supplement = f.requests.find(item => item.count === 20);
  assert.ok(supplement);
  assert.equal(supplement.review, phase === 'review');
  assert.deepEqual(supplement.input.subtitles.map(cue => cue.index), Array.from({ length: 20 }, (_, index) => index + 60));
  assert.deepEqual(supplement.input.contextOtherSubtitles.map(cue => cue.index), Array.from({ length: 60 }, (_, index) => index));
  assert.deepEqual(supplement.input.properNames, [term]);
  assertRequestSchema(supplement);
});

const invalid = {
  duplicate: entries => responseFor(entries.slice(0, 3), { subtitles: [entries[0], entries[0]].map(cue => ({ index: cue.index, text: KOREAN })) }),
  excess: entries => responseFor([...entries, entries[0]]),
  'out-of-range': entries => responseFor(entries.slice(0, 3), { subtitles: [{ index: 99999, text: KOREAN }] }),
  'unsafe subtitle formatting': entries => responseFor(entries.slice(0, 3), { subtitles: [{ index: entries[0].index, text: '```\n합성 열차 안내\n```' }] }),
  'empty text': entries => responseFor(entries.slice(0, 3), { subtitles: [{ index: entries[0].index, text: '' }] }),
  'term conflict': entries => responseFor(entries.slice(0, 3), { terms: [{ source: '合成駅', translation: '합성역' }, { source: '合成駅', translation: '다른 역' }] }),
  'empty array': () => ({ subtitles: [], terms: [] }),
  'absent array': () => ({ terms: [] })
};
for (const phase of ['draft', 'review']) for (const [name, makeInvalid] of Object.entries(invalid)) test(`a ${phase} ${name} retains only validated rows after bounded corrections`, async t => {
  const f = await fixture(t, { respond: item => item.review === (phase === 'review') ? makeInvalid(item.input.subtitles) : undefined });
  const result = await f.run();
  const recoverable = true;
  assert.equal(result.subtitleRepairStatus, recoverable ? 'partial' : 'failed');
  if (recoverable) {
    assert(f.requests.length > (phase === 'draft' ? 1 : 2) && f.requests.length <= 66, 'only the bounded shared correction budget is available');
    assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
    assert.equal(result.subtitleTranslationProgress.complete, false);
    assert.equal(result.subtitleTranslationProgress.processingComplete, true);
    assert.equal(result.subtitleTranslationProgress.processedCues, f.source.length);
    assert.equal(result.subtitleTranslation, undefined);
    const expected = name === 'excess' ? Array.from({ length: 79 }, (_, index) => index + 1) : [];
    assert.equal(result.subtitleTranslationPartial?.length || 0, expected.length);
    if (expected.length) {
      assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, expected);
      assert.deepEqual(result.subtitleTranslationPartial.map(cue => [cue.id, cue.start, cue.end]), expected.map(index =>
        [f.source[index].id, f.source[index].start, f.source[index].end]));
    }
  } else {
    assert.equal(f.requests.length, phase === 'draft' ? 1 : 2);
    assert.equal(result.subtitleTranslationPartial?.length || 0, 0);
  }
  assert.deepEqual(result.transcript, f.source);
});

for (const phase of ['draft', 'review']) test(`a partial ${phase} array containing a task refusal wins over its count mismatch and never invokes supplements`, async t => {
  const f = await fixture(t, { respond: item => {
    if (item.review === (phase === 'review')) {
      const rows = responseFor(item.input.subtitles.slice(0, 37));
      rows.subtitles[36].text = '죄송하지만 해당 요청을 도와드릴 수 없습니다.';
      return rows;
    }
  } });
  const result = await f.run();
  assert.equal(result.subtitleRepairStatus, 'failed');
  assert.equal(result.subtitleDiagnostic?.code, 'SUBTITLE_REFUSAL_TEXT_DETECTED');
  assert.equal(result.subtitleDiagnostic.refusalSource, 'subtitle-text');
  assert.equal(result.subtitleDiagnostic.returnedCues, 37);
  assert.equal(f.requests.length, phase === 'draft' ? 1 : 2);
  assert.equal(result.subtitleTranslationPartial?.length || 0, 0);
});

for (const phase of ['draft', 'review']) test(`an explicit ${phase} refusal without a subtitle array stops before missing-cue repair`, async t => {
  const f = await fixture(t, { respond: item => item.review === (phase === 'review') ? { refusal: 'synthetic-provider-refusal' } : undefined });
  const result = await f.run();
  assert.equal(result.subtitleRepairStatus, 'failed');
  assert.equal(result.subtitleDiagnostic?.code, 'SUBTITLE_PROVIDER_REFUSAL');
  assert.equal(result.subtitleDiagnostic.refusalSource, 'response-field');
  assert.equal('returnedCues' in result.subtitleDiagnostic, false, 'a missing subtitle array is not reported as zero returned cues');
  assert.equal(f.requests.length, phase === 'draft' ? 1 : 2);
  assert.equal(result.subtitleTranslationPartial?.length || 0, 0);
});

for (const phase of ['draft', 'review']) for (const source of ['response-field', 'subtitle-text']) {
  test(`a resumed synthetic 1819-cue job preserves its reviewed 240-cue prefix on ${phase} ${source} detection without retry`, async t => {
    const events = [], privateReason = 'SYNTHETIC-PRIVATE-REFUSAL-REASON';
    const f = await fixture(t, { count: 1819, respond: item => {
      assert.equal(item.start, 240, 'the saved prefix is not sent again and no later batch starts');
      if (item.review !== (phase === 'review')) return;
      const response = responseFor(item.input.subtitles.slice(0, 37));
      if (source === 'response-field') response.refusal = privateReason;
      else response.subtitles[36].text = '죄송하지만 해당 요청을 도와드릴 수 없습니다.';
      return response;
    } });
    const old = await seedPrefix(f, 4, 240);
    const result = await f.run({ onDiagnostic: event => events.push(event) });
    assert.equal(result.subtitleRepairStatus, 'failed');
    assert.equal(f.requests.length, phase === 'draft' ? 1 : 2, 'detection cannot trigger supplements, length repair or another request');
    assert.ok(f.requests.every(item => item.start === 240 && item.count === 80));
    const diagnostic = result.subtitleDiagnostic;
    assert.equal(diagnostic.code, source === 'response-field' ? 'SUBTITLE_PROVIDER_REFUSAL' : 'SUBTITLE_REFUSAL_TEXT_DETECTED');
    assert.equal(diagnostic.refusalSource, source);
    assert.equal(diagnostic.stage, `translation_${phase}`);
    assert.equal(diagnostic.totalCues, 1819); assert.equal(diagnostic.completedCues, 240);
    assert.equal(diagnostic.startCue, 241); assert.equal(diagnostic.endCue, 320);
    assert.equal(diagnostic.expectedCues, 80); assert.equal(diagnostic.returnedCues, 37);
    assert.equal(result.subtitleTranslationPartial.length, 240);
    assert.ok(result.subtitleTranslationPartial.every(cue => cue.text === RETAINED));
    assert.deepEqual(result.subtitleTranslationPartial.map(cue => [cue.id, cue.start, cue.end]), f.source.slice(0, 240).map(cue => [cue.id, cue.start, cue.end]));
    assert.equal(result.subtitleTranslationProgress.completedCues, 240);
    assert.equal(result.subtitleTranslationProgress.translationComplete, false);
    assert.deepEqual(result.transcript, f.source);
    const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints', `${f.record.id}-ko.json`), 'utf8'));
    assert.equal(saved.translationVersion, TRANSLATION_PROMPT_VERSION); assert.equal(saved.completedCues, 240); assert.equal(saved.reviewPasses, 2);
    assert.ok(saved.subtitles.every(cue => cue.text === RETAINED));
    assert.equal(await fs.readFile(old.filename, 'utf8'), old.bytes, 'the legacy reviewed checkpoint is unchanged');
    assert.equal(events.filter(event => event.event === 'error').length, 1);
    const technical = JSON.stringify([events, diagnostic]);
    for (const secret of [privateReason, JAPANESE, KOREAN, RETAINED, f.dataDir, 'contextOtherSubtitles']) assert.equal(technical.includes(secret), false);
  });
}

for (const phase of ['draft', 'review']) for (const failure of ['503 service unavailable', '401 authentication failed', 'quota usage limit']) test(`a ${phase} ${failure} stops without repair or retry`, async t => {
  const f = await fixture(t, { respond: item => {
    if (item.review === (phase === 'review')) throw Object.assign(new Error(failure), { exitCode: 1 });
  } });
  const result = await f.run();
  assert.equal(result.subtitleRepairStatus, 'failed');
  assert.equal(f.requests.length, phase === 'draft' ? 1 : 2);
});

for (const phase of ['draft', 'review']) test(`cancellation after a ${phase} response keeps a reviewed prefix and never makes a supplementary request`, async t => {
  const controller = new AbortController();
  const f = await fixture(t, { count: 161, afterResponse: item => { if (item.review === (phase === 'review')) controller.abort(); } });
  const old = await seedPrefix(f, 4, 80);
  await assert.rejects(f.run({ signal: controller.signal }), error => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.record.subtitleTranslationPartial.length, 80);
    assert.deepEqual(error.record.transcript, f.source);
    return true;
  });
  assert.equal(f.requests.length, phase === 'draft' ? 1 : 2);
  assert.equal(await fs.readFile(old.filename, 'utf8'), old.bytes);
});

test('the operation-wide supplementary budget stays at 64 while later explicitly reviewed source cues are still preserved', async t => {
  const f = await fixture(t, { count: 721, respond: item => item.count === 80 ? responseFor(item.input.subtitles.slice(0, 1)) : undefined });
  const result = await f.run();
  assert.equal(result.subtitleRepairStatus, 'partial');
  assert.equal(result.subtitleDiagnostic?.code, 'SUBTITLE_CUES_PENDING');
  assert.equal(f.requests.filter(item => item.start < 640 && item.count <= 20).length, 64);
  assert.deepEqual(f.requests.filter(item => item.start >= 640).map(item => [item.start, item.count, item.review]),
    [[640, 80, false], [640, 1, true], [720, 1, false], [720, 1, true]]);
  assert.equal(f.requests.length, 84);
  assert.equal(result.subtitleTranslationPartial.length, 642);
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints', `${f.record.id}-ko.json`), 'utf8'));
  assert.equal(saved.completedCues, 642); assert.equal(saved.reviewPasses, 2); assert.equal(saved.translationVersion, TRANSLATION_PROMPT_VERSION);
  const indexes = [...Array.from({ length: 641 }, (_, index) => index), 720];
  assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, indexes);
  assert.deepEqual(result.subtitleTranslationPartial.map(cue => [cue.id, cue.start, cue.end]), indexes.map(index =>
    [f.source[index].id, f.source[index].start, f.source[index].end]));
});

test('conflicting terminology from an otherwise valid supplement cannot replace the batch or committed prefix', async t => {
  const f = await fixture(t, { respond: item => {
    if (!item.review && item.count === 80) return responseFor(item.input.subtitles.slice(0, 60), { terms: [{ source: '合成駅', translation: '합성역' }] });
    if (!item.review) return responseFor(item.input.subtitles, { terms: [{ source: '合成駅', translation: '다른 역' }] });
  } });
  const result = await f.run();
  assert.equal(result.subtitleRepairStatus, 'partial'); assert.equal(f.requests.length, 4);
  assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
  assert.equal(result.subtitleTranslationProgress.processingComplete, true);
  assert.equal(result.subtitleTranslationPartial?.length || 0, 0);
});

test('supplement and failure diagnostics retain only technical counters and canonical errors without source, translation, prompts, paths or raw provider output', async t => {
  const diagnostics = [], privatePath = 'C:\\synthetic-private\\provider-output.txt', marker = 'SYNTHETIC-PRIVATE-PROVIDER-OUTPUT';
  let shortened = false;
  const f = await fixture(t, { respond: item => {
    if (!shortened && !item.review) { shortened = true; return responseFor(item.input.subtitles.slice(0, 37)); }
    if (item.review) throw Object.assign(new Error(`503 service unavailable ${marker} ${privatePath} ${JAPANESE} ${KOREAN}`), { exitCode: 1 });
  } });
  const result = await f.run({ onDiagnostic: event => diagnostics.push(event) });
  assert.equal(result.subtitleRepairStatus, 'failed');
  assert.equal(f.requests.length, 5);
  const warning = diagnostics.find(event => event.code === 'SUBTITLE_CUE_COUNT_MISMATCH');
  assert.equal(warning.expectedCues, 80); assert.equal(warning.returnedCues, 37);
  assert.equal(warning.startCue, 1); assert.equal(warning.endCue, 80);
  const failure = diagnostics.find(event => event.code === 'PROVIDER_UNAVAILABLE');
  assert.equal(failure.stage, 'translation_review'); assert.equal(failure.httpStatus, 503);
  const allowed = new Set(['source', 'level', 'event', 'stage', 'totalCues', 'completedCues', 'expectedCues', 'returnedCues', 'startCue', 'endCue', 'code', 'message', 'httpStatus',
    'executionSource', 'executionElapsedMs', 'executionDeadlineMs', 'providerErrorType', 'providerSystemCode',
    'providerReconnectAttempt', 'providerReconnectLimit', 'providerHttpStatus',
    'providerActivity', 'providerActivityAtMs', 'providerActivityAgeMs', 'providerAttempt', 'providerDeadlineScope', 'providerProcessStopped',
    'providerRequestedModel', 'providerReasoningEffort', 'providerServiceTier']);
  for (const event of [...diagnostics, result.subtitleDiagnostic]) assert.ok(Object.keys(event).every(key => allowed.has(key)), JSON.stringify(event));
  const serialized = JSON.stringify([...diagnostics, result.subtitleDiagnostic]);
  for (const secret of [JAPANESE, KOREAN, RETAINED, marker, privatePath, f.dataDir, 'contextOtherSubtitles', '자료 JSON:']) assert.equal(serialized.includes(secret), false);
});
