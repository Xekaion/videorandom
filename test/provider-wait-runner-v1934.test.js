const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const { createNoKeyProvider } = require('../lib/no-key-provider');
const { createProviderCapacityRecovery } = require('../lib/provider-capacity-recovery');
const { classifyQueueRecord } = require('../lib/queue-outcome');

async function fixture(t, behavior, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-owned-wait-v1934-'));
  const transcript = Array.from({ length: options.count || 1 }, (_, index) => ({ id: `cue-${index}`, start: index * 3,
    end: index * 3 + 2, text: '列車の到着時刻と乗り場を確認してください。' }));
  const record = { id: 'owned-wait', name: 'owned-neutral-train.mp4', duration: transcript.length * 3,
    status: 'partial', hasAudio: true, summary: '합성 열차 안내', frames: [], warnings: [], transcript,
    transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3',
    transcriptionQuality: { version: 1, recognitionRevision: 3, source: 'audio', profile: 'accurate', model: 'large-v3', language: 'ja',
      complete: true, processingComplete: true, duration: transcript.length * 3, processedUntil: transcript.length * 3,
      wordTimestamps: true, audit: { complete: true, unresolved: [], unresolvedCount: 0 }, warnings: [] } };
  const calls = [], progress = [], diagnostics = [], children = [];
  const provider = createNoKeyProvider({ providerStopGraceMs: 10, ...(options.provider || {}),
    environment: { VIDEORANDOM_CODEX: 'owned-synthetic-provider' },
    spawnImpl(binary, args, spawnOptions) {
      assert.equal(binary, 'owned-synthetic-provider');
      if (options.realChild) {
        // An owned inert Node process emits only protocol metadata and waits.
        // No model, service, media, prompt interpreter or provider is invoked.
        const child = spawn(process.execPath, ['-e', "process.stdin.resume(); process.stdout.write(JSON.stringify({type:'thread.started'})+'\\n'+JSON.stringify({type:'turn.started'})+'\\n'); setInterval(()=>{},1000);"], spawnOptions);
        calls.push({ child, args, close: () => { if (child.exitCode === null && child.signalCode === null) child.kill(); } });
        return child;
      }
      const child = new EventEmitter(); children.push(child);
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      let closed = false;
      const close = code => { if (!closed) { closed = true; child.emit('close', code); } };
      const call = { child, args, close, kills: [] }; calls.push(call);
      child.kill = signal => { call.kills.push(signal || 'SIGTERM'); if (call.onKill) call.onKill(signal); else queueMicrotask(() => close(null)); return true; };
      const chunks = [];
      child.stdin.on('data', bytes => chunks.push(bytes));
      child.stdin.on('finish', () => queueMicrotask(async () => {
        try {
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8').split('자료 JSON:\n').at(-1));
          call.input = input;
          call.respond = async () => {
            const answer = input.draftSubtitles ? { approvedIndexes: input.subtitles.map(cue => cue.index), corrections: [], terms: [] }
              : { subtitles: input.subtitles.map(cue => ({ index: cue.index, text: '열차 도착 시간과 승강장을 확인해 주세요.' })), terms: [] };
            await fs.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(answer));
            close(0);
          };
          child.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'PRIVATE_PROVIDER_ID' }) + '\n');
          child.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\n');
          await behavior(call, calls.length);
        } catch (error) { child.emit('error', error); close(1); }
      }));
      return child;
    } });
  t.after(async () => { for (const c of calls) c.close(1); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { provider, record, dataDir, calls, progress, diagnostics,
    run: (input = record) => provider.translateKoreanOnly(input, { dataDir, subtitleQuality: 'accurate',
      onProgress: (stage, percent, details) => progress.push({ stage, percent, details }), onDiagnostic: event => diagnostics.push(event) }) };
}

test('live request metadata uses the three-minute translation budget and only observed content-free activity', async t => {
  const f = await fixture(t, async call => {
    call.child.stdout.write(JSON.stringify({ type: 'item.started', item: { type: 'agent_message', text: 'PRIVATE_RESPONSE' } }) + '\n');
    await call.respond();
  });
  const result = await f.run();
  assert.equal(result.subtitleTranslationProgress.complete, true);
  const details = f.progress.map(p => p.details).filter(Boolean);
  assert(details.some(d => d.requestActivity === 'request_started' && d.requestDeadlineSeconds > 179 && d.requestDeadlineSeconds <= 180));
  assert(details.some(d => d.requestActivity === 'output_activity'));
  assert(details.some(d => d.requestAttempt === 1 && Number.isFinite(d.requestAttemptElapsedSeconds)));
  assert(f.diagnostics.some(d => d.code === 'PROVIDER_ACTIVITY' && d.providerActivity === 'turn-started'));
  assert.doesNotMatch(JSON.stringify([f.progress, f.diagnostics]), /PRIVATE_RESPONSE|PRIVATE_PROVIDER_ID|thread_id/);
});

test('a stopped slow second draft preserves the reviewed checkpoint and releases the next independent video', async t => {
  const f = await fixture(t, async (call, number) => { if (number < 3) await call.respond(); },
    { count: 81, provider: { translationRequestTimeoutMs: 80 } });
  const result = await f.run();
  assert.equal(f.calls.length, 3, 'a timed-out request is not replayed');
  assert.equal(result.subtitleTranslationProgress.completedCues, 80);
  assert.equal(result.subtitleTranslationProgress.complete, false);
  assert.equal(result.subtitleTranslationPartial.length, 80);
  assert.equal(result.subtitleDiagnostic.code, 'PROVIDER_REQUEST_DEADLINE');
  assert.equal(result.subtitleDiagnostic.providerProcessStopped, true);
  assert.equal(result.subtitleDiagnostic.providerDeadlineScope, 'translation-request');
  assert.equal(classifyQueueRecord(result, { catalogSaved: true }).canContinue, true);
  assert.deepEqual(result.transcript, f.record.transcript);
  const checkpoint = JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints', 'owned-wait-ko.json'), 'utf8'));
  assert.equal(checkpoint.completedCues, 80);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'tmp')), []);
});

