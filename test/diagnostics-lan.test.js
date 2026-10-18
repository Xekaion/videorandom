const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createLanAnalysis, sendDiagnosticReports, sendRemoteAnalysis } = require('../lib/lan-analysis');
const { createDiagnosticsStore } = require('../lib/diagnostics');
const { httpFixtureResponse: fetch } = require('./http-json-fixture');
const code = 'owned-diagnostic-connection-code-123456';

async function fixture(t, { processPackage, seed } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-diagnostics-lan-'));
  if (seed) await seed(dataDir);
  const diagnosticsStore = createDiagnosticsStore({ dataDir });
  const host = createLanAnalysis({ dataDir, diagnosticsStore, connectionStore: { getHostCode: async () => code },
    processPackage: processPackage || (async pkg => pkg.record) });
  const state = await host.start({ host: '127.0.0.1', port: 0 });
  const remoteUrl = 'http://127.0.0.1:' + state.port;
  t.after(async () => { await host.stop(); await diagnosticsStore.flush(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { host, dataDir, diagnosticsStore, remoteUrl };
}

test('authenticated idempotent reports retain only technical fields and the actual peer IP', async t => {
  const f = await fixture(t);
  const report = { reportId: 'a'.repeat(64), event: { event: 'error', level: 'error', stage: 'saving', videoName: 'C:/private/owned.mp4',
    clientId: 'spoofed', clientAddress: '192.168.9.9', expectedCues: 80, returnedCues: 79, message: '대사 수가 원문과 일치하지 않습니다. private dialogue',
    transcript: ['private'], connectionCode: 'private', prompt: 'private' } };
  const body = { clientId: 'owned-client', clientName: 'Owned PC', clientVersion: '1.9.2', reports: [report] };
  const denied = await fetch(f.remoteUrl + '/v1/diagnostics/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(denied.status, 401); await denied.arrayBuffer();
  for (let index = 0; index < 2; index++) {
    const response = await fetch(f.remoteUrl + '/v1/diagnostics/report', { method: 'POST', headers: { Authorization: 'Bearer ' + code, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).acceptedReportIds, [report.reportId]);
  }
  const query = await f.diagnosticsStore.query(); assert.equal(query.events.length, 1);
  const event = query.events[0]; assert.equal(event.clientId, 'owned-client'); assert.equal(event.clientAddress, '127.0.0.1');
  assert.equal(event.videoName, 'owned.mp4'); assert.equal(event.code, 'SUBTITLE_CUE_COUNT_MISMATCH'); assert.equal(event.returnedCues, 79);
  assert.equal(JSON.stringify(query).includes('private'), false); assert.equal(event.reporterVersion, '1.9.2');
  const over = await fetch(f.remoteUrl + '/v1/diagnostics/report', { method: 'POST', headers: { Authorization: 'Bearer ' + code, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, reports: Array.from({ length: 51 }, () => report) }) });
  assert.equal(over.status, 400); await over.arrayBuffer();
  const oversized = await fetch(f.remoteUrl + '/v1/diagnostics/report', { method: 'POST', headers: { Authorization: 'Bearer ' + code, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, reports: [{ ...report, event: { transcript: 'x'.repeat(65536) } }] }) });
  assert.equal(oversized.status, 413); await oversized.arrayBuffer();
  assert.equal((await f.diagnosticsStore.query()).stats.total, 1);
});

test('report sender acknowledges durable outbox and preserves historical version uncertainty', async t => {
  const f = await fixture(t), clientDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-diagnostics-client-'));
  t.after(() => fs.rm(clientDir, { recursive: true, force: true }));
  const store = createDiagnosticsStore({ dataDir: clientDir }), identity = await store.getIdentity();
  const report = await store.enqueueReport({ event: 'history-imported', code: 'SIDECAR_SAVE_FAILED', level: 'error',
    videoName: 'owned.mp4', originalRecordedAt: '2026-01-01T00:00:00Z' }, f.remoteUrl);
  // Identity describes the reporter now, not the original unknown analysis.
  const result = await sendDiagnosticReports({ remoteUrl: f.remoteUrl, connectionCode: code, ...identity, reports: [report] });
  assert.equal(result.ok, true); await store.ackReports(result.acceptedReportIds);
  assert.deepEqual(await store.pendingReports(f.remoteUrl), []);
  const event = (await f.diagnosticsStore.query()).events[0];
  assert.equal(event.clientVersion, undefined); assert.equal(event.serverVersion, undefined);
  assert.equal(event.reporterVersion, identity.clientVersion); assert.equal(event.originalRecordedAt, '2026-01-01T00:00:00.000Z');
  const offline = await sendDiagnosticReports({ remoteUrl: f.remoteUrl, connectionCode: 'wrong', ...identity, reports: [report] });
  assert.equal(offline.ok, false);
});

test('partial provider results are errors even when the remote job completed and include exact batch counters', async t => {
  const f = await fixture(t, { processPackage: async (pkg, context) => {
    context.onProgress('한국어 자막 검수 80/100구간', 94);
    context.onDiagnostic({ event: 'error', stage: 'translation_review', level: 'error', code: 'SUBTITLE_CUE_COUNT_MISMATCH', expectedCues: 20, returnedCues: 19, startCue: 80, endCue: 99 });
    return { ...pkg.record, status: 'partial', subtitleRepairStatus: 'failed', subtitleError: '대사 수가 원문과 일치하지 않습니다.',
      subtitleDiagnostic: { stage: 'translation_review', code: 'SUBTITLE_CUE_COUNT_MISMATCH', expectedCues: 20, returnedCues: 19, startCue: 80, endCue: 99 } };
  } });
  const clientDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-diagnostics-upload-'));
  t.after(() => fs.rm(clientDir, { recursive: true, force: true }));
  const cues = [{ id: 1, start: 1, end: 3, text: 'owned synthetic source' }];
  const record = { id: 'b'.repeat(32), name: 'owned.mp4', ext: 'MP4', duration: 10, hasAudio: false, status: 'completed', transcript: cues,
    transcriptSource: 'sidecar:owned.srt', transcriptLanguage: 'ja', frames: [], warnings: [], summary: 'owned synthetic summary' };
  const accepted = [];
  const result = await sendRemoteAnalysis(record, { remoteUrl: f.remoteUrl, connectionCode: code, dataDir: clientDir, operation: 'translation-only',
    subtitleLanguage: 'ko', subtitleQuality: 'fast', diagnosticClient: { clientId: 'owned-client', clientName: 'Owned PC', clientVersion: '1.9.2', clientJobId: 'owned-local-job' },
    onDiagnostic: event => accepted.push(event) });
  assert.equal(accepted[0].event, 'accepted'); assert.ok(accepted[0].serverJobId);
  assert.equal(result.subtitleDiagnostic.expectedCues, 20);
  const events = (await f.diagnosticsStore.query()).events;
  const terminal = events.find(event => event.event === 'completed');
  assert.equal(terminal.level, 'error'); assert.equal(terminal.code, 'SUBTITLE_CUE_COUNT_MISMATCH');
  assert.equal(terminal.expectedCues, 20); assert.equal(terminal.clientJobId, 'owned-local-job'); assert.equal(terminal.recordId, record.id);
  assert.equal(terminal.operation, 'translation-only');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dataDir, 'remote', 'jobs', terminal.jobId, 'terminal.json'), 'utf8')).operation, 'translation-only');
  assert.equal((await f.diagnosticsStore.query({ jobId: 'owned-local-job' })).events.length, events.length);
  assert.ok(events.find(event => event.event === 'stage_changed' && event.stage === 'translation_review'));
  await f.host.stop();
  const beforeRestart = (await f.diagnosticsStore.query()).stats.total;
  await f.host.start({ host: '127.0.0.1', port: 0 });
  assert.equal((await f.diagnosticsStore.query()).stats.total, beforeRestart, 'A terminal already logged live must not be imported twice');
});

