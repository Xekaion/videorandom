const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { normalizeSubtitleQuality, normalizeTranscriptionQuality, isProcessedTranscription,
    isVerifiedFullTranscription, isCurrentFullTranscription } = require('../lib/subtitle-quality');
const { validateOptions, createAnalysisService } = require('../lib/analysis-service');
const { createLanAnalysis, validateMetadata, sendRemoteAnalysis } = require('../lib/lan-analysis');
const { stampAnalysisProvenance, sanitizeAnalysisProvenance } = require('../lib/analysis-provenance');
const { catalogRecord } = require('../lib/catalog-record');
const { sanitizeDiagnosticEvent } = require('../lib/diagnostics');
const { createCatalogEngine } = require('../lib/catalog-engine');
const { reuseCachedExtraction } = require('../lib/cached-extraction');
const { httpJsonFixture } = require('./http-json-fixture');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
const sourceId = 'a'.repeat(32), attemptId = 'b'.repeat(32);
const quality = (changes = {}) => ({ version: 1, recognitionRevision: 3, source: 'audio', profile: 'turbo', model: 'turbo',
    complete: true, processingComplete: true, language: 'ja', duration: 60, processedUntil: 60,
    wordTimestamps: false, batchSize: 4, device: 'cuda', workers: 1, computeType: 'float16',
    audit: { complete: false, unresolved: [] }, warnings: [], ...changes });
const record = (changes = {}) => ({ id: sourceId, name: 'owned-synthetic-train.mp4', path: 'Z:/owned-synthetic-train.mp4', ext: 'MP4',
    duration: 60, status: 'completed', summary: '합성 열차 안내', plot: '', dialogueSummary: '', labels: [], frames: [], warnings: [], hasAudio: true,
    transcriptSource: 'audio:faster-whisper turbo', transcriptLanguage: 'ja', transcript: [{ id: 'owned-0', start: 1, end: 3, text: '合成の列車です。' }],
    transcriptionQuality: quality(), ...changes });
const metadata = (changes = {}) => ({ name: 'owned-synthetic-train.mp4', ext: 'MP4', sizeMB: 1, duration: 60,
    transcript: record().transcript, transcriptSource: 'audio:faster-whisper turbo', hasAudio: true, frames: [{ timestamp: 30, filename: 'frame-01.jpg' }],
    transcriptLanguage: 'ja', subtitleLanguage: 'ko', subtitleQuality: 'turbo', transcriptionQuality: quality(), ...changes });
