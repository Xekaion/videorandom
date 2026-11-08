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
  const calls = [], progress = [], diagnostics = [], checkpoints = [];
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
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      const close = code => { if (!call.closed) { call.closed = true; child.emit('close', code); } };
      const call = { child, args, close, closed: false, kills: [] }; calls.push(call);
      child.kill = signal => { call.kills.push(signal || 'SIGTERM'); if (call.onKill) call.onKill(signal); else queueMicrotask(() => close(null)); return true; };
      const chunks = [];
      child.stdin.on('data', bytes => chunks.push(bytes));
      child.stdin.on('finish', () => queueMicrotask(async () => {
        try {
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8').split('자료 JSON:\n').at(-1));
          call.input = input;
          call.indexes = input.subtitles.map(cue => cue.index);
          call.start = call.indexes[0]; call.count = call.indexes.length;
          call.review = Boolean(input.draftSubtitles);
          call.respond = async (change = answer => answer) => {
            const answer = input.draftSubtitles ? { approvedIndexes: input.subtitles.map(cue => cue.index), corrections: [], terms: [] }
              : { subtitles: input.subtitles.map(cue => ({ index: cue.index, text: '열차 도착 시간과 승강장을 확인해 주세요.' })), terms: [] };
            await fs.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(change(answer)));
            close(0);
          };
          child.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'PRIVATE_PROVIDER_ID' }) + '\n');
          child.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\n');
          await behavior(call, calls.length);
        } catch (error) { child.emit('error', error); close(1); }
      }));
      return child;
    } });
  t.after(async () => {
    for (const c of calls) c.close(1);
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.match(path.basename(dataDir), /^videorandom-owned-wait-v1934-/);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { provider, record, dataDir, calls, progress, diagnostics, checkpoints,
    run: (input = record) => provider.translateKoreanOnly(input, { dataDir, subtitleQuality: options.profile || 'accurate',
      onProgress: (stage, percent, details) => progress.push({ stage, percent, details }), onDiagnostic: event => diagnostics.push(event),
      onCheckpoint: value => checkpoints.push(structuredClone(value.subtitleTranslationProgress || {})) }) };
}

const cueRange = (start, end) => Array.from({ length: end - start }, (_, i) => start + i);
function assertCueIdentity(result, source, indexes) {
  const actual = result.subtitleTranslation || result.subtitleTranslationPartial || [];
  assert.equal(result.subtitleTranslationProgress.completedCues, indexes.length);
  assert.deepEqual(actual.map(({ id, start, end }) => [id, start, end]), indexes.map(index => {
    const { id, start, end } = source[index];
    return [id, start, end];
  }));
}

function assertTraversedGap(result, source, indexes) {
  assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
  assert.equal(result.subtitleTranslationProgress.complete, false);
  assert.equal(result.subtitleTranslationProgress.processingComplete, true);
  assert.equal(result.subtitleTranslationProgress.processedCues, source.length);
  assert.equal(classifyQueueRecord(result, { catalogSaved: true }).canContinue, true);
  assertCueIdentity(result, source, indexes);
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
  assertTraversedGap(result, f.record.transcript, cueRange(0, 80));
  assert.deepEqual(result.transcript, f.record.transcript);
  const checkpoint = JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints', 'owned-wait-ko.json'), 'utf8'));
  assert.equal(checkpoint.completedCues, 80);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'tmp')), []);
});

