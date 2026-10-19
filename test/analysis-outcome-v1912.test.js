const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { recordHealth } = require('../lib/record-health');
const { classifyDiagnosticError, sanitizeDiagnosticEvent } = require('../lib/diagnostics');
const { createAnalysisService } = require('../lib/analysis-service');
const { httpJsonFixture } = require('./http-json-fixture');

const sourceHash = source => crypto.createHash('sha256').update(JSON.stringify(source.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex');
const sourceCues = count => Array.from({ length: count }, (_, index) => ({ id: `owned-cue-${index}`, start: index * 3 + 0.125,
  end: index * 3 + 1.875, text: '合成の列車案内です。' }));
const translated = cue => ({ ...cue, text: '합성 열차 안내입니다.' });

function partialRecord({ count = 3, indexes = [0, 1], sourceComplete = true, sparse = false } = {}) {
  const transcript = sourceCues(count);
  return { id: 'a'.repeat(32), name: '합성 안내.mp4', status: 'partial', analysisMode: 'remote', summary: '보관된 합성 안내',
    transcript, transcriptSource: 'audio:faster-whisper large-v3', frames: [], warnings: [], labels: [],
    subtitleTranslationPartial: indexes.map(index => translated(transcript[index])),
    subtitleTranslationProgress: { version: sparse ? 2 : 1, language: 'ko', sourceFingerprint: sourceHash(transcript),
      totalCues: count, completedCues: indexes.length, complete: false, translationComplete: false, sourceComplete,
      ...(sparse ? { cueIndexes: indexes } : {}) } };
}

function completeRecord(count = 3) {
  const transcript = sourceCues(count);
  return { id: 'a'.repeat(32), name: '합성 안내.mp4', status: 'completed', summary: '합성 안내', labels: [], frames: [], warnings: [],
    transcript, subtitleLanguage: 'ko', subtitleTranslation: transcript.map(translated) };
}

test('records without subtitle evidence retain the original health shape', () => {
  assert.deepEqual(recordHealth({ status: 'completed', summary: '보관된 요약', transcript: sourceCues(2) }),
    { code: 'ready', summaryState: 'available', repairable: true, reason: '저장된 요약이 있습니다.' });
  assert.equal(recordHealth({ status: 'partial', subtitleError: 'old error only' }).completion, undefined);
});

test('all 129 saved translations with an incomplete source audit are distinguished from untranslated cues', () => {
  const record = partialRecord({ count: 129, indexes: Array.from({ length: 129 }, (_, index) => index), sourceComplete: false });
  record.subtitleTranslationProgress.translationComplete = true;
  const before = JSON.stringify(record), health = recordHealth(record);
  assert.equal(health.code, 'partial');
  assert.deepEqual(health.completion, { translationComplete: true, totalCues: 129, completedCues: 129, pendingCues: 0,
    sourceReviewRequired: true, subtitleSaveFailed: false });
  assert.match(health.reason, /번역은 129\/129구간까지 완료/);
  assert.match(health.reason, /원어 인식/);
  assert.doesNotMatch(health.reason, /번역은 아직 완료되지/);
  assert.equal(JSON.stringify(record), before);
});

test('a matched all-cue sparse retention union cannot certify a failed current translation attempt', () => {
  const record = partialRecord({ indexes: [0, 1, 2], sourceComplete: false, sparse: true });
  record.status = 'completed';
  const before = JSON.stringify(record), health = recordHealth(record);
  assert.equal(health.code, 'partial');
  assert.equal(health.completion.completedCues, 3);
  assert.equal(health.completion.pendingCues, 0);
  assert.equal(health.completion.translationComplete, false);
  assert.equal(health.completion.sourceReviewRequired, true);
  assert.match(health.reason, /현재 시도의 최종 번역 검수는 완료되지 않았/);
  assert.doesNotMatch(health.reason, /번역은.*완료했습니다/);
  assert.equal(JSON.stringify(record), before);
});

test('a complete translated array can still require source review without becoming ready', () => {
  const record = completeRecord(121);
  record.status = 'partial'; record.duration = 366; record.transcriptSource = 'audio:faster-whisper large-v3';
  record.transcriptionQuality = { version: 1, source: 'audio', profile: 'accurate', model: 'large-v3', complete: false,
    duration: 366, processedUntil: 366, processingComplete: true, audit: { complete: false, unresolved: [] } };
  const health = recordHealth(record);
  assert.equal(health.code, 'partial');
  assert.equal(health.completion.translationComplete, true);
  assert.equal(health.completion.sourceReviewRequired, true);
  assert.equal(health.completion.pendingCues, 0);
  assert.match(health.reason, /121\/121/);
});

test('a genuinely interrupted 1488 of 1856 translation reports the actual remaining count', () => {
  const record = partialRecord({ count: 1856, indexes: Array.from({ length: 1488 }, (_, index) => index) });
  const health = recordHealth(record);
  assert.equal(health.completion.translationComplete, false);
  assert.equal(health.completion.completedCues, 1488);
  assert.equal(health.completion.pendingCues, 368);
  assert.equal(health.completion.sourceReviewRequired, false);
  assert.match(health.reason, /368구간의 번역/);
});

test('sparse reviewed cues after two holes count as retained translations without claiming complete coverage', () => {
  const indexes = Array.from({ length: 1856 }, (_, index) => index).filter(index => ![1488, 1489].includes(index));
  const health = recordHealth(partialRecord({ count: 1856, indexes, sparse: true }));
  assert.equal(health.completion.completedCues, 1854);
  assert.equal(health.completion.pendingCues, 2);
  assert.equal(health.completion.translationComplete, false);
  assert.match(health.reason, /2구간의 번역/);
});

test('mismatched source fingerprints and forged progress counts never prove completed translations', () => {
  const stale = partialRecord();
  stale.subtitleTranslationProgress.sourceFingerprint = '0'.repeat(64);
  stale.subtitleTranslationProgress.sourceComplete = false;
  assert.equal(recordHealth(stale).completion.completedCues, 0);
  assert.equal(recordHealth(stale).completion.sourceReviewRequired, false);
  const forged = partialRecord(); forged.subtitleTranslationProgress.completedCues = 3;
  assert.equal(recordHealth(forged).completion.completedCues, 0);
  const full = completeRecord();
  full.subtitleTranslationProgress = { ...partialRecord().subtitleTranslationProgress, sourceFingerprint: '0'.repeat(64) };
  assert.equal(recordHealth(full).completion.translationComplete, false);
  assert.equal(recordHealth(full).completion.completedCues, 0);
});

test('cue times and IDs must match before a saved full translation proves completion', () => {
  for (const change of [record => { record.subtitleTranslation[1].end += 0.01; },
    record => { record.subtitleTranslation[1].id = 'wrong-owned-cue'; }]) {
    const record = completeRecord(); change(record);
    assert.equal(recordHealth(record).completion.completedCues, 0);
    assert.equal(recordHealth(record).completion.translationComplete, false);
  }
});

test('compact completion uses only paired derived counts and a matching available fingerprint', () => {
  const compact = { status: 'partial', catalogView: 'summary', summary: '합성 안내', transcriptCount: 20,
    subtitleTranslatedCount: 18, subtitleTranslationSourceFingerprint: 'a'.repeat(64) };
  assert.equal(recordHealth(compact).completion.pendingCues, 2);
  const unmatched = { ...compact, subtitleTranslationProgress: { language: 'ko', totalCues: 20, sourceComplete: false, sourceFingerprint: 'b'.repeat(64) } };
  assert.equal(recordHealth(unmatched).completion.completedCues, 0);
  assert.equal(recordHealth(unmatched).completion.sourceReviewRequired, false);
  assert.equal(recordHealth({ ...compact, subtitleTranslatedCount: 21 }).completion, undefined);
  assert.equal(recordHealth({ ...compact, subtitleTranslationSourceFingerprint: 'private-invalid-proof' }).completion, undefined);
});

test('unknown source counts stay unknown rather than turning unverified counters into progress', () => {
  const health = recordHealth({ status: 'partial', subtitleTranslationProgress: { language: 'ko', totalCues: 100, completedCues: 100, complete: true } });
  assert.equal(health.completion.totalCues, null);
  assert.equal(health.completion.pendingCues, null);
  assert.equal(health.completion.completedCues, 0);
  assert.equal(health.completion.translationComplete, false);
});

test('sidecar write failure is distinct from missing translation and cannot appear ready', () => {
  const record = completeRecord(); record.subtitleAutoSave = { status: 'failed', code: 'EACCES' };
  const health = recordHealth(record);
  assert.equal(record.status, 'completed', 'health does not mutate the retained provider outcome');
  assert.equal(health.code, 'partial');
  assert.equal(health.completion.translationComplete, true);
  assert.equal(health.completion.subtitleSaveFailed, true);
  assert.match(health.reason, /번역은 끝났지만.*SRT 파일을 저장하지 못/);
});

test('an inconsistent completed status does not override validated missing translation evidence', () => {
  const record = partialRecord(); record.status = 'completed';
  assert.equal(recordHealth(record).code, 'partial');
  assert.equal(recordHealth(record).completion.pendingCues, 1);
});

test('precise refusal and local timeout explanations survive completion metadata', () => {
  const refusal = partialRecord(); refusal.subtitleError = 'owned stopped';
  refusal.subtitleDiagnostic = { code: 'SUBTITLE_PROVIDER_REFUSAL', refusalSource: 'response-field' };
  assert.match(recordHealth(refusal).reason, /응답에 거절 표시/);
  assert.doesNotMatch(recordHealth(refusal).reason, /자동.*재시도/);
  const timeout = partialRecord(); timeout.subtitleError = 'owned stopped';
  timeout.subtitleDiagnostic = { code: 'PROVIDER_TIMEOUT', executionSource: 'local-deadline' };
  assert.match(recordHealth(timeout).reason, /대기 제한 시간/);
  timeout.subtitleAutoSave = { status: 'failed', code: 'ENOSPC' };
  assert.match(recordHealth(timeout).reason, /SRT 파일로 저장하지 못/);
  assert.match(recordHealth(timeout).reason, /대기 제한 시간/);
});

test('pending-cue diagnostics use a static safe message and do not expose supplied content', () => {
  const clean = sanitizeDiagnosticEvent({ code: 'SUBTITLE_CUES_PENDING', message: 'PRIVATE_TRANSCRIPT', rawResponse: 'PRIVATE_RESPONSE',
    causeCode: 'SUBTITLE_REVIEW_TOO_SHORT', stage: 'translation_review', totalCues: 1856, completedCues: 1854 });
  assert.equal(clean.code, 'SUBTITLE_CUES_PENDING');
  assert.equal(clean.causeCode, 'SUBTITLE_REVIEW_TOO_SHORT');
  assert.equal(clean.completedCues, 1854);
  assert.equal(JSON.stringify(clean).includes('PRIVATE_'), false);
  assert.deepEqual(sanitizeDiagnosticEvent(clean), clean);
});

test('coded immediate I/O causes preserve only known cause and system codes', () => {
  const cause = Object.assign(new Error('PRIVATE_FILE_PATH_AND_MESSAGE'), { code: 'EACCES', stack: 'PRIVATE_STACK', transcript: 'PRIVATE_DIALOGUE' });
  cause.cause = cause;
  const clean = classifyDiagnosticError({ code: 'SIDECAR_SAVE_FAILED', cause });
  assert.equal(clean.code, 'SIDECAR_SAVE_FAILED');
  assert.equal(clean.causeCode, 'STORAGE_WRITE_FAILED');
  assert.equal(clean.systemCode, 'EACCES');
  assert.equal(JSON.stringify(clean).includes('PRIVATE_'), false);
  assert.deepEqual(sanitizeDiagnosticEvent(clean), sanitizeDiagnosticEvent({ code: 'SIDECAR_SAVE_FAILED', cause }));
  for (const systemCode of ['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EEXIST', 'ENAMETOOLONG', 'EINVAL', 'EBUSY']) {
    const diagnostic = classifyDiagnosticError({ code: systemCode });
    assert.equal(diagnostic.systemCode, systemCode);
    assert.equal(diagnostic.code, 'STORAGE_WRITE_FAILED');
  }
});

test('unknown cause codes and arbitrary cause fields cannot enter stored diagnostics', () => {
  const clean = sanitizeDiagnosticEvent({ code: 'SIDECAR_SAVE_FAILED', causeCode: 'PRIVATE_CODE', systemCode: 'PRIVATE_SYSTEM',
    cause: { code: 'PRIVATE_CAUSE', message: 'PRIVATE_MESSAGE', headers: { authorization: 'PRIVATE_TOKEN' } } });
  assert.equal(clean.causeCode, undefined); assert.equal(clean.systemCode, undefined);
  assert.equal(JSON.stringify(clean).includes('PRIVATE_'), false);
});

test('a cause code cannot replace authoritative refusal or timeout classification and provenance', () => {
  const refusal = classifyDiagnosticError({ code: 'SUBTITLE_PROVIDER_REFUSAL', refusalSource: 'response-field', causeCode: 'STORAGE_WRITE_FAILED' });
  assert.equal(refusal.code, 'SUBTITLE_PROVIDER_REFUSAL'); assert.equal(refusal.refusalSource, 'response-field');
  const timeout = classifyDiagnosticError({ code: 'PROVIDER_TIMEOUT', executionSource: 'local-deadline', executionElapsedMs: 900000,
    executionDeadlineMs: 900000, causeCode: 'STORAGE_WRITE_FAILED' });
  assert.equal(timeout.code, 'PROVIDER_TIMEOUT'); assert.equal(timeout.executionSource, 'local-deadline');
  assert.equal(timeout.executionElapsedMs, 900000);
});

async function serviceFixture(t, subtitleWriter, { historical } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-outcome-v1912-'));
  const dataDir = path.join(root, 'catalog'), video = path.join(root, '합성 안내.mp4');
  await fs.writeFile(video, 'Owned fixture file. No media decoder is used.');
  if (historical) {
    await fs.mkdir(path.join(dataDir, 'results'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'results', historical.id + '.json'), JSON.stringify({ ...historical, path: video }));
  }
  let calls = 0;
  const service = createAnalysisService({ dataDir, subtitleWriter, engine: { getToolsStatus: async () => ({ available: true }),
    analyzeVideo: async file => { calls++; return { ...completeRecord(), ...file }; } } });
  await service.ready;
  service.registerFiles([{ path: video, name: path.basename(video) }]);
  const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}/api/analysis/`;
  const request = async (endpoint, body) => {
    const response = await httpJsonFixture(base, endpoint, body);
    assert.equal(response.status, endpoint === '/jobs' && body !== undefined ? 202 : 200, response.data.error);
    return response.data;
  };
  const until = async check => {
    for (let index = 0; index < 500; index++) {
      const value = await check(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Owned outcome fixture did not complete');
  };
  t.after(async () => {
    await service.stop(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('videorandom-outcome-v1912-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, dataDir, video, request, until, calls: () => calls };
}

test('analysis persistence and the saved-subtitle action retain safe I/O causes in their diagnostic events', async t => {
  const f = await serviceFixture(t, async () => ({ status: 'failed', path: '', code: 'EACCES', systemCode: 'EACCES', error: 'PRIVATE_WRITE_MESSAGE' }));
  const started = await f.request('/jobs', { files: [f.video], options: { mode: 'local', subtitleLanguage: 'ko' } });
  const done = await f.until(async () => { const job = await f.request('/jobs/' + started.id); return job.status === 'completed' ? job : null; });
  const record = done.results[0];
  assert.equal(record.health.completion.translationComplete, true);
  assert.equal(record.health.completion.subtitleSaveFailed, true);
  assert.equal(record.health.code, 'partial');
  const retriedSave = await f.request(`/results/${record.id}/subtitles/save`, {});
  assert.equal(retriedSave.subtitleAutoSave.code, 'EACCES');
  const diagnostics = await f.request('/diagnostics?limit=200');
  const failures = diagnostics.events.filter(event => event.code === 'SIDECAR_SAVE_FAILED');
  assert.equal(failures.length, 2);
  for (const event of failures) {
    assert.equal(event.systemCode, 'EACCES'); assert.equal(event.causeCode, 'STORAGE_WRITE_FAILED');
    assert.equal(event.totalCues, 3); assert.equal(event.completedCues, 3);
    assert.equal(JSON.stringify(event).includes('PRIVATE_'), false);
    assert.equal(JSON.stringify(event).includes(f.root), false);
  }
  const persisted = JSON.parse(await fs.readFile(path.join(f.dataDir, 'results', record.id + '.json'), 'utf8'));
  assert.deepEqual(persisted.subtitleTranslation, record.subtitleTranslation);
  assert.equal(persisted.health.completion.subtitleSaveFailed, true);
  assert.equal(f.calls(), 1, 'saving again cannot analyze or translate');
});

test('a thrown sidecar writer error preserves its explicitly coded I/O cause without leaking the cause', async t => {
  const cause = Object.assign(new Error('PRIVATE_CAUSE_PATH'), { code: 'EIO' });
  const f = await serviceFixture(t, async () => { throw new Error('Owned wrapper failure', { cause }); });
  const started = await f.request('/jobs', { files: [f.video], options: { mode: 'local', subtitleLanguage: 'ko' } });
  const done = await f.until(async () => { const job = await f.request('/jobs/' + started.id); return job.status === 'completed' ? job : null; });
  assert.equal(done.results[0].subtitleAutoSave.systemCode, 'EIO');
  assert.equal(done.results[0].subtitleAutoSave.causeCode, 'STORAGE_WRITE_FAILED');
  const failure = (await f.request('/diagnostics?limit=200')).events.find(event => event.code === 'SIDECAR_SAVE_FAILED');
  assert.equal(failure.systemCode, 'EIO'); assert.equal(failure.causeCode, 'STORAGE_WRITE_FAILED');
  assert.equal(JSON.stringify(failure).includes('PRIVATE_'), false);
  assert.equal(f.calls(), 1);
});

test('imported saved write failures retain their own I/O cause rather than unrelated provider timeout fields', async t => {
  const historical = { ...completeRecord(), status: 'partial', analysisMode: 'remote', savedAt: '2026-10-19T00:00:00Z',
    subtitleAutoSave: { status: 'failed', code: 'ENOSPC', error: 'PRIVATE_HISTORICAL_MESSAGE' },
    subtitleDiagnostic: { code: 'PROVIDER_TIMEOUT', executionSource: 'local-deadline', executionDeadlineMs: 900000 },
    subtitleError: 'Owned historical timeout' };
  const f = await serviceFixture(t, async () => { throw new Error('Passive import cannot save a sidecar'); }, { historical });
  const event = await f.until(async () => (await f.request('/diagnostics?limit=200')).events.find(item => item.event === 'history-imported'));
  assert.equal(event.code, 'SIDECAR_SAVE_FAILED'); assert.equal(event.systemCode, 'ENOSPC');
  assert.equal(event.causeCode, 'STORAGE_WRITE_FAILED');
  assert.equal(event.executionSource, undefined); assert.equal(event.executionDeadlineMs, undefined);
  assert.equal(JSON.stringify(event).includes('PRIVATE_'), false);
  assert.equal(f.calls(), 0);
});
