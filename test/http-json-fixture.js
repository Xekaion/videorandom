const http = require('node:http');

// OS-assigned test ports may be in fetch's browser-style forbidden-port list.
// Native HTTP keeps synthetic local fixtures independent of that unrelated rule.
function httpJsonFixture(base, endpoint, body, method = body === undefined ? 'GET' : 'POST') {
  const target = new URL(endpoint.replace(/^\//, ''), base.replace(/\/?$/, '/'));
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(target, { method, agent: false, headers: { 'Content-Type': 'application/json',
      ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }) } }, response => {
      let contents = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { contents += chunk; });
      response.on('error', reject);
      response.on('end', () => { try { resolve({ status: response.statusCode, data: JSON.parse(contents) }); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    request.setTimeout(15000, () => request.destroy(new Error('Owned fixture HTTP request timed out')));
    request.end(payload);
  });
}

function httpFixtureResponse(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body);
    const request = http.request(url, { method, agent: false, headers: { ...headers,
      ...(payload ? { 'Content-Length': payload.length } : {}) } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve(new Response([204, 205, 304].includes(response.statusCode) ? null : Buffer.concat(chunks),
        { status: response.statusCode, headers: response.headers })));
    });
    request.on('error', reject);
    request.setTimeout(15000, () => request.destroy(new Error('Owned fixture HTTP request timed out')));
    request.end(payload);
  });
}

module.exports = { httpJsonFixture, httpFixtureResponse };
