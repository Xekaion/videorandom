const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, getEventListeners } = require('node:events');
const { PassThrough } = require('node:stream');
const { createNoKeyProvider, TRANSLATION_PROMPT_VERSION } = require('../lib/no-key-provider');

const sourceText = '合成の列車が到着します。安全のためにホームの内側で待ち、案内と出発時間を確認してください。';
const translatedText = '합성 열차가 도착합니다. 안전을 위해 승강장 안쪽에서 기다리고 안내와 출발 시간을 확인하세요.';
const answer = call => ({ subtitles: call.input.subtitles.map(cue => ({ index: cue.index, text: translatedText })), terms: [] });

async function fixture(t, { count = 80, handler, environment = {} } = {}) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-translation-completion-v199-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const transcript = Array.from({ length: count }, (_, index) => ({ id: `owned-${index}`, start: index * 9 + 0.5,
        end: index * 9 + 7.5, text: sourceText }));
    const duration = count * 9 + 8;
    const record = { id: 'owned-completion-v199', name: 'owned-synthetic-train.mp4', summary: '보관된 합성 열차 안내',
        transcript, duration, warnings: [], frames: [], transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3',
        transcriptionQuality: { version: 1, recognitionRevision: 3, source: 'audio', profile: 'accurate', model: 'large-v3',
            complete: true, duration, processedUntil: duration, wordTimestamps: true, language: 'ja', languageProbability: 0.99,
            audit: { complete: true, speechSeconds: 10, uncoveredSpeechSeconds: 0, unresolved: [] }, warnings: [] } };
    const calls = [], commits = [], checkpoints = [], diagnostics = [], progress = [], controller = new AbortController();
    let active = 0;
    const spawnImpl = (binary, args) => {
        assert.equal(binary, 'owned-synthetic-codex');
        assert.equal(args[0], 'exec', 'only synthetic translation responses; no real media, provider, model or login');
        const child = new EventEmitter(), chunks = [];
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
        const call = { args, child, killed: false };
        let closed = false;
        active++;
        const close = code => { if (!closed) { closed = true; active--; child.emit('close', code); } };
        child.kill = () => { call.killed = true; queueMicrotask(() => close(null)); };
        child.stdin.on('data', chunk => chunks.push(chunk));
        child.stdin.on('finish', () => queueMicrotask(async () => {
            try {
                call.input = JSON.parse(Buffer.concat(chunks).toString('utf8').split('자료 JSON:\n').at(-1));
                call.indexes = call.input.subtitles.map(cue => cue.index);
                call.start = call.indexes[0]; call.count = call.indexes.length; call.review = Boolean(call.input.draftSubtitles);
                calls.push(call);
                const result = handler ? await handler(call, { calls, commits, controller, record }) : undefined;
                if (closed) return;
                await fs.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(result || answer(call)), 'utf8');
                close(0);
            } catch (error) { if (!closed) { child.stderr.write(error.message); close(1); } }
        }));
        return child;
    };
    const provider = createNoKeyProvider({ spawnImpl, platform: 'win32', environment: { VIDEORANDOM_CODEX: 'owned-synthetic-codex',
        VIDEORANDOM_TRANSLATION_PIPELINE: 'off', ...environment } });
    const run = settings => provider.translateKoreanOnly(record, { dataDir, subtitleQuality: 'accurate', signal: controller.signal,
        onCheckpoint: value => {
            commits.push(value.subtitleTranslationProgress?.completedCues || 0);
            checkpoints.push(structuredClone({ progress: value.subtitleTranslationProgress,
                cues: value.subtitleTranslationPartial || value.subtitleTranslation || [] }));
        },
        onDiagnostic: value => diagnostics.push(value), onProgress: (stage, percent, details) => progress.push({ stage, percent, details }), ...settings });
    const drained = async () => {
        assert.equal(active, 0);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
        assert.deepEqual(await fs.readdir(path.join(dataDir, 'tmp')).catch(() => []), []);
    };
    return { dataDir, transcript, record, calls, commits, checkpoints, diagnostics, progress, controller, run, drained };
}

