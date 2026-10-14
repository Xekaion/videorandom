const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startLocalServer, identifyRunningApp, startExistingAnalysisHost } = require('../lib/app-server');

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}
function close(server) { return new Promise(resolve => server.close(resolve)); }

test('old occupied server opens the new app on another port without replacing it', async () => {
  const old = await serve((req, res) => { res.statusCode = 404; res.end('old app'); });
  let current;
  try {
    const port = old.address().port;
    current = await startLocalServer((req, res) => res.end('new app'), { port, version: '1.3.0', fallbackPorts: [0] });
    assert.equal(current.portConflict, true);
    assert.equal(current.reused, false);
    assert.notEqual(current.port, port);
    assert.equal(await (await fetch(`http://127.0.0.1:${current.port}`)).text(), 'new app');
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'old app');
  } finally { if (current && current.server) await close(current.server); await close(old); }
});

test('launching the same current version reuses its server', async () => {
  const existing = await serve((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ application: 'videorandom', version: '1.3.0', features: ['history', 'catalog'] }));
  });
  try {
    const result = await startLocalServer(() => assert.fail('Must reuse the existing app'), { port: existing.address().port, version: '1.3.0', fallbackPorts: [] });
    assert.equal(result.reused, true);
    assert.equal(result.server, null);
    assert.equal(result.portConflict, false);
  } finally { await close(existing); }
});

test('an older version with an app-info endpoint is not reused', async () => {
  const old = await serve((req, res) => res.end(JSON.stringify({ application: 'videorandom', version: '1.2.0', features: ['catalog'] })));
  let current;
  try {
    current = await startLocalServer((req, res) => res.end('new'), { port: old.address().port, version: '1.3.0', fallbackPorts: [0] });
    assert.equal(current.reused, false);
    assert.equal(current.conflicts[0].version, '1.2.0');
  } finally { if (current && current.server) await close(current.server); await close(old); }
});

test('busy unrelated services are bounded and produce a clear startup error', async () => {
  const existing = await serve((req, res) => res.end('not JSON'));
  try {
    await assert.rejects(startLocalServer(() => {}, { port: existing.address().port, fallbackPorts: [] }), /종료하고 다시 실행/);
    assert.equal(await identifyRunningApp(existing.address().port), null);
  } finally { await close(existing); }
});

test('a continuously streaming unrelated service cannot stall startup', async () => {
  const existing = await serve((req, res) => {
    res.writeHead(200);
    const timer = setInterval(() => res.write('x'), 5);
    res.on('close', () => clearInterval(timer));
  });
  try {
    assert.equal(await identifyRunningApp(existing.address().port, { timeoutMs: 30 }), null);
  } finally { await close(existing); }
});

test('host launcher activates the analysis server when reusing an existing app', async () => {
  let started = false;
  const existing = await serve((req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/analysis/host/start');
    started = true;
    res.end(JSON.stringify({ running: true, addresses: ['http://192.168.0.2:3001'] }));
  });
  try {
    const result = await startExistingAnalysisHost(existing.address().port);
    assert.equal(started, true);
    assert.equal(result.running, true);
  } finally { await close(existing); }
});
