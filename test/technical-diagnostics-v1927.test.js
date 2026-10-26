const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createDiagnosticsStore, classifyAnalysisFailure, createDiagnosticFailureHealth } = require('../lib/diagnostics');
const { createDiagnosticReporter } = require('../lib/diagnostic-reporter');
const { createCatalogEngine } = require('../lib/catalog-engine');
const run = promisify(execFile);
const PRIVATE = 'PRIVATE_RAW_TRANSCRIPT_OR_PATH';
const technicalError = fields => Object.assign(new Error(PRIVATE), { stdout: PRIVATE, stderr: PRIVATE, prompt: PRIVATE, stack: PRIVATE }, fields);
const neutralRecord = () => ({ id: 'neutral-record', status: 'completed', hasAudio: false, warnings: [], frames: [], transcript: [{ start: 1, end: 2, text: '회의는 오후입니다.' }] });

for (const [fields, expected, extras] of [
  [{ code: 'ENOSPC' }, 'STORAGE_WRITE_FAILED', { systemCode: 'ENOSPC' }],
  [{ code: 'EISDIR' }, 'STORAGE_WRITE_FAILED', { systemCode: 'EISDIR' }],
  [{ code: 'ETIMEDOUT' }, 'PROVIDER_TIMEOUT', { systemCode: 'ETIMEDOUT' }],
  [{ code: 'ECONNRESET' }, 'NETWORK_UNREACHABLE', { systemCode: 'ECONNRESET' }],
  [{ code: 'STORAGE_SPACE_LOW' }, 'STORAGE_SPACE_LOW', {}],
  [{ statusCode: 503 }, 'PROVIDER_UNAVAILABLE', { httpStatus: 503 }],
  [{ status: 401 }, 'PROVIDER_AUTH', { httpStatus: 401 }],
  [{ httpStatus: 429 }, 'PROVIDER_QUOTA', { httpStatus: 429 }],
  [{ code: 'SUMMARY_INVALID', cause: technicalError({ code: 'PROVIDER_AUTH' }) }, 'PROVIDER_AUTH', { causeCode: 'PROVIDER_AUTH' }],
  [{ code: 'SUMMARY_INVALID', cause: technicalError({ code: 'PROVIDER_REFUSAL', refusalSource: 'execution-error' }) }, 'PROVIDER_REFUSAL', { causeCode: 'PROVIDER_REFUSAL', refusalSource: 'execution-error' }],
  [{ code: 'PROVIDER_AUTH', name: 'AbortError' }, 'ANALYSIS_CANCELLED', {}],
  [{ code: 'DIAGNOSTIC_UNKNOWN', executionSource: 'local-deadline', executionElapsedMs: 900004, executionDeadlineMs: 900000 }, 'PROVIDER_TIMEOUT', { executionSource: 'local-deadline', executionElapsedMs: 900004, executionDeadlineMs: 900000 }],
  [{ code: 'DIAGNOSTIC_UNKNOWN', executionSource: 'provider-error', providerErrorType: 'capacity', providerHttpStatus: 503 }, 'PROVIDER_CAPACITY', { executionSource: 'provider-error', providerErrorType: 'capacity', providerHttpStatus: 503, httpStatus: 503 }],
  [{ diagnostic: { code: 'SUBTITLE_PROVIDER_REFUSAL', refusalSource: 'response-field', stage: 'translation_draft', message: PRIVATE } }, 'SUBTITLE_PROVIDER_REFUSAL', { refusalSource: 'response-field' }],
  [{ cause: technicalError({ code: 'PROVIDER_QUOTA', httpStatus: 429, cause: technicalError({ code: 'ENOSPC' }) }) }, 'PROVIDER_QUOTA', { causeCode: 'PROVIDER_QUOTA', httpStatus: 429 }],
  [{ cause: technicalError({ code: 'PRIVATE_UNKNOWN_CODE', httpStatus: 401, cause: technicalError({ code: 'PROVIDER_AUTH' }) }) }, 'DIAGNOSTIC_UNKNOWN', {}]
]) test(`typed analysis failure retains ${expected}: ${JSON.stringify(fields, (key, value) => ['cause', 'diagnostic'].includes(key) ? 'safe fixture' : value)}`, () => {
  const result = classifyAnalysisFailure(technicalError(fields));
  assert.equal(result.code, expected);
  for (const [key, value] of Object.entries(extras)) assert.equal(result[key], value, key);
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  assert.equal('cause' in result, false);
});

