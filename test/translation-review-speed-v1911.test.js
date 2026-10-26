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
const correctedText = '합성 열차가 도착합니다. 안전을 위해 승강장 안쪽에서 기다린 뒤 안내와 출발 시간을 확인해 주세요.';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const fullAnswer = call => ({ subtitles: call.input.subtitles.map(cue => ({ index: cue.index, text: koreanText })), terms: [] });
const sparseAnswer = call => ({ approvedIndexes: call.indexes.slice(), corrections: [], terms: [] });
const answer = call => call.review ? sparseAnswer(call) : fullAnswer(call);
const unwrapped = text => text.replace(/\s+/g, ' ').trim();

async function fixture(t, { count = 80, handler, pipeline = false } = {}) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-sparse-review-v1911-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const transcript = Array.from({ length: count }, (_, index) => ({ id: `owned-sparse-${index}`,
        start: index * 9 + 0.5, end: index * 9 + 7.5, text: sourceText }));
    const duration = count * 9 + 8;
    const record = { id: 'owned-sparse-review-v1911', name: 'owned-synthetic-train.mp4', summary: '보관된 합성 열차 안내',
        transcript, duration, warnings: [], frames: [], transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3',
        transcriptionQuality: { version: 1, recognitionRevision: 3, source: 'audio', profile: 'accurate', model: 'large-v3',
            complete: true, duration, processedUntil: duration, wordTimestamps: true, language: 'ja', languageProbability: 0.99,
            audit: { complete: true, speechSeconds: 10, uncoveredSpeechSeconds: 0, unresolved: [] }, warnings: [] } };
    const calls = [], commits = [], checkpoints = [], diagnostics = [], controller = new AbortController();
    let active = 0, peak = 0;
    const spawnImpl = (binary, args) => {
        assert.equal(binary, 'owned-synthetic-codex');
        assert.equal(args[0], 'exec', 'only owned synthetic responses: no real provider, media, model or login');
        const child = new EventEmitter(), chunks = [], cancelled = deferred();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
        const call = { args, child, cancelled: cancelled.promise, killed: false };
        let closed = false;
        active++; peak = Math.max(peak, active);
        const close = code => { if (!closed) { closed = true; active--; child.emit('close', code); } };
        child.kill = () => { call.killed = true; cancelled.resolve(); queueMicrotask(() => close(null)); };
        child.stdin.on('data', chunk => chunks.push(chunk));
        child.stdin.on('finish', () => queueMicrotask(async () => {
            try {
                call.input = JSON.parse(Buffer.concat(chunks).toString('utf8').split('자료 JSON:\n').at(-1));
                call.indexes = call.input.subtitles.map(cue => cue.index);
                call.start = call.indexes[0]; call.count = call.indexes.length;
                call.review = Boolean(call.input.draftSubtitles);
                call.schema = JSON.parse(await fs.readFile(args[args.indexOf('--output-schema') + 1], 'utf8'));
                calls.push(call);
                const result = handler ? await handler(call, { calls, commits, controller, record }) : undefined;
                if (closed) return;
                call.response = result || answer(call);
                await fs.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(call.response), 'utf8');
                close(0);
            } catch (error) { if (!closed) { child.stderr.write(error.message); close(1); } }
        }));
        return child;
    };
    const provider = createNoKeyProvider({ spawnImpl, platform: 'win32', environment: {
        VIDEORANDOM_CODEX: 'owned-synthetic-codex', ...(pipeline ? {} : { VIDEORANDOM_TRANSLATION_PIPELINE: 'off' }) } });
    const run = settings => provider.translateKoreanOnly(record, { dataDir, subtitleQuality: 'accurate', signal: controller.signal,
        onCheckpoint: value => {
            commits.push(value.subtitleTranslationProgress?.completedCues || 0);
            checkpoints.push(structuredClone({ progress: value.subtitleTranslationProgress,
                cues: value.subtitleTranslationPartial || value.subtitleTranslation || [] }));
        },
        onDiagnostic: value => diagnostics.push(value), ...settings });
    const drained = async () => {
        assert.equal(active, 0, 'all started children have closed before completion or failure is exposed');
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
        assert.deepEqual(await fs.readdir(path.join(dataDir, 'tmp')).catch(() => []), []);
    };
    return { dataDir, transcript, record, calls, commits, checkpoints, diagnostics, controller, run, drained, get peak() { return peak; } };
}

