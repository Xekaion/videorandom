const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createAppUpdateService, compareVersions, assetUrlForVersion, validateManifest, validateUpdateUrl,
  openTrustedResponse, fetchUpdateManifest, downloadUpdateAsset,
  MANIFEST_URL, MAX_ASSET_BYTES, MAX_MANIFEST_BYTES } = require('../lib/app-update');

const ASSET_URL = assetUrlForVersion('1.9.0');
const bytes = Buffer.from('MZ synthetic update fixture, never executed');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const manifest = (version = '1.9.0', content = bytes) => ({ schemaVersion: 1, updateProtocol: 1, version,
  asset: { url: assetUrlForVersion(version), sha256: digest(content), sizeBytes: content.length } });
async function* chunks(content = bytes) { yield content.subarray(0, 1); yield content.subarray(1, 8); yield content.subarray(8); }

async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-app-update-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let checks = 0, downloads = 0;
  const service = createAppUpdateService({ currentVersion: '1.8.2', dataDir,
    fetchManifest: async options => { checks++; assert.equal(options.url, MANIFEST_URL); assert.equal(options.maxBytes, MAX_MANIFEST_BYTES); return manifest(); },
    downloadAsset: async options => { downloads++; assert.equal(options.url, ASSET_URL); assert.equal(options.maxBytes, bytes.length); return chunks(); },
    now: () => new Date('2026-10-16T12:00:00Z'), ...overrides });
  return { service, dataDir, checks: () => checks, downloads: () => downloads };
}

function requestFixture(responses) {
  const calls = [];
  const request = (url, options, callback) => {
    calls.push({ url, options });
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => {};
    const next = responses.shift();
    queueMicrotask(() => {
      if (next.error) return req.emit('error', next.error);
      const response = Readable.from(next.chunks || []);
      response.statusCode = next.status || 200;
      response.headers = next.headers || {};
      callback(response);
    });
    return req;
  };
  return { request, calls };
}
async function collect(stream) { const result = []; for await (const chunk of stream) result.push(chunk); return Buffer.concat(result); }

test('version comparison is numeric and never accepts a path or prerelease', () => {
  assert.equal(compareVersions('1.10.0', '1.9.99'), 1);
  assert.equal(compareVersions('1.8.2', '1.8.2'), 0);
  assert.equal(compareVersions('1.8.2', '2.0.0'), -1);
  for (const invalid of ['../1.2.3', '1.2.3/other', 'v1.2.3', '1.2.3-beta', '01.2.3', '1.2', '1.2.9999999', '', 123]) {
    assert.throws(() => compareVersions(invalid, '1.2.3'), { code: 'UPDATE_VERSION' });
  }
});

test('manifest is strict, bounded, immutable, and pinned to update protocol one', () => {
  const result = validateManifest(manifest());
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.asset), true);
  assert.deepEqual(result, manifest());
  for (const change of [
    value => { value.schemaVersion = 2; }, value => { value.updateProtocol = 2; },
    value => { delete value.updateProtocol; }, value => { value.path = '../program.exe'; },
    value => { value.asset.path = '../../program.exe'; }, value => { value.version = '../../x'; },
    value => { value.asset.sizeBytes = MAX_ASSET_BYTES + 1; }, value => { value.asset.sizeBytes = 0; },
    value => { value.asset.sizeBytes = 1.5; }, value => { value.asset.sha256 = 'a'.repeat(63); }
  ]) {
    const candidate = manifest(); change(candidate);
    assert.throws(() => validateManifest(candidate), { code: 'UPDATE_MANIFEST' });
  }
  const upper = manifest(); upper.asset.sha256 = upper.asset.sha256.toUpperCase();
  assert.equal(validateManifest(upper).asset.sha256, digest(bytes));
});

test('update URLs reject HTTP, local addresses, credentials, alternate repositories and traversal', () => {
  assert.equal(validateUpdateUrl(MANIFEST_URL, 'manifest'), MANIFEST_URL);
  assert.equal(validateUpdateUrl(ASSET_URL, 'asset'), ASSET_URL);
  for (const url of [
    ASSET_URL.replace('https:', 'http:'), 'https://127.0.0.1/videorandom.exe',
    'file:///C:/program.exe', 'https://raw.githubusercontent.com:443/Xekaion/videorandom/main/videorandom.exe',
    ASSET_URL + '?download=1', ASSET_URL + '#fragment', ASSET_URL.replace('Xekaion', 'another-owner'),
    ASSET_URL.replace('/videorandom/v1.9.0/', '/other/v1.9.0/'), ASSET_URL.replace('https://', 'https://user:pass@'),
    ASSET_URL.replace('/v1.9.0/', '/v1.9.0/../v1.9.0/'), ASSET_URL.replace('/v1.9.0/', '/v1.9.0/%2e%2e/v1.9.0/'),
    MANIFEST_URL, 'https://github.com/Xekaion/videorandom/raw/main/videorandom.exe'
  ]) {
    assert.throws(() => validateUpdateUrl(url, 'asset'), { code: 'UPDATE_URL' });
  }
});