for (const mode of ['codex', 'remote']) test(`catalog ${mode} catch retains typed technical failure without decoding media`, async () => {
  let attempts = 0;
  const failure = technicalError({ code: 'ECONNRESET', statusCode: 502, executionSource: 'provider-error', providerErrorType: 'network', executionElapsedMs: 81 });
  const engine = createCatalogEngine({
    extractionImpl: { analyzeVideo: async () => neutralRecord(), getToolsStatus() { throw new Error('No tools'); } },
    providerImpl: { analyzeExtracted: async () => { attempts++; throw failure; } },
    lanImpl: { checkRemoteServer: async () => ({ capabilities: [] }), sendRemoteAnalysis: async () => { attempts++; throw failure; } }
  });
  const record = await engine.analyzeVideo({ path: 'neutral.mp4' }, { mode }, { dataDir: 'unused' });
  assert.equal(attempts, 1); assert.equal(record.status, 'partial');
  assert.equal(record.analysisDiagnostic.code, 'NETWORK_UNREACHABLE');
  assert.equal(record.analysisDiagnostic.systemCode, 'ECONNRESET'); assert.equal(record.analysisDiagnostic.httpStatus, 502);
  assert.equal(record.analysisDiagnostic.executionElapsedMs, 81);
  assert.equal(JSON.stringify(record.analysisDiagnostic).includes(PRIVATE), false);
});

test('catalog cancellation keeps typed diagnostic on thrown partial record', async () => {
  const engine = createCatalogEngine({ extractionImpl: { analyzeVideo: async () => neutralRecord() },
    providerImpl: { analyzeExtracted: async () => { throw technicalError({ name: 'AbortError', code: 'PROVIDER_AUTH' }); } } });
  await assert.rejects(engine.analyzeVideo({}, { mode: 'codex' }, {}), error => {
    assert.equal(error.name, 'AbortError'); assert.equal(error.record.analysisDiagnostic.code, 'ANALYSIS_CANCELLED'); return true;
  });
});

test('catalog forwards acceptance receipts for analysis and translation and only resumes existing accepted jobs', async () => {
  const receipt = { serverJobId: 'owned-job', operation: 'analysis' }, source = neutralRecord(), calls = [];
  const callback = async (accepted, record) => { calls.push([accepted, record]); };
  const engine = createCatalogEngine({ extractionImpl: { analyzeVideo: async () => source }, providerImpl: {}, lanImpl: {
    checkRemoteServer: async () => ({ capabilities: [] }),
    async sendRemoteAnalysis(record, options) { await options.onRemoteJobAccepted(receipt, record); return record; },
    async resumeRemoteAnalysis(record, options, accepted) { assert.equal(accepted, receipt); assert.equal(options.remoteUrl, 'http://127.0.0.1:3300'); return { ...record, status: 'completed' }; }
  } });
  const context = { dataDir: 'unused', onRemoteJobAccepted: callback };
  await engine.analyzeVideo({}, { mode: 'remote' }, context);
  await engine.translateSubtitles(source, { mode: 'remote' }, context);
  assert.equal(calls.length, 2); assert.equal(calls[0][0], receipt); assert.equal(calls[0][1], source);
  assert.equal((await engine.resumeRemoteAnalysis(source, { remoteUrl: 'http://127.0.0.1:3300' }, receipt, context)).status, 'completed');
  assert.equal(calls.length, 2, 'resuming an accepted job does not create another acceptance or submit request');
});

