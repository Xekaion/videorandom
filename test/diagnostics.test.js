const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createDiagnosticsStore, sanitizeDiagnosticEvent, classifyDiagnosticError } = require('../lib/diagnostics');
const run = promisify(execFile);

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-diagnostics-'));
  const store = createDiagnosticsStore({ dataDir }); await store.ready;
  t.after(async () => { await store.flush(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { store, dataDir };
}

test('diagnostics retain only canonical technical metadata without user content or paths', () => {
  const clean = sanitizeDiagnosticEvent({ source: 'client', level: 'error', event: 'error', stage: 'translation_review',
    videoName: 'C:\\private\\owned-video.mp4', clientId: 'owned-client', clientName: 'Owned PC', jobId: 'ownedjob',
    completedCues: 80, totalCues: 1819, expectedCues: 80, returnedCues: 79, startCue: 80, endCue: 159,
    message: '대사 수가 원문과 일치하지 않습니다. private transcript secret', transcript: ['secret'], prompt: 'private',
    image: 'private', stack: 'C:/private', connectionCode: 'private', headers: { authorization: 'Bearer private' }, clientVersion: '1.9.2' });
  assert.equal(clean.videoName, 'owned-video.mp4');
  assert.equal(clean.code, 'SUBTITLE_CUE_COUNT_MISMATCH');
  assert.equal(clean.expectedCues, 80); assert.equal(clean.returnedCues, 79);
  assert.equal(JSON.stringify(clean).includes('private'), false);
  assert.equal(JSON.stringify(clean).includes('secret'), false);
  assert.equal(sanitizeDiagnosticEvent({ message: 'unrecognized private dialogue', code: 'CUSTOM_SECRET' }).code, 'DIAGNOSTIC_UNKNOWN');
  assert.equal(sanitizeDiagnosticEvent({ completedCues: -1, returnedCues: 50001, clientName: 'C:/path', stage: '대사 내용' }).completedCues, undefined);
  const injected = sanitizeDiagnosticEvent({ event: 'private_secret', stage: 'private_dialogue', operation: 'private_prompt', status: 'private_token', systemCode: 'PRIVATE' });
  assert.deepEqual(injected, { source: 'host', level: 'info' });
});

test('known validation, provider and storage errors have static safe messages', () => {
  for (const [input, code] of [['503 ServiceUnavailable private', 'PROVIDER_UNAVAILABLE'], ['401 private', 'PROVIDER_AUTH'],
    ['429 usage limit', 'PROVIDER_QUOTA'], ['timeout', 'PROVIDER_TIMEOUT'], ['EHOSTUNREACH', 'NETWORK_UNREACHABLE'],
    ['ENOSPC private', 'STORAGE_WRITE_FAILED'], ['번역 대사가 지나치게 짧아', 'SUBTITLE_TEXT_TOO_SHORT'],
    ["No module named 'faster_whisper'", 'LOCAL_DEPENDENCY_MISSING'], [{ code: 'ENOENT', message: 'private' }, 'FILE_NOT_FOUND'],
    [{ code: 'EACCES', message: 'private' }, 'STORAGE_WRITE_FAILED'], ['진행 중인 작업이 있습니다.', 'ANALYSIS_BUSY'],
    [{ code: 'SUBTITLE_REVIEW_TOO_SHORT', message: 'private' }, 'SUBTITLE_REVIEW_TOO_SHORT']]) {
    const result = classifyDiagnosticError(input); assert.equal(result.code, code); assert.equal(result.message.includes('private'), false);
  }
  assert.equal(classifyDiagnosticError({ code: 'EACCES' }).systemCode, 'EACCES');
  assert.equal(sanitizeDiagnosticEvent({ code: 'STORAGE_WRITE_FAILED', systemCode: 'EACCES' }).systemCode, 'EACCES');
  assert.equal(sanitizeDiagnosticEvent(sanitizeDiagnosticEvent(classifyDiagnosticError('503 ServiceUnavailable private'))).httpStatus, 503);
  assert.equal(classifyDiagnosticError({ code: 'PROVIDER_UNAVAILABLE', httpStatus: 503 }).httpStatus, 503);
});

test('refusal diagnostics retain only known provenance and distinguish detected subtitle text', () => {
  const sources = ['response-field', 'subtitle-text', 'execution-error'];
  const codes = ['PROVIDER_REFUSAL', 'SUBTITLE_PROVIDER_REFUSAL', 'SUBTITLE_REFUSAL_TEXT_DETECTED'];
  for (const code of codes) for (const refusalSource of sources) {
    const input = { code, refusalSource, message: 'private response', refusal: 'private reason',
      refusalReason: 'private policy category', prompt: 'private prompt', transcript: 'private dialogue' };
    const classified = classifyDiagnosticError(input);
    assert.equal(classified.code, code); assert.equal(classified.refusalSource, refusalSource);
    assert.equal(JSON.stringify(classified).includes('private'), false);
    const clean = sanitizeDiagnosticEvent(input);
    assert.equal(clean.refusalSource, refusalSource);
    assert.equal(JSON.stringify(clean).includes('private'), false);
    assert.deepEqual(sanitizeDiagnosticEvent(clean), clean);
  }
  const detected = classifyDiagnosticError({ code: 'SUBTITLE_REFUSAL_TEXT_DETECTED', refusalSource: 'subtitle-text' });
  assert.match(detected.message, /거절로 보이는 문구/);
  assert.match(detected.message, /실제 거절 여부와 사유는 확인되지/);
  assert.match(detected.message, /자동 재시도하지 않습니다/);
  assert.notEqual(detected.message, classifyDiagnosticError({ code: 'SUBTITLE_PROVIDER_REFUSAL' }).message);
  assert.equal(classifyDiagnosticError('request refused').refusalSource, undefined, 'provenance is not invented for old text-only errors');
  assert.equal(sanitizeDiagnosticEvent({ error: { code: 'SUBTITLE_PROVIDER_REFUSAL', refusalSource: 'response-field' } }).refusalSource, 'response-field');
  assert.equal(sanitizeDiagnosticEvent({ message: 'request refused', refusalSource: 'execution-error' }).refusalSource, 'execution-error');
});

test('refusal provenance drops unrecognized values and cannot replace technical error classification', () => {
  for (const refusalSource of ['response-field private', 'policy', 'private reason', '', 1, null, [], {}, true]) {
    assert.equal('refusalSource' in classifyDiagnosticError({ code: 'SUBTITLE_PROVIDER_REFUSAL', refusalSource }), false);
    assert.equal('refusalSource' in sanitizeDiagnosticEvent({ code: 'SUBTITLE_REFUSAL_TEXT_DETECTED', refusalSource }), false);
  }
  assert.equal('refusalSource' in sanitizeDiagnosticEvent({ refusalSource: 'response-field' }), false);
  for (const [message, code] of [['ECONNREFUSED private', 'NETWORK_UNREACHABLE'], ['401 authentication refused', 'PROVIDER_AUTH'],
    ['403 request refused', 'PROVIDER_AUTH'], ['429 quota refused', 'PROVIDER_QUOTA'], ['503 ServiceUnavailable request refused', 'PROVIDER_UNAVAILABLE'],
    ['ETIMEDOUT refused', 'PROVIDER_TIMEOUT'], ['EACCES request refused', 'STORAGE_WRITE_FAILED']]) {
    const classified = classifyDiagnosticError({ message, refusalSource: 'execution-error' });
    assert.equal(classified.code, code, message);
    assert.equal('refusalSource' in classified, false);
    const clean = sanitizeDiagnosticEvent({ message, refusalSource: 'subtitle-text' });
    assert.equal(clean.code, code); assert.equal('refusalSource' in clean, false);
  }
  assert.equal('refusalSource' in classifyDiagnosticError({ code: 'PROVIDER_AUTH', refusalSource: 'response-field' }), false);
});

test('safe refusal provenance survives storage, client outbox, fresh process and JSONL export', async t => {
  const { store, dataDir } = await fixture(t);
  const event = { event: 'error', level: 'error', stage: 'translation_review', code: 'SUBTITLE_REFUSAL_TEXT_DETECTED',
    refusalSource: 'subtitle-text', completedCues: 240, totalCues: 1819, startCue: 240, endCue: 319,
    message: 'private response', refusalReason: 'private reason', transcript: 'private dialogue' };
  await store.append(event);
  await store.enqueueReport(event, 'http://127.0.0.1:3001');
  let exported = ''; for await (const line of store.exportEvents()) exported += line;
  assert.equal(JSON.parse(exported).refusalSource, 'subtitle-text');
  assert.equal(exported.includes('private'), false);
  const code = `const s=require('./lib/diagnostics').createDiagnosticsStore({dataDir:process.argv[1]});(async()=>console.log(JSON.stringify({query:await s.query(),outbox:await s.pendingReports('http://127.0.0.1:3001')})))();`;
  const output = await run(process.execPath, ['-e', code, dataDir], { cwd: path.resolve(__dirname, '..'), windowsHide: true });
  const reopened = JSON.parse(output.stdout);
  assert.equal(reopened.query.events[0].refusalSource, 'subtitle-text');
  assert.equal(reopened.outbox[0].event.refusalSource, 'subtitle-text');
  assert.equal(reopened.query.events[0].code, 'SUBTITLE_REFUSAL_TEXT_DETECTED');
  assert.equal(output.stdout.includes('private'), false);
});

test('HTTP status survives repeated sanitization, persistence and JSONL export', async t => {
  const { store, dataDir } = await fixture(t);
  await store.append({ event: 'error', level: 'error', ...classifyDiagnosticError('503 ServiceUnavailable private') });
  let exported = ''; for await (const line of store.exportEvents()) exported += line;
  assert.equal(JSON.parse(exported).httpStatus, 503);
  const code = `const s=require('./lib/diagnostics').createDiagnosticsStore({dataDir:process.argv[1]});s.query().then(x=>console.log(JSON.stringify(x)));`;
  const output = await run(process.execPath, ['-e', code, dataDir], { cwd: path.resolve(__dirname, '..'), windowsHide: true });
  assert.equal(JSON.parse(output.stdout).events[0].httpStatus, 503);
});

test('shared instances serialize all history with bounded filtered pagination and idempotent imports', async t => {
  const { store, dataDir } = await fixture(t);
  assert.equal(createDiagnosticsStore({ dataDir }), store);
  await Promise.all(Array.from({ length: 230 }, (_, index) => store.append({ clientId: 'pc' + index % 2, clientName: 'Owned PC ' + index % 2,
    event: 'error', level: index % 2 ? 'error' : 'info', jobId: 'job' + index, videoName: 'owned-' + index + '.mp4', code: 'ANALYSIS_PARTIAL' })));
  const first = await store.query({ limit: 500 }); assert.equal(first.events.length, 200); assert.equal(first.hasMore, true);
  assert.equal((await store.query({ before: first.nextCursor, limit: 200 })).events.length, 30);
  const filtered = await store.query({ q: 'owned-17.mp4', level: 'error' }); assert.equal(filtered.events.length, 1);
  assert.equal(filtered.clients.length, 2); assert.equal(filtered.stats.total, 230);
  const one = await store.append({ event: 'imported', code: 'ANALYSIS_PARTIAL' }, { dedupeKey: 'owned-original-result' });
  const two = await store.append({ event: 'imported', code: 'ANALYSIS_PARTIAL' }, { dedupeKey: 'owned-original-result' });
  assert.equal(one.id, two.id); assert.equal((await store.query()).stats.total, 231);
});

test('persistent events, PC identity and pending outbox survive a fresh Node process', async t => {
  const { store, dataDir } = await fixture(t), identity = await store.getIdentity();
  await store.append({ level: 'error', event: 'error', code: 'PROVIDER_TIMEOUT', videoName: 'owned.mp4' });
  const queued = await store.enqueueReport({ event: 'error', code: 'SIDECAR_SAVE_FAILED' }, 'http://127.0.0.1:3001');
  await store.flush();
  const code = `const s=require('./lib/diagnostics').createDiagnosticsStore({dataDir:process.argv[1]}); (async()=>console.log(JSON.stringify({identity:await s.getIdentity(),query:await s.query(),outbox:await s.pendingReports('http://127.0.0.1:3001')})))().catch(()=>process.exit(1));`;
  const output = await run(process.execPath, ['-e', code, dataDir], { cwd: path.resolve(__dirname, '..'), windowsHide: true });
  const reopened = JSON.parse(output.stdout);
  assert.equal(reopened.identity.clientId, identity.clientId); assert.equal(reopened.query.stats.total, 1);
  assert.equal(reopened.outbox[0].reportId, queued.reportId);
  const outboxFile = path.join(dataDir, 'diagnostics', 'outbox', queued.reportId + '.json');
  const staleOutbox = await fs.readFile(outboxFile);
  await store.ackReports([queued.reportId]); assert.deepEqual(await store.pendingReports('http://127.0.0.1:3001'), []);
  await store.enqueueReport(queued.event, 'http://127.0.0.1:3001');
  assert.deepEqual(await store.pendingReports('http://127.0.0.1:3001'), []);
  // Simulate a process stopping after durable acknowledgement but before removal.
  await fs.writeFile(outboxFile, staleOutbox);
  const receiptCode = `const s=require('./lib/diagnostics').createDiagnosticsStore({dataDir:process.argv[1]}); (async()=>{await s.enqueueReport(JSON.parse(process.argv[2]),'http://127.0.0.1:3001');console.log(JSON.stringify(await s.pendingReports('http://127.0.0.1:3001')));})().catch(()=>process.exit(1));`;
  const afterAck = await run(process.execPath, ['-e', receiptCode, dataDir, JSON.stringify(queued.event)], { cwd: path.resolve(__dirname, '..'), windowsHide: true });
  assert.deepEqual(JSON.parse(afterAck.stdout), []);
});

test('outbox acknowledgement cannot delete an event before its receipt is durable', async t => {
  const { store, dataDir } = await fixture(t);
  const queued = await store.enqueueReport({ id: 'owned-event', event: 'error', code: 'CLIENT_REPORT_FAILED' }, 'http://127.0.0.1:3001');
  const target = path.join(dataDir, 'diagnostics', 'receipts', queued.reportId + '.json');
  await fs.mkdir(target);
  await assert.rejects(store.ackReports([queued.reportId]));
  assert.equal((await store.pendingReports('http://127.0.0.1:3001'))[0].reportId, queued.reportId);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'diagnostics', 'outbox', queued.reportId + '.json'), 'utf8')).reportId, queued.reportId);
});