const fingerprint = cues => crypto.createHash('sha256').update(JSON.stringify(cues.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex');

async function directory(t) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-turbo-profile-'));
    t.after(async () => {
        assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
        assert(path.basename(dataDir).startsWith('videorandom-turbo-profile-'));
        await fs.rm(dataDir, { recursive: true, force: true });
    });
    return dataDir;
}

test('turbo is explicit and never changes the legacy undefined profile or existing saved choices', () => {
    assert.equal(normalizeSubtitleQuality('turbo'), 'turbo');
    assert.equal(normalizeSubtitleQuality(), 'fast', 'legacy protocol default is unchanged');
    assert.equal(validateOptions({ mode: 'codex', subtitleQuality: 'accurate' }).subtitleQuality, 'accurate');
    assert.equal(validateOptions({ mode: 'codex', subtitleQuality: 'fast' }).subtitleQuality, 'fast');
    assert.equal(validateOptions({ mode: 'codex', subtitleQuality: 'turbo' }).subtitleQuality, 'turbo');
    for (const value of ['Turbo', 'ultra', null, 1, {}]) assert.throws(() => normalizeSubtitleQuality(value), /자막 품질/);
});

test('turbo quality preserves whole processing and bounded batch size without claiming an independent audit or word timing', () => {
    const normalized = normalizeTranscriptionQuality(quality({ audit: { complete: true, unresolved: [] }, wordTimestamps: true }));
    assert.equal(normalized.profile, 'turbo'); assert.equal(normalized.model, 'turbo');
    assert.equal(normalized.processingComplete, true); assert.equal(normalized.complete, true);
    assert.equal(normalized.audit.complete, false); assert.equal(normalized.wordTimestamps, false);
    assert.equal(normalized.batchSize, 4);
    for (const value of [undefined, false]) {
        assert.equal(normalizeTranscriptionQuality(quality({ processingComplete: value })).complete, false);
    }
    assert.equal(normalizeTranscriptionQuality(quality({ processedUntil: 17 })).complete, false);
    assert.equal(normalizeTranscriptionQuality(quality({ complete: false })).complete, false);
    for (const batchSize of [2, 8, 0, '4', 100000]) assert.equal(normalizeTranscriptionQuality(quality({ batchSize })).batchSize, undefined);
    assert.equal(normalizeTranscriptionQuality(quality({ batchSize: 1 })).batchSize, 1);
});

test('turbo whole-processing proof matches its own profile and can never become an accurate or audited proof', () => {
    const saved = record({ transcriptionQuality: quality({ audit: { complete: true, speechSeconds: 1, uncoveredSpeechSeconds: 0, unresolved: [] }, wordTimestamps: true }) });
    assert.equal(isProcessedTranscription(saved, 'turbo'), true);
    for (const profile of ['accurate', 'fast', 'turbo']) {
        assert.equal(isVerifiedFullTranscription(saved, profile), false);
        assert.equal(isCurrentFullTranscription(saved, profile), false);
    }
    assert.equal(isProcessedTranscription(saved, 'accurate'), false);
    assert.equal(isProcessedTranscription(saved, 'fast'), false);
    for (const changes of [{ processingComplete: false }, { processingComplete: undefined }, { processedUntil: 17 }, { duration: 30 }, { profile: 'fast' }, { profile: 'accurate' }]) {
        assert.equal(isProcessedTranscription(record({ transcriptionQuality: quality(changes) }), 'turbo'), false, JSON.stringify(changes));
    }
    assert.equal(isProcessedTranscription(record({ transcriptSource: 'audio:faster-whisper turbo (partial)' }), 'turbo'), false);
});

test('safe provenance and compact catalog retain the actual turbo profile and batch size without leaking private fields', () => {
    const saved = record({ transcriptionQuality: { ...quality(), path: 'C:/PRIVATE', connectionCode: 'PRIVATE', transcript: 'PRIVATE' } });
    stampAnalysisProvenance(saved, { operation: 'analysis', clientVersion: '1.9.11', now: '2026-10-19T10:00:00.000Z' });
    const provenance = sanitizeAnalysisProvenance(saved.analysisProvenance);
    assert.deepEqual(provenance.analysis.recognition, { recognitionRevision: 3, model: 'turbo', profile: 'turbo', device: 'cuda', workers: 1, batchSize: 4 });
    const compact = catalogRecord(saved);
    assert.deepEqual(compact.analysisProvenance, provenance);
    assert.equal(JSON.stringify(provenance).includes('PRIVATE'), false);
    assert.equal(compact.transcript, undefined);
    const invalidBatch = sanitizeAnalysisProvenance({ schemaVersion: 1, analysis: { clientVersion: '1.9.11', recognition: { profile: 'turbo', batchSize: 128 } } });
    assert.equal(invalidBatch.analysis.recognition.batchSize, undefined);
});

test('diagnostic metadata retains only an allowed profile and bounded batch size', () => {
    const safe = sanitizeDiagnosticEvent({ event: 'stage', stage: 'transcription', profile: 'turbo', batchSize: 4,
        transcript: 'PRIVATE', path: 'C:/PRIVATE', connectionCode: 'PRIVATE' });
    assert.equal(safe.profile, 'turbo'); assert.equal(safe.batchSize, 4);
    assert.equal(JSON.stringify(safe).includes('PRIVATE'), false);
    const invalid = sanitizeDiagnosticEvent({ profile: 'unsafe', batchSize: 99 });
    assert.equal(invalid.profile, undefined); assert.equal(invalid.batchSize, undefined);
});

test('explicit turbo settings persist through service restart without migrating accurate or fast choices', async t => {
    const dataDir = await directory(t);
    const closers = [];
    t.after(async () => { for (const close of closers) await close(); });
    const open = async () => {
        const service = createAnalysisService({ dataDir, deferAutoStart: true,
            engine: { getToolsStatus: async () => ({ available: true }), getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
                analyzeVideo: async () => { throw new Error('No actual analysis is allowed in a settings persistence test'); } },
            lan: { status: () => ({ running: false }), stop: async () => {} },
            diagnosticReporter: { start() {}, stop: async () => {}, flush: async () => {}, enqueue: async () => {}, getStatus: () => ({ pending: 0 }) } });
        await service.ready;
        const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
        const server = await new Promise(resolve => { const owned = app.listen(0, '127.0.0.1', () => resolve(owned)); });
        let closed = false;
        const close = async () => { if (closed) return; closed = true; await service.stop(); await new Promise(resolve => server.close(resolve)); };
        closers.push(close);
        return { request: (endpoint, body, method) => httpJsonFixture(`http://127.0.0.1:${server.address().port}/api/analysis`, endpoint, body, method), close };
    };
    for (const profile of ['accurate', 'fast', 'turbo']) {
        const first = await open();
        const saved = await first.request('/auto-pick', { enabled: false, options: { mode: 'codex', subtitleLanguage: 'ko', subtitleQuality: profile } }, 'PUT');
        assert.equal(saved.status, 200); assert.equal(saved.data.options.subtitleQuality, profile);
        await first.close();
        const reopened = await open();
        const config = await reopened.request('/config?view=summary');
        assert.equal(config.data.autoPick.options.subtitleQuality, profile);
        assert.equal(config.data.autoPick.enabled, false);
        await reopened.close();
    }
});

test('LAN metadata validates turbo and forwards whole-processing metadata without upgrading source audit', () => {
    const normalized = validateMetadata(metadata({ transcriptionQuality: quality({ audit: { complete: true, unresolved: [] }, wordTimestamps: true }) }));
    assert.equal(normalized.subtitleQuality, 'turbo');
    assert.equal(normalized.transcriptionQuality.profile, 'turbo'); assert.equal(normalized.transcriptionQuality.batchSize, 4);
    assert.equal(normalized.transcriptionQuality.complete, true); assert.equal(normalized.transcriptionQuality.processingComplete, true);
    assert.equal(normalized.transcriptionQuality.audit.complete, false); assert.equal(normalized.transcriptionQuality.wordTimestamps, false);
    assert.throws(() => validateMetadata(metadata({ subtitleQuality: 'ultra' })), /자막 품질/);
});

test('a turbo client rejects an older host before uploading any media or provider request', async t => {
    let posts = 0;
    const server = http.createServer((req, res) => {
        if (req.method === 'POST') posts++;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ready: true, protocol: 1, capabilities: ['timed-subtitles-v1', 'subtitle-quality-v3'] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const dataDir = await directory(t);
    await assert.rejects(sendRemoteAnalysis(record(), { remoteUrl: `http://127.0.0.1:${server.address().port}`,
        connectionCode: 'x'.repeat(32), dataDir, subtitleQuality: 'turbo', subtitleLanguage: 'ko' }), /초고속.*최신 버전/);
    assert.equal(posts, 0);
});

test('turbo remote capability is checked before frame extraction or audio decoding', async () => {
    let extracted = 0, decoded = 0;
    const engine = createCatalogEngine({ extractionImpl: { analyzeVideo: async () => { extracted++; }, runProcess: async () => { decoded++; } },
        lanImpl: { checkRemoteServer: async () => ({ ready: true, capabilities: ['subtitle-quality-v3'] }) } });
    await assert.rejects(engine.analyzeVideo({ path: 'Z:/owned.mp4' }, { mode: 'remote', subtitleQuality: 'turbo' }, {}), /초고속.*최신 버전/);
    assert.equal(extracted, 0); assert.equal(decoded, 0);
});

test('turbo remote preparation decodes the whole source once into lossless FLAC using fast compression', async t => {
    const dataDir = await directory(t), file = { id: attemptId, path: path.join(dataDir, 'owned-source.mp4') };
    let extracted = 0, decoded = 0, sent = 0, checks = 0, preparedPath;
    const engine = createCatalogEngine({
        extractionImpl: { analyzeVideo: async () => { extracted++; return record({ ...file, transcriptionQuality: undefined, transcriptSource: 'sidecar:owned.srt' }); },
            getToolsStatus: async () => ({ available: true, ffmpeg: { path: 'owned-mock-ffmpeg' } }),
            runProcess: async (binary, args) => {
                decoded++; assert.equal(binary, 'owned-mock-ffmpeg');
                assert.equal(args[args.indexOf('-c:a') + 1], 'flac'); assert.equal(args[args.indexOf('-compression_level') + 1], '0');
                assert.equal(args[args.indexOf('-ar') + 1], '16000'); assert.equal(args[args.indexOf('-ac') + 1], '1');
                assert.equal(args.includes('-ss') || args.includes('-t'), false);
                preparedPath = args.at(-1); assert.equal(path.extname(preparedPath), '.flac');
                await fs.writeFile(preparedPath, 'fLaCowned-synthetic-turbo');
            } },
        lanImpl: { checkRemoteServer: async () => { checks++; return { ready: true, capabilities: ['turbo-subtitles-v1', 'subtitle-quality-v3'] }; },
            sendRemoteAnalysis: async (saved, options) => {
                sent++; assert.equal(options.subtitleQuality, 'turbo'); assert.equal(options.audioPath, preparedPath);
                assert.equal(await fs.readFile(options.audioPath, 'utf8'), 'fLaCowned-synthetic-turbo');
                return { ...saved, transcriptionQuality: quality() };
            } } });
    const result = await engine.analyzeVideo(file, { mode: 'remote', subtitleQuality: 'turbo', subtitleLanguage: 'ko' }, { dataDir });
    assert.equal(result.transcriptionQuality.profile, 'turbo');
    assert.deepEqual([checks, extracted, decoded, sent], [1, 1, 1, 1]);
    assert.equal(await fs.stat(preparedPath).catch(() => null), null, 'only this owned prepared audio is cleaned after transfer');
});

test('turbo and audited or fast extraction caches cannot silently cross profile boundaries', async t => {
    const dataDir = await directory(t);
    const filePath = path.join(dataDir, 'owned-source.mp4'); await fs.writeFile(filePath, 'owned synthetic identity');
    const stat = await fs.stat(filePath);
    const frameDir = path.join(dataDir, 'frames', sourceId); await fs.mkdir(frameDir, { recursive: true });
    await fs.writeFile(path.join(frameDir, 'frame-01.jpg'), JPEG);
    const saved = record({ path: filePath, sourceFile: { sizeBytes: stat.size, mtimeMs: stat.mtimeMs }, frames: [{ timestamp: 30, filename: 'frame-01.jpg' }] });
    const file = { id: attemptId, path: filePath };
    for (const requestedProfile of ['accurate', 'fast']) {
        assert.equal(await reuseCachedExtraction(file, { mode: 'codex', frameCount: 1, subtitleLanguage: 'ko', subtitleQuality: requestedProfile, repairRecord: saved }, { dataDir }), null);
    }
    for (const previousProfile of ['accurate', 'fast']) {
        assert.equal(await reuseCachedExtraction(file, { mode: 'codex', frameCount: 1, subtitleLanguage: 'ko', subtitleQuality: 'turbo',
            repairRecord: { ...saved, transcriptionQuality: quality({ profile: previousProfile }) } }, { dataDir }), null);
    }
    assert.equal(await reuseCachedExtraction(file, { mode: 'codex', frameCount: 1, subtitleLanguage: 'ko', subtitleQuality: 'turbo',
        repairRecord: { ...saved, transcriptionQuality: quality({ complete: false }) } }, { dataDir }), null);
    const reused = await reuseCachedExtraction(file, { mode: 'codex', frameCount: 1, subtitleLanguage: 'ko', subtitleQuality: 'turbo', repairRecord: saved }, { dataDir });
    assert.equal(reused.extractionReusedFrom, sourceId); assert.equal(reused.transcriptionQuality.profile, 'turbo');
    assert.equal(reused.transcriptionQuality.audit.complete, false);
    assert.deepEqual(await fs.readFile(path.join(dataDir, 'frames', attemptId, 'frame-01.jpg')), JPEG);
    await fs.writeFile(filePath, 'owned synthetic replacement has a different identity');
    assert.equal(await reuseCachedExtraction({ ...file, id: 'c'.repeat(32) }, { mode: 'codex', frameCount: 1, subtitleLanguage: 'ko', subtitleQuality: 'turbo', repairRecord: saved }, { dataDir }), null);
});

test('a completed turbo LAN result retains all translated cues and actual profile while source audit stays false', async t => {
    const dataDir = await directory(t), hostDir = path.join(dataDir, 'host');
    let calls = 0;
    const host = createLanAnalysis({ dataDir: hostDir, processPackage: async (pkg, context) => {
        calls++; assert.equal(pkg.subtitleQuality, 'turbo');
        if (calls === 1) assert.equal(pkg.audioPath, null);
        else {
            assert.equal(path.extname(pkg.audioPath), '.flac');
            assert.equal(await fs.readFile(pkg.audioPath, 'utf8'), 'fLaCowned-synthetic-whole-source');
        }
        context.onProgress('transcription', 60, { phase: 'transcription', profile: 'turbo', model: 'turbo', batchSize: 4,
            processedSeconds: 60, totalSeconds: 60, device: 'cuda', computeType: 'float16', workers: 1 });
        const source = pkg.record.transcript;
        return { ...pkg.record, status: 'completed', summary: '합성 열차 안내', transcriptionQuality: quality({ audit: { complete: true, unresolved: [] } }),
            subtitleLanguage: 'ko', subtitleTranslation: source.map(cue => ({ ...cue, text: '합성 열차입니다.' })),
            subtitleTranslationProgress: { version: 1, sourceFingerprint: fingerprint(source), totalCues: source.length, completedCues: source.length,
                language: 'ko', complete: true, sourceComplete: true, translationComplete: true, sourceProcessed: true, sourceAuditComplete: true } };
    } });
    const status = await host.start({ port: 0, host: '127.0.0.1' });
    t.after(() => host.stop());
    const saved = record({ frames: [{ timestamp: 30, filename: 'frame-01.jpg' }] });
    const frames = path.join(dataDir, 'frames', saved.id); await fs.mkdir(frames, { recursive: true }); await fs.writeFile(path.join(frames, 'frame-01.jpg'), JPEG);
    const result = await sendRemoteAnalysis(saved, { remoteUrl: `http://127.0.0.1:${status.port}`, connectionCode: status.connectionCode,
        dataDir, subtitleQuality: 'turbo', subtitleLanguage: 'ko', transcriptLanguage: 'ja' });
    assert.equal(calls, 1); assert.equal(result.status, 'completed'); assert.equal(result.subtitleLanguage, 'ko');
    assert.equal(result.subtitleTranslation.length, 1); assert.equal(result.subtitleTranslation[0].text, '합성 열차입니다.');
    assert.equal(result.transcriptionQuality.profile, 'turbo'); assert.equal(result.transcriptionQuality.complete, true);
    assert.equal(result.transcriptionQuality.audit.complete, false); assert.equal(result.subtitleTranslationProgress.sourceAuditComplete, false);
    assert.equal(result.analysisProvenance.analysis.recognition.profile, 'turbo');
    const audioPath = path.join(dataDir, 'owned-audio.flac'); await fs.writeFile(audioPath, 'fLaCowned-synthetic-whole-source');
    const withAudio = await sendRemoteAnalysis({ ...saved, transcriptionQuality: undefined }, {
        remoteUrl: `http://127.0.0.1:${status.port}`, connectionCode: status.connectionCode,
        dataDir, audioPath, subtitleQuality: 'turbo', subtitleLanguage: 'ko', transcriptLanguage: 'ja' });
    assert.equal(calls, 2); assert.equal(withAudio.status, 'completed'); assert.equal(withAudio.transcriptionQuality.profile, 'turbo');
});

test('turbo LAN cannot reuse incomplete cached speech or accept lossy audio instead of its whole lossless source', async t => {
    const dataDir = await directory(t);
    let calls = 0;
    const host = createLanAnalysis({ dataDir: path.join(dataDir, 'host'), processPackage: async () => { calls++; throw new Error('Invalid turbo input must never start analysis'); } });
    const status = await host.start({ port: 0, host: '127.0.0.1' });
    t.after(() => host.stop());
    const saved = record({ frames: [{ timestamp: 30, filename: 'frame-01.jpg' }] });
    const frames = path.join(dataDir, 'frames', saved.id); await fs.mkdir(frames, { recursive: true }); await fs.writeFile(path.join(frames, 'frame-01.jpg'), JPEG);
    const options = { remoteUrl: `http://127.0.0.1:${status.port}`, connectionCode: status.connectionCode,
        dataDir, subtitleQuality: 'turbo', subtitleLanguage: 'ko', transcriptLanguage: 'ja' };
    for (const proof of [quality({ complete: false }), quality({ processingComplete: false }), quality({ processedUntil: 17 })]) {
        await assert.rejects(sendRemoteAnalysis({ ...saved, transcriptionQuality: proof }, options), /전체 음성.*끝까지 인식/);
    }
    const audioPath = path.join(dataDir, 'owned-audio.mp3'); await fs.writeFile(audioPath, 'ID3owned-synthetic-lossy-audio');
    await assert.rejects(sendRemoteAnalysis(saved, { ...options, audioPath }), /무손실 FLAC/);
    assert.equal(calls, 0);
});
