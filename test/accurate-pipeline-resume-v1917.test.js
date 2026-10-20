const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter, getEventListeners } = require('node:events');
const { PassThrough } = require('node:stream');
const { createNoKeyProvider, TRANSLATION_PROMPT_VERSION } = require('../lib/no-key-provider');

const sourceText = '合成の列車が到着します。安全のためにホームの内側で待ち、案内と出発時間を確認してください。';
const koreanText = '합성 열차가 도착합니다. 안전을 위해 승강장 안쪽에서 기다리고 안내와 출발 시간을 확인하세요.';
const textFor = index => koreanText + ' 합성 안내 번호 ' + index + '번입니다.';
const unwrapped = text => text.replace(/\s+/g, ' ').trim();
const indexes = count => Array.from({ length: count }, (_, index) => index);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { count = 640, pipeline = true, handler } = {}) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-pipeline-resume-v1917-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const transcript = indexes(count).map(index => ({ id: `owned-resume-${index}`, start: index * 7 + 0.5,
        end: index * 7 + 5.5, text: sourceText }));
    const duration = count * 7 + 6;
    const record = { id: 'owned-pipeline-resume-v1917', name: 'owned-synthetic-train.mp4', summary: '보관한 합성 열차 안내',
        transcript, duration, warnings: [], frames: [], transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3',
        transcriptionQuality: { version: 1, recognitionRevision: 3, source: 'audio', profile: 'accurate', model: 'large-v3',
            complete: true, duration, processedUntil: duration, wordTimestamps: true, language: 'ja', languageProbability: 0.99,
            audit: { complete: true, speechSeconds: 10, uncoveredSpeechSeconds: 0, unresolved: [] }, warnings: [] } };
    const calls = [], commits = [], diagnostics = [], controller = new AbortController();
    let active = 0, peak = 0, activeReviews = 0, peakReviews = 0;
    const normalResponse = call => call.review ? { approvedIndexes: call.indexes.slice(), corrections: [], terms: [] }
        : { subtitles: call.indexes.map(index => ({ index, text: textFor(index) })), terms: [] };
    const spawnImpl = (binary, args) => {
        assert.equal(binary, 'owned-synthetic-codex');
        assert.equal(args[0], 'exec', 'only neutral mocked translation runs; no ASR, login or summary');
        const child = new EventEmitter(), chunks = [], cancelled = deferred();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
        const call = { args, child, cancelled: cancelled.promise, killed: false, closed: false };
        active++; peak = Math.max(peak, active);
        const close = code => {
            if (call.closed) return;
            call.closed = true; active--;
            if (call.review) activeReviews--;
            child.emit('close', code);
        };
        child.kill = () => { call.killed = true; cancelled.resolve(); queueMicrotask(() => close(null)); };
        child.stdin.on('data', chunk => chunks.push(chunk));
        child.stdin.on('finish', () => queueMicrotask(async () => {
            try {
                call.input = JSON.parse(Buffer.concat(chunks).toString('utf8').split('자료 JSON:\n').at(-1));
                call.indexes = call.input.subtitles.map(cue => cue.index); call.start = call.indexes[0];
                call.count = call.indexes.length; call.review = Boolean(call.input.draftSubtitles);
                if (call.review) { activeReviews++; peakReviews = Math.max(peakReviews, activeReviews); }
                call.overlaps = calls.filter(previous => !previous.closed).map(previous => ({ start: previous.start, review: previous.review }));
                calls.push(call);
                const result = handler ? await handler(call, { calls, record, commits, diagnostics, controller, normalResponse }) : undefined;
                if (call.closed) return;
                call.response = result || normalResponse(call);
                await fs.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(call.response), 'utf8');
                close(0);
            } catch (error) {
                if (!call.closed) { child.stderr.write(error.message); close(error.exitCode || 1); }
            }
        }));
        return child;
    };
    const provider = createNoKeyProvider({ spawnImpl, platform: 'win32', environment: { VIDEORANDOM_CODEX: 'owned-synthetic-codex',
        ...(pipeline ? {} : { VIDEORANDOM_TRANSLATION_PIPELINE: 'off' }) } });
    const run = options => provider.translateKoreanOnly(record, { dataDir, subtitleQuality: 'accurate', signal: controller.signal,
        onCheckpoint: value => commits.push(structuredClone(value.subtitleTranslationProgress || {})),
        onDiagnostic: value => diagnostics.push(value), ...options });
    const seedSparse = async (accepted, terms = []) => {
        const progress = { version: 2, sourceFingerprint: crypto.createHash('sha256')
            .update(JSON.stringify(transcript.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex'),
            totalCues: count, completedCues: accepted.length, language: 'ko', complete: false, translationComplete: false,
            sourceComplete: true, sourceProcessed: true, sourceAuditComplete: true, cueIndexes: accepted,
            translationVersion: TRANSLATION_PROMPT_VERSION, targetLanguage: 'ko', subtitleQuality: 'accurate', reviewPasses: 2,
            subtitles: accepted.map(index => ({ index, id: transcript[index].id, start: transcript[index].start,
                end: transcript[index].end, text: textFor(index) })), terms };
        await fs.mkdir(path.join(dataDir, 'checkpoints'), { recursive: true });
        await fs.writeFile(path.join(dataDir, 'checkpoints', record.id + '-ko.json'), JSON.stringify(progress), 'utf8');
    };
    const drained = async () => {
        assert.equal(active, 0, 'every child is closed before exposing completion, failure or cancellation');
        assert.equal(activeReviews, 0); assert(peak <= 2); assert(peakReviews <= 1);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
        assert.deepEqual(await fs.readdir(path.join(dataDir, 'tmp')).catch(() => []), []);
    };
    return { dataDir, record, transcript, calls, commits, diagnostics, controller, run, seedSparse, drained,
        get peak() { return peak; }, get peakReviews() { return peakReviews; } };
}

function assertIdentity(result, source, accepted = indexes(source.length)) {
    const cues = result.subtitleTranslation || result.subtitleTranslationPartial;
    assert.equal(cues.length, accepted.length);
    cues.forEach((cue, offset) => {
        const index = accepted[offset];
        assert.deepEqual([cue.id, cue.start, cue.end], [source[index].id, source[index].start, source[index].end]);
        assert.equal(unwrapped(cue.text), textFor(index));
    });
}

function assertComplete(result, source) {
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(result.subtitleTranslationProgress.completedCues, source.length);
    assert.equal(result.subtitleTranslationProgress.complete, true);
    assert.equal(result.subtitleTranslationProgress.translationComplete, true);
    assertIdentity(result, source);
}

test('an exact V2 sparse repair resumes lookahead after its first clean committed recovery batch', async t => {
    const overlap = deferred(), draftReady = deferred();
    const f = await fixture(t, { handler: async (call, state) => {
        if (!call.review && call.start === 239) { draftReady.resolve(); await overlap.promise; }
        if (call.review && call.start === 159) {
            await draftReady.promise;
            assert(state.commits.some(progress => progress.completedCues === 159), 'the source-order recovery batch is durable first');
            assert.equal(call.input.previousTranslations.at(-1).index, 158);
            assert(call.input.properNames.some(term => term.source === '合成駅' && term.translation === '합성역'));
            assert(state.calls.some(other => other.start === 239 && !other.review && !other.closed));
            overlap.resolve();
        }
        return state.normalResponse(call);
    } });
    await f.seedSparse(indexes(80).filter(index => index !== 20), [{ source: '合成駅', translation: '합성역' }]);
    const original = structuredClone(f.transcript);
    const result = await f.run();
    assertComplete(result, original); assert.deepEqual(f.transcript, original);
    assert.deepEqual(f.calls.slice(0, 2).map(call => [call.review, call.start, call.count]), [[false, 20, 80], [true, 20, 80]]);
    assert(f.calls.every(call => !call.indexes.some(index => index < 80 && index !== 20)), 'accepted sparse cues are never translated again');
    assert.equal(f.peak, 2); assert.equal(f.peakReviews, 1);
    const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints', f.record.id + '-ko.json'), 'utf8'));
    assert.equal(saved.version, 1); assert.equal(saved.complete, true); assert.equal(saved.reviewPasses, 2);
    assert.deepEqual(saved.terms, [{ source: '合成駅', translation: '합성역' }]);
    await f.drained();
});

test('an unresolved older cue stays sparse while later clean batches safely resume draft overlap', async t => {
    const overlap = deferred(), draftReady = deferred();
    const f = await fixture(t, { handler: async (call, state) => {
        if (!call.review && call.start === 240) { draftReady.resolve(); await overlap.promise; }
        if (call.review && call.start === 160) {
            await draftReady.promise;
            assert(state.calls.some(other => other.start === 240 && !other.review && !other.closed));
            assert(state.commits.some(progress => progress.completedCues === 159));
            overlap.resolve();
        }
        const result = state.normalResponse(call);
        if (call.review) result.approvedIndexes = result.approvedIndexes.filter(index => index !== 20);
        return result;
    } });
    const original = structuredClone(f.transcript), result = await f.run();
    const accepted = indexes(f.transcript.length).filter(index => index !== 20);
    assert.equal(result.subtitleRepairStatus, 'partial'); assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
    assert.equal(result.subtitleTranslationProgress.processingComplete, true);
    assert.equal(result.subtitleTranslationProgress.processedCues, original.length);
    assert.equal(result.subtitleTranslationProgress.version, 2);
    assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, accepted);
    assert.equal(result.subtitleTranslationProgress.complete, false);
    assert.equal(result.subtitleTranslationProgress.translationComplete, false);
    assert.equal(result.subtitleTranslation, undefined); assertIdentity(result, original, accepted);
    assert.deepEqual(f.transcript, original);
    assert.equal(f.calls.filter(call => call.review && call.count === 1 && call.start === 20).length, 1);
    assert(f.calls.some(call => call.review && call.indexes.includes(original.length - 1)));
    assert.equal(f.peak, 2); await f.drained();
});

