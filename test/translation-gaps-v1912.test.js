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
const unwrapped = text => text.replace(/\s+/g, ' ').trim();
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { count = 160, bad = [20], profile = 'accurate', pipeline = false, handler } = {}) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-gaps-v1912-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const transcript = Array.from({ length: count }, (_, index) => ({ id: `owned-gap-${index}`,
        start: index * 7 + 0.5, end: index * 7 + 5.5, text: sourceText }));
    const duration = count * 7 + 6;
    const record = { id: 'owned-gap-record', name: 'owned-synthetic-train.mp4', summary: '보관한 합성 안내',
        transcript, duration, warnings: [], frames: [], transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3',
        transcriptionQuality: { version: 1, recognitionRevision: 3, source: 'audio', profile: 'accurate', model: 'large-v3',
            complete: true, duration, processedUntil: duration, wordTimestamps: true, language: 'ja', languageProbability: 0.99,
            audit: { complete: true, speechSeconds: 10, uncoveredSpeechSeconds: 0, unresolved: [] }, warnings: [] } };
    const calls = [], commits = [], diagnostics = [], controller = new AbortController();
    let active = 0, peak = 0, fixed = false;
    const badIndexes = new Set(bad);
    const normalResponse = call => call.review ? { approvedIndexes: call.indexes.slice(), corrections: [], terms: [] }
        : { subtitles: call.indexes.map(index => ({ index, text: !fixed && badIndexes.has(index) ? '네.' : koreanText })), terms: [] };
    const spawnImpl = (binary, args) => {
        assert.equal(binary, 'owned-synthetic-codex'); assert.equal(args[0], 'exec');
        const child = new EventEmitter(), chunks = [], cancelled = deferred();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
        const call = { args, child, cancelled: cancelled.promise, killed: false };
        active++; peak = Math.max(peak, active);
        let closed = false;
        const close = code => { if (!closed) { closed = true; active--; child.emit('close', code); } };
        child.kill = () => { call.killed = true; cancelled.resolve(); queueMicrotask(() => close(null)); };
        child.stdin.on('data', chunk => chunks.push(chunk));
        child.stdin.on('finish', () => queueMicrotask(async () => {
            try {
                call.input = JSON.parse(Buffer.concat(chunks).toString('utf8').split('자료 JSON:\n').at(-1));
                call.indexes = call.input.subtitles.map(cue => cue.index); call.start = call.indexes[0];
                call.count = call.indexes.length; call.review = Boolean(call.input.draftSubtitles);
                calls.push(call);
                const response = handler ? await handler(call, { calls, record, controller, normalResponse, commits }) : undefined;
                if (closed) return;
                call.response = response || normalResponse(call);
                await fs.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(call.response), 'utf8');
                close(0);
            } catch (error) { if (!closed) { child.stderr.write(error.message); close(1); } }
        }));
        return child;
    };
    const provider = createNoKeyProvider({ spawnImpl, platform: 'win32', environment: { VIDEORANDOM_CODEX: 'owned-synthetic-codex',
        ...(pipeline ? {} : { VIDEORANDOM_TRANSLATION_PIPELINE: 'off' }) } });
    const run = options => provider.translateKoreanOnly(record, { dataDir, subtitleQuality: profile, signal: controller.signal,
        onCheckpoint: value => commits.push(JSON.parse(JSON.stringify(value.subtitleTranslationProgress || {}))),
        onDiagnostic: value => diagnostics.push(value), ...options });
    const drained = async () => {
        assert.equal(active, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
        assert.deepEqual(await fs.readdir(path.join(dataDir, 'tmp')).catch(() => []), []);
    };
    return { dataDir, record, transcript, calls, commits, diagnostics, controller, run, drained,
        fix: () => { fixed = true; }, get peak() { return peak; } };
}

