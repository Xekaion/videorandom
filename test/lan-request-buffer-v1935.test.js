const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { classifyDiagnosticError, classifyAnalysisFailure } = require('../lib/diagnostics');

// Exercise the production HTTP boundary without exporting it or invoking an
// application/provider. Every request is to this test's own loopback listener.
const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'lan-analysis.js'), 'utf8');
const start = source.indexOf('function requestBuffer('), end = source.indexOf('\nfunction pause(', start);
assert(start >= 0 && end > start);
const requestBuffer = vm.runInNewContext(source.slice(start, end) + '\nrequestBuffer;', {
  http, Buffer, MB: 1024 * 1024, setTimeout, clearTimeout, classifyDiagnosticError,
  abortError: () => Object.assign(new Error('Owned request cancelled'), { name: 'AbortError' })
}, { filename: 'owned-request-buffer-production-source.js' });
const recoveryStart = source.indexOf('function recoverableUploadFailure(');
const recoveryEnd = source.indexOf('\n// Recover only reads', recoveryStart);
assert(recoveryStart >= 0 && recoveryEnd > recoveryStart);
const recoverableUploadFailure = vm.runInNewContext(source.slice(recoveryStart, recoveryEnd) + '\nrecoverableUploadFailure;', {},
  { filename: 'owned-upload-transport-production-source.js' });

async function fixture(t, handler) {
  let requests = 0;
  const server = http.createServer((request, response) => { requests++; handler(request, response); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  const target = { hostname: '127.0.0.1', port: server.address().port, hostHeader: '127.0.0.1' };
  return { get requests() { return requests; }, read: options => requestBuffer(target, '/owned-neutral', options) };
}

test('oversized response keeps its original limit error instead of a synthetic reset from stream destruction', async t => {
  const f = await fixture(t, (_request, response) => response.end(Buffer.alloc(1024)));
  await assert.rejects(f.read({ maxBytes: 3, timeout: 1000 }), error => {
    assert.equal(error.code, 'LAN_RESPONSE_TOO_LARGE'); assert.equal(error.statusCode, 200); return true;
  });
  assert.equal(f.requests, 1);
});

for (const [status, expected] of [[401, 'PROVIDER_AUTH'], [429, 'PROVIDER_QUOTA'], [503, 'PROVIDER_UNAVAILABLE']]) {
  test(`HTTP ${status} remains authoritative when its oversized body is destroyed`, async t => {
    const f = await fixture(t, (_request, response) => { response.writeHead(status); response.end(Buffer.alloc(1024)); });
    await assert.rejects(f.read({ maxBytes: 3, timeout: 1000 }), error => {
      assert.equal(error.code, 'LAN_RESPONSE_TOO_LARGE'); assert.equal(error.statusCode, status);
      assert.equal(classifyAnalysisFailure(error).code, expected); return true;
    });
    assert.equal(f.requests, 1);
  });

  test(`HTTP ${status} remains authoritative after a dropped partial response body`, async t => {
    const f = await fixture(t, (_request, response) => {
      response.writeHead(status, { 'Content-Length': 100 }); response.flushHeaders(); response.write('owned');
      const timer = setTimeout(() => response.destroy(), 15); response.once('close', () => clearTimeout(timer));
    });
    await assert.rejects(f.read({ timeout: 1000 }), error => {
      assert.equal(error.code, 'ECONNRESET'); assert.equal(error.statusCode, status);
      const diagnostic = classifyAnalysisFailure(error);
      if (status === 503) {
        assert.equal(diagnostic.httpStatus, 503);
        assert.equal(recoverableUploadFailure(error), false, 'a failed service response cannot grant transport recovery');
      } else assert.equal(diagnostic.code, expected);
      return true;
    });
    assert.equal(f.requests, 1);
  });
}

test('cancellation during an active partial response preserves AbortError and releases the request', async t => {
  const controller = new AbortController();
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Length': 100 }); response.flushHeaders(); response.write('owned');
    const timer = setTimeout(() => controller.abort(), 15); response.once('close', () => clearTimeout(timer));
  });
  await assert.rejects(f.read({ signal: controller.signal, timeout: 1000 }), error => {
    assert.equal(error.name, 'AbortError'); assert.equal(error.statusCode, 200);
    assert.equal(classifyAnalysisFailure(error).code, 'ANALYSIS_CANCELLED'); return true;
  });
  assert.equal(f.requests, 1);
});

