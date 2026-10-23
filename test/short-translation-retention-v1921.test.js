const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter, getEventListeners } = require('node:events');
const { PassThrough } = require('node:stream');
const { createNoKeyProvider, TRANSLATION_PROMPT_VERSION } = require('../lib/no-key-provider');

const sourceText = 'このホームに到着した列車から別の路線の列車に乗り換えるための連絡通路は、こちらの方向にあります。';
const shortKorean = '환승은 이쪽.';
const longKorean = '다른 노선의 열차로 갈아타시려면 이쪽 연결 통로로 이동하세요.';
const fingerprint = source => crypto.createHash('sha256').update(JSON.stringify(source.map(cue => [cue.id, cue.start, cue.end, cue.text]))).digest('hex');
const lengthWarnings = record => record.warnings.filter(warning => typeof warning === 'string' && warning.startsWith('원문과 번역의 길이 차이가 큰 자막 '));

async function fixture(t, { count = 81, profile = 'accurate', reviewShape = 'compact', shortIndexes,
    sourceComplete = true, handler } = {}) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-short-retention-v1921-'));
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
        await fs.rm(dataDir, { recursive: true, force: true });
    });
    const transcript = Array.from({ length: count }, (_, index) => ({ id: `owned-short-${index}`,
        start: index * 6 + 0.125, end: index * 6 + 4.875, text: sourceText }));
    const duration = count * 6 + 5;
    const record = { id: 'owned-short-retention-v1921', name: 'owned-synthetic-interchange.mp4', duration,
        transcript, transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3',
        summary: '보관된 합성 환승 안내', frames: [], warnings: [],
        transcriptionQuality: { version: 1, recognitionRevision: 3, source: 'audio', profile: 'accurate', model: 'large-v3',
            complete: sourceComplete, processingComplete: sourceComplete, duration, processedUntil: duration, wordTimestamps: true,
            language: 'ja', languageProbability: 0.99, audit: { complete: sourceComplete,
                speechSeconds: 10, uncoveredSpeechSeconds: sourceComplete ? 0 : 1,
                unresolved: sourceComplete ? [] : [{ start: 1, end: 2, reason: 'uncovered speech' }] }, warnings: [] } };
    const short = new Set(shortIndexes || transcript.map((_, index) => index));
    const calls = [], diagnostics = [], controller = new AbortController();
    let active = 0, summaryCalls = 0;
    const normal = call => call.review && reviewShape === 'compact'
        ? { approvedIndexes: call.indexes.slice(), corrections: [], terms: [] }
        : { subtitles: call.indexes.map(index => ({ index, text: short.has(index) ? shortKorean : longKorean })), terms: [] };
    const spawnImpl = (binary, args) => {
        assert(['owned-synthetic-codex', 'owned-synthetic-python'].includes(binary));
        const child = new EventEmitter(), chunks = [];
        child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        let closed = false;
        active++;
        const close = code => { if (!closed) { closed = true; active--; child.emit('close', code); } };
        child.kill = () => queueMicrotask(() => close(null));
        child.stdin.on('data', chunk => chunks.push(chunk));
        child.stdin.on('finish', () => queueMicrotask(async () => {
            try {
                if (args.includes('login')) { child.stderr.write('Logged in using ChatGPT\n'); close(0); return; }
                if (args.includes('import faster_whisper; print("ready")')) { child.stdout.write('ready\n'); close(0); return; }
                assert.equal(args[0], 'exec', 'all responses are synthetic; no actual recognition, media or model execution');
                const schema = JSON.parse(await fs.readFile(args[args.indexOf('--output-schema') + 1], 'utf8'));
                if (schema.properties.summary) {
                    summaryCalls++;
                    await fs.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify({
                        summary: '합성 환승 통로 안내입니다.', plot: '다른 노선으로 갈아타는 통로를 안내합니다.',
                        dialogueSummary: '환승 통로의 방향을 안내합니다.', labels: ['환승'],
                        frames: record.frames.map((_, index) => ({ index, caption: '합성 환승 안내 표본입니다.' })), limitations: [] }), 'utf8');
                    close(0); return;
                }
                const input = JSON.parse(Buffer.concat(chunks).toString('utf8').split('자료 JSON:\n').at(-1));
                const call = { input, indexes: input.subtitles.map(cue => cue.index), review: Boolean(input.draftSubtitles) };
                call.start = call.indexes[0]; call.count = call.indexes.length; calls.push(call);
                const response = handler ? await handler(call, { normal, controller, calls }) : normal(call);
                if (closed) return;
                await fs.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(response), 'utf8');
                close(0);
            } catch (error) { if (!closed) { child.stderr.write(error.message); close(1); } }
        }));
        return child;
    };
    const provider = createNoKeyProvider({ spawnImpl, platform: 'win32', environment: {
        VIDEORANDOM_CODEX: 'owned-synthetic-codex', VIDEORANDOM_PYTHON: 'owned-synthetic-python', VIDEORANDOM_TRANSLATION_PIPELINE: 'off' } });
    const run = options => provider.translateKoreanOnly(record, { dataDir, subtitleQuality: profile,
        signal: controller.signal, onDiagnostic: event => diagnostics.push(event), ...options });
    const drained = async () => {
        assert.equal(active, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
        assert.deepEqual(await fs.readdir(path.join(dataDir, 'tmp')).catch(() => []), []);
    };
    const analyze = options => provider.analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko', subtitleQuality: profile,
        signal: controller.signal, onDiagnostic: event => diagnostics.push(event), ...options });
    return { dataDir, record, transcript, calls, diagnostics, run, analyze, drained, get summaryCalls() { return summaryCalls; } };
}