test('separate batches and a final seventeen-cue batch keep explicitly reviewed concise cues without extra requests', async t => {
    const flagged = new Set([12, 109, 176]);
    const f = await fixture(t, { count: 177, handler: call => {
        const result = answer(call);
        if (call.review && call.count > 1) for (const cue of result.subtitles) if (flagged.has(cue.index)) cue.text = '네.';
        return result;
    } });
    const original = structuredClone(f.transcript);
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(f.calls.length, 6, 'only six ordinary draft/review calls; length alone requires no correction');
    assert.deepEqual(result.subtitleTranslation.map(cue => [cue.id, cue.start, cue.end]), original.map(cue => [cue.id, cue.start, cue.end]));
    assert(result.subtitleTranslation.every((cue, index) => cue.text.replace(/\n/g, ' ') === (flagged.has(index) ? '네.' : translatedText)));
    assert.deepEqual(f.transcript, original);
    assert.equal(result.subtitleTranslation.length, 177, 'prefix checkpointing never duplicates a retained cue');
    await f.drained();
});

test('mixed missing and short cues repair only missing indexes while concise accurate drafts still receive full review', async t => {
    const f = await fixture(t, { handler: call => {
        const result = answer(call);
        if (!call.review && call.count === 80) { result.subtitles = result.subtitles.filter(cue => cue.index !== 70); result.subtitles[10].text = '네.'; }
        if (call.review && call.count === 80) { result.subtitles = result.subtitles.filter(cue => cue.index !== 72); result.subtitles[20].text = '네.'; }
        return result;
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.deepEqual(f.calls.map(call => [call.review, call.indexes]), [[false, Array.from({ length: 80 }, (_, i) => i)],
        [false, [70]], [true, Array.from({ length: 80 }, (_, i) => i)], [true, [72]]]);
    assert.deepEqual(f.calls[2].input.omissionCheckIndexes, [10], 'the short draft goes through normal source review');
    assert.equal(result.subtitleTranslation.length, 80);
    const confirmed = Array.from({ length: 80 }, (_, index) => index).filter(index => index !== 72);
    const beforeCorrection = f.checkpoints.find(value => value.progress?.completedCues === 79);
    assert.deepEqual(beforeCorrection?.progress.cueIndexes, confirmed, 'the exact reviewed set including its concise cue is durable before missing-only correction');
    assert.deepEqual(beforeCorrection.cues.map(cue => [cue.id, cue.start, cue.end]),
        confirmed.map(index => f.transcript[index]).map(cue => [cue.id, cue.start, cue.end]));
    assert(beforeCorrection.cues.every((cue, offset) => cue.text.replace(/\n/g, ' ') === (confirmed[offset] === 20 ? '네.' : translatedText)));
    await f.drained();
});

test('a last single-cue concise review is retained without a minimum-batch exception', async t => {
    const f = await fixture(t, { count: 1, handler: (call, state) => {
        const result = answer(call);
        if (call.review && state.calls.length === 2) result.subtitles[0].text = '네.';
        return result;
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.deepEqual(f.calls.map(call => call.review), [false, true]);
    assert.equal(result.subtitleTranslation[0].text, '네.');
    await f.drained();
});

test('a still-missing targeted review isolates its cue and retains every other strict cue for missing-only resume', async t => {
    let failing = true;
    const f = await fixture(t, { count: 160, handler: call => {
        const result = answer(call);
        if (failing && call.review && call.indexes.includes(100)) result.subtitles = result.subtitles.filter(cue => cue.index !== 100);
        return result;
    } });
    const failed = await f.run();
    assert.equal(failed.subtitleRepairStatus, 'partial');
    assert.equal(failed.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
    assert.equal(failed.subtitleTranslationProgress.processingComplete, true);
    assert.equal(failed.subtitleTranslationProgress.processedCues, 160);
    assert.equal(f.calls.length, 5);
    assert.equal(failed.subtitleTranslationPartial.length, 159);
    const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints', f.record.id + '-ko.json'), 'utf8'));
    assert.equal(saved.translationVersion, TRANSLATION_PROMPT_VERSION); assert.equal(saved.reviewPasses, 2);
    const indexes = Array.from({ length: 160 }, (_, index) => index).filter(index => index !== 100);
    assert.equal(saved.version, 2); assert.deepEqual(saved.cueIndexes, indexes);
    assert.equal(saved.completedCues, 159); assert.equal(saved.translationComplete, false);
    assert.deepEqual(saved.subtitles.map(cue => [cue.id, cue.start, cue.end]), indexes.map(index => f.transcript[index]).map(cue => [cue.id, cue.start, cue.end]));
    const previousCalls = f.calls.length;
    failing = false;
    const completed = await f.run();
    assert.equal(completed.subtitleRepairStatus, 'completed', completed.subtitleError);
    assert.deepEqual(f.calls.slice(previousCalls).map(call => [call.start, call.count, call.review]), [[100, 1, false], [100, 1, true]]);
    assert.equal(completed.subtitleTranslation.length, 160);
    await f.drained();
});

test('missing draft-term confirmation prevents any prefix checkpoint even when its text was otherwise valid', async t => {
    const f = await fixture(t, { handler: call => {
        const result = answer(call);
        if (!call.review) result.terms = [{ source: '太郎', translation: '타로' }];
        if (call.review && call.count === 80) { result.subtitles = result.subtitles.filter(cue => cue.index !== 70); result.subtitles[20].text = '네.'; }
        return result;
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'failed');
    assert.match(result.subtitleError, /인명·호칭 표기 확인이 누락/);
    assert.equal(f.calls.length, 3);
    assert.equal(result.subtitleTranslationPartial?.length || 0, 0);
    assert(f.commits.every(count => count === 0), 'no prefix weakens the full required-terms acceptance contract');
    await f.drained();
});

test('a correction cannot change a confirmed proper name after a strict prefix checkpoint', async t => {
    const f = await fixture(t, { handler: call => {
        const result = answer(call);
        result.terms = [{ source: '太郎', translation: call.count === 1 ? '다로' : '타로' }];
        if (call.review && call.count === 80) result.subtitles = result.subtitles.filter(cue => cue.index !== 20);
        return result;
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'failed');
    assert.match(result.subtitleError, /표기가 앞 구간과 일치하지 않습니다/);
    assert.equal(f.calls.length, 3);
    assert.equal(result.subtitleTranslationPartial.length, 79);
    assert.deepEqual(result.subtitleTranslationProgress.cueIndexes,
        Array.from({ length: 80 }, (_, index) => index).filter(index => index !== 20));
    const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints', f.record.id + '-ko.json'), 'utf8'));
    assert.deepEqual(saved.terms, [{ source: '太郎', translation: '타로' }]);
    await f.drained();
});

test('parent cancellation during targeted correction drains the child and keeps the durable reviewed prefix', async t => {
    const f = await fixture(t, { count: 160, handler: (call, state) => {
        const result = answer(call);
        if (call.review && call.start === 80) result.subtitles = result.subtitles.filter(cue => cue.index !== 100);
        if (call.review && call.start === 100) state.controller.abort();
        return result;
    } });
    await assert.rejects(f.run(), { name: 'AbortError' });
    assert.equal(f.record.subtitleTranslationPartial.length, 159);
    assert.deepEqual(f.record.subtitleTranslationProgress.cueIndexes,
        Array.from({ length: 160 }, (_, index) => index).filter(index => index !== 100));
    assert.equal(f.calls.length, 5);
    assert.equal(f.calls.at(-1).killed, true);
    await f.drained();
});

for (const failure of ['response refusal', 'quota usage limit', '401 authentication failed', '503 service unavailable', 'execution timeout', 'ECONNRESET network failure']) {
    test(`a targeted correction ${failure} stops immediately, preserves the checked prefix and never reissues a request`, async t => {
        const f = await fixture(t, { count: 160, handler: call => {
            const result = answer(call);
            if (call.review && call.start === 80) result.subtitles = result.subtitles.filter(cue => cue.index !== 100);
            if (call.review && call.start === 100) {
                if (failure === 'response refusal') return { refusal: true };
                throw new Error(`Owned synthetic ${failure}`);
            }
            return result;
        } });
        const result = await f.run();
        assert.equal(result.subtitleRepairStatus, 'failed');
        assert.equal(f.calls.length, 5);
        assert.equal(f.calls.filter(call => call.start === 100).length, 1);
        assert.equal(result.subtitleTranslationPartial.length, 159);
        assert.deepEqual(result.subtitleTranslationProgress.cueIndexes,
            Array.from({ length: 160 }, (_, index) => index).filter(index => index !== 100));
        if (failure === 'response refusal') {
            assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_PROVIDER_REFUSAL');
            assert.equal(result.subtitleDiagnostic.refusalSource, 'response-field');
        } else assert.match(result.subtitleError, new RegExp(failure));
        await f.drained();
    });
}

test('missing corrections use exactly sixty-four requests while later strict tail cues remain durable', async t => {
    const f = await fixture(t, { count: 1360, handler: call => {
        const result = answer(call);
        if (!call.review && call.start === 0 && call.count === 80) result.subtitles.pop();
        if (call.review && call.count === 80) result.subtitles = result.subtitles.filter(cue => cue.index === 1359);
        return result;
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'partial');
    assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
    assert.equal(result.subtitleTranslationProgress.processingComplete, true);
    assert.equal(result.subtitleTranslationProgress.processedCues, 1360);
    const repairs = f.calls.filter(call => call.count <= 20);
    assert.equal(repairs.length, 64, 'one missing draft repair and sixty-three review repairs share one operation budget');
    assert(repairs.every(call => call.count <= 20));
    assert.equal(f.calls.length, 98, 'all seventeen source batches still receive a draft and independent review');
    assert(f.calls.some(call => call.review && call.indexes.includes(1359)), 'budget exhaustion does not stop later source review');
    assert(f.diagnostics.some(event => event.code === 'SUBTITLE_REPAIR_LIMIT' && event.level === 'warning'));
    const confirmed = [...Array.from({ length: 1260 }, (_, index) => index), 1359];
    assert.equal(result.subtitleTranslationPartial.length, 1261);
    assert.equal(result.subtitleTranslationProgress.version, 2);
    assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, confirmed);
    assert.equal(result.subtitleTranslationProgress.complete, false);
    assert.equal(result.subtitleTranslationProgress.translationComplete, false);
    assert.equal(result.subtitleDiagnostic.expectedCues, 99);
    assert.equal(result.subtitleTranslation, undefined);
    assert.deepEqual(result.subtitleTranslationPartial.map(cue => [cue.id, cue.start, cue.end]),
        confirmed.map(index => f.transcript[index]).map(cue => [cue.id, cue.start, cue.end]));
    assert(result.subtitleTranslationPartial.every(cue => cue.text.replace(/\n/g, ' ') === translatedText));
    await f.drained();
});

test('translation progress exposes real draft, review and repair waits and clears every finished request', async t => {
    const f = await fixture(t, { count: 1, handler: (call, state) => {
        const result = answer(call);
        if (call.review && state.calls.length === 2) result.subtitles = [];
        return result;
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed');
    for (const stage of ['translation_draft', 'translation_review', 'translation_repair']) {
        assert(f.progress.some(item => item.details?.requestStage === stage && item.details?.activeRequestCount === 1), stage);
    }
    assert.equal(f.progress.at(-1).details?.requestStage, undefined);
    await f.drained();
});
