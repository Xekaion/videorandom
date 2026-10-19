const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createNoKeyProvider } = require('../lib/no-key-provider');
const { isVerifiedFullTranscription, isProcessedTranscription } = require('../lib/subtitle-quality');

const source = '合成の列車が到着します。安全のためにホームの内側で待ち、出発時間を確認してください。';
const korean = '합성 열차가 도착합니다. 안전을 위해 승강장 안쪽에서 기다리고 출발 시간을 확인하세요.';

async function fixture(t, { override = {}, speechQuality = {}, handler } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-turbo-provider-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const audioPath = path.join(dataDir, 'owned.flac');
  await fs.writeFile(audioPath, 'Owned synthetic placeholder: never decode or send to a real model.');
  const calls = [], progress = [];
  const spawnImpl = (binary, args) => {
    assert(['owned-python', 'owned-codex'].includes(binary), 'never invoke actual providers or speech models');
    const child = new EventEmitter(), chunks = [];
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    let closed = false;
    const close = code => { if (!closed) { closed = true; child.emit('close', code); } };
    child.kill = () => { queueMicrotask(() => close(null)); };
    child.stdin.on('data', bytes => chunks.push(bytes));
    child.stdin.on('finish', () => queueMicrotask(async () => {
      try {
        const call = { binary, args, prompt: Buffer.concat(chunks).toString('utf8') };
        calls.push(call);
        if (args.includes('login')) child.stderr.write('Logged in using ChatGPT');
        else if (args.includes('import faster_whisper; print("ready")')) child.stdout.write('ready');
        else if (args.includes('--audio')) {
          const events = [
            { type: 'info', profile: 'turbo', model: 'turbo', duration: 120, language: 'ja', device: 'cuda', computeType: 'int8_float16', workers: 1, batchSize: 4 },
            { type: 'segment', id: 'owned-0', start: 3.25, end: 8.75, text: source },
            { type: 'progress', phase: 'transcription', completedSeconds: 90, totalSeconds: 120, percent: 75, workers: 1, batchSize: 1 },
            { type: 'complete', segments: 1, quality: { profile: 'turbo', model: 'turbo', durationSeconds: 120,
              processedSeconds: 120, processingComplete: true, wordTimestamps: false, recognitionRevision: 3,
              device: 'cuda', computeType: 'int8_float16', workers: 1, batchSize: 1, audit: { complete: false, unresolved: [] }, ...speechQuality } }
          ];
          child.stdout.write(events.map(event => JSON.stringify(event)).join('\n') + '\n');
        } else if (args[0] === 'exec') {
          call.input = JSON.parse(call.prompt.split('자료 JSON:\n').at(-1));
          const response = handler ? await handler(call) : { subtitles: call.input.subtitles.map(cue => ({ index: cue.index, text: korean })), terms: [] };
          await fs.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(response));
        } else throw new Error('This fixture permits only synthetic ASR and translation operations.');
        close(0);
      } catch (error) { if (!closed) { child.stderr.write(error.message); close(1); } }
    }));
    return child;
  };
  const provider = createNoKeyProvider({ spawnImpl, platform: 'win32', environment: {
    VIDEORANDOM_PYTHON: 'owned-python', VIDEORANDOM_CODEX: 'owned-codex', ...override } });
  return { provider, dataDir, audioPath, calls, progress };
}

test('turbo speech bridge selects the turbo model and preserves actual batch fallback without claiming an independent audit', async t => {
  const f = await fixture(t);
  const result = await f.provider.transcribeLocalAudio(f.audioPath, { dataDir: f.dataDir, subtitleQuality: 'turbo',
    onProgress: (stage, percent, details) => f.progress.push({ stage, percent, details }) });
  assert.equal(f.calls.length, 1);
  const args = f.calls[0].args;
  assert.equal(args[args.indexOf('--model') + 1], 'turbo');
  assert.equal(args[args.indexOf('--profile') + 1], 'turbo');
  assert.equal(result.quality.profile, 'turbo'); assert.equal(result.quality.processingComplete, true);
  assert.equal(result.quality.complete, true); assert.equal(result.quality.audit.complete, false);
  assert.equal(result.quality.wordTimestamps, false); assert.equal(result.quality.batchSize, 1);
  assert(f.progress.some(event => event.details?.batchSize === 4));
  assert(f.progress.some(event => event.details?.batchSize === 1));
  assert(result.warnings.some(warning => warning.includes('초고속') && warning.includes('추가 검수')));
  const record = { transcript: result.segments, transcriptSource: 'audio:faster-whisper turbo', duration: 120, transcriptionQuality: result.quality };
  assert.equal(isVerifiedFullTranscription(record, 'accurate'), false);
  assert.equal(isVerifiedFullTranscription(record, 'turbo'), false);
  assert.equal(isProcessedTranscription(record, 'turbo'), true);
});

