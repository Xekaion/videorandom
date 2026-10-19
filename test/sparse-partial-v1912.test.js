const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { validatePartialTranslation, subtitleText } = require('../lib/subtitle-utils');
const { saveKoreanSubtitle } = require('../lib/subtitle-sidecar');
const { createLanAnalysis, sendRemoteAnalysis } = require('../lib/lan-analysis');
const { catalogRecord } = require('../lib/catalog-record');
const { httpFixtureResponse } = require('./http-json-fixture');

const source = Array.from({ length: 6 }, (_, index) => ({ id: `owned-${index}`, start: index * 60 + .125,
    end: index * 60 + 3.375, text: `合成の列車案内 ${index + 1}` }));
const fingerprint = transcript => crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex');
const partial = (indexes = [0, 3, 5], version = 2) => ({ id: 'a'.repeat(32), name: 'owned-train.mp4', path: 'Z:/owned-train.mp4',
    status: 'partial', operation: 'translation-only', subtitleRepairStatus: 'partial', duration: 360, ext: 'MP4',
    summary: '보관된 합성 열차 안내', warnings: [], labels: [], frames: [], hasAudio: true,
    transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper turbo', transcript: structuredClone(source),
    transcriptionQuality: { version: 1, recognitionRevision: 3, source: 'audio', profile: 'turbo', model: 'turbo',
        complete: true, processingComplete: true, duration: 360, processedUntil: 360, wordTimestamps: false,
        audit: { complete: false, unresolved: [] }, warnings: [] },
    subtitleTranslationPartial: indexes.map(index => ({ id: source[index].id, start: source[index].start, end: source[index].end, text: `검수한 합성 안내 ${index + 1}` })),
    subtitleTranslationProgress: { version, language: 'ko', complete: false, sourceComplete: true, sourceFingerprint: fingerprint(source),
        totalCues: source.length, completedCues: indexes.length, translationComplete: false, sourceProcessed: true, sourceAuditComplete: false,
        ...(version === 2 ? { cueIndexes: indexes.slice() } : {}) } });

async function directory(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-sparse-partial-v1912-'));
    t.after(async () => {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('videorandom-sparse-partial-v1912-'));
        await fs.rm(root, { recursive: true, force: true });
    });
    return root;
}

test('sparse reviewed subtitles retain later cues and native gap times without inserting unchecked text', () => {
    const saved = partial();
    const checked = validatePartialTranslation(saved);
    assert.deepEqual(checked.map(cue => [cue.start, cue.end]), [0, 3, 5].map(index => [source[index].start, source[index].end]));
    const srt = subtitleText(saved, { language: 'ko', partial: true });
    assert(srt.includes('00:03:00,125 --> 00:03:03,375')); assert(srt.includes('00:05:00,125 --> 00:05:03,375'));
    assert(!srt.includes('00:01:00,125')); assert(!srt.includes('미번역')); assert(!srt.includes('合成'));
    assert.equal(srt.match(/ --> /g).length, 3);
    const vtt = subtitleText(saved, { language: 'ko', partial: true, format: 'vtt' });
    assert(vtt.startsWith('WEBVTT\n\n')); assert(vtt.includes('00:05:00.125 --> 00:05:03.375'));
    assert.throws(() => subtitleText(saved, { language: 'ko' }));
    assert.deepEqual(saved.subtitleTranslationProgress.cueIndexes, [0, 3, 5]);
});

test('existing v1 partial subtitles remain an exact contiguous prefix with their original compatibility contract', () => {
    const saved = partial([0, 1], 1);
    delete saved.subtitleTranslationPartial[0].id;
    assert.equal(validatePartialTranslation(saved).length, 2, 'legacy optional cue IDs remain supported');
    assert(subtitleText(saved, { language: 'ko', partial: true }).includes('00:01:00,125'));
    saved.subtitleTranslationPartial[1].start = source[3].start;
    assert.throws(() => validatePartialTranslation(saved), /시간/);
});