test('independent PC directories stay isolated and historical original versions are not invented', async t => {
  const first = await fixture(t), second = await fixture(t);
  await first.store.append({ event: 'error', code: 'ANALYSIS_FAILED' });
  assert.equal((await second.store.query()).stats.total, 0);
  const unknown = await first.store.enqueueReport({ id: 'history-unknown', event: 'history-imported', code: 'ANALYSIS_PARTIAL' }, 'http://127.0.0.1:3001');
  const known = await first.store.enqueueReport({ id: 'history-known', event: 'history-imported', clientVersion: '1.6.5', serverVersion: '1.6.1', code: 'ANALYSIS_PARTIAL' }, 'http://127.0.0.1:3001');
  assert.equal(unknown.event.clientVersion, undefined); assert.equal(unknown.event.serverVersion, undefined);
  assert.equal(unknown.event.reporterVersion, (await first.store.getIdentity()).clientVersion);
  assert.equal(known.event.clientVersion, '1.6.5'); assert.equal(known.event.serverVersion, '1.6.1');
});

test('JSONL export sanitizes all events and never silently deletes corrupt saved history', async t => {
  const { store, dataDir } = await fixture(t);
  await store.append({ event: 'error', level: 'error', message: 'private unknown dialogue', videoName: 'owned.mp4' });
  let exported = ''; for await (const line of store.exportEvents()) exported += line;
  assert.equal(exported.trim().split('\n').length, 1); assert.equal(exported.includes('private'), false);
  const corrupt = path.join(dataDir, 'diagnostics', 'events', 'f'.repeat(64) + '.json'); await fs.writeFile(corrupt, 'bad json');
  const code = `const s=require('./lib/diagnostics').createDiagnosticsStore({dataDir:process.argv[1]});s.query().then(x=>console.log(JSON.stringify(x)));`;
  const output = await run(process.execPath, ['-e', code, dataDir], { cwd: path.resolve(__dirname, '..'), windowsHide: true });
  assert.match(JSON.parse(output.stdout).error, /일부 진단/); assert.equal(await fs.readFile(corrupt, 'utf8'), 'bad json');
});

test('HTTP diagnostics preserve observed status codes and leave an unknown status unknown', () => {
  assert.equal(classifyDiagnosticError('500 Internal Server Error').httpStatus, 500);
  assert.equal(classifyDiagnosticError('503 Service Unavailable').httpStatus, 503);
  for (const message of ['ServiceUnavailable', '로그인이 필요합니다.', '사용량 한도에 도달했습니다.']) {
    assert.equal('httpStatus' in classifyDiagnosticError(message), false, message);
  }
  assert.equal(sanitizeDiagnosticEvent({ stage: 'connection', code: 'NETWORK_UNREACHABLE' }).stage, 'connection');
  assert.equal(classifyDiagnosticError('EACCES C:/PRIVATE-PATH').systemCode, 'EACCES');
  assert.equal(classifyDiagnosticError('분석을 중지했습니다.').code, 'ANALYSIS_CANCELLED');
});