test('an already-cancelled request starts no HTTP connection', async t => {
  const controller = new AbortController(); controller.abort();
  const f = await fixture(t, (_request, response) => response.end('owned'));
  await assert.rejects(f.read({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.requests, 0);
});

test('an absolute request deadline ends a continuously active trickle without waiting for socket inactivity', { timeout: 7000 }, async t => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200); response.flushHeaders(); response.write('owned');
    const interval = setInterval(() => response.write('o'), 5);
    response.once('close', () => clearInterval(interval));
  });
  const started = Date.now();
  await assert.rejects(f.read({ timeout: 250 }), error => {
    assert.equal(error.code, 'ETIMEDOUT'); assert.equal(error.statusCode, 200);
    assert.match(error.message, /요청 제한 시간/); return true;
  });
  assert(Date.now() - started >= 200);
  assert(Date.now() - started < 4500, 'active response must not extend the absolute request budget');
  assert.equal(f.requests, 1);
});

for (const code of ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'LAN_INVALID_JSON']) {
  test(`only a narrow owned transport error may enter read-only upload recovery: ${code}`, () => {
    const error = Object.assign(new Error('Owned neutral transport fixture'), { code, statusCode: 200 });
    assert.equal(recoverableUploadFailure(error), true);
    assert.equal(recoverableUploadFailure(error, { aborted: true }), false);
  });
}

for (const [label, extra] of [
  ['authentication', { code: 'PROVIDER_AUTH' }], ['quota', { code: 'PROVIDER_QUOTA' }],
  ['refusal', { code: 'PROVIDER_REFUSAL' }], ['unknown', { code: 'PROVIDER_UNKNOWN' }],
  ['disk errno', { systemCode: 'ENOSPC' }], ['different transport errno', { systemCode: 'EPIPE' }],
  ['HTTP authentication status', { status: 401 }], ['HTTP quota status', { statusCode: 429 }],
  ['HTTP service status', { httpStatus: 503 }], ['provider status', { providerHttpStatus: 401 }],
  ['provider error type', { providerErrorType: 'refusal' }], ['provider execution', { executionSource: 'provider-error' }],
  ['refusal source', { refusalSource: 'execution-error' }], ['immediate cause', { cause: { code: 'PROVIDER_AUTH' } }],
  ['coded cause', { causeCode: 'STORAGE_WRITE_FAILED' }], ['retained diagnostic', { diagnostic: { code: 'PROVIDER_UNKNOWN' } }],
  ['accepted job proof', { remoteJob: { serverJobId: 'a'.repeat(32) } }],
  ['arbitrary extra field', { unrelated: 'Owned synthetic extra' }], ['cancellation', { name: 'AbortError' }]
]) {
  test(`competing ${label} evidence cannot enter upload recovery`, () => {
    const error = Object.assign(new Error('Owned transport fixture'), { code: 'ECONNRESET', ...extra });
    assert.equal(recoverableUploadFailure(error), false);
  });
}

for (const [key, value] of [['providerErrorType', 'refusal'], ['executionSource', 'provider-error'],
  ['refusalSource', 'execution-error'], ['cause', { code: 'PROVIDER_QUOTA' }], ['causeCode', 'PROVIDER_AUTH'],
  ['diagnostic', { code: 'PROVIDER_UNKNOWN' }], ['unexpected', 'Owned synthetic extra']]) {
  test(`non-enumerable ${key} evidence is not erased by the transport admission gate`, () => {
    const error = Object.assign(new Error('Owned transport fixture'), { code: 'ECONNRESET' });
    Object.defineProperty(error, key, { value, enumerable: false });
    assert.equal(recoverableUploadFailure(error), false);
  });
}
