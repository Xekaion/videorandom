const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createNoKeyProvider, TRANSLATION_PROMPT_VERSION } = require('../lib/no-key-provider');

const SOURCE = '合成の列車が到着します。安全のためにホームの内側で待ち、案内と出発時間を確認してください。';
const KOREAN = '합성 열차가 도착합니다. 안전을 위해 승강장 안쪽에서 기다리고 안내와 출발 시간을 확인하세요.';
const normalized = text => text.replace(/\s+/g, ' ').trim();

async function fixture(t, { prefix = 3, mutate = () => {} } = {}) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-short-cache-v1921-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const transcript = Array.from({ length: 3 }, (_, index) => ({
        id: `owned-short-cache-${index}`, start: index * 9 + 0.125, end: index * 9 + 7.875, text: SOURCE
    }));
    const duration = 35;
    const record = { id: 'owned-new-short-cache', name: 'owned-synthetic-train.mp4', duration, summary: '합성 열차 안내',
        transcript, warnings: [], frames: [], transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3',
        transcriptionQuality: { version: 1, recognitionRevision: 3, source: 'audio', profile: 'accurate', model: 'large-v3',
            complete: true, duration, processedUntil: duration, wordTimestamps: true, language: 'ja', languageProbability: 0.99,
            audit: { complete: true, speechSeconds: 10, uncoveredSpeechSeconds: 0, unresolved: [] }, warnings: [] } };
    const sourceFingerprint = crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue =>
        [cue.id, cue.start, cue.end, cue.text]))).digest('hex');
    const indexId = crypto.createHash('sha256').update(`videorandom-subtitles\0${7}\0ko\0accurate\0${sourceFingerprint}`).digest('hex');
    const saved = { version: 1, translationVersion: 7, targetLanguage: 'ko', subtitleQuality: 'accurate', reviewPasses: 2,
        language: 'ko', sourceFingerprint, totalCues: transcript.length, completedCues: prefix,
        complete: prefix === transcript.length, translationComplete: prefix === transcript.length,
        sourceComplete: true, sourceProcessed: true, sourceAuditComplete: true,
        subtitles: transcript.slice(0, prefix).map((cue, index) => ({ ...cue, index, text: index === 1 ? '네.' : KOREAN })), terms: [] };
    mutate(saved);
    const directory = path.join(dataDir, 'checkpoints'); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${indexId}-translation-ko-v7.json`), JSON.stringify(saved), 'utf8');
    const calls = []; let active = 0;
    const spawnImpl = (binary, args) => {
        assert.equal(binary, 'owned-synthetic-codex'); assert.equal(args[0], 'exec', 'only owned synthetic output is executed');
        const child = new EventEmitter(), chunks = []; let closed = false; active++;
        child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        const close = code => { if (!closed) { closed = true; active--; child.emit('close', code); } };
        child.kill = () => queueMicrotask(() => close(null));
        child.stdin.on('data', chunk => chunks.push(chunk));
        child.stdin.on('finish', () => queueMicrotask(async () => {
            try {
                const input = JSON.parse(Buffer.concat(chunks).toString('utf8').split('자료 JSON:\n').at(-1));
                const call = { review: Boolean(input.draftSubtitles), indexes: input.subtitles.map(cue => cue.index), input };
                calls.push(call);
                const response = call.review ? { approvedIndexes: call.indexes.slice(), corrections: [], terms: [] }
                    : { subtitles: call.indexes.map(index => ({ index, text: KOREAN })), terms: [] };
                await fs.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(response), 'utf8');
                close(0);
            } catch (error) { child.stderr.write(error.message); close(1); }
        }));
        return child;
    };
    const provider = createNoKeyProvider({ spawnImpl, platform: 'win32', environment: {
        VIDEORANDOM_CODEX: 'owned-synthetic-codex', VIDEORANDOM_TRANSLATION_PIPELINE: 'off' } });
    const run = () => provider.translateKoreanOnly(record, { dataDir, subtitleQuality: 'accurate' });
    const drained = async () => {
        assert.equal(active, 0); assert.deepEqual(await fs.readdir(path.join(dataDir, 'tmp')).catch(() => []), []);
    };
    return { dataDir, directory, record, transcript, calls, run, drained };
}

test('an exact v7 independently reviewed short Korean checkpoint migrates to v8 without retranslating accepted cues', async t => {
    const f = await fixture(t); const original = structuredClone(f.transcript);
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(f.calls.length, 0, 'a length difference does not invalidate exact accepted v7 cache provenance');
    assert.equal(normalized(result.subtitleTranslation[1].text), '네.');
    assert.deepEqual(result.subtitleTranslation.map(cue => [cue.id, cue.start, cue.end]), original.map(cue => [cue.id, cue.start, cue.end]));
    assert.deepEqual(result.transcript, original);
    const migrated = JSON.parse(await fs.readFile(path.join(f.directory, f.record.id + '-ko.json'), 'utf8'));
    assert.equal(migrated.translationVersion, 8); assert.equal(TRANSLATION_PROMPT_VERSION, 8);
    assert.equal(migrated.subtitleQuality, 'accurate'); assert.equal(migrated.reviewPasses, 2); assert.equal(migrated.completedCues, 3);
    await f.drained();
});

test('an exact v7 reviewed short prefix is retained while only its missing tail receives translation and review', async t => {
    const f = await fixture(t, { prefix: 2 }); const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.deepEqual(f.calls.map(call => [call.review, call.indexes]), [[false, [2]], [true, [2]]]);
    assert.equal(normalized(result.subtitleTranslation[1].text), '네.');
    assert.equal(result.subtitleTranslation.length, 3);
    assert.deepEqual(result.subtitleTranslation.map(cue => [cue.id, cue.start, cue.end]), f.transcript.map(cue => [cue.id, cue.start, cue.end]));
    await f.drained();
});

for (const [name, mutate] of [
    ['source fingerprint', saved => { saved.sourceFingerprint = '0'.repeat(64); }],
    ['source cue ID', saved => { saved.subtitles[1].id = 'owned-unrelated-cue'; }],
    ['source cue start', saved => { saved.subtitles[1].start += 0.25; }],
    ['source cue end', saved => { saved.subtitles[1].end += 0.25; }],
    ['source cue index', saved => { saved.subtitles[1].index = 2; }],
    ['quality profile', saved => { saved.subtitleQuality = 'fast'; }],
    ['independent review count', saved => { saved.reviewPasses = 1; }],
    ['foreign subtitle text', saved => { saved.subtitles[1].text = SOURCE; }],
    ['provider refusal subtitle text', saved => { saved.subtitles[1].text = '해당 요청의 자막 번역을 제공할 수 없습니다.'; }],
    ['inconsistent completed count', saved => { saved.completedCues = 2; }]
]) test(`v7 cache with mismatched ${name} cannot certify or reuse a short Korean result`, async t => {
    const f = await fixture(t, { mutate }); const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.deepEqual(f.calls.map(call => [call.review, call.indexes]), [[false, [0, 1, 2]], [true, [0, 1, 2]]]);
    assert(result.subtitleTranslation.every(cue => normalized(cue.text) === KOREAN), 'only new explicitly reviewed owned synthetic text is accepted');
    assert.deepEqual(result.subtitleTranslation.map(cue => [cue.id, cue.start, cue.end]), f.transcript.map(cue => [cue.id, cue.start, cue.end]));
    await f.drained();
});
