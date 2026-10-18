const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createNoKeyProvider } = require('../lib/no-key-provider');
const { createUnitProgress, normalizeProgressDetails, ageProgressDetails, formatProgressDetails,
  progressPresentation } = require('../public/js/analysis-progress');

test('a resumed prefix needs two fresh measured advances before translation ETA', () => {
  let at = 0;
  const measure = createUnitProgress('translation', { total: 1819, completed: 160, now: () => at });
  assert.deepEqual(measure(160), { phase: 'translation', elapsedSeconds: 0, sampleAgeSeconds: 0, completedCues: 160, totalCues: 1819 });
  at = 10000;
  assert.equal(measure(240).remainingSeconds, undefined);
  at = 20000;
  assert.equal(measure(320).remainingSeconds, 188, '1,499 remaining cues at 8 new cues/second; saved 160 are excluded');
  at = 30000;
  assert.equal(measure(320).remainingSeconds, 375, 'a slow current batch makes the estimate more conservative');
});

test('fast callback bursts, repeated counters and pipeline drafts cannot create rate evidence', () => {
  let at = 0;
  const measure = createUnitProgress('translation', { total: 480, now: () => at });
  for (let index = 0; index < 20; index++) { at += 1000; assert.equal(measure(0).remainingSeconds, undefined); }
  at = 21000;
  assert.equal(measure(80).remainingSeconds, undefined);
  at = 22000;
  assert.equal(measure(160).remainingSeconds, 44, 'recent fast work cannot erase slow measured warmup');
  const burst = createUnitProgress('translation', { total: 480, now: () => at });
  at += 1; burst(80);
  at += 1;
  assert.equal(burst(160).remainingSeconds, undefined, 'two milliseconds are insufficient');
});

test('stale translation measurements expire through repeated events and both LAN age hops', () => {
  let at = 0;
  const measure = createUnitProgress('translation', { total: 480, now: () => at });
  at = 10000; measure(80);
  at = 20000; const fresh = measure(160);
  assert.equal(fresh.remainingSeconds, 40);
  const forwarded = ageProgressDetails(ageProgressDetails(fresh, 70), 51);
  assert.equal(forwarded.sampleAgeSeconds, 121);
  assert.equal(forwarded.remainingSeconds, undefined);
  assert.equal(progressPresentation(forwarded).stale, true);
  assert.match(progressPresentation(forwarded).etaText, /진행 확인 중/);
  at = 141000;
  assert.equal(measure(160).remainingSeconds, undefined, 'repeated draft/review status cannot reset last committed time');
});

test('counter rollback starts a new timing window and completion clears numeric ETA', () => {
  let at = 0;
  const measure = createUnitProgress('translation', { total: 320, now: () => at });
  at = 10000; measure(80);
  at = 20000; assert.equal(measure(160).remainingSeconds, 20);
  at = 30000; assert.equal(measure(80).remainingSeconds, undefined);
  at = 40000; assert.equal(measure(160).remainingSeconds, undefined);
  at = 50000; assert.equal(measure(240).remainingSeconds, 10);
  at = 60000; assert.equal(measure(320).remainingSeconds, undefined);
  assert.equal(progressPresentation({ phase: 'completed', remainingSeconds: 99 }), undefined);
});

test('summary ETA measures independent completed chunks and labels only that stage', () => {
  let at = 0;
  const measure = createUnitProgress('summary', { total: 8, now: () => at });
  at = 10000; measure(1);
  at = 20000; const measured = measure(2);
  assert.equal(measured.remainingSeconds, 60);
  const presentation = progressPresentation(measured);
  assert.equal(presentation.unit, 'chunks');
  assert.equal(presentation.completed, 2);
  assert.equal(presentation.total, 8);
  assert.equal(presentation.currentStageOnly, true);
  assert.match(presentation.etaText, /현재 구간 요약 단계 예상 잔여/);
  assert.match(formatProgressDetails(measured), /2 \/ 8구간.*이후 단계 별도/);
  assert.match(progressPresentation({ phase: 'summary', elapsedSeconds: 0 }).etaText, /측정 중/);
});

