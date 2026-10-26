const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createRemoteReceiptStore } = require('../lib/remote-receipts');

const id = 'a'.repeat(32), serverId = 'b'.repeat(32);
const receipt = (extra = {}) => ({ schemaVersion: 1, recordId: id, serverJobId: serverId, serverOrigin: 'http://127.0.0.1:3101',
  sourceIdentity: 'c'.repeat(64), operation: 'analysis', acceptedAt: '2026-10-27T01:02:03.000Z', serverVersion: '1.9.27',
  capabilities: ['diagnostics-v1', 'managed-update-v1'], ...extra });
const source = (extra = {}) => ({ id, path: 'D:\\synthetic\\office.mp4', name: 'office.mp4', ext: 'MP4', size: 12, duration: 12.5,
  hasAudio: true, transcript: [{ id: 0, start: 0, end: 2, text: '다음 열차는 오전 아홉 시에 출발합니다.' }],
  frames: [{ filename: 'frame-1.jpg', timestamp: 5 }], ...extra });
const name = value => crypto.createHash('sha256').update(value).digest('hex') + '.json';
const context = () => ({ sourceFileSize: 123456, sourceFileMtimeMs: 123.75, subtitleQuality: 'accurate', transcriptLanguage: 'ja',
  subtitleLanguage: 'ko', clientJobId: 'd'.repeat(32), repairOf: 'e'.repeat(16), state: 'accepted' });

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-receipt-v1927-'));
  t.after(async () => {
    assert(path.basename(root).startsWith('videorandom-receipt-v1927-'));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const io = { ...fs, ...overrides };
  const store = createRemoteReceiptStore({ dataDir: root, fs: io });
  await store.ready;
  return { root, directory: path.join(root, 'remote-receipts'), store, io };
}

test('accepted receipt survives a new store instance with the full source projection', async t => {
  const { root, directory, store } = await fixture(t);
  const originalSource = source({ transcriptionQuality: { complete: true, processingComplete: true },
    subtitleTranslationPartial: [{ start: 0, end: 2, text: '열차는 아홉 시에 출발합니다.' }] });
  const saved = await store.save(receipt(), originalSource, context());
  assert.deepEqual(saved, { receipt: receipt(), sourceRecord: originalSource, context: context() });
  assert.deepEqual(await fs.readdir(directory), [name(id)]);
  const reopened = createRemoteReceiptStore({ dataDir: root });
  await reopened.ready;
  assert.deepEqual(await reopened.get(id), saved);
  assert.deepEqual(await reopened.list(), [saved]);
});

test('journal clones input immediately and does not return mutable internal references', async t => {
  const { store } = await fixture(t);
  const original = source(), accepted = receipt(), options = context();
  const pending = store.save(accepted, original, options);
  original.transcript[0].text = '변경된 합성 대사';
  accepted.capabilities.push('sparse-subtitles-v1');
  options.state = 'blocked';
  const saved = await pending;
  assert.equal(saved.sourceRecord.transcript[0].text, source().transcript[0].text);
  assert.deepEqual(saved.receipt.capabilities, receipt().capabilities);
  assert.equal(saved.context.state, 'accepted');
  saved.sourceRecord.transcript[0].text = '반환 객체 변경';
  assert.equal((await store.get(id)).sourceRecord.transcript[0].text, source().transcript[0].text);
});

test('only explicit safe context fields and credential-free receipt fields are persisted', async t => {
  const { store, directory } = await fixture(t);
  const secret = 'SYNTHETIC_PRIVATE_CREDENTIAL';
  const saved = await store.save(receipt({ connectionCode: secret, apiKey: secret, token: secret, capabilities: ['diagnostics-v1', 'unknown-secret-capability', 'diagnostics-v1'] }),
    source({ connectionCode: secret, remoteConnectionCode: secret, apiKey: secret, token: secret, Authorization: secret,
      credentials: { customSecret: secret }, nested: { accessToken: secret, refreshToken: secret, password: secret, Secret: secret, keep: 'ordinary' } }),
    { ...context(), connectionCode: secret, token: secret, code: secret, credentials: secret, remoteUrl: secret, message: secret, forceTranslation: true });
  assert.deepEqual(saved.context, context());
  assert.deepEqual(saved.receipt.capabilities, ['diagnostics-v1']);
  assert.deepEqual(saved.sourceRecord.nested, { keep: 'ordinary' });
  const text = await fs.readFile(path.join(directory, name(id)), 'utf8');
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes('forceTranslation'), false);
  assert.equal(text.includes('unknown-secret-capability'), false);
});