for (const [label, alter] of [
    ['unknown progress version', value => { value.subtitleTranslationProgress.version = 3; }],
    ['missing mapping', value => { delete value.subtitleTranslationProgress.cueIndexes; }],
    ['duplicate mapping', value => { value.subtitleTranslationProgress.cueIndexes = [0, 0, 5]; }],
    ['unsorted mapping', value => { value.subtitleTranslationProgress.cueIndexes = [3, 0, 5]; }],
    ['negative index', value => { value.subtitleTranslationProgress.cueIndexes[0] = -1; }],
    ['foreign index', value => { value.subtitleTranslationProgress.cueIndexes[2] = 6; }],
    ['fractional index', value => { value.subtitleTranslationProgress.cueIndexes[1] = 3.5; }],
    ['string index', value => { value.subtitleTranslationProgress.cueIndexes[1] = '3'; }],
    ['count mismatch', value => { value.subtitleTranslationProgress.completedCues = 2; }],
    ['mapping length mismatch', value => { value.subtitleTranslationProgress.cueIndexes.pop(); }],
    ['oversized mapping', value => { value.subtitleTranslationProgress.cueIndexes = Array(50001).fill(0); }],
    ['missing source ID', value => { delete value.subtitleTranslationPartial[1].id; }],
    ['wrong source ID', value => { value.subtitleTranslationPartial[1].id = 'owned-1'; }],
    ['wrong start time', value => { value.subtitleTranslationPartial[1].start += .001; }],
    ['wrong end time', value => { value.subtitleTranslationPartial[1].end += .001; }],
    ['wrong source fingerprint', value => { value.subtitleTranslationProgress.sourceFingerprint = 'f'.repeat(64); }],
    ['changed source text', value => { value.transcript[2].text = 'different owned source'; }],
    ['complete despite holes', value => { value.subtitleTranslationProgress.complete = true; }],
    ['translation complete despite holes', value => { value.subtitleTranslationProgress.translationComplete = true; }],
    ['missing translation complete flag', value => { delete value.subtitleTranslationProgress.translationComplete; }],
    ['invalid source completion flag', value => { value.subtitleTranslationProgress.sourceComplete = 'true'; }],
    ['invalid processing flag', value => { value.subtitleTranslationProgress.sourceProcessed = 'true'; }],
    ['invalid audit flag', value => { value.subtitleTranslationProgress.sourceAuditComplete = 1; }],
    ['empty Korean text', value => { value.subtitleTranslationPartial[1].text = ' '; }],
    ['oversized Korean text', value => { value.subtitleTranslationPartial[1].text = '합'.repeat(10001); }]
]) test(`sparse partial export rejects ${label}`, () => {
    const saved = partial(); alter(saved);
    assert.throws(() => validatePartialTranslation(saved));
    assert.throws(() => subtitleText(saved, { language: 'ko', partial: true }));
    assert.equal(catalogRecord(saved).subtitleTranslatedCount, 0);
});

test('compact catalog counts all validated later subtitles without exposing source or translation text', () => {
    const summary = catalogRecord(partial());
    assert.equal(summary.subtitleTranslatedCount, 3); assert.equal(summary.transcriptCount, 6);
    assert.equal(summary.subtitleTranslationSourceFingerprint, fingerprint(source));
    assert.equal(summary.transcript, undefined); assert.equal(summary.subtitleTranslationPartial, undefined);
});

test('automatic sparse SRT saving includes valid later scenes and preserves an existing complete subtitle', async t => {
    const root = await directory(t), video = path.join(root, 'owned-train.mp4');
    await fs.writeFile(video, 'Owned undecodable fixture; no decoding or providers.');
    const complete = path.join(root, 'owned-train.ko.srt'); await fs.writeFile(complete, 'Existing owned complete subtitle.');
    const saved = { ...partial(), path: video };
    const result = await saveKoreanSubtitle(saved);
    assert.equal(result.status, 'saved'); assert.equal(result.partial, true);
    assert.equal(result.path, path.join(root, 'owned-train.ko.partial.srt'));
    const text = await fs.readFile(result.path, 'utf8');
    assert(text.includes('00:05:00,125 --> 00:05:03,375')); assert.equal(text.match(/ --> /g).length, 3);
    assert.equal(await fs.readFile(complete, 'utf8'), 'Existing owned complete subtitle.');
    assert.equal((await fs.readdir(root)).some(name => name.endsWith('.tmp')), false);
});

test('sidecar failures retain a bounded filesystem error code without copying its raw message', async t => {
    const root = await directory(t), video = path.join(root, 'owned-train.mp4'); await fs.writeFile(video, 'Owned undecodable fixture');
    const io = { ...fs, open: async (filename, flags, mode) => {
        if (flags === 'wx') throw Object.assign(new Error('PRIVATE_PATH_AND_RAW_ERROR'), { code: 'EACCES' });
        return fs.open(filename, flags, mode);
    } };
    const result = await saveKoreanSubtitle({ ...partial(), path: video }, { io });
    assert.equal(result.status, 'failed'); assert.equal(result.code, 'EACCES'); assert.equal(result.systemCode, 'EACCES');
    assert.equal(JSON.stringify(result).includes('PRIVATE_PATH_AND_RAW_ERROR'), false);
});

async function relay(t, processPackage) {
    const root = await directory(t);
    const host = createLanAnalysis({ dataDir: path.join(root, 'host'), processPackage });
    const status = await host.start({ port: 0, host: '127.0.0.1' });
    t.after(() => host.stop());
    return { root, host, status, options: { remoteUrl: `http://127.0.0.1:${status.port}`, connectionCode: status.connectionCode,
        dataDir: root, operation: 'translation-only', subtitleQuality: 'turbo', subtitleLanguage: 'ko' } };
}