test('cue/chunk progress whitelist rejects wrong units, invalid counts and private payloads', () => {
  const safe = normalizeProgressDetails({ phase: 'translation', completedCues: 160, totalCues: 1819, remainingSeconds: 90,
    completedSeconds: 1, totalSeconds: 2, completedChunks: 1, totalChunks: 2, transcript: 'private', path: 'private', prompt: 'private' });
  assert.deepEqual(safe, { phase: 'translation', completedCues: 160, totalCues: 1819, remainingSeconds: 90 });
  for (const changes of [{ completedCues: -1 }, { completedCues: 1820 }, { completedCues: 0.5 }, { totalCues: Infinity }, { totalCues: 2000001 }]) {
    assert.deepEqual(normalizeProgressDetails({ phase: 'translation', completedCues: 160, totalCues: 1819, remainingSeconds: 90, ...changes }), { phase: 'translation' });
  }
  assert.equal(normalizeProgressDetails({ ...safe, sampleAgeSeconds: 121 }).remainingSeconds, undefined);
  assert.equal(progressPresentation(safe).unit, 'cues');
  assert.match(formatProgressDetails(safe), /현재 번역 단계 예상 잔여.*160 \/ 1,819구간/);
  assert.equal(JSON.stringify(safe).includes('private'), false);
});

async function translationFixture(t, { prefix = 0, failAt, abortAt, checkpointFailure = false } = {}) {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'videorandom-eta-synthetic-'));
  t.after(() => fs.promises.rm(dataDir, { recursive: true, force: true }));
  const transcript = Array.from({ length: 480 }, (_, index) => ({ id: 'synthetic-' + index, start: index * 2, end: index * 2 + 1, text: '次の予定を確認します。' }));
  const record = { id: 'synthetic-eta', name: 'synthetic.mp4', hasAudio: true, transcriptLanguage: 'ja', transcriptSource: 'sidecar',
    transcript, frames: [], warnings: [], status: 'completed' };
  const directory = path.join(dataDir, 'checkpoints');
  await fs.promises.mkdir(directory, { recursive: true });
  if (prefix) {
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue => [cue.id, cue.start, cue.end, cue.text]))).digest('hex');
    await fs.promises.writeFile(path.join(directory, record.id + '-ko.json'), JSON.stringify({ version: 1, translationVersion: 6,
      targetLanguage: 'ko', subtitleQuality: 'accurate', reviewPasses: 2, language: 'ko', sourceFingerprint: fingerprint,
      totalCues: transcript.length, completedCues: prefix, complete: false, sourceComplete: true, translationComplete: false,
      subtitles: transcript.slice(0, prefix).map((cue, index) => ({ index, ...cue, text: '다음 일정을 확인합니다.' })), terms: [] }));
  }
  let at = 0, durable = prefix;
  const controller = new AbortController();
  const progress = [], requests = [];
  const spawnImpl = (binary, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.killed = false;
    child.kill = () => { if (!child.killed) { child.killed = true; queueMicrotask(() => child.emit('close', null)); } };
    const bytes = [];
    child.stdin.on('data', chunk => bytes.push(chunk));
    child.stdin.on('finish', () => queueMicrotask(async () => {
      try {
        if (args.includes('login')) child.stderr.write('Logged in using ChatGPT\n');
        else {
          const prompt = Buffer.concat(bytes).toString('utf8');
          const input = JSON.parse(prompt.slice(prompt.lastIndexOf('자료 JSON:\n') + '자료 JSON:\n'.length));
          const review = prompt.includes('새로운 원문 대조 검수 단계');
          const start = input.subtitles[0].index;
          requests.push({ review, start });
          at += 10000;
          if (review && start === failAt) throw Object.assign(new Error('Owned synthetic 503 service unavailable'), { exitCode: 1 });
          await fs.promises.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify({
            subtitles: input.subtitles.map(cue => ({ index: cue.index, text: '다음 일정을 확인합니다.' })), terms: [] }));
        }
        if (!child.killed) child.emit('close', 0);
      } catch (error) {
        if (error.exitCode) { child.stderr.write(error.message); child.emit('close', error.exitCode); }
        else child.emit('error', error);
      }
    }));
    return child;
  };
  const provider = createNoKeyProvider({ spawnImpl, now: () => at, platform: 'win32', statusCacheMs: 0,
    environment: { VIDEORANDOM_CODEX: 'owned-mock-codex' }, checkpointIO: { ...fs.promises,
      async rename(from, to) {
        const ownedRecord = to === path.join(directory, record.id + '-ko.json');
        const payload = ownedRecord ? JSON.parse(await fs.promises.readFile(from, 'utf8')) : undefined;
        if (ownedRecord && checkpointFailure && payload.completedCues > 0) throw new Error('Owned synthetic checkpoint write failure');
        await fs.promises.rename(from, to);
        if (ownedRecord) durable = payload.completedCues;
      } } });
  return { record, requests, progress, run: () => provider.translateKoreanOnly(record, { dataDir, subtitleQuality: 'accurate', signal: controller.signal,
    onProgress(stage, percent, details) {
      if (details?.phase === 'translation') assert(details.completedCues <= durable, 'only durable cues may advance progress');
      progress.push({ stage, percent, details: details && { ...details }, durable });
      if (abortAt !== undefined && details?.remainingSeconds > 0 && details.completedCues >= abortAt) controller.abort();
    } }) };
}

