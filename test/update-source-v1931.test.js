const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createAppUpdateService, fetchUpdateManifest, validateManifest, validateUpdateUrl,
  assetUrlForVersion, downloadUpdateAsset, MANIFEST_URL } = require('../lib/app-update');

const API_URL = 'https://api.github.com/repos/Xekaion/videorandom/contents/update.json?ref=main';
const bytes = Buffer.from('MZ neutral update-source fixture; never executed');
const manifest = version => ({ schemaVersion: 1, updateProtocol: 1, version,
  asset: { url: assetUrlForVersion(version), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length } });
const fresh = manifest('1.9.31');

function wire(reply) {
  const calls = [];
  const request = (url, options, callback) => {
    const item = { url, options };
    calls.push(item);
    const req = new EventEmitter();
    req.destroy = () => {};
    req.setTimeout = () => req;
    queueMicrotask(() => {
      const value = reply(item, calls.length);
      const response = Readable.from(value.body === undefined ? [] : [Buffer.from(value.body)]);
      response.statusCode = value.status || 200;
      response.headers = value.headers || {};
      callback(response);
    });
    return req;
  };
  return { calls, request };
}

function fixture(transport) {
  return createAppUpdateService({ currentVersion: '1.9.28',
    dataDir: path.join(os.tmpdir(), 'videorandom-update-source-no-files'),
    fetchManifest: options => fetchUpdateManifest({ ...options, request: transport.request }),
    downloadAsset: () => { throw new Error('No executable download belongs in an update check'); } });
}