for (const recoverable of [true, false, undefined, 'true']) test(`catalog remote recovery permission requires explicit boolean true: ${String(recoverable)}`, async () => {
  const receipt = { serverJobId: 'owned-job', operation: 'translation-only' }, source = neutralRecord();
  source.remoteJobRecovery = { recoverable: true, receipt: { serverJobId: 'stale' } };
  const failure = technicalError({ code: recoverable === false ? 'PROVIDER_AUTH' : 'ECONNRESET', remoteJob: receipt, remoteJobRecoverable: recoverable });
  const engine = createCatalogEngine({ extractionImpl: {}, providerImpl: {}, lanImpl: { resumeRemoteAnalysis: async () => { throw failure; } } });
  const result = await engine.resumeRemoteAnalysis(source, { operation: 'translation-only' }, receipt, {});
  assert.equal(result.subtitleDiagnostic.code, recoverable === false ? 'PROVIDER_AUTH' : 'NETWORK_UNREACHABLE');
  assert.deepEqual(result.remoteJobRecovery, { recoverable: recoverable === true, receipt });
  assert.equal(JSON.stringify(result.subtitleDiagnostic).includes('owned-job'), false);
});

test('catalog clears stale remote recovery metadata without a current accepted receipt', async () => {
  const source = neutralRecord(); source.remoteJobRecovery = { recoverable: true, receipt: { serverJobId: 'stale' } };
  const engine = createCatalogEngine({ extractionImpl: {}, providerImpl: {}, lanImpl: { resumeRemoteAnalysis: async () => { throw technicalError({ code: 'PROVIDER_AUTH' }); } } });
  const result = await engine.resumeRemoteAnalysis(source, {}, {}, {});
  assert.equal(result.remoteJobRecovery, undefined); assert.equal(result.analysisDiagnostic.code, 'PROVIDER_AUTH');
});

test('catalog actual-duration disk guard runs before provider/audio and preserves typed low-space failure', async () => {
  let providerCalls = 0, toolCalls = 0, reserved;
  const source = { ...neutralRecord(), duration: 7200, hasAudio: true };
  const engine = createCatalogEngine({ extractionImpl: { analyzeVideo: async () => source, getToolsStatus: async () => { toolCalls++; } },
    providerImpl: { analyzeExtracted: async () => { providerCalls++; } } });
  const result = await engine.analyzeVideo({}, { mode: 'codex', transcribeAudio: true }, { dataDir: 'owned-data', diskSpace: { async assert(value) { reserved = value; throw technicalError({ code: 'STORAGE_SPACE_LOW' }); } } });
  assert.equal(providerCalls, 0); assert.equal(toolCalls, 0); assert.equal(reserved.path, 'owned-data');
  assert.ok(reserved.requiredBytes > 7200 * 16000 * 2); assert.equal(result.analysisDiagnostic.code, 'STORAGE_SPACE_LOW');
  assert.deepEqual(result.storageWait, { location: 'local' });
});

test('catalog remote storage wait retains only safe byte counts and probes the configured server', async () => {
  const source = neutralRecord(); let statusOptions;
  const engine = createCatalogEngine({ extractionImpl: { analyzeVideo: async () => source }, providerImpl: {}, lanImpl: {
    async checkRemoteServer(options) { statusOptions = options; return { storage: { known: true, availableBytes: 123 } }; },
    async sendRemoteAnalysis() { throw technicalError({ code: 'STORAGE_SPACE_LOW', storageLocation: 'remote', availableBytes: 12, requiredBytes: 34, reserveBytes: 56, path: PRIVATE }); }
  } });
  const options = { mode: 'remote', remoteUrl: 'http://127.0.0.1:3300', connectionCode: PRIVATE };
  const result = await engine.analyzeVideo({}, options, {});
  assert.deepEqual(result.storageWait, { location: 'remote', availableBytes: 12, requiredBytes: 34, reserveBytes: 56 });
  assert.equal(result.analysisDiagnostic.code, 'STORAGE_SPACE_LOW'); assert.equal(JSON.stringify(result.storageWait).includes(PRIVATE), false);
  assert.equal((await engine.getRemoteStatus(options)).storage.availableBytes, 123);
  assert.equal(statusOptions.remoteUrl, options.remoteUrl); assert.equal(statusOptions.connectionCode, PRIVATE);
});

