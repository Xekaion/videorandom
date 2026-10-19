const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createNoKeyProvider } = require('../lib/no-key-provider');
const { createDiagnosticsStore, classifyDiagnosticError, sanitizeDiagnosticEvent } = require('../lib/diagnostics');
const { catalogRecord } = require('../lib/catalog-record');

async function fixture(t, onReview, { deadline = 500, controller = new AbortController() } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-v199-execution-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const transcript = [{ id: 'owned-1', start: 1.25, end: 9.75, text: '合成の列車が到着します。安全のためにホームの内側で待ち、案内と出発時間を確認してください。' }];
  const record = { id: 'owned-execution', name: 'owned-synthetic-train.mp4', status: 'partial', hasAudio: true,
    summary: '합성 열차 안내', duration: 20, frames: [], warnings: [], transcript, transcriptLanguage: 'ja',
    transcriptSource: 'audio:faster-whisper large-v3', transcriptionQuality: { version: 1, recognitionRevision: 3,
      source: 'audio', profile: 'accurate', model: 'large-v3', language: 'ja', complete: true, processingComplete: true,
      duration: 20, processedUntil: 20, wordTimestamps: true,
      audit: { complete: true, unresolved: [], unresolvedCount: 0, speechSeconds: 8, uncoveredSpeechSeconds: 0 }, warnings: [] } };
  const calls = [], diagnostics = [];
  let active = 0;
  const provider = createNoKeyProvider({ providerTimeoutMs: deadline, environment: { VIDEORANDOM_CODEX: 'owned-fake-provider' },
    spawnImpl(binary, args) {
      assert.equal(binary, 'owned-fake-provider'); assert.equal(args[0], 'exec');
      const child = new EventEmitter(), chunks = [];
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      const call = { child, args }; calls.push(call); active++;
      let closed = false;
      const close = code => { if (!closed) { closed = true; active--; child.emit('close', code); } };
      child.kill = () => {
        // A final technical stderr line may arrive while the tool terminates.
        child.stderr.write('Reconnecting... 3/5 (unexpected status 503 Service Unavailable)\n');
        queueMicrotask(() => close(null));
      };
      child.stdin.on('data', bytes => chunks.push(bytes));
      child.stdin.on('finish', () => queueMicrotask(async () => {
        try {
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8').split('자료 JSON:\n').at(-1));
          call.review = Boolean(input.draftSubtitles);
          if (call.review) { await onReview({ child, close, controller }); return; }
          await fs.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify({
            subtitles: input.subtitles.map(cue => ({ index: cue.index, text: '합성 열차가 도착합니다. 안전을 위해 승강장 안쪽에서 기다리고 안내와 출발 시간을 확인하세요.' })), terms: [] }));
          close(0);
        } catch (error) { child.emit('error', error); close(1); }
      }));
      return child;
    } });
  return { record, calls, diagnostics, dataDir,
    run: () => provider.translateKoreanOnly(record, { dataDir, subtitleQuality: 'accurate', signal: controller.signal,
      onDiagnostic: event => diagnostics.push(event) }),
    drained: async () => {
      assert.equal(active, 0); assert.deepEqual(await fs.readdir(path.join(dataDir, 'tmp')), []);
      assert.equal(calls.length, 2, 'a failed request is never automatically retried or divided');
    } };
}

test('local request deadline preserves bounded reconnect evidence including final stderr without changing the timeout reason', async t => {
  const f = await fixture(t, ({ child }) => {
    child.stderr.write('PRIVATE_PROMPT token=PRIVATE_KEY https://private.invalid/503\n');
    child.stderr.write('Reconnecting... 2/5 (unexpected status 503 Service Unavailable)\n');
  });
  const result = await f.run();
  assert.equal(result.status, 'partial'); assert.deepEqual(result.transcript, f.record.transcript);
  const d = result.subtitleDiagnostic;
  assert.equal(d.code, 'PROVIDER_TIMEOUT'); assert.equal(d.executionSource, 'local-deadline');
  assert.equal(d.executionDeadlineMs, 500); assert(d.executionElapsedMs >= 450);
  assert.equal(d.providerReconnectAttempt, 3); assert.equal(d.providerReconnectLimit, 5);
  assert.equal(d.providerHttpStatus, 503); assert.equal(d.providerErrorType, 'unavailable');
  assert.equal(d.completedCues, 0); assert.equal(d.totalCues, 1); assert.equal(d.expectedCues, 1);
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /PRIVATE_|private\.invalid|https:|資料/);
  await f.drained();
});

for (const [message, status, code] of [['unexpected status 503 Service Unavailable', 503, 'PROVIDER_UNAVAILABLE'],
  ['authentication failed HTTP 401', 401, 'PROVIDER_AUTH'], ['quota exceeded HTTP 429', 429, 'PROVIDER_QUOTA'],
  ['request timed out', undefined, 'PROVIDER_TIMEOUT']]) {
  test(`a provider-reported ${code} remains separate from the local command deadline and is never reissued`, async t => {
    const f = await fixture(t, ({ child }) => child.stdout.write(JSON.stringify({ type: 'turn.failed',
      error: { message, ...(status ? { status } : {}) } }) + '\n'));
    const result = await f.run(), d = result.subtitleDiagnostic;
    assert.equal(d.code, code); assert.equal(d.executionSource, 'provider-error');
    if (status) assert.equal(d.providerHttpStatus, 503, 'the final observed stderr is retained separately from the authoritative error code');
    assert.equal(d.completedCues, 0); await f.drained();
  });
}

test('execution metadata survives safe diagnostics persistence and compact records without expanding the failure meaning', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-v199-diagnostic-store-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const input = { code: 'PROVIDER_TIMEOUT', executionSource: 'local-deadline', executionElapsedMs: 900028,
    executionDeadlineMs: 900000, providerHttpStatus: 503, providerReconnectAttempt: 2, providerReconnectLimit: 5,
    providerErrorType: 'unavailable', stage: 'translation_review', completedCues: 240, totalCues: 390,
    stderr: 'PRIVATE_OUTPUT', prompt: 'PRIVATE_PROMPT', connectionCode: 'PRIVATE_CODE' };
  assert.equal(classifyDiagnosticError(input).code, 'PROVIDER_TIMEOUT');
  const store = createDiagnosticsStore({ dataDir });
  await store.append({ ...input, level: 'error', event: 'error', videoName: 'owned-synthetic.mp4' });
  const saved = (await store.query()).events[0];
  for (const key of ['executionSource', 'executionElapsedMs', 'executionDeadlineMs', 'providerHttpStatus',
    'providerReconnectAttempt', 'providerReconnectLimit', 'providerErrorType']) assert.equal(saved[key], input[key]);
  const compact = catalogRecord({ id: 'owned', name: 'owned-synthetic.mp4', status: 'partial',
    transcript: [], frames: [], subtitleError: 'Synthetic timeout', subtitleDiagnostic: input });
  assert.deepEqual(compact.subtitleDiagnostic, sanitizeDiagnosticEvent(input));
  assert.match(compact.health.reason, /대기 제한 시간/);
  assert.doesNotMatch(JSON.stringify([saved, compact]), /PRIVATE_/);
});

test('a user cancellation keeps its original meaning and never submits another review', async t => {
  const f = await fixture(t, ({ controller }) => controller.abort());
  await assert.rejects(f.run(), error => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.record.subtitleDiagnostic.code, 'ANALYSIS_CANCELLED');
    assert.equal(error.record.subtitleDiagnostic.executionSource, 'cancelled');
    return true;
  });
  await f.drained();
});