function assertSparse(result, source, missing) {
    const expected = source.map((_, index) => index).filter(index => !missing.includes(index));
    const progress = result.subtitleTranslationProgress;
    assert.equal(progress.version, 2);
    assert.deepEqual(progress.cueIndexes, expected);
    assert.equal(progress.completedCues, expected.length); assert.equal(progress.totalCues, source.length);
    assert.equal(progress.complete, false); assert.equal(progress.translationComplete, false);
    assert.equal(result.subtitleTranslation, undefined); assert.equal(result.subtitleLanguage, undefined);
    assert.equal(result.subtitleTranslationPartial.length, expected.length);
    result.subtitleTranslationPartial.forEach((cue, offset) => {
        const original = source[expected[offset]];
        assert.deepEqual([cue.id, cue.start, cue.end], [original.id, original.start, original.end]);
        assert.equal(unwrapped(cue.text), koreanText);
    });
}

for (const [count, bad] of [[80, [20]], [160, [20]], [1856, [1488, 1489]]]) {
    test(`${count} accurate cues isolate ${bad.join(',')} after one correction and still translate the final cue`, async t => {
        const f = await fixture(t, { count, bad });
        const original = structuredClone(f.transcript);
        const result = await f.run();
        assert.equal(result.subtitleRepairStatus, 'failed');
        assert.match(result.subtitleError, /미완료/);
        assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
        assert.equal(result.subtitleDiagnostic.totalCues, count);
        assert.equal(result.subtitleDiagnostic.completedCues, count - bad.length);
        assert.equal(result.subtitleDiagnostic.expectedCues, bad.length);
        assertSparse(result, original, bad);
        assert.deepEqual(f.transcript, original);
        assert(f.calls.some(call => call.review && call.indexes.includes(count - 1)), 'later review reaches the actual final source cue');
        const corrections = f.calls.filter(call => call.review && call.count <= 20 && call.indexes.some(index => bad.includes(index)));
        assert.equal(corrections.length, 1); assert.deepEqual(corrections[0].indexes, bad);
        assert(f.diagnostics.some(event => event.code === 'SUBTITLE_REVIEW_TOO_SHORT' && event.level === 'warning'));
        const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints', f.record.id + '-ko.json'), 'utf8'));
        assert.equal(saved.version, 2); assert.equal(saved.translationVersion, TRANSLATION_PROMPT_VERSION);
        assert.equal(saved.subtitleQuality, 'accurate'); assert.equal(saved.reviewPasses, 2);
        assert.deepEqual(saved.subtitles.map(cue => cue.index), result.subtitleTranslationProgress.cueIndexes);
        await f.drained();
    });
}

test('a sparse repair requests only the two missing global indexes and keeps surrounding context and later accepted cues', async t => {
    const f = await fixture(t, { count: 160, bad: [20, 101] });
    const first = await f.run(); assertSparse(first, f.transcript, [20, 101]);
    f.calls.length = 0; f.fix();
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(result.subtitleTranslation.length, 160);
    assert.deepEqual(f.calls.map(call => call.indexes), [[20, 101], [20, 101]]);
    assert.deepEqual(f.calls[0].input.previousTranslations.map(cue => cue.index), [12, 13, 14, 15, 16, 17, 18, 19]);
    assert.equal(f.calls[0].input.contextBefore.at(-1).index, 19);
    assert.equal(f.calls[0].input.contextAfter[0].index, 102);
    assert.equal(result.subtitleTranslationProgress.version, 1);
    assert.equal(result.subtitleTranslationProgress.complete, true);
    assert.equal(result.subtitleTranslationProgress.cueIndexes, undefined);
    result.subtitleTranslation.forEach((cue, index) => assert.deepEqual([cue.id, cue.start, cue.end],
        [f.transcript[index].id, f.transcript[index].start, f.transcript[index].end]));
    await f.drained();
});

for (const profile of ['fast', 'turbo']) test(`${profile} single-pass translations isolate a repeatedly short cue after one same-source correction`, async t => {
    const f = await fixture(t, { profile, count: 160 });
    const result = await f.run(); assertSparse(result, f.transcript, [20]);
    assert(f.calls.every(call => !call.review), 'single-pass mode never pretends to have run an independent review');
    assert.deepEqual(f.calls.map(call => call.indexes.length), [80, 1, 80]);
    assert.deepEqual(f.calls[1].indexes, [20]);
    const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints', f.record.id + '-ko.json'), 'utf8'));
    assert.equal(saved.subtitleQuality, profile); assert.equal(saved.reviewPasses, 1);
    await f.drained();
});