test('manifest assets must use the exact semantic-version tag matching the advertised version', () => {
  assert.equal(assetUrlForVersion('1.10.7'), 'https://raw.githubusercontent.com/Xekaion/videorandom/v1.10.7/videorandom.exe');
  assert.equal(validateManifest(manifest('1.10.7')).asset.url, assetUrlForVersion('1.10.7'));
  const mismatched = manifest('1.10.7'); mismatched.asset.url = assetUrlForVersion('1.9.0');
  assert.throws(() => validateManifest(mismatched), { code: 'UPDATE_URL' });
  for (const tag of ['main', 'master', 'latest', '1.10.7', 'v01.10.7', 'v1.10.7-beta', 'v1.10.7/other', 'refs/tags/v1.10.7']) {
    const url = 'https://raw.githubusercontent.com/Xekaion/videorandom/' + tag + '/videorandom.exe';
    assert.throws(() => validateUpdateUrl(url, 'asset'), { code: 'UPDATE_URL' });
    const candidate = manifest('1.10.7'); candidate.asset.url = url;
    assert.throws(() => validateManifest(candidate), { code: 'UPDATE_URL' });
  }
  for (const version of ['v1.10.7', '../main', '01.10.7', '1.10.7-beta']) {
    assert.throws(() => assetUrlForVersion(version), { code: 'UPDATE_VERSION' });
  }
});

test('staging requests the manifest on main and executable on its exact version tag', async t => {
  const selected = manifest('1.10.7');
  const transport = requestFixture([
    { chunks: [Buffer.from(JSON.stringify(selected))] },
    { headers: { 'content-length': String(bytes.length) }, chunks: [bytes] }
  ]);
  const f = await fixture(t, {
    fetchManifest: options => fetchUpdateManifest({ ...options, request: transport.request }),
    downloadAsset: options => downloadUpdateAsset({ ...options, request: transport.request })
  });
  assert.equal((await f.service.stage()).status, 'ready');
  assert.deepEqual(transport.calls.map(call => call.url), [MANIFEST_URL, assetUrlForVersion('1.10.7')]);
  assert.equal(f.service.getStagedUpdate().version, '1.10.7');
});

test('asset redirects stay on the original version even when another version URL is otherwise valid', async () => {
  const same = requestFixture([{ status: 302, headers: { location: ASSET_URL } }, { chunks: [bytes] }]);
  assert.deepEqual(await collect(downloadUpdateAsset({ url: ASSET_URL, maxBytes: bytes.length, request: same.request })), bytes);
  assert.deepEqual(same.calls.map(call => call.url), [ASSET_URL, ASSET_URL]);
  for (const location of [assetUrlForVersion('1.9.1'), assetUrlForVersion('1.8.2'), ASSET_URL.replace('/v1.9.0/', '/main/'), ASSET_URL + '?download=1']) {
    const other = requestFixture([{ status: 302, headers: { location } }]);
    await assert.rejects(collect(downloadUpdateAsset({ url: ASSET_URL, maxBytes: bytes.length, request: other.request })), { code: 'UPDATE_URL' });
    assert.equal(other.calls.length, 1);
  }
});

test('checking and downloading retain only verified staged executable bytes', async t => {
  const f = await fixture(t);
  assert.equal(f.service.getState().status, 'idle');
  const checked = await f.service.check();
  assert.equal(checked.status, 'available');
  assert.equal(checked.latestVersion, '1.9.0');
  assert.equal(checked.updateAvailable, true);
  assert.equal(checked.checkedAt, '2026-10-16T12:00:00.000Z');
  checked.status = 'forged';
  assert.equal(f.service.getState().status, 'available');
  const ready = await f.service.stage();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.downloadedBytes, bytes.length);
  assert.equal(ready.stagedVersion, '1.9.0');
  assert.equal(ready.readyAt, '2026-10-16T12:00:00.000Z');
  const staged = f.service.getStagedUpdate();
  assert.equal(path.relative(f.service.directory, staged.path).startsWith('..'), false);
  assert.equal(staged.sha256, digest(bytes));
  assert.deepEqual(await fs.readFile(staged.path), bytes);
  assert.deepEqual(await fs.readdir(path.dirname(staged.path)), ['videorandom.exe']);
  assert.equal(JSON.stringify(ready).includes(f.dataDir), false);
  staged.path = 'forged';
  assert.notEqual(f.service.getStagedUpdate().path, 'forged');
  await f.service.stage();
  assert.equal(f.downloads(), 1);
});

