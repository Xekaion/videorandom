const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');
const express = require('express');
const ExcelJS = require('exceljs');
const { createHistoryService } = require('../lib/history-service');

const VIDEO = { path: 'C:\\Videos\\한글 영상.mp4', name: '한글 영상.mp4', size: 123.4, ext: 'MP4' };

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-history-'));
  const service = createHistoryService({ dataDir });
  await service.ready;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/history', service.router);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}/api/history`;
  const request = (url, body) => fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    // Only remove the newly allocated fixture directory.
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, service, request };
}

test('history retains every pick and play, survives restart and paginates beyond five entries', async t => {
  const { dataDir, service, request } = await fixture(t);
  for (let i = 0; i < 137; i++) await service.recordPick({ ...VIDEO, name: `영상 ${i}.mp4` });
  await service.recordPlayback(VIDEO);
  const first = await (await request('/')).json();
  assert.equal(first.allTotal, 138);
  assert.equal(first.total, 138);
  assert.equal(first.entries.length, 50);
  assert.equal(first.pages, 3);
  assert.equal(first.entries[0].type, 'play');
  assert.deepEqual(first.counts, { pick: 137, play: 1, legacy_pick: 0, windows_recent: 0 });
  const picks = await (await request('/?type=pick&page=3&pageSize=50')).json();
  assert.equal(picks.total, 137);
  assert.equal(picks.entries.length, 37);
  assert.equal(picks.entries.at(-1).name, '영상 0.mp4');
  const restored = createHistoryService({ dataDir });
  await restored.ready;
  assert.equal((await restored.list()).allTotal, 138);
  assert.equal((await restored.list({ query: '영상 13' })).total, 8);
  const log = (await fs.readFile(service.logPath, 'utf8')).trim().split('\n');
  assert.equal(log.length, 138);
});

test('browser legacy import is idempotent and retains unknown dates and newest order', async t => {
  const { service } = await fixture(t);
  const legacy = [{ ...VIDEO, time: '오후 11:30:10' }, { ...VIDEO, name: '이전 영상.mp4', path: 'C:\\Videos\\이전 영상.mp4', time: '오전 09:00:00' }];
  assert.deepEqual(await service.importLegacy({ sourceId: 'browser-profile-one', entries: legacy }), { imported: 2, skipped: 0 });
  assert.deepEqual(await service.importLegacy({ sourceId: 'browser-profile-one', entries: legacy }), { imported: 0, skipped: 2 });
  const history = await service.list();
  assert.equal(history.entries[0].name, VIDEO.name);
  assert.equal(history.entries[0].occurredAt, null);
  assert.equal(history.entries[0].legacyTime, '오후 11:30:10');
  assert.match(history.entries[0].importedAt, /^\d{4}-/);
  assert.equal(history.entries[0].source, '기존 브라우저 기록');
  assert.equal(history.entries[0].type, 'legacy_pick');
});

test('pending client event IDs dedupe response-loss retries while distinct repeated picks survive', async t => {
  const { service, request } = await fixture(t);
  const body = { video: VIDEO, clientEventId: 'pending-event-0000001', occurredAt: '2026-10-13T15:20:00.000Z' };
  const responses = await Promise.all(Array.from({ length: 12 }, () => request('/picks', body)));
  const results = await Promise.all(responses.map(response => response.json()));
  assert.equal(results.reduce((total, result) => total + result.imported, 0), 1);
  assert.equal(results.reduce((total, result) => total + result.skipped, 0), 11);
  assert.equal(results[0].entry.occurredAt, body.occurredAt);
  await service.recordPick(VIDEO, { clientEventId: 'pending-event-0000002' });
  assert.equal((await service.list()).allTotal, 2);
});

test('Windows recent imports preserve provenance and shortcut metadata without inventing playback time', async t => {
  const { service } = await fixture(t);
  const recent = [{ ...VIDEO, observedAt: '2026-10-13T13:10:00Z', command: 'never copied' }, { ...VIDEO, name: '이전 영상.mp4', path: 'C:\\Videos\\이전 영상.mp4', observedAt: '2026-10-12T13:10:00Z' }];
  assert.deepEqual(await service.importWindowsRecent(recent), { imported: 2, skipped: 0 });
  assert.deepEqual(await service.importWindowsRecent(recent), { imported: 0, skipped: 2 });
  const entry = (await service.list()).entries[0];
  assert.equal(entry.type, 'windows_recent');
  assert.equal(entry.occurredAt, null);
  assert.equal(entry.observedAt, '2026-10-13T13:10:00.000Z');
  assert.equal(entry.source, 'Windows 최근 영상');
  assert.equal('command' in entry, false);
});

test('late queued picks appear at their actual date rather than above newer events', async t => {
  const { service } = await fixture(t);
  await service.recordPick({ ...VIDEO, name: '새 기록.mp4' }, { occurredAt: '2026-10-14T15:20:00Z' });
  await service.recordPick({ ...VIDEO, name: '늦게 저장된 이전 기록.mp4' }, { occurredAt: '2026-10-12T15:20:00Z' });
  assert.deepEqual((await service.list()).entries.map(entry => entry.name), ['새 기록.mp4', '늦게 저장된 이전 기록.mp4']);
});