for (const failure of ['503 service unavailable', '401 authentication failed', 'quota usage limit', 'execution timeout', 'ECONNRESET network failure', 'response refusal', 'malformed response']) {
    test(`a later ${failure} stops immediately and retains the earlier sparse approved set`, async t => {
        const f = await fixture(t, { count: 240, handler: (call, state) => {
            if (call.review && call.start === 80) {
                if (failure === 'response refusal') return { refusal: true };
                if (failure === 'malformed response') return { approvedIndexes: [99999], corrections: [], terms: [] };
                throw new Error('Owned synthetic ' + failure);
            }
            return state.normalResponse(call);
        } });
        const result = await f.run();
        assert.equal(result.subtitleRepairStatus, 'failed');
        assert.equal(result.subtitleTranslationProgress.version, 2);
        assert.equal(result.subtitleTranslationProgress.completedCues, 79);
        assert(!result.subtitleTranslationProgress.cueIndexes.includes(20));
        assert.equal(result.subtitleTranslationProgress.cueIndexes.at(-1), 79);
        assert.equal(f.calls.length, 5, 'the failed provider request starts no replacement or later batch');
        assert(!f.calls.some(call => call.start >= 160));
        if (failure === 'response refusal') assert.equal(result.subtitleDiagnostic.refusalSource, 'response-field');
        else if (failure !== 'malformed response') assert(result.subtitleError.includes(failure));
        await f.drained();
    });
}

test('quarantining during an overlapping review drains its speculative draft and keeps later work serial', async t => {
    const ready = deferred(); let first = true;
    const f = await fixture(t, { count: 320, bad: [100], pipeline: true, handler: async (call, state) => {
        if (!call.review && call.start === 160 && first) { first = false; ready.resolve(); await call.cancelled; }
        if (call.review && call.start === 80 && call.count === 80) await ready.promise;
        return state.normalResponse(call);
    } });
    const result = await f.run(); assertSparse(result, f.transcript, [100]);
    assert.equal(f.peak, 2); assert(f.calls.find(call => call.start === 160 && !call.review).killed);
    assert.equal(f.calls.filter(call => call.start === 160 && !call.review).length, 2, 'only the discarded speculative draft is replaced');
    await f.drained();
});

test('parent cancellation after quarantining keeps sparse checkpoints and drains the active child', async t => {
    const f = await fixture(t, { count: 160, handler: (call, state) => {
        if (!call.review && call.start === 80) state.controller.abort();
        return state.normalResponse(call);
    } });
    await assert.rejects(f.run(), { name: 'AbortError' });
    assert.equal(f.record.subtitleTranslationProgress.version, 2);
    assert.equal(f.record.subtitleTranslationProgress.completedCues, 79);
    assert(f.calls.at(-1).killed); await f.drained();
});

test('a missing correction is still a hard stop rather than being quarantined or automatically approved', async t => {
    const f = await fixture(t, { count: 160, handler: (call, state) => call.review && call.count === 1
        ? { approvedIndexes: [], corrections: [], terms: [] } : state.normalResponse(call) });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'failed'); assert.equal(f.calls.length, 3);
    assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUE_COUNT_MISMATCH');
    assert.equal(result.subtitleTranslationProgress.version, 1); assert.equal(result.subtitleTranslationProgress.completedCues, 20);
    await f.drained();
});