for (const [profile, reviewShape] of [['accurate', 'compact'], ['accurate', 'full'], ['fast', 'full'], ['turbo', 'full']]) {
    test(`${profile} ${reviewShape} keeps concise valid Korean and reuses its exact complete checkpoint`, async t => {
        const f = await fixture(t, { profile, reviewShape });
        const original = structuredClone(f.transcript);
        const result = await f.run();
        assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
        assert.equal(result.subtitleError, null); assert.equal(result.subtitleDiagnostic, undefined);
        assert.equal(result.subtitleTranslation.length, 81);
        assert(result.subtitleTranslation.every(cue => cue.text === shortKorean));
        assert.deepEqual(result.subtitleTranslation.map(cue => [cue.id, cue.start, cue.end]),
            original.map(cue => [cue.id, cue.start, cue.end]));
        assert.deepEqual(f.transcript, original);
        assert.equal(f.calls.length, profile === 'accurate' ? 4 : 2, 'length alone starts no correction request');
        assert.equal(f.calls.filter(call => call.review).length, profile === 'accurate' ? 2 : 0);
        if (profile === 'accurate') assert.deepEqual(f.calls[1].input.omissionCheckIndexes,
            Array.from({ length: 80 }, (_, index) => index), 'the normal source review still checks a concise draft');
        assert(f.diagnostics.some(event => event.code === 'SUBTITLE_LENGTH_REVIEW' && event.level === 'warning'));
        assert(f.record.warnings.some(warning => warning.includes('길이 차이') && warning.includes('보관')));
        assert(!f.diagnostics.some(event => ['SUBTITLE_REVIEW_TOO_SHORT', 'SUBTITLE_TEXT_TOO_SHORT'].includes(event.code)));
        const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints', f.record.id + '-ko.json'), 'utf8'));
        assert.equal(saved.translationVersion, TRANSLATION_PROMPT_VERSION); assert.equal(saved.reviewPasses, profile === 'accurate' ? 2 : 1);
        const count = f.calls.length;
        const resumed = await f.run();
        assert.equal(resumed.subtitleRepairStatus, 'completed', resumed.subtitleError);
        assert.equal(f.calls.length, count, 'an accepted concise checkpoint is not discarded by the length heuristic');
        assert.deepEqual(resumed.subtitleTranslation, result.subtitleTranslation);
        await f.drained();
    });
}

