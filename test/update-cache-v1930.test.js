const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createAppUpdateService, fetchUpdateManifest, downloadUpdateAsset, openTrustedResponse,
  validateUpdateUrl, assetUrlForVersion, MANIFEST_URL } = require('../lib/app-update');

const bytes = Buffer.from('MZ neutral cache fixture; never executed');
const hash = crypto.createHash('sha256').update(bytes).digest('hex');
const manifest = version => ({ schemaVersion: 1, updateProtocol: 1, version,
  asset: { url: assetUrlForVersion(version), sha256: hash, sizeBytes: bytes.length } });
const noncePattern = new RegExp('^' + MANIFEST_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\?check=[a-f0-9]{32}$');

function transport(resolve) {
  const calls = [];
  const request = (url, options, callback) => {
    const call = { url, options };
    calls.push(call);
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => {};
    queueMicrotask(() => {
      const value = resolve(call, calls.length);
      const response = Readable.from(value.chunks || []);
      response.statusCode = value.status || 200;
      response.headers = value.headers || {};
      callback(response);
    });
    return req;
  };
  return { calls, request };
}

function manifestResponse(version) {
  return { headers: { 'cache-control': 'max-age=300' }, chunks: [Buffer.from(JSON.stringify(manifest(version)))] };
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('each manual update check sees new manifest data instead of the cached canonical response', async () => {
  let latest = '1.9.29';
  const cache = new Map([[MANIFEST_URL, manifestResponse('1.9.28')]]);
  const wire = transport(({ url }) => {
    if (!cache.has(url)) cache.set(url, manifestResponse(latest));
    return cache.get(url);
  });
  const service = createAppUpdateService({ currentVersion: '1.9.28',
    dataDir: path.join(os.tmpdir(), 'videorandom-update-cache-no-files'),
    fetchManifest: options => fetchUpdateManifest({ ...options, request: wire.request }) });
  const first = await service.check();
  assert.equal(first.latestVersion, '1.9.29');
  assert.equal(first.updateAvailable, true);
  latest = '1.9.30';
  const second = await service.check();
  assert.equal(second.latestVersion, '1.9.30');
  assert.equal(second.updateAvailable, true);
  assert.equal(wire.calls.length, 2);
  assert.notEqual(wire.calls[0].url, wire.calls[1].url);
  for (const call of wire.calls) {
    assert.match(call.url, noncePattern);
    assert.equal(call.options.headers['Cache-Control'], 'no-cache, no-store, max-age=0');
    assert.equal(call.options.headers.Pragma, 'no-cache');
    assert.equal(call.options.headers['Accept-Encoding'], 'identity');
  }
});

test('a fresh manifest nonce is random even when all check times are identical', async () => {
  const wire = transport(() => manifestResponse('1.9.30'));
  const service = createAppUpdateService({ currentVersion: '1.9.28',
    dataDir: path.join(os.tmpdir(), 'videorandom-update-cache-no-files'),
    now: () => new Date(0),
    fetchManifest: options => fetchUpdateManifest({ ...options, request: wire.request }) });
  for (let index = 0; index < 8; index++) await service.check();
  assert.equal(new Set(wire.calls.map(call => call.url)).size, 8);
  assert.ok(wire.calls.every(call => noncePattern.test(call.url)));
  assert.equal(service.getState().checkedAt, '1970-01-01T00:00:00.000Z');
});

test('fresh manifest transport keeps the selected tagged asset URL, size and hash checks unchanged', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-update-cache-stage-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const selected = manifest('1.9.30');
  const wire = transport(({ url }) => url === selected.asset.url
    ? { headers: { 'content-length': String(bytes.length) }, chunks: [bytes] }
    : manifestResponse('1.9.30'));
  const service = createAppUpdateService({ currentVersion: '1.9.28', dataDir,
    fetchManifest: options => fetchUpdateManifest({ ...options, request: wire.request }),
    downloadAsset: options => downloadUpdateAsset({ ...options, request: wire.request }) });
  assert.equal((await service.stage()).status, 'ready');
  assert.equal(wire.calls.length, 2);
  assert.match(wire.calls[0].url, noncePattern);
  assert.equal(wire.calls[1].url, selected.asset.url);
  assert.equal(wire.calls[1].options.headers['Cache-Control'], undefined);
  assert.equal(wire.calls[1].options.headers.Pragma, undefined);
  assert.deepEqual(await fs.readFile(service.getStagedUpdate().path), bytes);
  assert.equal(service.getStagedUpdate().sha256, hash);
});

test('the same canonical manifest redirect receives another internal nonce without allowing new URLs', async () => {
  const wire = transport((call, count) => count === 1
    ? { status: 302, headers: { location: MANIFEST_URL } }
    : manifestResponse('1.9.30'));
  assert.deepEqual(await fetchUpdateManifest({ request: wire.request }), manifest('1.9.30'));
  assert.equal(wire.calls.length, 2);
  assert.notEqual(wire.calls[0].url, wire.calls[1].url);
  assert.ok(wire.calls.every(call => noncePattern.test(call.url)));
});

test('an immutable executable download never gains a manifest cache nonce or cache headers', async () => {
  const asset = assetUrlForVersion('1.9.30');
  const wire = transport(() => ({ chunks: [bytes] }));
  assert.deepEqual(await collect(downloadUpdateAsset({ url: asset, maxBytes: bytes.length, request: wire.request })), bytes);
  assert.equal(wire.calls[0].url, asset);
  assert.equal(wire.calls[0].options.headers['Cache-Control'], undefined);
  assert.equal(wire.calls[0].options.headers.Pragma, undefined);
});

for (const suffix of ['?check=' + 'a'.repeat(32), '?check=1', '?x=1', '#fragment', '/', '?check=%2f']) {
  test('caller-provided manifest URL remains rejected: ' + suffix, async () => {
    let called = false;
    const url = MANIFEST_URL + suffix;
    assert.throws(() => validateUpdateUrl(url, 'manifest'), { code: 'UPDATE_URL' });
    await assert.rejects(fetchUpdateManifest({ url, request: () => { called = true; } }), { code: 'UPDATE_URL' });
    assert.equal(called, false);
  });
}

const hostileLocations = [
  MANIFEST_URL + '?check=' + 'a'.repeat(32),
  MANIFEST_URL + '?x=1',
  MANIFEST_URL + '#fragment',
  MANIFEST_URL.replace('https:', 'http:'),
  MANIFEST_URL.replace('https://', 'https://user:password@'),
  MANIFEST_URL.replace('.com/', '.com:443/'),
  MANIFEST_URL.replace('Xekaion', 'other-owner'),
  MANIFEST_URL.replace('/videorandom/', '/other/'),
  MANIFEST_URL.replace('/main/', '/v1.9.30/'),
  'https://127.0.0.1/internal',
  '/Xekaion/videorandom/main/update.json',
  assetUrlForVersion('1.9.30')
];
for (const location of hostileLocations) {
  test('manifest redirect cannot broaden its trust boundary: ' + location, async () => {
    const wire = transport(() => ({ status: 302, headers: { location } }));
    await assert.rejects(fetchUpdateManifest({ request: wire.request }), { code: 'UPDATE_URL' });
    assert.equal(wire.calls.length, 1);
  });
}

test('even the internally generated manifest request URL is not a trusted redirect target', async () => {
  const wire = transport(({ url }) => ({ status: 302, headers: { location: url } }));
  await assert.rejects(fetchUpdateManifest({ request: wire.request }), { code: 'UPDATE_URL' });
  assert.equal(wire.calls.length, 1);
});

test('pre-aborted cache-bypassed manifest checks still open no transport', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(openTrustedResponse(MANIFEST_URL,
    { kind: 'manifest', signal: controller.signal, request: () => { called = true; } }), { code: 'UPDATE_TIMEOUT' });
  assert.equal(called, false);
});
