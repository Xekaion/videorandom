const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createNoKeyProvider } = require('../lib/no-key-provider');
const { createDiagnosticsStore } = require('../lib/diagnostics');
const { catalogRecord } = require('../lib/catalog-record');

async function fixture(t, behavior, { deadline = 900000, now } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-provider-retention-v1927-'));
  t.after(async () => {
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert(path.basename(dataDir).startsWith('videorandom-provider-retention-v1927-'));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const controller = new AbortController(), calls = [], events = [];
  const record = { id: 'owned-synthetic-retention', path: 'synthetic-office.mp4', name: 'synthetic-office.mp4', status: 'partial', duration: 10,
    hasAudio: true, summary: '합성 열차 안내', frames: [], warnings: [], transcriptLanguage: 'ja', transcriptSource: 'embedded-subtitle',
    transcript: [{ id: 'owned-cue-1', start: 0.25, end: 5.5, text: '次の列車は午前九時に出発します。駅の案内を確認してください。' }] };
  let active = 0;
  const provider = createNoKeyProvider({ providerTimeoutMs: deadline, ...(now ? { now } : {}), platform: 'win32',
    environment: { VIDEORANDOM_CODEX: 'owned-synthetic-cli', OPENAI_API_KEY: 'SYNTHETIC_SECRET_API_KEY' },
    spawnImpl(binary, args, settings) {
      assert.equal(binary, 'owned-synthetic-cli'); assert.equal(args[0], 'exec');
      assert.equal(settings.shell, false); assert.equal(settings.windowsHide, true);
      assert.equal(settings.env.OPENAI_API_KEY, undefined);
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.stdin.resume(); active++;
      let closed = false;
      const close = code => { if (closed) return; closed = true; active--; child.emit('close', code); };
      child.kill = () => queueMicrotask(() => close(null));
      calls.push({ args, settings });
      child.stdin.on('finish', () => queueMicrotask(() => {
        try { behavior({ child, controller, close }); } catch (error) { child.emit('error', error); close(1); }
      }));
      return child;
    } });
  return { dataDir, record, controller, calls, events,
    run: () => provider.translateKoreanOnly(record, { dataDir, subtitleQuality: 'fast', signal: controller.signal,
      onDiagnostic: event => events.push(event) }),
    async verify(result, code, expected = {}) {
      const diagnostic = result.subtitleDiagnostic;
      assert.equal(diagnostic.code, code);
      for (const [key, value] of Object.entries(expected)) assert.equal(diagnostic[key], value, key);
      const emitted = events.filter(event => event.event === 'error');
      assert(emitted.some(event => event.code === code));
      assert.equal(calls.length, 1, 'failure never changes model, retries, divides the request, or launches review');
      assert.equal(active, 0);
      assert.deepEqual(result.transcript, record.transcript);
      const store = createDiagnosticsStore({ dataDir });
      for (const event of emitted) await store.append({ ...event, videoName: 'synthetic-office.mp4' });
      const savedEvent = (await store.query()).events.find(event => event.code === code);
      assert(savedEvent);
      const saved = catalogRecord(result);
      await fs.writeFile(path.join(dataDir, 'synthetic-saved-record.json'), JSON.stringify(saved));
      const reopened = JSON.parse(await fs.readFile(path.join(dataDir, 'synthetic-saved-record.json'), 'utf8'));
      assert.equal(reopened.subtitleDiagnostic.code, code);
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(savedEvent[key], value, 'stored event ' + key);
        assert.equal(reopened.subtitleDiagnostic[key], value, 'saved subtitle diagnostic ' + key);
      }
      assert.doesNotMatch(JSON.stringify([savedEvent, reopened.subtitleDiagnostic, events]), /SYNTHETIC_SECRET|PRIVATE_PROMPT|private\.invalid/);
    }
  };
}

test('an unclassified machine provider failure retains PROVIDER_UNKNOWN and its 771-second execution evidence without inventing a cause', async t => {
  let elapsed = 1000;
  const f = await fixture(t, ({ child }) => {
    elapsed += 771235;
    child.stderr.write('PRIVATE_PROMPT token=SYNTHETIC_SECRET https://private.invalid/hidden\n');
    child.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'Synthetic generic provider error' } }) + '\n');
  }, { now: () => elapsed });
  const result = await f.run();
  assert.equal(result.status, 'partial');
  await f.verify(result, 'PROVIDER_UNKNOWN', { executionSource: 'provider-error', executionElapsedMs: 771235,
    executionDeadlineMs: 180000, providerRequestedModel: 'gpt-6-luna', providerReasoningEffort: 'low', providerServiceTier: 'standard' });
  assert.equal(result.subtitleDiagnostic.causeCode, undefined);
  assert.equal(result.subtitleDiagnostic.providerErrorType, undefined);
  assert.equal(result.subtitleDiagnostic.httpStatus, undefined);
});