test('a 2,215-cue translation keeps all nine concise final cues after explicit review', async t => {
    const finalIndexes = Array.from({ length: 9 }, (_, offset) => 2206 + offset);
    const f = await fixture(t, { count: 2215, shortIndexes: finalIndexes });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(result.subtitleTranslationProgress.completedCues, 2215);
    assert.equal(result.subtitleTranslationProgress.translationComplete, true);
    assert.equal(result.subtitleTranslationProgress.complete, true);
    assert.equal(result.subtitleTranslation.length, 2215);
    assert.equal(f.calls.length, 56, '28 source batches each receive one draft and one review, with no length correction');
    assert.deepEqual(f.calls.at(-1).input.omissionCheckIndexes, finalIndexes);
    for (const index of finalIndexes) assert.deepEqual(result.subtitleTranslation[index], {
        id: f.transcript[index].id, start: f.transcript[index].start, end: f.transcript[index].end, text: shortKorean });
    await f.drained();
});

test('a concise explicit correction is retained with surrounding Korean and an independently missing cue stays pending', async t => {
    const f = await fixture(t, { count: 3, handler: (call, { normal }) => {
        if (!call.review) return normal(call);
        if (call.count === 3) return { approvedIndexes: [0], corrections: [{ index: 1, text: shortKorean }], terms: [] };
        return { approvedIndexes: [], corrections: [], terms: [] };
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'partial'); assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
    assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, undefined, 'the retained two cues form a contiguous prefix');
    assert.equal(result.subtitleTranslationPartial.length, 2);
    assert(result.subtitleTranslationPartial.every(cue => cue.text === shortKorean));
    assert.deepEqual(f.calls.map(call => call.indexes), [[0, 1, 2], [0, 1, 2], [2]]);
    assert.equal(result.subtitleTranslationProgress.translationComplete, false);
    await f.drained();
});

test('short Korean cannot certify source speech that still needs review', async t => {
    const f = await fixture(t, { count: 1, sourceComplete: false });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed'); assert.equal(result.status, 'partial');
    assert.equal(result.subtitleTranslationProgress.translationComplete, true);
    assert.equal(result.subtitleTranslationProgress.sourceComplete, false);
    assert.equal(result.subtitleTranslationProgress.complete, false);
    assert.equal(result.subtitleTranslation, undefined); assert.equal(result.subtitleTranslationPartial[0].text, shortKorean);
    await f.drained();
});

test('full analysis keeps concise reviewed Korean and its warning without declaring a subtitle error', async t => {
    const f = await fixture(t, { count: 81 });
    const framesDir = path.join(f.dataDir, 'frames', f.record.id);
    await fs.mkdir(framesDir, { recursive: true });
    await fs.writeFile(path.join(framesDir, 'owned-frame.jpg'), 'inert synthetic frame bytes; never decoded');
    f.record.frames = [{ timestamp: 1, filename: 'owned-frame.jpg' }];
    const result = await f.analyze();
    assert.equal(f.summaryCalls, 1);
    assert.equal(f.calls.length, 4);
    assert.equal(result.status, 'completed', result.error || result.subtitleError);
    assert.equal(result.subtitleTranslation.length, 81);
    assert(result.subtitleTranslation.every(cue => cue.text === shortKorean));
    assert.equal(result.subtitleError, null);
    assert.equal(result.subtitleDiagnostic, undefined);
    assert(result.warnings.some(warning => warning.includes('길이 차이') && warning.includes('보관')));
    await f.drained();
});

test('a later shared error preserves the earlier concise checkpoint and advisory without certifying the failed attempt', async t => {
    const f = await fixture(t, { count: 160, handler: (call, { normal }) => {
        if (!call.review && call.start === 80) throw new Error('Owned synthetic 503 service unavailable');
        return normal(call);
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'failed'); assert.equal(f.calls.length, 3);
    assert.equal(result.subtitleDiagnostic.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(result.subtitleTranslationPartial.length, 80);
    assert(result.subtitleTranslationPartial.every(cue => cue.text === shortKorean));
    assert(result.warnings.some(warning => warning.includes('길이 차이') && warning.includes('보관')));
    assert.equal(result.subtitleTranslationProgress.translationComplete, false);
    await f.drained();
});

test('a failed forced replacement counts concise cues in the retained old complete subtitles rather than its discarded draft', async t => {
    const f = await fixture(t, { count: 81, shortIndexes: [0], handler: (call, { normal }) => {
        if (!call.review && call.start === 80) throw new Error('Owned synthetic 503 service unavailable');
        return normal(call);
    } });
    const old = f.transcript.map((cue, index) => ({ ...cue, text: [0, 80].includes(index) ? shortKorean : longKorean }));
    f.record.subtitleTranslation = structuredClone(old);
    f.record.subtitleLanguage = 'ko';
    f.record.subtitleTranslationProgress = { version: 1, language: 'ko', sourceFingerprint: fingerprint(f.transcript),
        totalCues: 81, completedCues: 81, complete: true, translationComplete: true,
        sourceComplete: true, sourceProcessed: true, sourceAuditComplete: true };
    const result = await f.run({ forceTranslation: true });
    assert.equal(result.subtitleRepairStatus, 'failed');
    assert.equal(result.subtitleDiagnostic.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(f.calls.length, 3);
    assert.deepEqual(result.subtitleTranslation, old, 'a failed new attempt preserves the old complete output');
    assert.equal(result.subtitleLanguage, 'ko');
    assert.equal(result.subtitleTranslationProgress.complete, true);
    assert.equal(result.subtitleTranslationProgress.sourceComplete, true);
    assert.equal(lengthWarnings(result).length, 1);
    assert.match(lengthWarnings(result)[0], /자막 2구간/);
    assert.doesNotMatch(lengthWarnings(result)[0], /자막 1구간/);
    await f.drained();
});

test('a failed attempt counts concise cues across the exposed old sparse and newly reviewed union', async t => {
    const f = await fixture(t, { count: 161, shortIndexes: [0], handler: (call, { normal }) => {
        if (!call.review && call.start === 80) throw new Error('Owned synthetic 503 service unavailable');
        return normal(call);
    } });
    f.record.subtitleTranslationPartial = [{ ...f.transcript[160], text: shortKorean }];
    f.record.subtitleTranslationProgress = { version: 2, language: 'ko', sourceFingerprint: fingerprint(f.transcript),
        totalCues: 161, completedCues: 1, cueIndexes: [160], complete: false, translationComplete: false,
        sourceComplete: true, sourceProcessed: true, sourceAuditComplete: true };
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'failed');
    assert.equal(result.subtitleDiagnostic.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(f.calls.length, 3);
    assert.equal(result.subtitleTranslation, undefined);
    assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, [...Array.from({ length: 80 }, (_, index) => index), 160]);
    assert.equal(result.subtitleTranslationPartial.length, 81);
    assert.equal(result.subtitleTranslationPartial[0].text, shortKorean);
    assert.equal(result.subtitleTranslationPartial.at(-1).text, shortKorean);
    assert.equal(result.subtitleTranslationProgress.complete, false);
    assert.equal(result.subtitleTranslationProgress.translationComplete, false);
    assert.equal(result.subtitleTranslationProgress.sourceComplete, true);
    assert.equal(lengthWarnings(result).length, 1);
    assert.match(lengthWarnings(result)[0], /자막 2구간/);
    await f.drained();
});

test('a successful concise repair clears old failure warnings instead of merging them back from its working copy', async t => {
    const f = await fixture(t, { count: 1 });
    const oldFailure = '한국어 자막 번역 복구를 완료하지 못했습니다. 보관된 원문과 기존 자막은 유지했습니다. Owned synthetic old unavailable';
    const oldAnalysisFailure = '한국어 자막을 완료하지 못했습니다. 원문 대사와 시간 정보는 보관했습니다. Owned synthetic old short failure';
    const oldLengthFailure = '길이 보완 뒤에도 원문 의미의 누락이 의심되는 자막 1구간은 따로 보관했습니다.';
    f.record.warnings = [oldFailure, oldAnalysisFailure, oldLengthFailure, '보관된 별도 참고 안내'];
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(result.subtitleError, null);
    assert.equal(result.subtitleTranslationProgress.complete, true);
    assert.equal(result.subtitleTranslationProgress.sourceComplete, true);
    assert.equal(result.subtitleTranslation[0].text, shortKorean);
    assert(!result.warnings.includes(oldFailure)); assert(!result.warnings.includes(oldAnalysisFailure));
    assert(!result.warnings.includes(oldLengthFailure)); assert(result.warnings.includes('보관된 별도 참고 안내'));
    assert.equal(lengthWarnings(result).length, 1);
    assert.match(lengthWarnings(result)[0], /자막 1구간/);
    await f.drained();
});

for (const failure of ['response refusal', '401 authentication failed', 'quota usage limit', '503 service unavailable',
    'execution timeout', 'ECONNRESET network failure', 'invalid root shape']) {
    test(`a concise draft does not bypass ${failure} or start an automatic retry`, async t => {
        const f = await fixture(t, { count: 80, handler: (call, { normal }) => {
            if (!call.review) return normal(call);
            if (failure === 'response refusal') return { refusal: true };
            if (failure === 'invalid root shape') return { approvedIndexes: null, corrections: [], terms: [] };
            throw new Error('Owned synthetic ' + failure);
        } });
        const result = await f.run();
        assert.equal(result.subtitleRepairStatus, 'failed'); assert.equal(f.calls.length, 2);
        assert.equal(result.subtitleTranslation, undefined); assert.equal(result.subtitleTranslationPartial?.length || 0, 0);
        assert.notEqual(result.subtitleTranslationProgress?.translationComplete, true);
        await f.drained();
    });
}

for (const failure of ['invalid index', 'empty cue']) {
    test(`a concise draft isolates an ${failure} and retains its explicitly approved tail`, async t => {
        const f = await fixture(t, { count: 81, handler: (call, { normal }) => {
            if (!call.review || !call.indexes.includes(0)) return normal(call);
            const approvedIndexes = call.indexes.filter(index => index !== 0);
            return failure === 'invalid index'
                ? { approvedIndexes: [...approvedIndexes, 99999], corrections: [], terms: [] }
                : { approvedIndexes, corrections: [{ index: 0, text: '' }], terms: [] };
        } });
        const result = await f.run();
        assert.equal(result.subtitleRepairStatus, 'partial'); assert.equal(result.subtitleError, null);
        assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
        assert.equal(result.subtitleTranslationProgress.processingComplete, true);
        assert.equal(result.subtitleTranslationProgress.processedCues, 81);
        assert.equal(result.subtitleTranslationProgress.completedCues, 80);
        assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, Array.from({ length: 80 }, (_, index) => index + 1));
        assert(result.subtitleTranslationPartial.every(cue => cue.text === shortKorean));
        assert.deepEqual(result.subtitleTranslationPartial.map(cue => [cue.id, cue.start, cue.end]),
            f.transcript.slice(1).map(cue => [cue.id, cue.start, cue.end]));
        assert.equal(f.calls.length, 5, 'one malformed cue is corrected once and the final batch is still reviewed');
        assert(f.calls.some(call => call.review && call.start === 80));
        await f.drained();
    });
}