test('the production manifest request reads the fixed Contents API even when every raw CDN request would be stale', async () => {
  const transport = wire(({ url }) => ({ body: JSON.stringify(url.startsWith(API_URL + '&check=') ? fresh : manifest('1.9.28')) }));
  const service = fixture(transport);
  const state = await service.check();
  assert.equal(state.status, 'available');
  assert.equal(state.latestVersion, '1.9.31');
  assert.equal(transport.calls.length, 1);
  const call = transport.calls[0];
  const source = new URL(call.url);
  assert.equal(source.origin, 'https://api.github.com');
  assert.equal(source.pathname, '/repos/Xekaion/videorandom/contents/update.json');
  assert.equal(source.searchParams.get('ref'), 'main');
  assert.match(source.searchParams.get('check'), /^[a-f0-9]{32}$/);
  assert.deepEqual([...source.searchParams.keys()], ['ref', 'check']);
  assert.equal(call.options.headers.Accept, 'application/vnd.github.raw+json');
  assert.equal(call.options.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(call.options.headers['Cache-Control'], 'no-cache, no-store, max-age=0');
  assert.equal(call.options.headers.Pragma, 'no-cache');
  assert.equal(call.options.headers['Accept-Encoding'], 'identity');
  assert.equal(call.options.headers.Authorization, undefined);
});

test('public raw API bytes use the existing bounded JSON and strict manifest validators', async () => {
  const transport = wire(() => ({ body: JSON.stringify(fresh) }));
  assert.deepEqual(validateManifest(await fetchUpdateManifest({ request: transport.request })), fresh);
  assert.equal(validateUpdateUrl(MANIFEST_URL, 'manifest'), MANIFEST_URL);
  assert.throws(() => validateUpdateUrl(API_URL, 'manifest'), { code: 'UPDATE_URL' });
});

test('every new check queries the fixed API with a distinct nonce', async () => {
  let version = '1.9.30';
  const transport = wire(() => ({ body: JSON.stringify(manifest(version)) }));
  const service = fixture(transport);
  assert.equal((await service.check()).latestVersion, '1.9.30');
  version = '1.9.31';
  assert.equal((await service.check()).latestVersion, '1.9.31');
  assert.notEqual(transport.calls[0].url, transport.calls[1].url);
  assert.ok(transport.calls.every(call => call.url.startsWith(API_URL + '&check=')));
});

for (const status of [304, 401, 403, 404, 429, 500, 503]) {
  test('API HTTP ' + status + ' reports an error rather than declaring the installed version latest or falling back to stale raw data', async () => {
    const transport = wire(() => ({ status, body: JSON.stringify({ message: 'neutral API error' }) }));
    const service = fixture(transport);
    await assert.rejects(service.check(), { code: 'UPDATE_HTTP' });
    assert.equal(service.getState().status, 'error');
    assert.equal(service.getState().latestVersion, null);
    assert.equal(service.getState().checkedAt, null);
    assert.equal(service.getState().errorCode, 'UPDATE_HTTP');
    assert.equal(transport.calls.length, 1);
    assert.ok(transport.calls.every(call => call.url.startsWith(API_URL + '&check=')));
  });
}

test('a later rate limit does not change a successful available result into a latest-version claim', async () => {
  const transport = wire((item, count) => count === 1 ? { body: JSON.stringify(fresh) } : { status: 403 });
  const service = fixture(transport);
  assert.equal((await service.check()).status, 'available');
  await assert.rejects(service.check(), { code: 'UPDATE_HTTP' });
  assert.equal(service.getState().status, 'error');
  assert.equal(service.getState().latestVersion, '1.9.31');
  assert.equal(service.getState().updateAvailable, true);
  assert.equal(transport.calls.length, 2);
});

for (const status of [304, 403, 429]) {
  test('a previously current response followed by HTTP ' + status + ' keeps the old timestamp and reports an error', async () => {
    const transport = wire((item, count) => count === 1
      ? { body: JSON.stringify(manifest('1.9.28')) } : { status });
    const service = fixture(transport);
    const previous = await service.check();
    assert.equal(previous.status, 'current');
    await assert.rejects(service.check(), { code: 'UPDATE_HTTP' });
    const state = service.getState();
    assert.equal(state.status, 'error');
    assert.equal(state.checkedAt, previous.checkedAt);
    assert.equal(state.errorCode, 'UPDATE_HTTP');
    assert.equal(transport.calls.length, 2);
  });
}

for (const url of [
  API_URL,
  API_URL + '&check=' + 'a'.repeat(32),
  API_URL.replace('Xekaion', 'other-owner'),
  API_URL.replace('/videorandom/', '/other/'),
  API_URL.replace('/update.json', '/other.json'),
  API_URL.replace('ref=main', 'ref=other'),
  API_URL.replace('https:', 'http:'),
  API_URL.replace('.com/', '.com:443/'),
  API_URL.replace('https://', 'https://user:password@')
]) {
  test('callers cannot override the internally pinned API source: ' + url, async () => {
    const transport = wire(() => ({ body: JSON.stringify(fresh) }));
    await assert.rejects(fetchUpdateManifest({ url, request: transport.request }), { code: 'UPDATE_URL' });
    assert.equal(transport.calls.length, 0);
  });
}

test('an API redirect cannot reuse or replace the private request URL', async () => {
  const transport = wire(({ url }) => ({ status: 302, headers: { location: url } }));
  await assert.rejects(fetchUpdateManifest({ request: transport.request }), { code: 'UPDATE_URL' });
  assert.equal(transport.calls.length, 1);
});

test('a Contents metadata wrapper is rejected without following its download_url', async () => {
  const transport = wire(() => ({ body: JSON.stringify({ type: 'file', encoding: 'base64',
    content: Buffer.from(JSON.stringify(fresh)).toString('base64'), download_url: 'http://127.0.0.1/private.exe' }) }));
  const service = fixture(transport);
  await assert.rejects(service.check(), { code: 'UPDATE_MANIFEST' });
  assert.equal(service.getState().status, 'error');
  assert.equal(transport.calls.length, 1);
});

test('an API error envelope returned with HTTP 200 cannot become a valid or current manifest', async () => {
  const transport = wire(() => ({ body: JSON.stringify({ message: 'API rate limit exceeded', documentation_url: 'https://docs.github.com/' }) }));
  const service = fixture(transport);
  await assert.rejects(service.check(), { code: 'UPDATE_MANIFEST' });
  assert.equal(service.getState().status, 'error');
  assert.equal(service.getState().latestVersion, null);
  assert.equal(service.getState().checkedAt, null);
  assert.equal(transport.calls.length, 1);
});

test('API transport never relaxes version-tag executable URL validation', async () => {
  const forged = structuredClone(fresh);
  forged.asset.url = 'https://api.github.com/repos/Xekaion/videorandom/contents/videorandom.exe?ref=main';
  const transport = wire(() => ({ body: JSON.stringify(forged) }));
  await assert.rejects(fixture(transport).check(), { code: 'UPDATE_URL' });
  assert.equal(transport.calls.length, 1);
});

test('immutable executable transport still uses the exact asset URL and binary headers', async () => {
  const url = assetUrlForVersion('1.9.31');
  const transport = wire(() => ({ body: bytes, headers: { 'content-length': String(bytes.length) } }));
  const received = [];
  for await (const chunk of downloadUpdateAsset({ url, maxBytes: bytes.length, request: transport.request })) received.push(chunk);
  assert.deepEqual(Buffer.concat(received), bytes);
  assert.equal(transport.calls[0].url, url);
  assert.equal(transport.calls[0].options.headers.Accept, 'application/octet-stream');
  assert.equal(transport.calls[0].options.headers['X-GitHub-Api-Version'], undefined);
  assert.equal(transport.calls[0].options.headers['Cache-Control'], undefined);
});