test('LAN round trip retains sparse mappings, source IDs and late cue times without certifying complete translation', async t => {
    let calls = 0;
    const f = await relay(t, async pkg => {
        calls++; assert.equal(pkg.operation, 'translation-only'); assert.equal(pkg.audioPath, null); assert.deepEqual(pkg.record.frames, []);
        return { ...pkg.record, ...partial(), id: pkg.record.id, path: pkg.record.path };
    });
    const capabilities = await httpFixtureResponse(f.options.remoteUrl + '/v1/status', { headers: { Authorization: 'Bearer ' + f.status.connectionCode } });
    assert((await capabilities.json()).capabilities.includes('sparse-subtitles-v1'));
    const original = partial(); delete original.subtitleTranslationPartial; delete original.subtitleTranslationProgress;
    const result = await sendRemoteAnalysis(original, f.options);
    assert.equal(calls, 1); assert.equal(result.status, 'partial'); assert.equal(result.subtitleTranslation, undefined);
    assert.equal(result.subtitleRepairStatus, 'partial'); assert.equal(result.subtitleTranslationProgress.version, 2);
    assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, [0, 3, 5]);
    assert.deepEqual(result.subtitleTranslationPartial.map(cue => cue.id), [0, 3, 5].map(index => source[index].id));
    assert.equal(result.subtitleTranslationProgress.translationComplete, false);
    assert(subtitleText(result, { language: 'ko', partial: true }).includes('00:05:00,125'));
});

test('failed translation repair retains both an older contiguous prefix and newly reviewed later sparse cues', async t => {
    const f = await relay(t, async pkg => ({ ...pkg.record, ...partial([3, 5]), id: pkg.record.id, path: pkg.record.path,
        subtitleRepairStatus: 'failed', subtitleError: 'Owned synthetic provider stop; no retry' }));
    const original = partial([0], 1); original.subtitleTranslationPartial[0].text = '보존할 이전 합성 안내';
    const result = await sendRemoteAnalysis(original, f.options);
    assert.equal(result.subtitleRepairStatus, 'failed'); assert.equal(result.subtitleTranslationProgress.version, 2);
    assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, [0, 3, 5]);
    assert.equal(result.subtitleTranslationPartial[0].text, '보존할 이전 합성 안내');
    assert.equal(validatePartialTranslation(result).length, 3);
    assert(subtitleText(result, { language: 'ko', partial: true }).includes('00:05:00,125'));
});

test('failed sparse repair merges disjoint reviewed positions instead of comparing only translated counts', async t => {
    const f = await relay(t, async pkg => ({ ...pkg.record, ...partial([1, 5]), id: pkg.record.id, path: pkg.record.path,
        subtitleRepairStatus: 'failed', subtitleError: 'Owned synthetic stopped attempt' }));
    const original = partial([0, 3]);
    const result = await sendRemoteAnalysis(original, f.options);
    assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, [0, 1, 3, 5]);
    assert.equal(validatePartialTranslation(result).length, 4);
    assert.equal(result.subtitleRepairStatus, 'failed'); assert.equal(result.subtitleTranslationProgress.translationComplete, false);
});

for (const [label, change] of [
    ['wrong IDs', value => { value.subtitleTranslationPartial[1].id = 'foreign'; }],
    ['wrong mapping', value => { value.subtitleTranslationProgress.cueIndexes = [0, 3, 99]; }],
    ['false completion', value => { value.subtitleTranslationProgress.complete = true; }],
    ['wrong source fingerprint', value => { value.subtitleTranslationProgress.sourceFingerprint = 'f'.repeat(64); }]
]) test(`LAN cannot turn sparse ${label} into usable or completed subtitles`, async t => {
    const f = await relay(t, async pkg => { const value = { ...pkg.record, ...partial(), id: pkg.record.id, path: pkg.record.path }; change(value); return value; });
    const original = partial(); delete original.subtitleTranslationPartial; delete original.subtitleTranslationProgress;
    const result = await sendRemoteAnalysis(original, f.options);
    assert.equal(result.status, 'partial'); assert.equal(result.subtitleTranslation, undefined);
    assert.equal(result.subtitleTranslationPartial, undefined);
    assert.throws(() => subtitleText(result, { language: 'ko', partial: true }));
});

test('a client rejects v2 sparse output from a host that did not advertise sparse support', async t => {
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/v1/status') return res.end(JSON.stringify({ ready: true, protocol: 1,
            capabilities: ['timed-subtitles-v1', 'subtitle-quality-v3', 'subtitle-translation-only-v1', 'turbo-subtitles-v1'] }));
        req.resume(); req.on('end', () => res.end(JSON.stringify({ id: 'b'.repeat(32), status: 'completed', result: partial() })));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const root = await directory(t);
    const original = partial(); delete original.subtitleTranslationPartial; delete original.subtitleTranslationProgress;
    await assert.rejects(sendRemoteAnalysis(original, { remoteUrl: `http://127.0.0.1:${server.address().port}`, connectionCode: 'x'.repeat(32),
        dataDir: root, operation: 'translation-only', subtitleQuality: 'turbo' }), /빠진 구간 뒤.*최신 버전/);
});