async function storageFixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-tech-health-'));
  let milliseconds = Date.parse('2026-10-27T00:00:00Z'), blockedOperation;
  const fsImpl = { ...fs, async rename(from, to) {
    const operation = to.includes(`${path.sep}events${path.sep}`) ? 'append' : to.includes(`${path.sep}outbox${path.sep}`) ? 'enqueue' : to.includes(`${path.sep}receipts${path.sep}`) ? 'ack' : null;
    if (operation && operation === blockedOperation) throw technicalError({ code: 'ENOSPC' });
    return fs.rename(from, to);
  } };
  const store = createDiagnosticsStore({ dataDir, fsImpl, now: () => milliseconds }); await store.ready;
  t.after(async () => { await store.flush(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, store, block(operation) { blockedOperation = operation; }, tick() { milliseconds += 1000; }, timestamp() { return new Date(milliseconds).toISOString(); } };
}

test('diagnostic append failures preserve time/code/history and only a durable append clears current failure', async t => {
  const f = await storageFixture(t), destination = 'http://127.0.0.1:3300';
  await f.store.append({ code: 'ANALYSIS_STARTED' }, { dedupeKey: 'old' });
  f.block('append');
  await assert.rejects(f.store.append({ code: 'ANALYSIS_PARTIAL' }));
  const firstAt = f.timestamp(); f.tick();
  await assert.rejects(f.store.append({ code: 'ANALYSIS_PARTIAL' }));
  let status = f.store.getStatus(), entry = status.storageHealth.currentFailures[0];
  assert.equal(status.available, false); assert.equal(entry.operation, 'append'); assert.equal(entry.systemCode, 'ENOSPC');
  assert.equal(entry.firstFailureAt, firstAt); assert.equal(entry.lastFailureAt, f.timestamp()); assert.equal(entry.failureCount, 2);
  await f.store.append({ code: 'ANALYSIS_STARTED' }, { dedupeKey: 'old' });
  const queued = await f.store.enqueueReport({ id: 'neutral', code: 'ANALYSIS_PARTIAL' }, destination);
  await f.store.ackReports([queued.reportId]); await f.store.ackReports([]);
  assert.equal(f.store.getStatus().storageHealth.currentFailures[0].operation, 'append', 'ack/enqueue/dedupe cannot repair lost append');
  f.block(null); f.tick(); await f.store.append({ code: 'ANALYSIS_COMPLETED' });
  status = f.store.getStatus(); assert.equal(status.available, true); assert.equal(status.error, '');
  assert.equal(status.storageHealth.currentFailures.length, 0);
  assert.equal(status.storageHealth.failureHistory[0].recoveredAt, f.timestamp());
  assert.equal(JSON.stringify(await f.store.query()).includes(PRIVATE), false);
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'diagnostics', 'storage-health.json'), 'utf8'));
  assert.deepEqual(saved, status.storageHealth);
  const output = await run(process.execPath, ['-e', "const s=require('./lib/diagnostics').createDiagnosticsStore({dataDir:process.argv[1]});s.ready.then(()=>console.log(JSON.stringify(s.getStatus())));", f.dataDir], { cwd: path.resolve(__dirname, '..'), windowsHide: true });
  const reopened = JSON.parse(output.stdout); assert.equal(reopened.available, true);
  assert.equal(reopened.storageHealth.failureHistory[0].recoveredAt, f.timestamp());
});

