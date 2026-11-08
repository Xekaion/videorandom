const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createNoKeyProvider } = require('../lib/no-key-provider');
const { classifyQueueRecord } = require('../lib/queue-outcome');

const range = (start, end) => Array.from({ length: end - start }, (_, offset) => start + offset);
const spans = calls => calls.map(({ indexes }) => [indexes[0], indexes.length]);

async function fixture(t, behavior, { count = 101, profile = 'accurate' } = {}) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-owned-deferred-v1937-'));
    const transcript = range(0, count).map(index => ({ id: `train-cue-${index}`, start: index * 3 + 0.125,
        end: index * 3 + 2.375, text: '列車の到着時刻と乗り場を確認してください。' }));
    const record = { id: 'owned-deferred', name: 'owned-neutral-train.mp4', duration: count * 3,
        status: 'partial', hasAudio: true, summary: '합성 열차 안내', frames: [], warnings: [], transcript: structuredClone(transcript),
        transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3',
        transcriptionQuality: { version: 1, recognitionRevision: 3, source: 'audio', profile: 'accurate', model: 'large-v3', language: 'ja',
            complete: true, processingComplete: true, duration: count * 3, processedUntil: count * 3,
            wordTimestamps: true, audit: { complete: true, unresolved: [], unresolvedCount: 0 }, warnings: [] } };
    const calls = [], checkpoints = [];
    const provider = createNoKeyProvider({ translationRequestTimeoutMs: 210, providerStopGraceMs: 20,
        environment: { VIDEORANDOM_CODEX: 'owned-synthetic-deferred-provider' },
        spawnImpl(binary, args) {
            assert.equal(binary, 'owned-synthetic-deferred-provider');
            const child = new EventEmitter();
            child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
            const call = { closed: false, kills: [], savedWhenSpawned: checkpoints.at(-1) || [] };
            const close = code => { if (!call.closed) { call.closed = true; child.emit('close', code); } };
            call.close = close;
            calls.push(call);
            child.kill = signal => { call.kills.push(signal || 'SIGTERM'); queueMicrotask(() => close(null)); return true; };
            const chunks = [];
            child.stdin.on('data', chunk => chunks.push(chunk));
            child.stdin.on('finish', () => queueMicrotask(async () => {
                try {
                    const input = JSON.parse(Buffer.concat(chunks).toString('utf8').split('자료 JSON:\n').at(-1));
                    call.indexes = input.subtitles.map(cue => cue.index);
                    call.review = Boolean(input.draftSubtitles);
                    call.start = call.indexes[0]; call.count = call.indexes.length;
                    call.respond = async (rewrite = answer => answer) => {
                        const answer = call.review ? { approvedIndexes: call.indexes, corrections: [], terms: [] }
                            : { subtitles: call.indexes.map(index => ({ index, text: '열차 도착 시간과 승강장을 확인해 주세요.' })), terms: [] };
                        await fs.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(rewrite(answer)));
                        close(0);
                    };
                    call.authFailure = () => { child.stderr.write('authentication failed\n'); close(1); };
                    child.stdout.write('{"type":"thread.started"}\n{"type":"turn.started"}\n');
                    await behavior(call);
                } catch (error) { child.emit('error', error); close(1); }
            }));
            return child;
        } });
    t.after(async () => {
        for (const call of calls) call.close(1);
        const [resolved, temporaryRoot] = await Promise.all([fs.realpath(dataDir), fs.realpath(os.tmpdir())]);
        assert.equal(path.dirname(resolved), temporaryRoot);
        assert.match(path.basename(resolved), /^videorandom-owned-deferred-v1937-/);
        await fs.rm(resolved, { recursive: true, force: true });
    });
    return { calls, transcript, run: () => provider.translateKoreanOnly(record, { dataDir, subtitleQuality: profile,
        onCheckpoint: current => checkpoints.push((current.subtitleTranslationPartial || current.subtitleTranslation || []).map(cue => cue.id)) }) };
}

function assertCues(result, transcript, indexes) {
    const cues = result.subtitleTranslation || result.subtitleTranslationPartial || [];
    assert.deepEqual(result.transcript, transcript, 'source text, times and IDs must stay unchanged');
    assert.equal(result.subtitleTranslationProgress.completedCues, indexes.length);
    assert.deepEqual(cues.map(cue => [cue.id, cue.start, cue.end]), indexes.map(index => {
        const { id, start, end } = transcript[index];
        return [id, start, end];
    }));
}

const skipDraftRows = (call, exclude) => call.respond(answer => ({ ...answer,
    subtitles: answer.subtitles.filter(cue => !exclude(cue.index)) }));

function isKnownInitialTimeout(call) {
    return !call.review && ((call.start === 10 && call.count === 20) || (call.start === 20 && call.count === 10));
}

test('after a healthy tail is durably saved, only unresolved timeout IDs are redrafted and reviewed', async t => {
    const f = await fixture(t, async call => {
        if (!call.review && call.start === 0) return skipDraftRows(call, index => index >= 10 && index < 30);
        if (isKnownInitialTimeout(call)) return;
        await call.respond();
    });
    const result = await f.run();
    const tailReview = f.calls.findIndex(call => call.review && call.start === 80);
    assert(tailReview >= 0, 'the healthy tail gets reviewed before returning to earlier gaps');
    const deferred = f.calls.slice(tailReview + 1);
    assert.equal(deferred.length, 4, result.subtitleError);
    assert(deferred[0].savedWhenSpawned.includes('train-cue-100'), 'tail is already durable when deferred recovery starts');
    for (const review of [false, true]) {
        const requested = deferred.filter(call => call.review === review);
        assert(requested.every(call => call.count <= 8));
        assert.deepEqual(requested.flatMap(call => call.indexes), range(20, 30));
    }
    assert.equal(result.subtitleTranslationProgress.complete, true);
    assertCues(result, f.transcript, range(0, 101));
});