for (const reviewTimeout of [false, true]) test(`an owned ${reviewTimeout ? 'review' : 'draft'} deadline recovers a smaller batch and verifies the later source`, async t => {
  const f = await fixture(t, async call => {
    if (call.review === reviewTimeout && call.start === 0 && call.count === 80) return;
    await call.respond();
  }, { count: 101, provider: { translationRequestTimeoutMs: 170 } });
  const source = structuredClone(f.record.transcript);
  const result = await f.run();
  const timedStage = f.calls.filter(call => call.review === reviewTimeout && call.start < 80);
  const [original, ...recovered] = timedStage;
  assert.deepEqual(original.indexes, cueRange(0, 80));
  assert.deepEqual(original.kills, ['SIGTERM']);
  assert(original.closed);
  assert(recovered.every(call => call.count <= 20 && call.kills.length === 0), 'only smaller requests may recover the deadline');
  assert.deepEqual(recovered.flatMap(call => call.indexes), cueRange(0, 80));
  assert(f.calls.some(call => call.review && call.indexes.includes(100)), 'the final source cue was explicitly reviewed');
  assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
  assert.equal(result.subtitleTranslationProgress.complete, true);
  assertCueIdentity(result, source, cueRange(0, source.length));
  assert.deepEqual(result.transcript, source);
  assert(f.calls.every(call => call.closed));
});

test('a timed-out targeted draft correction keeps valid rows and resumes only remaining gaps after bounded late attempts', async t => {
  let recoveringFromSavedGap = false;
  const f = await fixture(t, async call => {
    if (recoveringFromSavedGap) await call.respond();
    else if (!call.review && call.start === 0 && call.count === 80) {
      await call.respond(answer => ({ ...answer, subtitles: answer.subtitles.filter(cue => cue.index < 10 || cue.index >= 30) }));
    } else if (!call.review && ((call.start === 10 && call.count === 20) || (call.start === 20 && [10, 8].includes(call.count))
        || (call.start === 28 && call.count === 2))) {
      return;
    } else await call.respond();
  }, { count: 101, provider: { translationRequestTimeoutMs: 170 } });
  const source = structuredClone(f.record.transcript);
  const result = await f.run();
  const firstDrafts = f.calls.filter(call => !call.review && call.start < 80);
  assert.deepEqual(firstDrafts.map(call => [call.start, call.count, call.kills.length]),
    [[0, 80, 0], [10, 20, 1], [10, 10, 0], [20, 10, 1], [20, 8, 1], [28, 2, 1]]);
  assert(f.calls.indexOf(f.calls.find(call => call.review && call.indexes.includes(100))) < f.calls.indexOf(firstDrafts.at(-2)),
    'independent healthy tail is reviewed before the bounded late attempts');
  const accepted = [...cueRange(0, 20), ...cueRange(30, 101)];
  assertTraversedGap(result, source, accepted);
  const deadlines = f.diagnostics.filter(event => event.code === 'SUBTITLE_BATCH_DEADLINE');
  assert.deepEqual(deadlines.map(event => [event.startCue, event.endCue, event.expectedCues, event.event, event.level,
    event.providerDeadlineScope, event.providerProcessStopped]), [
    [11, 30, 20, 'stage', 'warning', 'translation-request', true],
    [21, 30, 10, 'stage', 'warning', 'translation-request', true],
    [21, 28, 8, 'stage', 'warning', 'translation-request', true],
    [29, 30, 2, 'stage', 'warning', 'translation-request', true]
  ]);
  assert.doesNotMatch(JSON.stringify(deadlines), /PRIVATE_PROVIDER_ID|列車|열차|"text"|thread_id/);
  assert.deepEqual(f.calls.filter(call => call.review).flatMap(call => call.indexes), accepted, 'provisional drafts are never committed without their review');
  const checkpoint = JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints', 'owned-wait-ko.json'), 'utf8'));
  assert.deepEqual(checkpoint.cueIndexes, accepted);
  assert.deepEqual(checkpoint.subtitles.map(cue => cue.id), accepted.map(index => source[index].id));
  assert(f.calls.every(call => call.closed));
  const firstAttemptCount = f.calls.length;
  recoveringFromSavedGap = true;
  const resumed = await f.run();
  assert.equal(resumed.subtitleTranslationProgress.complete, true);
  assertCueIdentity(resumed, source, cueRange(0, source.length));
  assert.deepEqual(f.calls.slice(firstAttemptCount).map(call => call.indexes), [cueRange(20, 30), cueRange(20, 30)],
    'the exact missing IDs are drafted and reviewed without replaying earlier verified cues');
});