test('a child with confirmed exit and missing close drains within a bounded grace', async t => {
  const f = await fixture(t, call => { call.onKill = () => call.child.emit('exit', null); },
    { provider: { translationRequestTimeoutMs: 25 } });
  const result = await f.run();
  assert.equal(result.subtitleDiagnostic.code, 'PROVIDER_REQUEST_DEADLINE');
  assert.equal(result.subtitleDiagnostic.providerProcessStopped, true);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].kills, ['SIGTERM']);
});

test('an actual owned inert child exits before deadline continuation is granted', async t => {
  const f = await fixture(t, () => {}, { realChild: true, provider: { translationRequestTimeoutMs: 250, providerStopGraceMs: 100 } });
  const result = await f.run();
  assert.equal(result.subtitleDiagnostic.code, 'PROVIDER_REQUEST_DEADLINE');
  assert.equal(result.subtitleDiagnostic.providerProcessStopped, true);
  assert.equal(f.calls.length, 1);
  assert.throws(() => process.kill(f.calls[0].child.pid, 0), error => error.code === 'ESRCH');
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'tmp')), []);
});

test('unconfirmed termination returns a blocking outcome and prevents any new provider child until exit', async t => {
  let allowResponse = false;
  const f = await fixture(t, async call => { if (allowResponse) await call.respond(); else call.onKill = () => {}; }, { provider: { translationRequestTimeoutMs: 80 } });
  const result = await f.run();
  assert.equal(result.subtitleDiagnostic.code, 'PROVIDER_TIMEOUT');
  assert.equal(result.subtitleDiagnostic.providerProcessStopped, false);
  assert.equal(classifyQueueRecord(result, { catalogSaved: true }).canContinue, false);
  assert.deepEqual(f.calls[0].kills, ['SIGTERM', 'SIGKILL']);
  const second = await f.run();
  assert.equal(second.subtitleDiagnostic.code, 'ANALYSIS_BUSY');
  assert.equal(f.calls.length, 1);
  f.calls[0].close(null);
  allowResponse = true;
  const resumed = await f.run();
  assert.equal(resumed.subtitleTranslationProgress.complete, true);
  assert.equal(f.calls.length, 3, 'only a confirmed close permits a new draft and its review');
});