test('a recovered current gap drains its in-flight draft and requires a later clean committed batch before overlap resumes', async t => {
    const firstLookahead = deferred(), resumed = deferred(), resumedDraftReady = deferred(); let first = true;
    const f = await fixture(t, { count: 800, handler: async (call, state) => {
        if (!call.review && call.start === 160 && first) {
            first = false; firstLookahead.resolve(); await call.cancelled;
        }
        if (call.review && call.start === 80 && call.count === 80) await firstLookahead.promise;
        if (call.review && call.start === 159) {
            const discarded = state.calls.find(other => !other.review && other.start === 160);
            assert.equal(discarded.killed, true); assert.equal(discarded.closed, true);
        }
        if (!call.review && call.start === 320) { resumedDraftReady.resolve(); await resumed.promise; }
        if (call.review && call.start === 160) assert(!call.overlaps.some(other => other.start > 160));
        if (call.review && call.start === 240) {
            await resumedDraftReady.promise;
            assert(state.commits.some(progress => progress.completedCues === 240));
            assert(state.calls.some(other => other.start === 320 && !other.review && !other.closed));
            resumed.resolve();
        }
        const result = state.normalResponse(call);
        if (call.review && call.start === 80 && call.count === 80) result.approvedIndexes.pop();
        return result;
    } });
    const result = await f.run(); assertComplete(result, f.transcript);
    assert.equal(f.calls.filter(call => !call.review && call.start === 160).length, 2, 'only the discarded draft is replaced');
    assert.equal(f.calls.filter(call => call.review && call.start === 159).length, 1);
    assert.equal(f.diagnostics.some(event => event.code === 'ANALYSIS_CANCELLED'), false);
    await f.drained();
});