test('real provider pipeline exposes only durable translations and resumes without counting the cached prefix', async t => {
  const f = await translationFixture(t, { prefix: 160 });
  const result = await f.run();
  assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
  assert.ok(f.requests.every(call => call.start >= 160));
  const measured = f.progress.filter(event => event.details?.phase === 'translation');
  assert.equal(measured[0].details.completedCues, 160);
  assert.equal(measured[0].details.remainingSeconds, undefined);
  assert.ok(measured.some(event => event.details.completedCues === 320 && event.details.remainingSeconds > 0));
  assert.ok(measured.every(event => event.details.remainingSeconds === undefined || event.details.completedCues >= 320));
  assert.equal(f.progress.at(-1).stage, 'completed');
  assert.equal(f.progress.at(-1).details, undefined);
  assert.equal(result.subtitleTranslationPartial.length, 480);
});

test('an upstream failure clears an established ETA and preserves the approved prefix', async t => {
  const f = await translationFixture(t, { failAt: 240 });
  const result = await f.run();
  assert.equal(result.subtitleRepairStatus, 'failed');
  assert.ok(f.progress.some(event => event.details?.remainingSeconds > 0));
  assert.equal(f.progress.at(-1).details, undefined);
  assert.match(f.progress.at(-1).stage, /결과 보관/);
  assert.equal(result.subtitleTranslationPartial.length, 240);
});

test('a failed checkpoint never advances a translated draft into completed cue progress', async t => {
  const f = await translationFixture(t, { checkpointFailure: true });
  const result = await f.run();
  assert.equal(result.subtitleRepairStatus, 'failed');
  assert.ok(f.progress.every(event => !event.details || event.details.completedCues === 0));
  assert.equal(f.progress.at(-1).details, undefined);
});

test('cancellation clears an established ETA without starting a replacement translation', async t => {
  const f = await translationFixture(t, { abortAt: 160 });
  await assert.rejects(f.run(), error => error.name === 'AbortError');
  assert.ok(f.progress.some(event => event.details?.remainingSeconds > 0));
  assert.match(f.progress.at(-1).stage, /중지됨/);
  assert.equal(f.progress.at(-1).details, undefined);
  assert.equal(f.record.subtitleTranslationPartial.length, 160);
  assert.ok(f.requests.every(request => request.start <= 160), 'at most the already-started lookahead can exist');
});
