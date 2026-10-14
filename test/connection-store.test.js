const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createConnectionStore } = require('../lib/connection-store');

const pair = { remoteUrl: 'http://192.168.1.10:3001', connectionCode: 'fixture-client-code-1234567890' };
const hostCode = 'fixture-host-code-1234567890123';
function protector() {
  const key = Buffer.alloc(32, 17);
  return { name: 'test-aes-gcm',
    async protect(value) { const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce); return Buffer.concat([nonce, cipher.update(value), cipher.final(), cipher.getAuthTag()]); },
    async unprotect(value) { const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(-16)); return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]); }
  };
}
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-connection-'));
  const codec = protector();
  const open = () => createConnectionStore({ dataDir, protector: codec });
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, open, store: open() };
}

test('protected pairing and stable host identity survive replacement executable instances', async t => {
  const f = await fixture(t);
  await f.store.saveConnection(pair);
  await f.store.setHostCode(hostCode);
  await f.store.setHostEnabled(true);
  const reopened = f.open();
  assert.deepEqual(await reopened.getConnection(), { ...pair, remembered: true });
  assert.deepEqual(await reopened.getHostState(), { enabled: true, connectionCode: hostCode });
  const saved = await fs.readFile(path.join(f.store.directory, 'client.json'), 'utf8');
  assert.equal(saved.includes(pair.connectionCode), false);
  assert.equal(saved.includes(pair.remoteUrl), false);
  await reopened.clearConnection();
  assert.deepEqual(await reopened.getConnection(), { remoteUrl: '', connectionCode: '', remembered: false });
  assert.deepEqual(await reopened.getHostState(), { enabled: true, connectionCode: hostCode });
});

test('separate instances serialize initial host creation and preserve host/client fields', async t => {
  const f = await fixture(t), second = f.open();
  const codes = await Promise.all([f.store.getHostCode(), second.getHostCode()]);
  assert.equal(codes[0], codes[1]);
  await Promise.all([f.store.setHostEnabled(true), second.saveConnection(pair)]);
  assert.deepEqual(await second.getHostState(), { enabled: true, connectionCode: codes[0] });
  assert.equal((await f.store.getConnection()).connectionCode, pair.connectionCode);
  await Promise.all([f.store.setHostCode(hostCode), second.setHostEnabled(false)]);
  assert.deepEqual(await f.store.getHostState(), { enabled: false, connectionCode: hostCode });
});

test('client corruption is recoverable by save or forget while host corruption never rotates identity', async t => {
  const f = await fixture(t);
  await f.store.saveConnection(pair);
  await fs.writeFile(path.join(f.store.directory, 'client.json'), 'broken protected envelope');
  await assert.rejects(f.store.getConnection(), /읽지 못했습니다/);
  await f.store.clearConnection();
  assert.equal((await f.store.getConnection()).remembered, false);
  await fs.writeFile(path.join(f.store.directory, 'client.json'), 'broken again');
  await f.store.saveConnection(pair);
  assert.equal((await f.store.getConnection()).connectionCode, pair.connectionCode);
  await fs.writeFile(path.join(f.store.directory, 'host.json'), 'broken host identity');
  await assert.rejects(f.store.getHostCode(), /읽지 못했습니다/);
  assert.equal(await fs.readFile(path.join(f.store.directory, 'host.json'), 'utf8'), 'broken host identity');
});

test('a failed protection/write never replaces a saved pairing', async t => {
  const f = await fixture(t);
  await f.store.saveConnection(pair);
  const saved = await fs.readFile(path.join(f.store.directory, 'client.json'));
  const broken = createConnectionStore({ dataDir: f.dataDir, protector: { ...protector(), protect: async () => { throw new Error('mock protection unavailable'); } } });
  await assert.rejects(broken.saveConnection({ ...pair, connectionCode: 'new-connection-code-1234567890' }), /저장하지 못했습니다/);
  assert.deepEqual(await fs.readFile(path.join(f.store.directory, 'client.json')), saved);
  assert.equal((await f.store.getConnection()).connectionCode, pair.connectionCode);
});

test('platform protection round trip hides host code on disk', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-platform-secret-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = createConnectionStore({ dataDir });
  const code = await store.getHostCode();
  const reopened = createConnectionStore({ dataDir });
  assert.equal(await reopened.getHostCode(), code);
  const raw = await fs.readFile(path.join(store.directory, 'host.json'), 'utf8');
  assert.equal(raw.includes(code), false);
  assert.equal(JSON.parse(raw).protection, process.platform === 'win32' ? 'windows-current-user-dpapi' : 'owner-aes-256-gcm');
});