test('stage can perform the initial manifest check and never downloads an equal or older version', async t => {
  const fresh = await fixture(t);
  await fresh.service.stage();
  assert.equal(fresh.checks(), 1);
  for (const version of ['1.8.2', '1.7.99']) {
    const f = await fixture(t, { fetchManifest: async () => manifest(version) });
    assert.equal((await f.service.check()).status, 'current');
    await assert.rejects(f.service.stage(), { code: 'UPDATE_NONE' });
    assert.equal(f.downloads(), 0);
    assert.equal(f.service.getStagedUpdate(), null);
  }
});

test('concurrent checks and stages share a single download and checked snapshot', async t => {
  let release;
  let checks = 0, downloads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, {
    fetchManifest: async () => { checks++; await gate; return manifest(); },
    downloadAsset: async () => { downloads++; return chunks(); }
  });
  const checkA = f.service.check(), checkB = f.service.check();
  const stageA = f.service.stage(), stageB = f.service.stage();
  assert.equal(checkA, checkB);
  release();
  await Promise.all([checkA, stageA, stageB]);
  assert.equal(checks, 1);
  assert.equal(downloads, 1);
  assert.equal(f.service.getState().status, 'ready');
});

test('wrong hash, truncated bytes, overlong bytes and non-executable payload never publish a file', async t => {
  const cases = [
    { payload: Buffer.from('MZ different fixture same-ish'), code: 'UPDATE_SIZE' },
    { payload: Buffer.concat([bytes.subarray(0, -1), Buffer.from('!')]), code: 'UPDATE_HASH' },
    { payload: bytes.subarray(0, -1), code: 'UPDATE_SIZE' },
    { payload: Buffer.concat([bytes, Buffer.from('extra')]), code: 'UPDATE_SIZE' },
    { payload: Buffer.from('not an executable'), usePayloadManifest: true, code: 'UPDATE_BINARY' }
  ];
  for (const item of cases) {
    const f = await fixture(t, {
      fetchManifest: async () => manifest('1.9.0', item.usePayloadManifest ? item.payload : bytes),
      downloadAsset: async () => chunks(item.payload)
    });
    await assert.rejects(f.service.stage(), { code: item.code });
    assert.equal(f.service.getState().status, 'error');
    assert.equal(f.service.getStagedUpdate(), null);
    const dirs = await fs.readdir(f.service.directory);
    for (const directory of dirs) assert.deepEqual(await fs.readdir(path.join(f.service.directory, directory)), []);
  }
});

test('download failures clean temporary bytes, sanitize errors and allow a manual retry', async t => {
  let attempt = 0;
  const f = await fixture(t, { downloadAsset: async () => (async function* () {
    yield bytes.subarray(0, 4);
    if (++attempt === 1) throw new Error('private C:/path and token should never be public');
    yield bytes.subarray(4);
  })() });
  await assert.rejects(f.service.stage(), /저장하지 못했습니다/);
  assert.equal(JSON.stringify(f.service.getState()).includes('private'), false);
  const dirs = await fs.readdir(f.service.directory);
  assert.deepEqual(await fs.readdir(path.join(f.service.directory, dirs[0])), []);
  assert.equal((await f.service.stage()).status, 'ready');
});

test('failure during a newer download preserves a previously verified executable', async t => {
  let next = false;
  const f = await fixture(t, {
    fetchManifest: async () => manifest(next ? '1.9.1' : '1.9.0'),
    downloadAsset: async () => chunks(next ? bytes.subarray(0, 5) : bytes)
  });
  await f.service.stage();
  const original = f.service.getStagedUpdate();
  next = true;
  await f.service.check();
  await assert.rejects(f.service.stage(), { code: 'UPDATE_SIZE' });
  assert.deepEqual(await fs.readFile(original.path), bytes);
});

test('a failed atomic publication does not mark an executable ready', async t => {
  const f = await fixture(t, { fs: { ...fs, rename: async () => { const error = new Error('disk failure'); error.code = 'EACCES'; throw error; } } });
  await assert.rejects(f.service.stage(), { code: 'UPDATE_IO' });
  assert.equal(f.service.getStagedUpdate(), null);
  const dirs = await fs.readdir(f.service.directory);
  assert.deepEqual(await fs.readdir(path.join(f.service.directory, dirs[0])), []);
});

test('manifest and asset operations have separate abortable bounded deadlines', async t => {
  function waiting(signal) {
    return new Promise((resolve, reject) => {
      const keepAlive = setTimeout(resolve, 1000);
      signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(new Error('aborted')); }, { once: true });
    });
  }
  const checking = await fixture(t, { manifestTimeoutMs: 10, fetchManifest: async ({ signal }) => waiting(signal) });
  await assert.rejects(checking.service.check(), { code: 'UPDATE_TIMEOUT' });
  const downloading = await fixture(t, { timeoutMs: 10, downloadAsset: async ({ signal }) => (async function* () {
    yield bytes.subarray(0, 3);
    await waiting(signal);
    yield bytes.subarray(3);
  })() });
  await assert.rejects(downloading.service.stage(), { code: 'UPDATE_TIMEOUT' });
  assert.equal(downloading.service.getStagedUpdate(), null);
  const dirs = await fs.readdir(downloading.service.directory);
  assert.deepEqual(await fs.readdir(path.join(downloading.service.directory, dirs[0])), []);
});