test('internal assembled terms may exceed the per-response limit while every provider response remains bounded', async t => {
    const f = await fixture(t, { count: 80, bad: [], handler: (call, state) => {
        const result = state.normalResponse(call);
        if (call.review && call.count === 80) {
            result.approvedIndexes = result.approvedIndexes.filter(index => index !== 79);
            result.terms = Array.from({ length: 100 }, (_, index) => ({ source: '合成駅' + index, translation: '합성역' + index }));
        } else if (call.review) result.terms = [{ source: '合成次駅', translation: '합성다음역' }];
        return result;
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(result.subtitleTranslation.length, 80); assert.equal(f.calls.length, 3);
    assert(f.calls.every(call => call.response.terms.length <= 100));
    const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints', f.record.id + '-ko.json'), 'utf8'));
    assert.equal(saved.terms.length, 101); await f.drained();
});

test('a provider response with more than one hundred terms is still rejected before any repair', async t => {
    const f = await fixture(t, { bad: [], handler: (call, state) => {
        const result = state.normalResponse(call);
        if (call.review) result.terms = Array.from({ length: 101 }, (_, index) => ({ source: '合成駅' + index, translation: '합성역' + index }));
        return result;
    } });
    const result = await f.run(); assert.equal(result.subtitleRepairStatus, 'failed'); assert.equal(f.calls.length, 2);
    assert.equal(result.subtitleTranslationPartial?.length || 0, 0); await f.drained();
});

test('sparse checkpoint identity, ordering and quality remain strict before missing-only reuse', async t => {
    for (const corruption of ['duplicate index', 'wrong time', 'wrong ID', 'wrong fingerprint', 'wrong profile', 'wrong review passes']) {
        const f = await fixture(t, { count: 80 });
        await f.run();
        const directory = path.join(f.dataDir, 'checkpoints');
        for (const name of await fs.readdir(directory)) {
            if (!name.endsWith('.json')) continue;
            const filename = path.join(directory, name); const value = JSON.parse(await fs.readFile(filename, 'utf8'));
            if (value.version !== 2) continue;
            if (corruption === 'duplicate index') value.cueIndexes[1] = value.cueIndexes[0];
            if (corruption === 'wrong time') value.subtitles[0].end += 0.1;
            if (corruption === 'wrong ID') value.subtitles[0].id = 'different';
            if (corruption === 'wrong fingerprint') value.sourceFingerprint = '0'.repeat(64);
            if (corruption === 'wrong profile') value.subtitleQuality = 'fast';
            if (corruption === 'wrong review passes') value.reviewPasses = 1;
            await fs.writeFile(filename, JSON.stringify(value), 'utf8');
        }
        f.calls.length = 0; f.fix();
        const result = await f.run();
        assert.equal(result.subtitleRepairStatus, 'completed', `${corruption}: ${result.subtitleError}`);
        assert.deepEqual(f.calls[0].indexes, Array.from({ length: 80 }, (_, index) => index), corruption);
        await f.drained();
    }
});

test('a short final cue keeps the legacy contiguous progress format until it can be repaired', async t => {
    const f = await fixture(t, { count: 80, bad: [79] });
    const result = await f.run();
    assert.equal(result.subtitleTranslationProgress.version, 1);
    assert.equal(result.subtitleTranslationProgress.completedCues, 79);
    assert.equal(result.subtitleTranslationProgress.cueIndexes, undefined);
    f.calls.length = 0; f.fix(); const complete = await f.run();
    assert.equal(complete.subtitleRepairStatus, 'completed', complete.subtitleError);
    assert.deepEqual(f.calls.map(call => call.indexes), [[79], [79]]); await f.drained();
});

test('v2 partial preservation cannot reconstruct a missing original cue ID before a failed new attempt', async t => {
    let fail = false;
    const f = await fixture(t, { count: 80, handler: (call, state) => {
        if (fail) throw new Error('Owned synthetic 503 service unavailable');
        return state.normalResponse(call);
    } });
    const partial = await f.run(); assertSparse(partial, f.transcript, [20]);
    delete f.record.subtitleTranslationPartial[0].id;
    fail = true; f.calls.length = 0;
    const result = await f.run({ forceTranslation: true });
    assert.equal(result.subtitleRepairStatus, 'failed');
    assert.equal(f.calls.length, 1, 'service errors still stop without retry');
    assert.equal(result.subtitleTranslationPartial?.length || 0, 0, 'the corrupt sparse proof is rejected rather than repaired by adding IDs');
    await f.drained();
});

async function splitSparseCheckpoints(f, { sharedTextConflict = false, termConflict = false, tooManyTerms = false } = {}) {
    const directory = path.join(f.dataDir, 'checkpoints');
    const recordFile = path.join(directory, f.record.id + '-ko.json');
    const saved = JSON.parse(await fs.readFile(recordFile, 'utf8'));
    const cues = new Map(saved.subtitles.map(cue => [cue.index, cue]));
    const branch = (indexes, terms) => ({ ...saved, cueIndexes: indexes, completedCues: indexes.length,
        subtitles: indexes.map(index => ({ ...cues.get(index) })), terms });
    const firstTerms = tooManyTerms ? Array.from({ length: 200 }, (_, index) => ({ source: '合成駅' + index, translation: '합성역' + index }))
        : [{ source: '合成駅', translation: '합성역' }];
    const secondTerms = [{ source: tooManyTerms ? '合成次駅' : termConflict ? '合成駅' : '合成列車',
        translation: termConflict ? '다른역' : '합성열차' }];
    const primary = branch([0, 3], firstTerms);
    const secondary = branch(sharedTextConflict ? [0, 5] : [1, 5], secondTerms);
    if (sharedTextConflict) secondary.subtitles[0].text = koreanText + ' 합성 안내를 확인합니다.';
    await fs.writeFile(recordFile, JSON.stringify(primary), 'utf8');
    const indexFile = (await fs.readdir(directory)).find(name => /-translation-ko-v7\.json$/.test(name));
    assert(indexFile);
    await fs.writeFile(path.join(directory, indexFile), JSON.stringify(secondary), 'utf8');
    return { recordFile, indexFile: path.join(directory, indexFile), primary, secondary };
}

test('compatible sparse record and content checkpoints merge disjoint approved indexes before missing-only requests', async t => {
    const f = await fixture(t, { count: 6, bad: [2, 4] });
    await f.run();
    await splitSparseCheckpoints(f);
    f.calls.length = 0; f.fix();
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.deepEqual(f.calls.map(call => call.indexes), [[2, 4], [2, 4]], 'neither branch re-translates already accepted later cues');
    assert.deepEqual(f.calls[0].input.properNames, [{ source: '合成駅', translation: '합성역' }, { source: '合成列車', translation: '합성열차' }]);
    assert.equal(result.subtitleTranslation.length, 6); await f.drained();
});

for (const conflict of ['term', 'text', 'term capacity']) test(`a sparse checkpoint ${conflict} conflict cannot merge or overwrite its previously accepted proof`, async t => {
    const f = await fixture(t, { count: 6, bad: [2, 4] });
    await f.run();
    const files = await splitSparseCheckpoints(f, { termConflict: conflict === 'term', sharedTextConflict: conflict === 'text', tooManyTerms: conflict === 'term capacity' });
    const before = await fs.readFile(files.indexFile, 'utf8');
    f.calls.length = 0; f.fix();
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.deepEqual(f.calls.map(call => call.indexes), [[1, 2, 4, 5], [1, 2, 4, 5]], 'the conflicting branch is ignored in its entirety');
    assert.equal(await fs.readFile(files.indexFile, 'utf8'), before, 'the private content index does not erase a conflicting text or term decision');
    await f.drained();
});

function retainRecordOnly(f, indexes, textFor = () => koreanText) {
    f.record.subtitleTranslationPartial = indexes.map(index => ({ ...f.transcript[index], text: textFor(index) }));
    f.record.subtitleTranslationProgress = { version: 2, language: 'ko', totalCues: f.transcript.length,
        completedCues: indexes.length, cueIndexes: indexes, complete: false, translationComplete: false,
        sourceComplete: true, sourceProcessed: true, sourceAuditComplete: true,
        sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(f.transcript.map(cue => [cue.id, cue.start, cue.end, cue.text]))).digest('hex') };
}

test('record-only accepted late cue 300 survives alongside a new 80-cue prefix when the next provider request fails', async t => {
    const f = await fixture(t, { count: 400, bad: [], handler: (call, state) => {
        if (!call.review && call.start === 80) throw new Error('Owned synthetic 503 service unavailable');
        return state.normalResponse(call);
    } });
    retainRecordOnly(f, [300]);
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'failed');
    assert.match(result.subtitleError, /503/);
    const expected = [...Array.from({ length: 80 }, (_, index) => index), 300];
    assert.equal(result.subtitleTranslationProgress.version, 2);
    assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, expected);
    assert.equal(result.subtitleTranslationProgress.completedCues, 81);
    assert.equal(result.subtitleTranslationProgress.complete, false);
    assert.equal(result.subtitleTranslationProgress.translationComplete, false);
    assert.equal(result.subtitleTranslationPartial.length, 81);
    result.subtitleTranslationPartial.forEach((cue, offset) => assert.deepEqual([cue.id, cue.start, cue.end],
        [f.transcript[expected[offset]].id, f.transcript[expected[offset]].start, f.transcript[expected[offset]].end]));
    assert.deepEqual(f.calls.map(call => [call.start, call.count, call.review]), [[0, 80, false], [0, 80, true], [80, 80, false]]);
    const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints', f.record.id + '-ko.json'), 'utf8'));
    assert.equal(saved.completedCues, 80, 'retaining a record-only cue never upgrades a translation cache or its review-pass proof');
    assert.equal(saved.reviewPasses, 2);
    await f.drained();
});