test('an explicit speech model override remains effective for the opt-in turbo profile', async t => {
  const f = await fixture(t, { override: { VIDEORANDOM_WHISPER_MODEL: 'owned-explicit-model' } });
  await f.provider.transcribeLocalAudio(f.audioPath, { dataDir: f.dataDir, subtitleQuality: 'turbo' });
  const args = f.calls[0].args;
  assert.equal(args[args.indexOf('--model') + 1], 'owned-explicit-model');
});

test('explicit turbo analysis recognizes the whole supplied audio even when an old sidecar transcript exists', async t => {
  const f = await fixture(t, { handler: call => call.input.subtitles
    ? { subtitles: call.input.subtitles.map(cue => ({ index: cue.index, text: korean })), terms: [] }
    : { summary: '합성 열차 안내입니다.', plot: '열차의 출발 안내를 확인합니다.', dialogueSummary: '안전 안내',
      labels: ['합성'], frames: [], limitations: [] } });
  const original = [{ id: 'old-sidecar', start: 0.5, end: 1.5, text: 'これは古い字幕です。' }];
  const record = { id: 'owned-turbo-recognition', duration: 120, hasAudio: true, frames: [], warnings: [],
    transcriptLanguage: 'ja', transcriptSource: 'sidecar:owned.srt', transcript: original };
  const result = await f.provider.analyzeExtracted(record, { dataDir: f.dataDir, audioPath: f.audioPath,
    subtitleQuality: 'turbo', subtitleLanguage: 'ko', transcribeAudio: false });
  assert.equal(f.calls.filter(call => call.args.includes('--audio')).length, 1, 'the opt-in mode actually invokes its full-input worker');
  assert.equal(result.transcript[0].text, source);
  assert.equal(original[0].id, 'old-sidecar', 'the caller-owned previous source array is not mutated');
  assert.equal(result.transcriptionQuality.profile, 'turbo');
  assert.equal(result.subtitleTranslationProgress.translationComplete, true);
  assert.equal(result.subtitleTranslationProgress.sourceAuditComplete, false);
  assert.equal(f.calls.filter(call => call.args[0] === 'exec' && call.input.subtitles).length, 1);
});

for (const speechQuality of [{ processedSeconds: 60 }, { processingComplete: false }, { processingComplete: undefined }]) {
  test(`turbo completion requires explicit whole-input proof: ${JSON.stringify(speechQuality)}`, async t => {
    const f = await fixture(t, { speechQuality });
    const result = await f.provider.transcribeLocalAudio(f.audioPath, { dataDir: f.dataDir, subtitleQuality: 'turbo' });
    assert.equal(result.quality.complete, false); assert.equal(result.quality.processingComplete, false);
  });
}

test('turbo speech never silently accepts a different worker profile', async t => {
  const f = await fixture(t, { speechQuality: { profile: 'fast' } });
  await assert.rejects(f.provider.transcribeLocalAudio(f.audioPath, { dataDir: f.dataDir, subtitleQuality: 'turbo' }), /실제 처리 모드/);
  assert.equal(f.calls.length, 1);
});

test('turbo Korean translation uses one strict pass and reuses only its exact profile cache', async t => {
  const f = await fixture(t);
  const record = { id: 'owned-turbo-translation', duration: 120, hasAudio: true, frames: [], warnings: [], summary: '합성 안내',
    transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper turbo',
    transcript: [{ id: 'owned-0', start: 3.25, end: 8.75, text: source }],
    transcriptionQuality: { version: 1, source: 'audio', profile: 'turbo', model: 'turbo', duration: 120, processedUntil: 120,
      processingComplete: true, complete: true, recognitionRevision: 3, audit: { complete: false, unresolved: [] } } };
  const options = { dataDir: f.dataDir, subtitleQuality: 'turbo' };
  const result = await f.provider.translateKoreanOnly(record, options);
  assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].input.draftSubtitles, undefined);
  assert.equal(result.subtitleTranslationProgress.sourceAuditComplete, false);
  assert.equal(result.subtitleTranslationProgress.translationComplete, true);
  assert.deepEqual(result.subtitleTranslation.map(cue => [cue.id, cue.start, cue.end]), [['owned-0', 3.25, 8.75]]);
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints', record.id + '-ko.json'), 'utf8'));
  assert.equal(saved.subtitleQuality, 'turbo'); assert.equal(saved.reviewPasses, 1);
  await f.provider.translateKoreanOnly(record, options);
  assert.equal(f.calls.length, 1, 'a verified exact turbo cache avoids another service request');
});
