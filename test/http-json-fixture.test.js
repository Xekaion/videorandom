const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { httpJsonFixture } = require('./http-json-fixture');

test('owned HTTP fixtures work even if Windows allocates a browser-forbidden ephemeral port', async t => {
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ path: request.url, body: JSON.parse(body) })); });
  });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(6667, '127.0.0.1', resolve); }); }
  catch (error) { if (error.code === 'EADDRINUSE') { t.skip('The regression fixture port is already occupied'); return; } throw error; }
  try {
    await assert.rejects(fetch('http://127.0.0.1:6667/owned-fixture'), error => error.cause?.message === 'bad port');
    const result = await httpJsonFixture('http://127.0.0.1:6667/api/analysis', '/owned-fixture', { text: '합성 테스트' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { path: '/api/analysis/owned-fixture', body: { text: '합성 테스트' } });
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }); }
});