test('a deferred timeout waits for healthy fresh work before one smaller retry and leaves ordinary format gaps untouched', async t => {
    const f = await fixture(t, async call => {
        if (!call.review && call.start === 0) return skipDraftRows(call, index => index >= 10 && index < 30 || index === 79);
        if (isKnownInitialTimeout(call) || !call.review && call.start === 20 && call.count === 8) return;
        if (!call.review && call.start === 79) return skipDraftRows(call, () => true);
        await call.respond();
    }, { profile: 'fast' });
    const result = await f.run();
    const tail = f.calls.findIndex(call => call.start === 80);
    assert(tail >= 0);
    const deferred = f.calls.slice(tail + 1);
    assert.deepEqual(spans(deferred.slice(0, 2)), [[20, 8], [28, 2]], 'fresh work runs before the retry');
    assert.deepEqual(deferred[0].kills, ['SIGTERM']);
    assert(deferred.slice(1).every(call => !call.kills.length));
    const retried = deferred.slice(2);
    assert(retried.every(call => call.count <= 4), 'each retry is at most half the original timed-out group');
    assert.deepEqual(retried.flatMap(call => call.indexes), range(20, 28), 'only failed IDs retry and each retries once');
    const accepted = [...range(0, 79), ...range(80, 101)];
    assertCues(result, f.transcript, accepted);
    assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, accepted);
    assert.equal(result.subtitleTranslationProgress.processingComplete, true);
    assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
    assert.equal(classifyQueueRecord(result, { catalogSaved: true }).canContinue, true);
});

test('healthy deferred recovery processes all 80 eligible IDs rather than stopping at the old 64-ID ceiling', async t => {
    const f = await fixture(t, async call => {
        if (call.start < 80 && call.count > 8) return;
        await call.respond();
    }, { profile: 'fast' });
    const result = await f.run();
    const tail = f.calls.findIndex(call => call.start === 80);
    assert(tail >= 0);
    const deferred = f.calls.slice(tail + 1);
    assert.equal(deferred.length, 10);
    assert(deferred.every(call => call.count <= 8 && !call.kills.length));
    assert.deepEqual(deferred.flatMap(call => call.indexes), range(0, 80));
    assertCues(result, f.transcript, range(0, 101));
    assert.equal(result.subtitleTranslationProgress.complete, true);
});

test('a verified deferred group opens recovery for the timed-out final source span', async t => {
    const f = await fixture(t, async call => {
        if ((call.start < 80 || call.start >= 160) && call.count > 8) return;
        await call.respond();
    }, { count: 181, profile: 'fast' });
    const result = await f.run();
    const lastBaseRequest = f.calls.findLastIndex(call => call.start >= 160 && call.count > 8);
    assert(lastBaseRequest >= 0, 'the final source span timed out before the late pass');
    const deferred = f.calls.slice(lastBaseRequest + 1);
    const firstTrailing = deferred.findIndex(call => call.indexes.some(index => index >= 160));
    assert(firstTrailing > 0, 'a trailing request is admitted only after verified deferred progress');
    assert(deferred[firstTrailing].savedWhenSpawned.includes('train-cue-0'));
    assert(deferred.every(call => call.count <= 8 && !call.kills.length));
    assert.deepEqual(deferred.flatMap(call => call.indexes).sort((a, b) => a - b), [...range(0, 80), ...range(160, 181)]);
    assertCues(result, f.transcript, range(0, 181));
    assert.equal(result.subtitleTranslationProgress.complete, true);
});

test('consecutive empty deferred deadlines shrink 8→4→2→1 then stop without erasing the saved healthy tail', async t => {
    const f = await fixture(t, async call => { if (call.start >= 80) await call.respond(); }, { profile: 'fast' });
    const result = await f.run();
    const tail = f.calls.findIndex(call => call.start === 80);
    assert(tail >= 0);
    const deferred = f.calls.slice(tail + 1);
    assert.deepEqual(spans(deferred), [[0, 8], [8, 4], [12, 2], [14, 1]]);
    assert(deferred.every(call => call.kills.length === 1));
    assertCues(result, f.transcript, range(80, 101));
    assert.equal(result.subtitleTranslationProgress.processingComplete, true);
    assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
    assert.equal(classifyQueueRecord(result, { catalogSaved: true }).canContinue, true);
});

test('an exhausted trailing batch is not late-rechecked without a later healthy source batch', async t => {
    const f = await fixture(t, async call => { if (call.start < 80) await call.respond(); }, { profile: 'fast' });
    const result = await f.run();
    assert.deepEqual(spans(f.calls), [[0, 80], [80, 21], [80, 11], [91, 10]]);
    assertCues(result, f.transcript, range(0, 80));
    assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
});

test('authentication failure on the following source batch stops before the deferred pass', async t => {
    const f = await fixture(t, async call => {
        if (call.start === 0) return skipDraftRows(call, index => index >= 10 && index < 30);
        if (isKnownInitialTimeout(call)) return;
        if (call.start === 80) return call.authFailure();
        await call.respond();
    }, { profile: 'fast' });
    const result = await f.run();
    assert.equal(f.calls.at(-1).start, 80, 'no later requests may run after genuine authentication failure');
    assert.equal(result.subtitleDiagnostic.code, 'PROVIDER_AUTH');
    assert.equal(classifyQueueRecord(result, { catalogSaved: true }).canContinue, false);
    assertCues(result, f.transcript, [...range(0, 20), ...range(30, 80)]);
});