test('safe context state can be atomically updated without re-upload or provider authority', async t => {
  const { store } = await fixture(t);
  const first = await store.save(receipt(), source(), context());
  await store.save(first.receipt, first.sourceRecord, { ...first.context, state: 'blocked', blockedCode: 'REMOTE_TERMINAL_FAILED' });
  const entries = await store.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].context.state, 'blocked');
  assert.equal(entries[0].context.blockedCode, 'REMOTE_TERMINAL_FAILED');
  assert.deepEqual(entries[0].sourceRecord, source());
});

test('invalid optional context values are excluded rather than treated as trusted settings', async t => {
  const { store } = await fixture(t);
  const saved = await store.save(receipt(), source(), { sourceFileSize: -1, sourceFileMtimeMs: NaN,
    subtitleQuality: 'arbitrary', transcriptLanguage: 'execute', subtitleLanguage: 'ja', clientJobId: '../escape', repairOf: 'zzz',
    state: 'completed', blockedCode: 'contains text / secret' });
  assert.deepEqual(saved.context, {});
});

test('translation-only receipts and zero size/mtime metadata remain intact', async t => {
  const { store } = await fixture(t);
  const result = await store.save(receipt({ operation: 'translation-only', serverVersion: null }), source(),
    { sourceFileSize: 0, sourceFileMtimeMs: 0, subtitleQuality: 'turbo', transcriptLanguage: 'auto', subtitleLanguage: 'original', state: 'waiting' });
  assert.equal(result.receipt.operation, 'translation-only');
  assert.equal(result.context.sourceFileSize, 0);
  assert.equal(result.context.sourceFileMtimeMs, 0);
  assert.equal(result.context.state, 'waiting');
});

for (const [label, extra] of [
  ['schema', { schemaVersion: 2 }], ['record id', { recordId: '../outside' }], ['server id', { serverJobId: 'x' }],
  ['source fingerprint', { sourceIdentity: 'invalid' }], ['operation', { operation: 'retry' }],
  ['acceptance date', { acceptedAt: 'not a date' }], ['credentialed origin', { serverOrigin: 'http://user:password@127.0.0.1:3101' }],
  ['origin path', { serverOrigin: 'http://127.0.0.1:3101/private' }], ['origin query', { serverOrigin: 'http://127.0.0.1:3101?token=secret' }],
  ['origin fragment', { serverOrigin: 'http://127.0.0.1:3101#secret' }], ['non-HTTP origin', { serverOrigin: 'file:///C:/private' }]
]) test(`invalid receipt ${label} cannot be saved`, async t => {
  const { store, directory } = await fixture(t);
  await assert.rejects(store.save(receipt(extra), source()), error => error.code === 'LAN_RECEIPT_SAVE_FAILED');
  assert.deepEqual(await fs.readdir(directory), []);
});

for (const [label, value] of [['missing', null], ['array', []], ['mismatched id', source({ id: 'f'.repeat(32) })], ['missing id', {}]]) {
  test(`invalid source ${label} cannot be saved`, async t => {
    const { store, directory } = await fixture(t);
    await assert.rejects(store.save(receipt(), value), error => error.code === 'LAN_RECEIPT_SAVE_FAILED');
    assert.deepEqual(await fs.readdir(directory), []);
  });
}

test('non-JSON source failures are typed and do not expose raw content', async t => {
  const { store } = await fixture(t);
  const cyclic = source();
  cyclic.loop = cyclic;
  for (const value of [cyclic, source({ invalidBigInt: 1n })]) await assert.rejects(store.save(receipt(), value), error => {
    assert.equal(error.code, 'LAN_RECEIPT_SAVE_FAILED');
    assert.equal(error.message.includes('loop'), false);
    return true;
  });
});

test('file names are hashes and invalid IDs never select arbitrary paths', async t => {
  const { store, directory } = await fixture(t);
  await store.save(receipt(), source());
  assert.match((await fs.readdir(directory))[0], /^[a-f0-9]{64}\.json$/);
  for (const invalid of ['../outside', 'C:\\private\\file', '', 'a'.repeat(64), null]) {
    await assert.rejects(store.get(invalid), error => error.code === 'LAN_RECEIPT_READ_FAILED');
    await assert.rejects(store.remove(invalid), error => error.code === 'LAN_RECEIPT_SAVE_FAILED');
  }
  assert.equal((await store.list()).length, 1);
});

