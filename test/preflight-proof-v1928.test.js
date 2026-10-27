const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dns = require('node:dns').promises;
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { checkRemoteServer, sendRemoteAnalysis } = require('../lib/lan-analysis');
const { createCatalogEngine } = require('../lib/catalog-engine');

const CODE = 'owned-preflight-code-123456789';
const URL = 'http://127.0.0.1:31999';
const PROOF = { version: 1, phase: 'preflight', submission: 'not-submitted' };
const NETWORK_CODES = ['EHOSTUNREACH', 'ENETUNREACH', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN'];
const HOST = { ready: true, protocol: 1, capabilities: ['timed-subtitles-v1', 'subtitle-quality-v3', 'subtitle-translation-only-v1'] };
const source = () => ({ id: 'a'.repeat(32), name: 'synthetic-train.mp4', path: 'C:/owned-fixture/synthetic-train.mp4',
  ext: 'MP4', duration: 10, size: 1, status: 'partial', hasAudio: false, frames: [], transcript: [], warnings: [] });

// Replace only this test process's HTTP transport. No server, model or real
// network connection is involved, including tests of normally slow deadlines.
function fakeHttp(t, respond) {
  const calls = [];
  t.mock.method(http, 'request', (options, receive) => {
    calls.push({ method: options.method, path: options.path });
    const request = new PassThrough({ autoDestroy: false });
    request.resume();
    request.setTimeout = () => request;
    request.on('finish', () => queueMicrotask(() => {
      const result = respond(options, calls.length);
      if (result.error) { request.destroy(result.error); return; }
      const response = new EventEmitter();
      response.statusCode = result.status || 200;
      response.destroy = () => {};
      receive(response);
      if (result.bodyError) response.emit('error', result.bodyError);
      else {
        const body = result.raw === undefined ? JSON.stringify(result.body || {}) : result.raw;
        response.emit('data', Buffer.from(body));
        response.emit('end');
      }
      request.emit('close');
    }));
    return request;
  });
  return calls;
}

function send(record = source(), options = {}) {
  return sendRemoteAnalysis(record, { remoteUrl: URL, connectionCode: CODE,
    dataDir: 'C:/owned-fixture/not-read', subtitleQuality: 'fast', subtitleLanguage: 'original', ...options });
}

for (const method of ['check', 'send']) {
  for (const code of NETWORK_CODES) test(`${method}: a typed ${code} before POST carries exact not-submitted proof`, async t => {
    const calls = fakeHttp(t, () => ({ error: Object.assign(new Error('Owned synthetic preflight transport failure'), { code }) }));
    await assert.rejects(method === 'check' ? checkRemoteServer({ remoteUrl: URL, connectionCode: CODE }) : send(), error => {
      assert.equal(error.code, code);
      assert.deepEqual(error.analysisTransport, PROOF);
      assert.equal(error.remoteJob, undefined);
      return true;
    });
    assert.deepEqual(calls, [{ method: 'GET', path: '/v1/status' }]);
  });

  test(`${method}: a failed LAN name lookup is proven before any HTTP request`, async t => {
    const calls = fakeHttp(t, () => { throw new Error('HTTP must not run after failed DNS'); });
    t.mock.method(dns, 'lookup', async () => { throw Object.assign(new Error('Owned synthetic DNS failure'), { code: 'ENOTFOUND' }); });
    const remoteUrl = 'http://owned-preflight.local:31999';
    await assert.rejects(method === 'check' ? checkRemoteServer({ remoteUrl, connectionCode: CODE }) : send(source(), { remoteUrl }), error => {
      assert.deepEqual(error.analysisTransport, PROOF); return true;
    });
    assert.deepEqual(calls, []);
  });

  for (const [field, value] of [['providerErrorType', 'authentication'], ['executionSource', 'provider-error'], ['refusalSource', 'execution-error']]) {
    test(`${method}: even non-enumerable ${field} blocks preflight proof`, async t => {
      const error = Object.assign(new Error('Owned synthetic execution failure'), { code: 'ECONNRESET' });
      Object.defineProperty(error, field, { value, enumerable: false });
      fakeHttp(t, () => ({ error }));
      await assert.rejects(method === 'check' ? checkRemoteServer({ remoteUrl: URL, connectionCode: CODE }) : send(), failure => {
        assert.equal(failure.analysisTransport, undefined); return true;
      });
    });
  }

  for (const status of [401, 403, 429, 503]) test(`${method}: HTTP ${status} is never an automatic preflight submission proof`, async t => {
    const calls = fakeHttp(t, () => ({ status, body: { error: 'Owned synthetic service failure', code: 'ECONNRESET' } }));
    await assert.rejects(method === 'check' ? checkRemoteServer({ remoteUrl: URL, connectionCode: CODE }) : send(), error => {
      assert.equal(error.statusCode, status);
      assert.equal(error.analysisTransport, undefined);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  test(`${method}: an interrupted authentication response retains its HTTP stop`, async t => {
    fakeHttp(t, () => ({ status: 401, bodyError: Object.assign(new Error('Owned dropped authentication response'), { code: 'ECONNRESET' }) }));
    await assert.rejects(method === 'check' ? checkRemoteServer({ remoteUrl: URL, connectionCode: CODE }) : send(), error => {
      assert.equal(error.code, 'ECONNRESET'); assert.equal(error.statusCode, 401);
      assert.equal(error.analysisTransport, undefined); return true;
    });
  });

  test(`${method}: malformed status JSON and not-ready status never invent network proof`, async t => {
    for (const result of [{ raw: '{' }, { body: { ready: false, protocol: 1 } }]) await t.test(JSON.stringify(result), async t => {
      fakeHttp(t, () => result);
      await assert.rejects(method === 'check' ? checkRemoteServer({ remoteUrl: URL, connectionCode: CODE }) : send(), error => {
        assert.equal(error.analysisTransport, undefined); return true;
      });
    });
  });

  test(`${method}: user cancellation is never automatically replayable`, async t => {
    const calls = fakeHttp(t, () => { throw new Error('HTTP must not run after abort'); });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(method === 'check' ? checkRemoteServer({ remoteUrl: URL, connectionCode: CODE, signal: controller.signal })
      : send(source(), { signal: controller.signal }), error => {
      assert.equal(error.name, 'AbortError'); assert.equal(error.analysisTransport, undefined); return true;
    });
    assert.deepEqual(calls, []);
  });
}

test('an upload error cannot inherit stale preflight proof or be POSTed twice', async t => {
  const calls = fakeHttp(t, options => options.method === 'GET' ? { body: HOST }
    : { error: Object.assign(new Error('Owned ambiguous upload acceptance'), { code: 'ECONNRESET', analysisTransport: { ...PROOF } }) });
  const record = { ...source(), transcript: [{ id: 'owned-cue', start: 1, end: 3, text: '次の列車です。' }] };
  await assert.rejects(send(record, { operation: 'translation-only' }), error => {
    assert.equal(error.code, 'LAN_UPLOAD_INTERRUPTED'); assert.equal(error.systemCode, 'ECONNRESET');
    assert.equal(error.lanTransferPhase, 'upload'); assert.equal(error.lanSubmissionState, 'unconfirmed');
    assert.equal(error.lanServerReady, true); assert.equal(error.analysisTransport, undefined);
    assert.equal(error.remoteJob, undefined); return true;
  });
  assert.deepEqual(calls, [{ method: 'GET', path: '/v1/status' }, { method: 'POST', path: '/v1/jobs' },
    { method: 'GET', path: '/v1/status' }], 'the fresh healthy read permits only another independent file, never another POST');
});

test('an accepted-job status failure cannot become not-submitted preflight proof', async t => {
  const jobId = 'b'.repeat(32);
  const calls = fakeHttp(t, options => {
    if (options.path === '/v1/status') return { body: HOST };
    if (options.method === 'POST') return { body: { id: jobId, status: 'running' } };
    return { status: 503, body: { error: 'Owned service unavailable' } };
  });
  const record = { ...source(), transcript: [{ id: 'owned-cue', start: 1, end: 3, text: '次の列車です。' }] };
  await assert.rejects(send(record, { operation: 'translation-only' }), error => {
    assert.equal(error.statusCode, 503); assert.equal(error.analysisTransport, undefined);
    assert.equal(error.remoteJob.serverJobId, jobId); return true;
  });
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('a successful direct send removes stale transport proof from both source and returned result', async t => {
  const jobId = 'b'.repeat(32), cue = { id: 'owned-cue', start: 1, end: 3, text: '次の列車です。' };
  const record = { ...source(), transcript: [cue], transcriptLanguage: 'ja', analysisTransport: { ...PROOF } };
  const calls = fakeHttp(t, options => options.path === '/v1/status' ? { body: HOST } : { body: {
    id: jobId, status: 'completed', result: { ...record, id: jobId, analysisTransport: undefined, status: 'completed',
      subtitleLanguage: 'ko', subtitleTranslation: [{ ...cue, text: '다음 열차입니다.' }] }
  } });
  const result = await send(record, { operation: 'translation-only' });
  assert.equal(record.analysisTransport, undefined); assert.equal(result.analysisTransport, undefined);
  assert.equal(result.subtitleTranslation[0].text, '다음 열차입니다.');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

function engineFixture({ error, result, mode = 'remote' } = {}) {
  const record = { ...source(), analysisTransport: { ...PROOF } };
  const engine = createCatalogEngine({
    extractionImpl: { analyzeVideo: async () => record, getToolsStatus: async () => ({}) },
    providerImpl: { analyzeExtracted: async () => result || record, translateKoreanOnly: async () => result || record },
    lanImpl: { checkRemoteServer: async () => { if (error) throw error; return HOST; },
      sendRemoteAnalysis: async () => result || record, resumeRemoteAnalysis: async () => { if (error) throw error; return result || record; } }
  });
  return { engine, record, options: { mode, remoteUrl: URL, connectionCode: CODE, subtitleQuality: 'fast', subtitleLanguage: 'original' },
    context: { dataDir: 'C:/owned-fixture/not-read' }, file: { id: record.id, path: record.path, name: record.name } };
}

test('catalog retains only validated transport proof and discards cached stale proof', async () => {
  const error = Object.assign(new Error('Owned preflight network failure'), { code: 'EHOSTUNREACH', analysisTransport: { ...PROOF } });
  const f = engineFixture({ error });
  const record = await f.engine.analyzeVideo(f.file, f.options, f.context);
  assert.deepEqual(record.analysisTransport, PROOF);
  assert.notEqual(record.analysisTransport, error.analysisTransport);
  assert.equal(record.analysisDiagnostic.code, 'NETWORK_UNREACHABLE');
});

for (const [label, extra] of [
  ['missing proof', { analysisTransport: undefined }],
  ['unknown failure', { code: 'UNKNOWN' }],
  ['extra proof field', { analysisTransport: { ...PROOF, private: 'PRIVATE_PAYLOAD' } }],
  ['wrong phase', { analysisTransport: { ...PROOF, phase: 'upload' } }],
  ['already submitted', { analysisTransport: { ...PROOF, submission: 'accepted' } }],
  ['HTTP authentication', { statusCode: 401 }],
  ['provider refusal', { refusalSource: 'execution-error' }],
  ['provider network error', { executionSource: 'provider-error' }],
  ['typed cause', { cause: { code: 'PROVIDER_AUTH' } }],
  ['typed diagnostic', { diagnostic: { code: 'PROVIDER_QUOTA' } }],
  ['accepted receipt', { remoteJob: { serverJobId: 'b'.repeat(32) } }]
]) test(`catalog rejects ${label} as preflight retry proof`, async () => {
  const error = Object.assign(new Error('Owned synthetic failure'), { code: 'EHOSTUNREACH', analysisTransport: { ...PROOF }, ...extra });
  const f = engineFixture({ error });
  const record = await f.engine.analyzeVideo(f.file, f.options, f.context);
  assert.equal(record.analysisTransport, undefined);
});

for (const mode of ['local', 'codex', 'remote']) test(`successful ${mode} analysis clears cached and returned stale transport proof`, async () => {
  const result = { ...source(), status: 'completed', analysisTransport: { ...PROOF } };
  const f = engineFixture({ result, mode });
  const record = await f.engine.analyzeVideo(f.file, f.options, f.context);
  assert.equal(record.analysisTransport, undefined); assert.equal(f.record.analysisTransport, undefined);
});

for (const mode of ['codex', 'remote']) test(`successful ${mode} translation clears stale transport proof`, async () => {
  const result = { ...source(), status: 'completed', analysisTransport: { ...PROOF } };
  const f = engineFixture({ result, mode });
  const record = await f.engine.translateSubtitles(f.record, f.options, f.context);
  assert.equal(record.analysisTransport, undefined); assert.equal(f.record.analysisTransport, undefined);
});

test('accepted-result resume explicitly strips any old not-submitted marker on failure', async () => {
  const error = Object.assign(new Error('Owned synthetic accepted-job read failure'), { code: 'ECONNRESET', analysisTransport: { ...PROOF } });
  const f = engineFixture({ error });
  const record = await f.engine.resumeRemoteAnalysis(f.record, f.options, { operation: 'analysis' }, f.context);
  assert.equal(record.analysisTransport, undefined); assert.equal(error.analysisTransport, undefined);
});

test('direct translation preflight rejects with typed proof for the service catch without keeping stale input proof', async t => {
  const f = engineFixture();
  const real = createCatalogEngine({ lanImpl: { sendRemoteAnalysis } });
  const calls = fakeHttp(t, () => ({ error: Object.assign(new Error('Owned synthetic translation preflight failure'), { code: 'ECONNREFUSED' }) }));
  await assert.rejects(real.translateSubtitles(f.record, f.options, f.context), error => {
    assert.deepEqual(error.analysisTransport, PROOF); return true;
  });
  assert.equal(f.record.analysisTransport, undefined);
  assert.deepEqual(calls, [{ method: 'GET', path: '/v1/status' }]);
});