for (const count of [80, 160, 320]) test(`sparse review explicitly approves every one of ${count} accurate cues without regenerating approved text`, async t => {
    const f = await fixture(t, { count });
    const original = structuredClone(f.transcript);
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(f.calls.length, count / 80 * 2, 'every draft still receives an independent full source review');
    assert.equal(result.subtitleTranslation.length, count);
    assert.deepEqual(result.subtitleTranslation.map(cue => [cue.id, cue.start, cue.end]), original.map(cue => [cue.id, cue.start, cue.end]));
    assert(result.subtitleTranslation.every(cue => unwrapped(cue.text) === koreanText));
    assert.deepEqual(f.transcript, original);
    for (const call of f.calls) {
        assert.equal(call.count, 80);
        if (call.review) {
            assert.deepEqual(call.response.approvedIndexes, call.indexes);
            assert.equal(call.input.draftSubtitles.length, call.count);
            assert(call.schema.properties.approvedIndexes, 'the real review request selects the sparse response schema');
            const legacyBytes = Buffer.byteLength(JSON.stringify(fullAnswer(call)));
            const sparseBytes = Buffer.byteLength(JSON.stringify(call.response));
            assert(legacyBytes / sparseBytes > 20, 'synthetic unchanged-review response bytes fall by more than 20×; this is not a wall-time claim');
        } else assert(call.schema.properties.subtitles, 'the initial translation remains a complete normal draft');
    }
    const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints', f.record.id + '-ko.json'), 'utf8'));
    assert.equal(saved.translationVersion, TRANSLATION_PROMPT_VERSION); assert.equal(TRANSLATION_PROMPT_VERSION, 10);
    assert.equal(saved.reviewPasses, 2); assert.equal(saved.completedCues, count);
    await f.drained();
});