test('a synchronous signal-delivery error cannot finish a live child or reopen admission before termination', async t => {
  let killing;
  const gate = new Promise(resolve => { killing = resolve; });
  const f = await fixture(t, call => { call.onKill = () => {
    call.child.emit('error', Object.assign(new Error('owned signal failed'), { code: 'EPERM' }));
    killing();
  }; }, { provider: { translationRequestTimeoutMs: 25 } });
  const running = f.run();
  await gate;
  const blocked = await f.run({ ...structuredClone(f.record), id: 'owned-independent-blocked' });
  assert.equal(blocked.subtitleDiagnostic.code, 'ANALYSIS_BUSY');
  assert.equal(f.calls.length, 1);
  const result = await running;
  assert.equal(result.subtitleDiagnostic.providerProcessStopped, false);
  assert.equal(classifyQueueRecord(result, { catalogSaved: true }).canContinue, false);
  assert.deepEqual(f.calls[0].kills, ['SIGTERM', 'SIGKILL']);
  f.calls[0].close(null);
});

for (const [line, code] of [['authentication failed', 'PROVIDER_AUTH'], ['quota exceeded', 'PROVIDER_QUOTA'],
  ['Request refused', 'PROVIDER_REFUSAL'], ['ECONNRESET', 'NETWORK_UNREACHABLE'], ['unexpected status 503 Service Unavailable', 'PROVIDER_UNAVAILABLE']]) {
  test(`final technical ${code} evidence prevents deadline continuation`, async t => {
    const f = await fixture(t, call => { call.onKill = () => { call.child.stderr.write(line + '\n'); queueMicrotask(() => call.close(null)); }; },
      { provider: { translationRequestTimeoutMs: 25 } });
    const result = await f.run();
    assert.equal(result.subtitleDiagnostic.code, code);
    assert.equal(classifyQueueRecord(result, { catalogSaved: true }).canContinue, false);
    assert.equal(f.calls.length, 1);
  });
}

test('a final unclassified machine error cannot be hidden by the application deadline', async t => {
  const f = await fixture(t, call => { call.onKill = () => {
    call.child.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'Owned synthetic unknown service error' } }));
    queueMicrotask(() => call.close(null));
  }; }, { provider: { translationRequestTimeoutMs: 25 } });
  const result = await f.run();
  assert.equal(result.subtitleDiagnostic.code, 'PROVIDER_UNKNOWN');
  assert.equal(classifyQueueRecord(result, { catalogSaved: true }).canContinue, false);
  assert.equal(f.calls.length, 1);
});

test('capacity retries share the logical request budget and never shorten server backoff', async () => {
  let at = 1000, calls = 0;
  const waits = [], remaining = [];
  const capacity = () => Object.assign(new Error('capacity'), { code: 'PROVIDER_CAPACITY', executionSource: 'provider-error', providerErrorType: 'capacity' });
  const recovery = createProviderCapacityRecovery({ now: () => at, random: () => 0,
    wait: async ms => { waits.push(ms); at += ms; } });
  await assert.rejects(recovery.run(async ({ remainingMs }) => { remaining.push(remainingMs); calls++; at += 20000; throw capacity(); },
    { maxRequestElapsedMs: 80000 }), error => error.code === 'PROVIDER_CAPACITY' && error.providerCapacityStopReason === 'deadline');
  assert.equal(calls, 2); assert.deepEqual(waits, [30000]); assert.deepEqual(remaining, [80000, 30000]);
});

test('an overslept capacity cooldown cannot start a child after the logical request deadline', async () => {
  let at = 1000, calls = 0;
  const recovery = createProviderCapacityRecovery({ now: () => at, random: () => 0, wait: async () => { at += 90000; } });
  await assert.rejects(recovery.run(async () => { calls++; throw Object.assign(new Error('capacity'), {
    code: 'PROVIDER_CAPACITY', executionSource: 'provider-error', providerErrorType: 'capacity' }); },
  { maxRequestElapsedMs: 80000 }), error => error.code === 'PROVIDER_CAPACITY' && error.providerCapacityStopReason === 'deadline');
  assert.equal(calls, 1);
});