for (const failure of ['503 service unavailable', '401 authentication failed', 'quota usage limit', 'execution timeout', 'ECONNRESET network failure', 'response refusal']) {
    test(`a resumed prefetched ${failure} stops immediately without a repair or later request`, async t => {
        const ready = deferred();
        const f = await fixture(t, { handler: async (call, state) => {
            if (!call.review && call.start === 239) {
                await ready.promise;
                if (failure === 'response refusal') return { refusal: true };
                throw new Error('Owned synthetic ' + failure);
            }
            if (call.review && call.start === 159) { ready.resolve(); await call.cancelled; }
            return state.normalResponse(call);
        } });
        await f.seedSparse(indexes(80).filter(index => index !== 20));
        const result = await f.run();
        assert.equal(result.subtitleRepairStatus, 'failed');
        if (failure === 'response refusal') assert.equal(result.subtitleDiagnostic.refusalSource, 'response-field');
        else assert(result.subtitleError.includes(failure));
        assert.equal(f.calls.filter(call => !call.review && call.start === 239).length, 1);
        assert(!f.calls.some(call => call.start > 239 || call.start === 239 && call.review));
        assert.equal(result.subtitleTranslationProgress.completedCues, 159);
        assertIdentity(result, f.transcript, indexes(159));
        await f.drained();
    });
}

