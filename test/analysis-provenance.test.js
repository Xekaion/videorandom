const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeAnalysisProvenance, stampAnalysisProvenance, attachRemoteServerVersion, reportedRemoteServerVersion } = require('../lib/analysis-provenance');
const { catalogRecord } = require('../lib/catalog-record');

const now = '2026-10-16T01:02:03.000Z';
const originalAt = '2026-10-15T23:00:00.000Z';

test('full analysis records supplied runtime versions and actual recognition settings', () => {
  const record = { transcriptionQuality: { recognitionRevision: 3, model: 'large-v3', profile: 'accurate', device: 'cuda', workers: 2,
    transcript: 'private speech', modelDirectory: 'C:/private/models', warnings: ['private warning'] },
    analysisProvenance: { schemaVersion: 1, analysis: { clientVersion: '0.1.0' }, translation: { clientVersion: '0.2.0' } } };
  assert.equal(stampAnalysisProvenance(record, { clientVersion: '1.8.0', serverVersion: '1.7.1', operation: 'analysis', now }), record);
  assert.deepEqual(record.analysisProvenance, { schemaVersion: 1, analysis: {
    clientVersion: '1.8.0', serverVersion: '1.7.1', recordedAt: now,
    recognition: { recognitionRevision: 3, model: 'large-v3', profile: 'accurate', device: 'cuda', workers: 2 } } });
  assert.equal(record.transcriptionQuality.transcript, 'private speech', 'provenance collection leaves recognition data untouched');
});

test('translation-only repair preserves original analysis version and adds a separate translation version', () => {
  const original = { clientVersion: '1.6.6', serverVersion: '1.6.5', recordedAt: originalAt,
    recognition: { recognitionRevision: 2, model: 'small', profile: 'fast', device: 'cpu', workers: 1 } };
  const record = { analysisProvenance: { schemaVersion: 1, analysis: structuredClone(original),
    translation: { clientVersion: '1.7.1', recordedAt: originalAt } }, transcriptionQuality: { model: 'large-v3' } };
  stampAnalysisProvenance(record, { clientVersion: '1.8.0', serverVersion: '1.8.1', operation: 'translation-only', now });
  assert.deepEqual(record.analysisProvenance.analysis, original);
  assert.deepEqual(record.analysisProvenance.translation, { clientVersion: '1.8.0', serverVersion: '1.8.1', recordedAt: now });
});

test('legacy translation repair never fabricates an original analysis version from timestamps or recognition revision', () => {
  const record = { analyzedAt: originalAt, savedAt: originalAt,
    transcriptionQuality: { recognitionRevision: 3, model: 'large-v3', profile: 'accurate' } };
  stampAnalysisProvenance(record, { clientVersion: '1.8.0', operation: 'translation-only', now });
  assert.deepEqual(record.analysisProvenance, { schemaVersion: 1, translation: { clientVersion: '1.8.0', recordedAt: now } });
  assert.equal(Object.hasOwn(record.analysisProvenance, 'analysis'), false);
});

test('new version stamps use trusted caller options rather than preexisting record claims', () => {
  const record = { clientVersion: '99.0.0', serverVersion: '98.0.0',
    analysisProvenance: { schemaVersion: 1, analysis: { clientVersion: '97.0.0', serverVersion: '96.0.0' } } };
  stampAnalysisProvenance(record, { serverVersion: '1.8.0', operation: 'analysis', now });
  assert.deepEqual(record.analysisProvenance, { schemaVersion: 1, analysis: { serverVersion: '1.8.0', recordedAt: now } });
});

test('sanitizer bounds version fields and removes paths, secrets, unknown schemas and invalid timestamps', () => {
  const clean = sanitizeAnalysisProvenance({ schemaVersion: 1, connectionCode: 'SECRET', analysis: {
    clientVersion: '1.8.0', serverVersion: 'https://private.example/1.8.0', recordedAt: '2026-02-30T01:02:03Z',
    connectionCode: 'SECRET', recognition: { model: 'C:/Users/private/models/large-v3', profile: 'unsafe', device: 'cuda:0',
      recognitionRevision: -1, workers: 16, transcript: 'private speech' } },
    translation: { clientVersion: '1.8.0-rc.1+build.20', recordedAt: now, recognition: { model: 'small' } } });
  assert.deepEqual(clean, { schemaVersion: 1, analysis: { clientVersion: '1.8.0' },
    translation: { clientVersion: '1.8.0-rc.1+build.20', recordedAt: now } });
  for (const invalid of [null, [], {}, { schemaVersion: 2, analysis: { clientVersion: '1.8.0' } },
    { schemaVersion: 1, analysis: { recordedAt: now, recognition: { recognitionRevision: 3 } } }]) {
    assert.equal(sanitizeAnalysisProvenance(invalid), undefined);
  }
});