test('a failed new attempt preserves older accepted text at an overlapping global index while adding new reviewed indexes', async t => {
    const originalText = '이전에 검수한 합성 열차 안내입니다. 안전선 안쪽에서 기다리고 출발 시간을 확인하세요.';
    const f = await fixture(t, { count: 400, bad: [], handler: (call, state) => {
        if (!call.review && call.start === 80) throw new Error('Owned synthetic 503 service unavailable');
        return state.normalResponse(call);
    } });
    retainRecordOnly(f, [0, 300], index => index === 0 ? originalText : koreanText);
    const result = await f.run();
    assert.equal(result.subtitleTranslationProgress.completedCues, 81);
    assert.equal(result.subtitleTranslationPartial[0].text, originalText, 'the failed attempt cannot replace the previously accepted wording');
    assert.equal(result.subtitleTranslationPartial[1].text.replace(/\s+/g, ' ').trim(), koreanText);
    assert.equal(result.subtitleTranslationProgress.cueIndexes.at(-1), 300);
    assert.equal(f.calls.length, 3); await f.drained();
});

test('a record-retention union covering every index cannot certify completion of the failed current attempt', async t => {
    const f = await fixture(t, { count: 81, bad: [], handler: (call, state) => {
        if (!call.review && call.start === 80) throw new Error('Owned synthetic 503 service unavailable');
        return state.normalResponse(call);
    } });
    retainRecordOnly(f, [80]);
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'failed'); assert.equal(result.status, 'partial');
    assert.equal(result.subtitleTranslationPartial.length, 81);
    assert.equal(result.subtitleTranslationProgress.version, 2);
    assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, Array.from({ length: 81 }, (_, index) => index));
    assert.equal(result.subtitleTranslationProgress.completedCues, 81);
    assert.equal(result.subtitleTranslationProgress.totalCues, 81);
    assert.equal(result.subtitleTranslationProgress.complete, false);
    assert.equal(result.subtitleTranslationProgress.translationComplete, false);
    assert.equal(result.subtitleTranslation, undefined); assert.equal(result.subtitleLanguage, undefined);
    assert.equal(f.calls.length, 3); await f.drained();
});

for (const language of ['ja', undefined]) test(`record-only v2 progress with ${language || 'missing'} language cannot preserve Korean-looking text before a service failure`, async t => {
    const f = await fixture(t, { count: 80, bad: [], handler: () => { throw new Error('Owned synthetic 503 service unavailable'); } });
    retainRecordOnly(f, [20]);
    if (language === undefined) delete f.record.subtitleTranslationProgress.language;
    else f.record.subtitleTranslationProgress.language = language;
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'failed');
    assert.match(result.subtitleError, /503/);
    assert.equal(f.calls.length, 1, 'the service failure starts no replacement request');
    assert.equal(result.subtitleTranslationPartial?.length || 0, 0, 'language metadata is part of the accepted partial proof');
    assert.equal(result.subtitleTranslationProgress.completedCues, 0);
    assert.equal(result.subtitleTranslationProgress.language, 'ko', 'only the current validated empty checkpoint survives');
    await f.drained();
});