test('parent cancellation drains a resumed lookahead and review while preserving the exact reviewed recovery prefix', async t => {
    const ready = deferred(); let overlapping = 0;
    const f = await fixture(t, { handler: async (call, state) => {
        if (!call.review && call.start === 239 || call.review && call.start === 159) {
            if (++overlapping === 2) ready.resolve();
            await call.cancelled;
        }
        return state.normalResponse(call);
    } });
    await f.seedSparse(indexes(80).filter(index => index !== 20));
    const pending = f.run(); await ready.promise; f.controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(f.record.subtitleTranslationProgress.completedCues, 159);
    assertIdentity(f.record, f.transcript, indexes(159));
    assert.equal(f.calls.filter(call => call.killed).length, 2);
    await f.drained();
});

test('resumed lookahead still replaces only a newly stale term draft once and reviews against current committed terms', async t => {
    const ready = deferred();
    const f = await fixture(t, { handler: async (call, state) => {
        const result = state.normalResponse(call);
        if (!call.review && call.start === 239) {
            if (!call.input.properNames.some(term => term.source === '合成駅')) await ready.promise;
            result.terms = [{ source: '合成駅', translation: call.input.properNames.some(term => term.source === '合成駅') ? '합성역' : '기존역' }];
        }
        if (call.review && call.start === 159) { result.terms = [{ source: '合成駅', translation: '합성역' }]; ready.resolve(); }
        if (call.review && call.start === 239) {
            assert.equal(call.input.previousTranslations.at(-1).index, 238);
            assert.deepEqual(call.input.draftTerms, [{ source: '合成駅', translation: '합성역' }]);
            assert(call.input.properNames.some(term => term.source === '合成駅' && term.translation === '합성역'));
            result.terms = [{ source: '合成駅', translation: '합성역' }];
        }
        return result;
    } });
    await f.seedSparse(indexes(80).filter(index => index !== 20));
    const result = await f.run(); assertComplete(result, f.transcript);
    assert.equal(f.calls.filter(call => !call.review && call.start === 239).length, 2);
    assert.equal(f.calls.filter(call => call.review && call.start === 239).length, 1);
    await f.drained();
});

test('mock latency comparison after an earlier gap preserves all requests, reviews and exact output', async t => {
    const handler = async (call, state) => {
        await delay(15);
        const result = state.normalResponse(call);
        if (call.review && call.start === 0 && call.count === 80) result.approvedIndexes.pop();
        return result;
    };
    const serial = await fixture(t, { count: 1120, pipeline: false, handler });
    const resumed = await fixture(t, { count: 1120, handler });
    const serialStart = performance.now(), oldResult = await serial.run(), serialElapsed = performance.now() - serialStart;
    const resumedStart = performance.now(), result = await resumed.run(), resumedElapsed = performance.now() - resumedStart;
    assertComplete(oldResult, serial.transcript); assertComplete(result, resumed.transcript);
    assert.deepEqual(result.subtitleTranslation, oldResult.subtitleTranslation);
    assert.deepEqual(resumed.transcript, serial.transcript);
    assert.equal(serial.calls.length, 29); assert.equal(resumed.calls.length, serial.calls.length);
    assert.equal(serial.peak, 1); assert.equal(resumed.peak, 2); assert.equal(resumed.peakReviews, 1);
    t.diagnostic(`Owned synthetic 1,120-cue translation, recovered first-batch gap, 15 ms/request: pipeline off ${serialElapsed.toFixed(1)} ms; resumed pipeline ${resumedElapsed.toFixed(1)} ms; ${(serialElapsed / resumedElapsed).toFixed(2)}x. Same 29 mocked requests and two passes. This is not actual provider, ASR or whole-video speed.`);
    await serial.drained(); await resumed.drained();
});