test('invalid client and server versions cannot create provenance; valid server-only evidence remains usable', () => {
  for (const invalid of ['1', '1.8', 'v1.8.0', '01.8.0', '1.8.0-01', '1.8.0/secret', '1.8.0\n', '', 10800, '1'.repeat(81)]) {
    assert.throws(() => stampAnalysisProvenance({}, { clientVersion: invalid, serverVersion: invalid, operation: 'analysis', now }), /프로그램 버전/);
    assert.equal(sanitizeAnalysisProvenance({ schemaVersion: 1, analysis: { clientVersion: invalid, serverVersion: invalid } }), undefined);
  }
  const record = {};
  stampAnalysisProvenance(record, { clientVersion: 'invalid', serverVersion: '1.8.0', operation: 'analysis', now });
  assert.deepEqual(record.analysisProvenance.analysis, { serverVersion: '1.8.0', recordedAt: now });
  assert.throws(() => stampAnalysisProvenance({}, { clientVersion: '1.8.0', operation: 'wrong', now }), /작업/);
  assert.throws(() => stampAnalysisProvenance({}, { clientVersion: '1.8.0', operation: 'analysis', now: 'not-a-time' }), /시각/);
});

test('catalog summaries round trip safe version metadata without mutating full records or exposing model paths', () => {
  const record = { id: 'a'.repeat(32), name: 'synthetic.mp4', status: 'partial', transcript: [], frames: [],
    analysisProvenance: { schemaVersion: 1, analysis: { clientVersion: '1.8.0', serverVersion: '1.7.1', recordedAt: originalAt,
      recognition: { model: 'C:/private/model', profile: 'fast', device: 'cuda', workers: 1, recognitionRevision: 3 } },
      translation: { clientVersion: '1.8.0', recordedAt: now }, secret: 'SECRET' } };
  const before = JSON.stringify(record);
  const compact = JSON.parse(JSON.stringify(catalogRecord(record)));
  assert.deepEqual(compact.analysisProvenance, { schemaVersion: 1, analysis: { clientVersion: '1.8.0', serverVersion: '1.7.1', recordedAt: originalAt,
    recognition: { recognitionRevision: 3, profile: 'fast', device: 'cuda', workers: 1 } }, translation: { clientVersion: '1.8.0', recordedAt: now } });
  assert.equal(JSON.stringify(record), before);
  assert.equal(JSON.stringify(compact).includes('private'), false);
  assert.equal(JSON.stringify(compact).includes('SECRET'), false);
  assert.equal(Object.hasOwn(catalogRecord({ transcript: [], frames: [] }), 'analysisProvenance'), false);
});

test('fresh remote version tags are ephemeral and cannot be supplied by payload fields or copied from a saved result', () => {
  const record = { id: 'a'.repeat(32), analysisProvenance: { schemaVersion: 1,
    analysis: { clientVersion: '1.7.1', serverVersion: '1.6.6', recordedAt: originalAt },
    translation: { clientVersion: '1.7.1', serverVersion: '1.7.0', recordedAt: originalAt } },
    serverVersion: '99.0.0', remoteServerVersion: '98.0.0', reportedRemoteServerVersion: '97.0.0',
    'Symbol(VideoRandom current remote server version)': '96.0.0' };
  const original = JSON.stringify(record);
  assert.equal(reportedRemoteServerVersion(record), undefined, 'saved or payload version fields are not current-operation evidence');
  assert.equal(attachRemoteServerVersion(record, '1.8.0'), record);
  assert.equal(reportedRemoteServerVersion(record), '1.8.0');
  assert.equal(JSON.stringify(record), original, 'tag does not rewrite or expose persisted provenance');
  for (const copied of [JSON.parse(JSON.stringify(record)), { ...record }, Object.assign({}, record)]) {
    assert.equal(reportedRemoteServerVersion(copied), undefined);
    assert.deepEqual(copied.analysisProvenance, record.analysisProvenance);
  }
  assert.equal(reportedRemoteServerVersion(Object.create(record)), undefined, 'inherited tags cannot attest a separate result');
  assert.equal(reportedRemoteServerVersion({ [Symbol('VideoRandom current remote server version')]: '95.0.0' }), undefined);
  const descriptor = Object.getOwnPropertyDescriptor(record, Object.getOwnPropertySymbols(record)[0]);
  assert.equal(descriptor.enumerable, false);
  assert.equal(descriptor.writable, false);
});

test('remote version tags validate fresh reports and clear stale tags for an invalid or absent report', () => {
  const record = {};
  attachRemoteServerVersion(record, '1.8.0-rc.1+owned.2');
  assert.equal(reportedRemoteServerVersion(record), '1.8.0-rc.1+owned.2');
  attachRemoteServerVersion(record, '1.8.1');
  assert.equal(reportedRemoteServerVersion(record), '1.8.1');
  for (const invalid of [undefined, null, '', '01.8.0', '1.8.0-01', 'http://private/1.8.0', '1.8.0\n', 10800]) {
    attachRemoteServerVersion(record, '1.8.0');
    assert.equal(attachRemoteServerVersion(record, invalid), record);
    assert.equal(reportedRemoteServerVersion(record), undefined);
  }
  for (const invalid of [undefined, null, [], 1, '1.8.0']) assert.equal(reportedRemoteServerVersion(invalid), undefined);
  assert.throws(() => attachRemoteServerVersion(null, '1.8.0'), /분석 기록/);
});