for (const [status, code] of [[418, 'PROVIDER_UNKNOWN'], [502, 'PROVIDER_UNAVAILABLE'], [401, 'PROVIDER_AUTH'], [429, 'PROVIDER_QUOTA']]) {
  test(`typed machine HTTP ${status} retains ${code} through emitted and saved subtitle diagnostics without a second request`, async t => {
    const f = await fixture(t, ({ child }) => child.stdout.write(JSON.stringify({ type: 'turn.failed',
      error: { message: 'Synthetic generic machine failure', status } }) + '\n'));
    await f.verify(await f.run(), code, { executionSource: 'provider-error', httpStatus: status, providerHttpStatus: status });
  });
}

test('a local deadline remains PROVIDER_TIMEOUT with its execution source and is not resubmitted', async t => {
  const f = await fixture(t, () => {}, { deadline: 25 });
  const result = await f.run();
  await f.verify(result, 'PROVIDER_TIMEOUT', { executionSource: 'local-deadline', executionDeadlineMs: 25 });
  assert(result.subtitleDiagnostic.executionElapsedMs >= 20);
});

test('a typed immediate authentication cause cannot be downgraded to subtitle validation', async t => {
  const f = await fixture(t, ({ child, close }) => {
    const failure = Object.assign(new Error('한국어 자막 번역의 대사 수가 원문과 일치하지 않습니다.'), {
      code: 'SUBTITLE_CUE_COUNT_MISMATCH', cause: { code: 'PROVIDER_AUTH', statusCode: 403, message: 'PRIVATE_PROMPT' }
    });
    child.emit('error', failure); close(1);
  });
  await f.verify(await f.run(), 'PROVIDER_AUTH', { executionSource: 'process-error', httpStatus: 403, causeCode: 'PROVIDER_AUTH' });
});

test('a typed process statusCode is retained even when the message is generic', async t => {
  const f = await fixture(t, ({ child, close }) => {
    child.emit('error', Object.assign(new Error('Synthetic process error'), { statusCode: 503 })); close(1);
  });
  await f.verify(await f.run(), 'PROVIDER_UNAVAILABLE', { executionSource: 'process-error', httpStatus: 503 });
});

test('a service refusal remains stopped and its execution source survives persistence', async t => {
  const f = await fixture(t, ({ child }) => child.stdout.write(JSON.stringify({ type: 'turn.failed',
    error: { message: 'Request refused' } }) + '\n'));
  await f.verify(await f.run(), 'PROVIDER_REFUSAL', { executionSource: 'provider-error', providerErrorType: 'refusal', refusalSource: 'execution-error' });
});

test('user cancellation remains an AbortError and cannot become a provider unknown or be retried', async t => {
  const f = await fixture(t, ({ controller }) => controller.abort());
  let cancelled;
  await assert.rejects(f.run(), error => {
    assert.equal(error.name, 'AbortError');
    cancelled = error;
    return true;
  });
  await f.verify(cancelled.record, 'ANALYSIS_CANCELLED', { executionSource: 'cancelled' });
});