test('enqueue and acknowledgement failures stay distinct and preserve outbox until matching success', async t => {
  const f = await storageFixture(t), destination = 'http://127.0.0.1:3300';
  const old = await f.store.enqueueReport({ id: 'old-neutral', code: 'ANALYSIS_PARTIAL' }, destination);
  f.block('enqueue'); await assert.rejects(f.store.enqueueReport({ id: 'new-neutral', code: 'ANALYSIS_PARTIAL' }, destination));
  f.block('ack'); await assert.rejects(f.store.ackReports([old.reportId]));
  assert.deepEqual(f.store.getStatus().storageHealth.currentFailures.map(item => item.operation), ['enqueue', 'ack']);
  assert.equal((await f.store.pendingReports(destination)).length, 1);
  f.block(null); await f.store.ackReports([old.reportId]);
  assert.deepEqual(f.store.getStatus().storageHealth.currentFailures.map(item => item.operation), ['enqueue']);
  await f.store.enqueueReport({ id: 'old-neutral', code: 'ANALYSIS_PARTIAL' }, destination);
  assert.equal(f.store.getStatus().available, false, 'already acknowledged report does not prove enqueue writable');
  await f.store.enqueueReport({ id: 'new-neutral', code: 'ANALYSIS_PARTIAL' }, destination);
  assert.equal(f.store.getStatus().available, true); assert.equal((await f.store.pendingReports(destination)).length, 1);
});

test('unresolved append health survives restart and successful ack cannot clear its history', async t => {
  const f = await storageFixture(t); f.block('append');
  await assert.rejects(f.store.append({ code: 'ANALYSIS_PARTIAL' }));
  const output = await run(process.execPath, ['-e', "const s=require('./lib/diagnostics').createDiagnosticsStore({dataDir:process.argv[1]});(async()=>{const q=await s.enqueueReport({id:'neutral',code:'ANALYSIS_PARTIAL'},'http://127.0.0.1:3300');await s.ackReports([q.reportId]);console.log(JSON.stringify(s.getStatus()));})();", f.dataDir], { cwd: path.resolve(__dirname, '..'), windowsHide: true });
  const status = JSON.parse(output.stdout); assert.equal(status.available, false);
  assert.equal(status.storageHealth.currentFailures[0].operation, 'append'); assert.equal(status.storageHealth.currentFailures[0].systemCode, 'ENOSPC');
});

test('a full disk can defer its health journal and a later unrelated durable write preserves the unresolved append failure', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-deferred-health-'));
  let full = false;
  const fsImpl = { ...fs, async open(filename, ...options) {
    if (full) throw technicalError({ code: 'ENOSPC' });
    return fs.open(filename, ...options);
  } };
  const store = createDiagnosticsStore({ dataDir, fsImpl }); await store.ready;
  t.after(async () => { await store.flush(); await fs.rm(dataDir, { recursive: true, force: true }); });
  full = true; await assert.rejects(store.append({ code: 'ANALYSIS_PARTIAL' }));
  await assert.rejects(fs.stat(path.join(dataDir, 'diagnostics', 'storage-health.json')), { code: 'ENOENT' });
  full = false; await store.enqueueReport({ id: 'neutral-recovered-disk', code: 'ANALYSIS_PARTIAL' }, 'http://127.0.0.1:3300');
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'diagnostics', 'storage-health.json'), 'utf8'));
  assert.equal(saved.currentFailures[0].operation, 'append'); assert.equal(saved.currentFailures[0].systemCode, 'ENOSPC');
  assert.equal(store.getStatus().available, false, 'the failed event has not been stored even though the disk accepts other writes');
});

test('corrupt loaded history is preserved and not cleared by later append/ack success', async t => {
  const f = await storageFixture(t), filename = path.join(f.dataDir, 'diagnostics', 'events', 'f'.repeat(64) + '.json');
  await fs.writeFile(filename, PRIVATE);
  const output = await run(process.execPath, ['-e', "const s=require('./lib/diagnostics').createDiagnosticsStore({dataDir:process.argv[1]});(async()=>{await s.append({code:'ANALYSIS_STARTED'});console.log(JSON.stringify(await s.query()));})();", f.dataDir], { cwd: path.resolve(__dirname, '..'), windowsHide: true });
  const query = JSON.parse(output.stdout); assert.match(query.error, /일부 진단/);
  assert.equal(query.storageHealth.currentFailures[0].operation, 'load-events'); assert.equal(output.stdout.includes(PRIVATE), false);
  assert.equal(await fs.readFile(filename, 'utf8'), PRIVATE);
});