test('remove deletes only the exact consumed receipt and missing receipts are harmless', async t => {
  const { store, directory } = await fixture(t);
  const secondId = 'f'.repeat(32);
  await store.save(receipt(), source());
  await store.save(receipt({ recordId: secondId }), source({ id: secondId }));
  await fs.writeFile(path.join(directory, 'unrelated.keep'), 'ordinary');
  assert.equal(await store.remove(id), true);
  assert.equal(await store.get(id), null);
  assert.equal(await store.remove(id), false);
  assert.deepEqual((await store.list()).map(entry => entry.receipt.recordId), [secondId]);
  assert.equal(await fs.readFile(path.join(directory, 'unrelated.keep'), 'utf8'), 'ordinary');
});

test('orphan temp files and unrelated files are retained but excluded from pending receipts', async t => {
  const { store, directory } = await fixture(t);
  const orphan = name(id) + '.synthetic.tmp';
  await fs.writeFile(path.join(directory, orphan), '{unfinished');
  await fs.writeFile(path.join(directory, 'readme.txt'), 'ordinary');
  assert.deepEqual(await store.list(), []);
  assert.deepEqual((await fs.readdir(directory)).sort(), [orphan, 'readme.txt'].sort());
});

for (const [label, transform] of [
  ['invalid JSON', () => '{unfinished'],
  ['wrong envelope schema', saved => JSON.stringify({ ...saved, schemaVersion: 2 })],
  ['mismatched source id', saved => JSON.stringify({ ...saved, sourceRecord: source({ id: 'f'.repeat(32) }) })],
  ['mismatched file identity', saved => JSON.stringify({ ...saved, receipt: receipt({ recordId: 'f'.repeat(32) }), sourceRecord: source({ id: 'f'.repeat(32) }) })]
]) test(`corrupted receipt ${label} is reported and never deleted`, async t => {
  const { store, directory } = await fixture(t);
  await store.save(receipt(), source());
  const target = path.join(directory, name(id));
  const original = JSON.parse(await fs.readFile(target, 'utf8'));
  const broken = transform(original);
  await fs.writeFile(target, broken);
  await assert.rejects(store.get(id), error => error.code === 'LAN_RECEIPT_READ_FAILED');
  await assert.rejects(store.list(), error => error.code === 'LAN_RECEIPT_READ_FAILED');
  assert.equal(await fs.readFile(target, 'utf8'), broken);
});

test('a directory impersonating a receipt file is retained and reported', async t => {
  const { store, directory } = await fixture(t);
  const target = path.join(directory, name(id));
  await fs.mkdir(target);
  await assert.rejects(store.list(), error => error.code === 'LAN_RECEIPT_READ_FAILED');
  assert.equal((await fs.stat(target)).isDirectory(), true);
});

test('a symbolic receipt is not followed or deleted', async t => {
  let read = false, deleted = false;
  const { store } = await fixture(t, {
    readdir: async () => [name(id)],
    lstat: async () => ({ isFile: () => true, isSymbolicLink: () => true, size: 200 }),
    readFile: async () => { read = true; throw new Error('Must not follow a link'); },
    unlink: async () => { deleted = true; }
  });
  await assert.rejects(store.list(), error => error.code === 'LAN_RECEIPT_READ_FAILED');
  assert.equal(read, false);
  assert.equal(deleted, false);
});

test('an oversized receipt is rejected before its contents are loaded', async t => {
  let read = false;
  const { store } = await fixture(t, {
    readdir: async () => [name(id)],
    lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 64 * 1024 * 1024 + 1 }),
    readFile: async () => { read = true; throw new Error('Must not load oversized data'); }
  });
  await assert.rejects(store.list(), error => error.code === 'LAN_RECEIPT_READ_FAILED');
  assert.equal(read, false);
});

test('atomic write uses exclusive private temp, sync, close, then rename', async t => {
  const events = [];
  const { store } = await fixture(t, { open: async (target, flags, mode) => {
    assert.match(path.basename(target), /^[a-f0-9]{64}\.json\.[a-f0-9]{24}\.tmp$/);
    assert.equal(flags, 'wx');
    assert.equal(mode, 0o600);
    const handle = await fs.open(target, flags, mode);
    return { writeFile: async (...args) => { events.push('write'); return handle.writeFile(...args); },
      sync: async () => { events.push('sync'); return handle.sync(); },
      close: async () => { events.push('close'); return handle.close(); } };
  }, rename: async (...args) => { events.push('rename'); return fs.rename(...args); } });
  await store.save(receipt(), source());
  assert.deepEqual(events, ['write', 'sync', 'close', 'rename']);
});