test('full CSV export retains Unicode, quotes and newlines and neutralizes formulas', async t => {
  const { service, request } = await fixture(t);
  await service.recordPick({ ...VIDEO, name: '=HYPERLINK("https://example.com","한글")\n둘째 줄' });
  await service.recordPick({ ...VIDEO, name: '+SUM(1,2)' });
  const response = await request('/export.csv');
  assert.match(response.headers.get('content-type'), /text\/csv/);
  const buffer = Buffer.from(await response.arrayBuffer());
  assert.equal(buffer.subarray(0, 3).toString('hex'), 'efbbbf');
  const workbook = new ExcelJS.Workbook();
  const worksheet = await workbook.csv.read(Readable.from([buffer]));
  assert.equal(worksheet.getRow(2).getCell(1).value, "'+SUM(1,2)");
  assert.equal(worksheet.getRow(3).getCell(1).value, '\'=HYPERLINK("https://example.com","한글")\n둘째 줄');
  assert.equal(worksheet.getRow(3).getCell(2).value, VIDEO.path);
});

test('JSON backup restores to another data folder with stable IDs and excludes unexpected fields', async t => {
  const { service, request } = await fixture(t);
  await service.recordPick(VIDEO);
  await service.importLegacy({ sourceId: 'old-browser', entries: [{ ...VIDEO, time: '10:00:00' }] });
  const backup = await (await request('/export.json')).json();
  assert.equal(backup.schemaVersion, 1);
  assert.equal(backup.entries.length, 2);
  backup.entries[0].apiKey = 'credential-not-persisted';
  const secondDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-history-restore-'));
  t.after(() => fs.rm(secondDirectory, { recursive: true, force: true }));
  const restored = createHistoryService({ dataDir: secondDirectory });
  assert.deepEqual(await restored.importJson(backup), { imported: 2, skipped: 0 });
  assert.deepEqual(await restored.importJson(backup), { imported: 0, skipped: 2 });
  assert.deepEqual((await restored.list()).entries.map(entry => entry.id), backup.entries.map(entry => entry.id));
  assert.equal((await fs.readFile(restored.logPath, 'utf8')).includes('credential-not-persisted'), false);
  const response = await request('/import-json', { schemaVersion: 1, entries: backup.entries });
  assert.deepEqual(await response.json(), { imported: 0, skipped: 2 });
});

test('malformed records and torn final lines are preserved while valid history stays readable', async t => {
  const { service, dataDir } = await fixture(t);
  const valid = (await service.recordPick(VIDEO)).entry;
  const original = JSON.stringify(valid) + '\nnot-json\n{"id":"truncated';
  await fs.writeFile(service.logPath, original, 'utf8');
  const restored = createHistoryService({ dataDir });
  await restored.ready;
  assert.equal(await fs.readFile(service.logPath, 'utf8'), original);
  const initial = await restored.list();
  assert.equal(initial.total, 1);
  assert.equal(initial.warnings.length, 1);
  assert.match(initial.warnings[0], /2개/);
  await restored.recordPlayback(VIDEO);
  const final = await fs.readFile(service.logPath, 'utf8');
  assert.equal(final.startsWith(original + '\n'), true);
  const restarted = createHistoryService({ dataDir });
  assert.equal((await restarted.list()).total, 2);
});

test('failed appends never create phantom history and later writes still succeed', async t => {
  const { service } = await fixture(t);
  await fs.mkdir(service.logPath);
  await assert.rejects(service.recordPick(VIDEO));
  assert.equal((await service.list()).allTotal, 0);
  await fs.rmdir(service.logPath);
  await service.recordPick(VIDEO);
  assert.equal((await service.list()).allTotal, 1);
});

test('validation rejects unsafe record shapes and pagination while imports skip isolated bad entries', async t => {
  const { service, request } = await fixture(t);
  assert.equal((await request('/picks', { video: { ...VIDEO, path: '../relative.mp4' } })).status, 400);
  assert.equal((await request('/picks', { video: { ...VIDEO, path: '\\rooted-without-drive.mp4' } })).status, 400);
  assert.equal((await request('/picks', { video: { ...VIDEO, size: -10 } })).status, 400);
  assert.equal((await request('/picks', { video: VIDEO, clientEventId: 'short' })).status, 400);
  assert.equal((await request('/picks', { video: VIDEO, occurredAt: 'not a timestamp' })).status, 400);
  assert.equal((await request('/?type=unknown')).status, 400);
  assert.equal((await request('/?pageSize=101')).status, 400);
  assert.equal((await request('/?page=-1')).status, 400);
  assert.equal((await request('/import-legacy', { entries: [] })).status, 400);
  assert.equal((await request('/import-json', { schemaVersion: 2, entries: [] })).status, 400);
  const imported = await service.importLegacy({ sourceId: 'browser', entries: [{ ...VIDEO, time: '13:00:00' }, { path: 'relative.mp4' }] });
  assert.equal(imported.imported, 1);
  assert.equal(imported.skipped, 1);
  assert.match(imported.warnings[0], /올바르지 않은 기록 1개/);
  const invalidBackup = await service.importJson({ schemaVersion: 1, entries: [{ ...VIDEO, id: 'invalid-backup-record', type: 'play', occurredAt: 'bad-date' }] });
  assert.equal(invalidBackup.imported, 0);
  assert.equal(invalidBackup.skipped, 1);
  assert.match(invalidBackup.warnings[0], /올바르지 않은 기록 1개/);
  assert.equal((await service.list()).allTotal, 1);
});