test('untrusted manifests fail before any file download or staging directory creation', async t => {
  const bad = manifest(); bad.asset.url = 'https://127.0.0.1/private.exe';
  const f = await fixture(t, { fetchManifest: async () => bad });
  await assert.rejects(f.service.stage(), { code: 'UPDATE_URL' });
  assert.equal(f.downloads(), 0);
  await assert.rejects(fs.stat(f.service.directory), { code: 'ENOENT' });
});

test('HTTPS transport follows only the exact pinned same-file URL and caps redirect loops', async () => {
  const good = requestFixture([{ status: 302, headers: { location: MANIFEST_URL } }, { chunks: [Buffer.from('{}')] }]);
  const response = await openTrustedResponse(MANIFEST_URL, { kind: 'manifest', request: good.request });
  assert.equal((await collect(response)).toString(), '{}');
  assert.equal(good.calls.length, 2);
  assert.equal(good.calls[0].options.headers['Accept-Encoding'], 'identity');
  for (const location of ['http://127.0.0.1/internal', ASSET_URL, MANIFEST_URL + '?x=1', MANIFEST_URL.replace('Xekaion', 'other')]) {
    const bad = requestFixture([{ status: 302, headers: { location } }]);
    await assert.rejects(openTrustedResponse(MANIFEST_URL, { kind: 'manifest', request: bad.request }), { code: 'UPDATE_URL' });
    assert.equal(bad.calls.length, 1);
  }
  const loop = requestFixture(Array.from({ length: 4 }, () => ({ status: 302, headers: { location: MANIFEST_URL } })));
  await assert.rejects(openTrustedResponse(MANIFEST_URL, { kind: 'manifest', request: loop.request }), { code: 'UPDATE_REDIRECT' });
  assert.equal(loop.calls.length, 4);
});

test('HTTPS manifest parser bounds both advertised and actual bytes and rejects malformed JSON', async () => {
  const valid = requestFixture([{ chunks: [Buffer.from(JSON.stringify(manifest()))] }]);
  assert.deepEqual(await fetchUpdateManifest({ request: valid.request }), manifest());
  for (const response of [
    { headers: { 'content-length': String(MAX_MANIFEST_BYTES + 1) } },
    { headers: { 'content-length': 'invalid' } },
    { chunks: [Buffer.alloc(MAX_MANIFEST_BYTES + 1)] },
    { chunks: [Buffer.from('{bad')] }
  ]) {
    const transport = requestFixture([response]);
    await assert.rejects(fetchUpdateManifest({ request: transport.request }), { code: 'UPDATE_MANIFEST' });
  }
});

test('HTTPS asset reader rejects wrong content length, compression, HTTP errors and oversized streams', async () => {
  const valid = requestFixture([{ headers: { 'content-length': String(bytes.length) }, chunks: [bytes] }]);
  assert.deepEqual(await collect(downloadUpdateAsset({ url: ASSET_URL, maxBytes: bytes.length, request: valid.request })), bytes);
  for (const response of [
    { headers: { 'content-length': String(bytes.length - 1) }, chunks: [bytes] },
    { headers: { 'content-length': 'invalid' } },
    { chunks: [bytes, Buffer.from('extra')] }
  ]) {
    const transport = requestFixture([response]);
    await assert.rejects(collect(downloadUpdateAsset({ url: ASSET_URL, maxBytes: bytes.length, request: transport.request })), { code: 'UPDATE_SIZE' });
  }
  for (const response of [{ status: 503 }, { headers: { 'content-encoding': 'gzip' } }]) {
    const transport = requestFixture([response]);
    await assert.rejects(collect(downloadUpdateAsset({ url: ASSET_URL, maxBytes: bytes.length, request: transport.request })), { code: 'UPDATE_HTTP' });
  }
  const network = requestFixture([{ error: new Error('private transport detail') }]);
  await assert.rejects(fetchUpdateManifest({ request: network.request }), { code: 'UPDATE_NETWORK' });
});

test('pre-aborted transport does not open a socket', async () => {
  const controller = new AbortController(); controller.abort();
  let opened = false;
  await assert.rejects(openTrustedResponse(MANIFEST_URL, { kind: 'manifest', signal: controller.signal, request: () => { opened = true; } }), { code: 'UPDATE_TIMEOUT' });
  assert.equal(opened, false);
});