for (const step of ['open', 'write', 'sync', 'rename']) test(`${step} ENOSPC preserves the prior accepted receipt and exposes only the safe system code`, async t => {
  let fail = false;
  const synthetic = () => Object.assign(new Error('ENOSPC C:\\PRIVATE\\payload'), { code: 'ENOSPC' });
  const { store, directory } = await fixture(t, {
    open: async (...args) => {
      if (fail && step === 'open') throw synthetic();
      const handle = await fs.open(...args);
      return { writeFile: async (...args) => { if (fail && step === 'write') throw synthetic(); return handle.writeFile(...args); },
        sync: async () => { if (fail && step === 'sync') throw synthetic(); return handle.sync(); }, close: () => handle.close() };
    }, rename: async (...args) => { if (fail && step === 'rename') throw synthetic(); return fs.rename(...args); }
  });
  await store.save(receipt(), source(), context());
  const before = await fs.readFile(path.join(directory, name(id)), 'utf8');
  fail = true;
  await assert.rejects(store.save(receipt(), source(), { ...context(), state: 'blocked' }), error => {
    assert.equal(error.code, 'LAN_RECEIPT_SAVE_FAILED');
    assert.equal(error.systemCode, 'ENOSPC');
    assert.equal(error.message.includes('PRIVATE'), false);
    return true;
  });
  assert.equal(await fs.readFile(path.join(directory, name(id)), 'utf8'), before);
  assert.deepEqual(await fs.readdir(directory), [name(id)]);
});

test('an exclusive-open failure does not unlink a temp file the operation did not create', async t => {
  let unlinks = 0;
  const { store } = await fixture(t, { open: async () => { throw Object.assign(new Error('collision'), { code: 'EEXIST' }); },
    unlink: async () => { unlinks++; } });
  await assert.rejects(store.save(receipt(), source()), error => error.systemCode === 'EEXIST');
  assert.equal(unlinks, 0);
});

test('failed removal retains a pending receipt with a typed system error', async t => {
  let fail = false;
  const { store } = await fixture(t, { unlink: async target => {
    if (fail && target.endsWith('.json')) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    return fs.unlink(target);
  } });
  await store.save(receipt(), source());
  fail = true;
  await assert.rejects(store.remove(id), error => error.code === 'LAN_RECEIPT_SAVE_FAILED' && error.systemCode === 'EACCES');
  assert.equal((await store.list()).length, 1);
});

test('read I/O errors retain receipts and expose a typed safe system code', async t => {
  let fail = false;
  const { store, directory } = await fixture(t, { readFile: async (...args) => {
    if (fail) throw Object.assign(new Error('PRIVATE'), { code: 'EIO' });
    return fs.readFile(...args);
  } });
  await store.save(receipt(), source());
  fail = true;
  await assert.rejects(store.get(id), error => error.code === 'LAN_RECEIPT_READ_FAILED' && error.systemCode === 'EIO' && !error.message.includes('PRIVATE'));
  assert.deepEqual(await fs.readdir(directory), [name(id)]);
});

test('serialized concurrent saves preserve call order and remain usable after failure', async t => {
  let failed = false;
  const { store } = await fixture(t, { rename: async (...args) => {
    if (!failed) { failed = true; throw Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' }); }
    return fs.rename(...args);
  } });
  const first = store.save(receipt(), source(), { state: 'accepted' });
  const second = store.save(receipt(), source(), { state: 'waiting' });
  const third = store.save(receipt(), source(), { state: 'blocked', blockedCode: 'SOURCE_CHANGED' });
  await assert.rejects(first, error => error.systemCode === 'ENOSPC');
  await Promise.all([second, third]);
  assert.equal((await store.get(id)).context.state, 'blocked');
});

test('invalid data directories are rejected before any journal I/O', () => {
  for (const dataDir of [undefined, null, '', ' ', 'bad\0path']) assert.throws(() => createRemoteReceiptStore({ dataDir }), TypeError);
});

test('initial directory creation failure is typed without exposing its path', async () => {
  const store = createRemoteReceiptStore({ dataDir: path.join(os.tmpdir(), 'synthetic-unused-journal'),
    fs: { mkdir: async () => { throw Object.assign(new Error('ENOSPC PRIVATE'), { code: 'ENOSPC' }); } } });
  await assert.rejects(store.ready, error => error.code === 'LAN_RECEIPT_SAVE_FAILED' && error.systemCode === 'ENOSPC' && !error.message.includes('PRIVATE'));
});
