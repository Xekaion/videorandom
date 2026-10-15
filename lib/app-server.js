const http = require('http');

function identifyRunningApp(port, { timeoutMs = 1000 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => { request.destroy(); finish(null); }, timeoutMs);
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/app-info', timeout: timeoutMs }, response => {
      if (response.statusCode !== 200) { request.destroy(); finish(null); return; }
      let body = '';
      response.on('data', chunk => {
        body += chunk.toString('utf8');
        if (body.length > 32768) { request.destroy(); finish(null); }
      });
      response.on('error', () => finish(null));
      response.on('end', () => {
        try {
          const value = JSON.parse(body);
          finish(value.application === 'videorandom' && typeof value.version === 'string' ? value : null);
        } catch { finish(null); }
      });
    });
    request.on('timeout', () => { request.destroy(); finish(null); });
    request.on('error', () => finish(null));
  });
}

function listen(app, port, host) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    const failed = error => { server.removeListener('listening', started); reject(error); };
    const started = () => { server.removeListener('error', failed); resolve(server); };
    server.once('error', failed);
    server.once('listening', started);
    server.listen(port, host);
  });
}

async function startLocalServer(app, {
  port = 3000, host = '127.0.0.1', version, dataStoreId,
  fallbackPorts, identify = identifyRunningApp
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('프로그램 포트가 올바르지 않습니다.');
  fallbackPorts = fallbackPorts || Array.from({ length: 30 }, (_, index) => (port === 3000 ? 3002 : port + 1) + index).filter(candidate => candidate !== 3001 && candidate <= 65535);
  const candidates = [...new Set([port, ...fallbackPorts])];
  const conflicts = [];
  for (const candidate of candidates) {
    if (!Number.isInteger(candidate) || candidate < 0 || candidate > 65535) continue;
    try {
      const server = await listen(app, candidate, host);
      return { server, port: server.address().port, requestedPort: port, portConflict: conflicts.length > 0, conflicts, reused: false };
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      const existing = await identify(candidate);
      if (existing && version && existing.version === version && Array.isArray(existing.features) && existing.features.includes('history')
          && (!dataStoreId || !existing.dataStoreId || existing.dataStoreId === dataStoreId)) {
        return { server: null, port: candidate, requestedPort: port, portConflict: conflicts.length > 0, conflicts, reused: true };
      }
      conflicts.push({ port: candidate, version: existing ? existing.version : null,
        ...(typeof existing?.dataStoreId === 'string' && /^[a-f0-9]{64}$/.test(existing.dataStoreId) ? { dataStoreId: existing.dataStoreId } : {}) });
    }
  }
  throw new Error('사용할 수 있는 로컬 포트가 없습니다. 실행 중인 VideoRandom 창을 종료하고 다시 실행해 주세요.');
}

function startExistingAnalysisHost(port) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => { request.destroy(); finish(new Error('실행 중인 프로그램의 분석 서버 시작 시간이 초과되었습니다.')); }, 30000);
    const request = http.request({ hostname: '127.0.0.1', port, path: '/api/analysis/host/start', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '2' } }, response => {
      let body = '';
      response.on('data', chunk => {
        body += chunk.toString('utf8');
        if (body.length > 32768) { request.destroy(); finish(new Error('분석 서버 시작 응답을 읽지 못했습니다.')); }
      });
      response.on('error', error => finish(error));
      response.on('end', () => {
        try {
          const value = JSON.parse(body);
          if (response.statusCode !== 200 || !value.running || !Array.isArray(value.addresses)) throw new Error(value.error || '실행 중인 프로그램에서 분석 서버를 시작하지 못했습니다.');
          finish(null, value);
        } catch (error) { finish(error); }
      });
    });
    request.on('error', error => finish(error));
    request.end('{}');
  });
}

module.exports = { startLocalServer, identifyRunningApp, startExistingAnalysisHost };