test('sparse review substitutes only explicit corrections and preserves every approved draft and original time', async t => {
    const corrected = new Set([0, 37, 79]);
    const f = await fixture(t, { handler: call => {
        if (!call.review) return fullAnswer(call);
        return { approvedIndexes: call.indexes.filter(index => !corrected.has(index)),
            corrections: call.indexes.filter(index => corrected.has(index)).map(index => ({ index, text: correctedText })), terms: [] };
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(f.calls.length, 2);
    result.subtitleTranslation.forEach((cue, index) => {
        assert.equal(unwrapped(cue.text), corrected.has(index) ? correctedText : koreanText);
        assert.deepEqual([cue.id, cue.start, cue.end], [f.transcript[index].id, f.transcript[index].start, f.transcript[index].end]);
    });
    await f.drained();
});

test('partially missing sparse approvals use one existing targeted review and never treat an absent approval as acceptance', async t => {
    const f = await fixture(t, { handler: call => {
        const result = answer(call);
        if (call.review && call.count === 80) result.approvedIndexes = result.approvedIndexes.filter(index => ![20, 72].includes(index));
        return result;
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.deepEqual(f.calls.map(call => [call.review, call.indexes]), [[false, Array.from({ length: 80 }, (_, index) => index)],
        [true, Array.from({ length: 80 }, (_, index) => index)], [true, [20, 72]]]);
    const confirmed = Array.from({ length: 80 }, (_, index) => index).filter(index => ![20, 72].includes(index));
    const beforeCorrection = f.checkpoints.find(value => value.progress?.completedCues === 78);
    assert.deepEqual(beforeCorrection?.progress.cueIndexes, confirmed, 'only the exact explicitly approved indexes become durable before correction');
    assert.deepEqual(beforeCorrection.cues.map(cue => [cue.id, cue.start, cue.end]),
        confirmed.map(index => f.transcript[index]).map(cue => [cue.id, cue.start, cue.end]));
    assert(beforeCorrection.cues.every(cue => unwrapped(cue.text) === koreanText));
    assert.equal(result.subtitleTranslation.length, 80);
    await f.drained();
});

test('a repeatedly unapproved sparse cue remains pending while every explicitly approved neighbor is retained', async t => {
    const f = await fixture(t, { handler: call => {
        const result = answer(call);
        if (call.review) result.approvedIndexes = result.approvedIndexes.filter(index => index !== 20);
        return result;
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'partial');
    assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
    assert.equal(f.calls.length, 3, 'an absent approval is not silently accepted or recursively retried');
    const confirmed = Array.from({ length: 80 }, (_, index) => index).filter(index => index !== 20);
    assert.equal(result.subtitleTranslationPartial.length, 79);
    assert.equal(result.subtitleTranslationProgress.version, 2);
    assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, confirmed);
    assert.equal(result.subtitleTranslationProgress.complete, false);
    assert.equal(result.subtitleTranslationProgress.translationComplete, false);
    assert.deepEqual(result.subtitleTranslationPartial.map(cue => [cue.id, cue.start, cue.end]),
        confirmed.map(index => f.transcript[index]).map(cue => [cue.id, cue.start, cue.end]));
    assert(result.subtitleTranslationPartial.every(cue => unwrapped(cue.text) === koreanText));
    assert.deepEqual(f.calls.at(-1).indexes, [20]);
    assert.equal(result.subtitleTranslation, undefined);
    await f.drained();
});

test('empty sparse approval and correction arrays cannot certify an unchecked batch', async t => {
    const f = await fixture(t, { handler: call => call.review ? { approvedIndexes: [], corrections: [], terms: [] } : fullAnswer(call) });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'partial');
    assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
    const corrections = f.calls.slice(2);
    assert.equal(corrections.length, 64, 'valid empty reviews use only the shared bounded correction budget');
    assert(corrections.every(call => call.review && call.count <= 20));
    assert.deepEqual(corrections.filter(call => call.count === 20).map(call => call.indexes),
        Array.from({ length: 4 }, (_, group) => Array.from({ length: 20 }, (_, index) => group * 20 + index)));
    assert.deepEqual(corrections.filter(call => call.count === 1).map(call => call.indexes[0]),
        Array.from({ length: 60 }, (_, index) => index), 'only missing rows receive one singleton correction and the remaining rows are not retried beyond budget');
    assert(f.diagnostics.some(event => event.code === 'SUBTITLE_REPAIR_LIMIT' && event.level === 'warning'));
    assert.equal(result.subtitleTranslationProgress.complete, false);
    assert.equal(result.subtitleTranslationProgress.translationComplete, false);
    assert.equal(result.subtitleTranslation, undefined);
    assert.equal(result.subtitleTranslationPartial?.length || 0, 0);
    await f.drained();
});

test('explicit sparse review can approve a short Korean draft after independently checking the full source', async t => {
    const f = await fixture(t, { handler: call => {
        const result = answer(call);
        if (!call.review) result.subtitles.find(cue => cue.index === 20).text = '네.';
        return result;
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(f.calls.length, 2, 'a length difference alone does not trigger another provider request');
    assert.deepEqual(f.calls[1].input.omissionCheckIndexes, [20]);
    assert.equal(f.calls[1].input.subtitles.find(cue => cue.index === 20).text, sourceText);
    assert.equal(f.calls[1].input.draftSubtitles.find(cue => cue.index === 20).text, '네.');
    assert.equal(result.subtitleTranslation.length, 80);
    assert.equal(unwrapped(result.subtitleTranslation[20].text), '네.');
    assert.deepEqual(result.subtitleTranslation.map(cue => [cue.id, cue.start, cue.end]), f.transcript.map(cue => [cue.id, cue.start, cue.end]));
    assert(f.diagnostics.some(event => event.code === 'SUBTITLE_LENGTH_REVIEW' && event.level === 'warning'));
    await f.drained();
});

test('an independent sparse review can replace a short draft without requesting an extra correction', async t => {
    const f = await fixture(t, { handler: call => {
        const result = answer(call);
        if (!call.review) result.subtitles.find(cue => cue.index === 20).text = '네.';
        if (call.review) return { approvedIndexes: call.indexes.filter(index => index !== 20),
            corrections: [{ index: 20, text: koreanText }], terms: [] };
        return result;
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(f.calls.length, 2);
    assert(result.subtitleTranslation.every(cue => unwrapped(cue.text) === koreanText));
    await f.drained();
});

test('sparse approval still requires explicit review confirmation for draft proper names', async t => {
    const f = await fixture(t, { handler: call => {
        const result = answer(call);
        if (!call.review) result.terms = [{ source: '太郎', translation: '타로' }];
        return result;
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'partial');
    assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
    assert.equal(f.calls.length, 3);
    assert.equal(result.subtitleTranslationPartial?.length || 0, 0);
    await f.drained();
});

test('sparse corrections cannot change a proper name confirmed by a previous durable batch', async t => {
    const f = await fixture(t, { count: 160, handler: call => {
        const result = answer(call);
        result.terms = [{ source: '太郎', translation: call.review && call.start === 80 ? '다로' : '타로' }];
        return result;
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'partial');
    assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
    assert.equal(f.calls.length, 5);
    assert.equal(result.subtitleTranslationPartial.length, 80);
    await f.drained();
});

test('a refusal carried in a sparse correction preserves text provenance and immediately stops', async t => {
    const f = await fixture(t, { handler: call => call.review ? {
        approvedIndexes: call.indexes.filter(index => index !== 20),
        corrections: [{ index: 20, text: '해당 요청의 자막 번역을 제공할 수 없습니다.' }], terms: [] } : fullAnswer(call) });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'failed');
    assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_REFUSAL_TEXT_DETECTED');
    assert.equal(result.subtitleDiagnostic.refusalSource, 'subtitle-text');
    assert.equal(f.calls.length, 2);
    assert.equal(result.subtitleTranslationPartial?.length || 0, 0);
    await f.drained();
});

for (const failure of ['response refusal', '401 authentication failed', '503 service unavailable', 'execution timeout']) {
    test(`sparse review ${failure} stops without another batch or correction request`, async t => {
        const f = await fixture(t, { count: 160, handler: call => {
            if (call.review) {
                if (failure === 'response refusal') return { refusal: true };
                throw new Error(`Owned synthetic ${failure}`);
            }
            return fullAnswer(call);
        } });
        const result = await f.run();
        assert.equal(result.subtitleRepairStatus, 'failed');
        assert.equal(f.calls.length, 2);
        assert.equal(result.subtitleTranslationPartial?.length || 0, 0);
        if (failure === 'response refusal') {
            assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_PROVIDER_REFUSAL');
            assert.equal(result.subtitleDiagnostic.refusalSource, 'response-field');
        } else assert(result.subtitleError.includes(failure));
        await f.drained();
    });
}

test('a sparse review refusal cancels and drains an already started lookahead draft while keeping the warmup prefix', async t => {
    const nextDraftReady = deferred();
    const f = await fixture(t, { count: 320, pipeline: true, handler: async call => {
        if (!call.review && call.start === 160) { nextDraftReady.resolve(); await call.cancelled; }
        if (call.review && call.start === 80) { await nextDraftReady.promise; return { refusal: true }; }
        return answer(call);
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'failed');
    assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_PROVIDER_REFUSAL');
    assert.equal(result.subtitleTranslationPartial.length, 80);
    assert.equal(f.peak, 2);
    assert.equal(f.calls.length, 5);
    assert(f.calls.find(call => call.start === 160 && !call.review).killed);
    assert(!f.calls.some(call => call.start > 160 || call.start === 160 && call.review));
    await f.drained();
});

test('parent cancellation during sparse review kills and drains its child before returning', async t => {
    const f = await fixture(t, { handler: (call, state) => {
        if (call.review) state.controller.abort();
        return answer(call);
    } });
    await assert.rejects(f.run(), { name: 'AbortError' });
    assert.equal(f.calls.length, 2);
    assert(f.calls.at(-1).killed);
    assert.equal(f.record.subtitleTranslationPartial?.length || 0, 0);
    await f.drained();
});

for (const version of [6, 8]) test(`an exact v${version} fully reviewed checkpoint migrates to the current contract without any new translation or review request`, async t => {
    const f = await fixture(t);
    const sourceFingerprint = crypto.createHash('sha256').update(JSON.stringify(f.transcript.map(cue => [cue.id, cue.start, cue.end, cue.text]))).digest('hex');
    const saved = { version: 1, translationVersion: version, targetLanguage: 'ko', subtitleQuality: 'accurate', reviewPasses: 2,
        language: 'ko', sourceFingerprint, totalCues: 80, completedCues: 80, sourceComplete: true, sourceProcessed: true,
        sourceAuditComplete: true, complete: true, translationComplete: true,
        subtitles: f.transcript.map((cue, index) => ({ index, id: cue.id, start: cue.start, end: cue.end, text: koreanText })), terms: [] };
    const checkpointDir = path.join(f.dataDir, 'checkpoints');
    await fs.mkdir(checkpointDir, { recursive: true });
    const indexId = crypto.createHash('sha256').update(`videorandom-subtitles\0${version}\0ko\0accurate\0${sourceFingerprint}`).digest('hex');
    await fs.writeFile(path.join(checkpointDir, `${indexId}-translation-ko-v${version}.json`), JSON.stringify(saved), 'utf8');
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(f.calls.length, 0, 'only exact final accepted source, timing, ID, profile and review-pass matches are reusable');
    assert.equal(result.subtitleTranslation.length, 80);
    assert(result.subtitleTranslation.every(cue => unwrapped(cue.text) === koreanText));
    const migrated = JSON.parse(await fs.readFile(path.join(checkpointDir, f.record.id + '-ko.json'), 'utf8'));
    assert.equal(migrated.translationVersion, TRANSLATION_PROMPT_VERSION); assert.equal(migrated.reviewPasses, 2); assert.equal(migrated.completedCues, 80);
    await f.drained();
});