test('a verified prefetched draft deadline keeps the overlapping review and recovers the original cue set in smaller requests', async t => {
  let draftReady;
  const nextDraftStarted = new Promise(resolve => { draftReady = resolve; });
  const f = await fixture(t, async call => {
    if (!call.review && call.start === 160 && call.count === 80) {
      draftReady(call);
      return;
    }
    if (call.review && call.start === 80) {
      const prefetched = await nextDraftStarted;
      assert.equal(prefetched.closed, false, 'review and the draft that later timed out were actually concurrent');
    }
    await call.respond();
  }, { count: 321, provider: { translationRequestTimeoutMs: 220 } });
  const source = structuredClone(f.record.transcript);
  const result = await f.run();
  const priorReview = f.calls.filter(call => call.review && call.start === 80);
  assert.equal(priorReview.length, 1); assert.deepEqual(priorReview[0].kills, []);
  assert(f.checkpoints.some(checkpoint => checkpoint.completedCues === 160), 'the preceding successful review was stored');
  const prefetched = f.calls.filter(call => !call.review && call.start === 160 && call.count === 80);
  assert.equal(prefetched.length, 1); assert.deepEqual(prefetched[0].kills, ['SIGTERM']);
  const recovered = f.calls.filter(call => !call.review && call.start >= 160 && call.start < 240 && call.count < 80);
  assert(recovered.every(call => call.count <= 20));
  assert.deepEqual(recovered.flatMap(call => call.indexes), cueRange(160, 240));
  assert.equal(result.subtitleTranslationProgress.complete, true);
  assertCueIdentity(result, source, cueRange(0, source.length));
  assert(f.calls.every(call => call.closed));
});

test('two empty source batches trigger bounded fresh probes and do not claim the rest was processed', async t => {
  const f = await fixture(t, () => {}, { count: 241, provider: { translationRequestTimeoutMs: 90 } });
  const result = await f.run();
  const fullBatches = f.calls.filter(call => call.count === 80);
  assert.deepEqual(fullBatches.map(call => call.start), [0, 80]);
  assert(f.calls.length > fullBatches.length, 'a smaller request was tried before concluding there was no progress');
  assert(f.calls.length <= fullBatches.length + 8, 'timeouts cannot exhaust an unbounded series of extra calls');
  assert.deepEqual(f.calls.filter(call => call.start >= 160).map(call => [call.start, call.count]), [[160, 16], [176, 8]]);
  assert(f.calls.every(call => call.indexes.every(index => index < 184) && call.closed && call.kills.length === 1));
  assert.equal(result.subtitleDiagnostic.code, 'PROVIDER_REQUEST_DEADLINE');
  assert.equal(result.subtitleDiagnostic.providerProcessStopped, true);
  assert.equal(result.subtitleTranslationProgress.completedCues, 0);
  assert.notEqual(result.subtitleTranslationProgress.processingComplete, true);
  assert.equal(classifyQueueRecord(result, { catalogSaved: true }).canContinue, true);
});

test('a healthy forward probe after consecutive timeouts saves the tail and recovers earlier holes', async t => {
  let forwardReached = false;
  const f = await fixture(t, async call => {
    if (call.start < 160 && !forwardReached) return;
    if (call.start >= 160) forwardReached = true;
    await call.respond();
  }, { count: 193, provider: { translationRequestTimeoutMs: 140 } });
  const result = await f.run();
  assert.deepEqual(f.calls.filter(call => !call.review && call.start >= 160).map(call => [call.start, call.count]), [[160, 16], [176, 17]]);
  const tailReview = f.calls.findIndex(call => call.review && call.indexes.includes(192));
  assert(tailReview > 0);
  const remaining = f.calls.slice(tailReview + 1).filter(call => !call.review);
  assert(remaining.every(call => call.count <= 8));
  assert.deepEqual(remaining.flatMap(call => call.indexes), cueRange(0, 160));
  assert.equal(result.subtitleTranslationProgress.complete, true);
  assertCueIdentity(result, f.record.transcript, cueRange(0, 193));
});