test('failure health bounds history, sanitizes restored fields and returns detached snapshots', () => {
  let at = Date.parse('2026-10-27T00:00:00Z'); const health = createDiagnosticFailureHealth({ now: () => at++ });
  for (let index = 0; index < 50; index++) { health.fail('append', technicalError({ code: 'ENOSPC' })); health.recover('append'); }
  health.fail('ack', technicalError({ code: 'EACCES' }));
  const snapshot = health.snapshot(); assert.equal(snapshot.failureHistory.length, 32);
  snapshot.currentFailures[0].operation = PRIVATE; assert.equal(health.snapshot().currentFailures[0].operation, 'ack');
  const restored = createDiagnosticFailureHealth(); restored.restore({ schemaVersion: 1, failureHistory: [{ operation: 'append', firstFailureAt: '2026-10-27T00:00:00Z', lastFailureAt: '2026-10-27T00:00:01Z', failureCount: 2, code: PRIVATE, systemCode: PRIVATE, message: PRIVATE, path: PRIVATE }, { operation: PRIVATE }] });
  assert.equal(restored.snapshot().failureHistory.length, 1); assert.equal(JSON.stringify(restored.snapshot()).includes(PRIVATE), false);
});

test('a startup directory read failure records the affected operation and does not masquerade as initialization failure', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-read-health-'));
  const store = createDiagnosticsStore({ dataDir, fsImpl: { ...fs, async readdir(folder) {
    if (path.basename(folder) === 'outbox') throw technicalError({ code: 'EACCES' });
    return fs.readdir(folder);
  } } });
  t.after(async () => { await store.flush(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await store.ready; await store.append({ code: 'ANALYSIS_STARTED' });
  const failure = store.getStatus().storageHealth.currentFailures[0];
  assert.equal(failure.operation, 'load-outbox'); assert.equal(failure.systemCode, 'EACCES');
  assert.equal(JSON.stringify(store.getStatus()).includes(PRIVATE), false);
});

test('reporter separates send, acknowledgement and enqueue errors without dropping durable reports', async () => {
  let at = Date.parse('2026-10-27T00:00:00Z'), failSend = true, failEnqueue = false;
  const pending = new Map(), connection = { remoteUrl: 'http://127.0.0.1:3300', connectionCode: PRIVATE };
  const store = {
    async enqueueReport(event) { if (failEnqueue) throw technicalError({ code: 'ENOSPC' }); pending.set(event.id, { reportId: event.id, event }); },
    async pendingReports() { return [...pending.values()]; }, async getIdentity() { return { clientId: 'neutral-pc' }; },
    async ackReports(ids) { ids.forEach(id => pending.delete(id)); }, async flush() {}
  };
  const reporter = createDiagnosticReporter({ store, getConnection: async () => connection, now: () => at++,
    async sendReports(options) { return failSend ? { ok: false, error: technicalError({ code: 'ETIMEDOUT' }) } : { ok: true, acceptedReportIds: options.reports.map(item => item.reportId) }; } });
  try {
    await reporter.enqueue({ id: 'neutral' }, connection.remoteUrl); await reporter.flush();
    assert.equal(reporter.getStatus().deliveryHealth.currentFailures[0].operation, 'send');
    assert.equal(reporter.getStatus().deliveryHealth.currentFailures[0].systemCode, 'ETIMEDOUT'); assert.equal(pending.size, 1);
    failEnqueue = true; await assert.rejects(reporter.enqueue({ id: 'missing' }, connection.remoteUrl));
    failSend = false; await reporter.flush(); assert.equal(pending.size, 0);
    assert.deepEqual(reporter.getStatus().deliveryHealth.currentFailures.map(item => item.operation), ['enqueue']);
    assert.equal(JSON.stringify(reporter.getStatus()).includes(PRIVATE), false);
    failEnqueue = false; await reporter.enqueue({ id: 'later' }, connection.remoteUrl); await reporter.flush();
    assert.equal(reporter.getStatus().lastError, ''); assert.ok(reporter.getStatus().deliveryHealth.failureHistory.every(item => item.recoveredAt));
  } finally { await reporter.stop(); }
});