test('old terminal failures import once without fabricating old client identity or server version', async t => {
  const id = 'c'.repeat(32);
  const f = await fixture(t, { seed: async dataDir => {
    const dir = path.join(dataDir, 'remote', 'jobs', id); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'terminal.json'), JSON.stringify({ schemaVersion: 1, id, status: 'completed', stage: '분석 완료', percent: 100,
      createdAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:10Z', originalFrames: [], result: { id, name: 'owned-old.mp4', ext: 'MP4', duration: 10,
        status: 'partial', transcript: [], frames: [], warnings: [], subtitleError: '한국어 자막 번역의 대사 수가 원문과 일치하지 않습니다.' } }));
  } });
  const imported = (await f.diagnosticsStore.query()).events.find(event => event.event === 'imported_terminal');
  assert.equal(imported.level, 'error'); assert.equal(imported.code, 'SUBTITLE_CUE_COUNT_MISMATCH');
  assert.equal(imported.clientId, undefined); assert.equal(imported.serverVersion, undefined);
  assert.equal(imported.originalRecordedAt, '2026-01-01T00:00:10.000Z');
  assert.equal(imported.stage, 'translation');
  assert.equal('operation' in imported, false, 'Unrecorded legacy operation must stay unknown');
  await f.host.stop(); await f.host.start({ host: '127.0.0.1', port: 0 });
  assert.equal((await f.diagnosticsStore.query()).events.filter(event => event.event === 'imported_terminal').length, 1);
});

test('accepted diagnostic reports hold update drain busy until durable and later reports wait for reconnect', async t => {
  const f = await fixture(t);
  const append = f.diagnosticsStore.append.bind(f.diagnosticsStore);
  let entered = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  f.diagnosticsStore.append = async (...args) => { entered = true; await gate; return append(...args); };
  const body = { clientId: 'owned-client', clientName: 'Owned PC', clientVersion: '1.9.2',
    reports: [{ reportId: 'a'.repeat(64), event: { event: 'error', code: 'SIDECAR_SAVE_FAILED' } }] };
  const send = () => fetch(f.remoteUrl + '/v1/diagnostics/report', { method: 'POST',
    headers: { Authorization: 'Bearer ' + code, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const posted = send();
  try {
    for (let n = 0; !entered && n < 200; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(entered, true);
    const state = f.host.prepareUpdate();
    assert.equal(state.persisting, 1); assert.equal(state.busy, true);
    await assert.rejects(f.host.finishUpdate(), { status: 409 });
    release();
    assert.equal((await posted).status, 200);
    assert.equal((await send()).status, 503);
    assert.equal((await f.diagnosticsStore.query()).stats.total, 1);
  } finally { release(); await posted.catch(() => {}); f.diagnosticsStore.append = append; }
});

test('cancelled legacy jobs retain cancellation rather than an invented unknown error', async t => {
  const id = 'd'.repeat(32);
  const f = await fixture(t, { seed: async dataDir => {
    const dir = path.join(dataDir, 'remote', 'jobs', id); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'terminal.json'), JSON.stringify({ schemaVersion: 1, id, status: 'cancelled', stage: '분석 중지됨', percent: 0,
      createdAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:10Z', originalFrames: [], error: '분석을 중지했습니다.', result: null }));
  } });
  const event = (await f.diagnosticsStore.query()).events[0];
  assert.equal(event.status, 'cancelled'); assert.equal(event.code, 'ANALYSIS_CANCELLED'); assert.equal(event.level, 'warning');
  assert.equal('operation' in event, false);
});