test('the immediate recovery budget does not cap a healthy final sweep of the exact remaining IDs', async t => {
  const f = await fixture(t, async call => {
    if (!call.review && call.start < 240 && call.count === 80) return;
    await call.respond();
  }, { count: 321, provider: { translationRequestTimeoutMs: 175 } });
  const result = await f.run();
  const tailReview = f.calls.findIndex(call => call.review && call.indexes.includes(320));
  assert(tailReview >= 0);
  const immediate = f.calls.slice(0, tailReview).filter(call => !call.review && call.start < 240 && call.count < 80);
  assert.equal(immediate.length, 8);
  assert.deepEqual(immediate.flatMap(call => call.indexes), cueRange(0, 160));
  const late = f.calls.slice(tailReview + 1);
  const lateDrafts = late.filter(call => !call.review), lateReviews = late.filter(call => call.review);
  assert.equal(lateDrafts.length, 10);
  assert(lateDrafts.every(call => call.count === 8));
  assert.deepEqual(lateDrafts.flatMap(call => call.indexes), cueRange(160, 240));
  assert.deepEqual(lateReviews.map(call => call.indexes), lateDrafts.map(call => call.indexes));
  assert.equal(result.subtitleTranslationProgress.complete, true);
  assertCueIdentity(result, f.record.transcript, cueRange(0, 321));
});

test('a late hard failure from an overlapping draft wins over a verified local review deadline', async t => {
  let draftReady;
  const pendingDraft = new Promise(resolve => { draftReady = resolve; });
  const f = await fixture(t, async call => {
    if (!call.review && call.start === 160) {
      call.onKill = () => {}; // Remain open until the sibling review times out.
      draftReady(call);
      return;
    }
    if (call.review && call.start === 80) {
      const draft = await pendingDraft;
      call.onKill = () => {
        call.close(null);
        queueMicrotask(() => {
          draft.child.stderr.write('authentication failed\n');
          draft.close(1);
        });
      };
      return;
    }
    await call.respond();
  }, { count: 321, provider: { translationRequestTimeoutMs: 220, providerStopGraceMs: 75 } });
  const result = await f.run();
  assert.equal(result.subtitleDiagnostic.code, 'PROVIDER_AUTH');
  assert.equal(classifyQueueRecord(result, { catalogSaved: true }).canContinue, false);
  assertCueIdentity(result, f.record.transcript, cueRange(0, 80));
  assert(f.calls.some(call => call.review && call.start === 80 && call.kills.length === 1));
  assert.equal(f.calls.length, 5, 'no smaller retry may bypass the hard provider failure');
  assert(f.calls.every(call => call.closed));
});

test('a child with confirmed exit and missing close drains within a bounded grace', async t => {
  const f = await fixture(t, call => { call.onKill = () => call.child.emit('exit', null); },
    { provider: { translationRequestTimeoutMs: 25 } });
  const result = await f.run();
  assertTraversedGap(result, f.record.transcript, []);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].kills, ['SIGTERM']);
});

test('an actual owned inert child exits before deadline continuation is granted', async t => {
  const f = await fixture(t, () => {}, { realChild: true, provider: { translationRequestTimeoutMs: 250, providerStopGraceMs: 100 } });
  const result = await f.run();
  assertTraversedGap(result, f.record.transcript, []);
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
      { count: 81, provider: { translationRequestTimeoutMs: 100 } });
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
  }; }, { count: 81, provider: { translationRequestTimeoutMs: 100 } });
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
