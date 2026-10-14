const express = require('express');
const multer = require('multer');
const FormData = require('form-data');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const dns = require('dns').promises;
const { Transform, pipeline } = require('stream');

const MB = 1024 * 1024;
const MAX_IMAGE = 5 * MB;
const MAX_AUDIO = 250 * MB;
const MAX_METADATA = 2 * MB;
const MAX_UPLOAD = MAX_AUDIO + 20 * MAX_IMAGE + MAX_METADATA + MB;
const SAFE_FRAME = /^[a-zA-Z0-9_-]{1,90}\.jpe?g$/i;
const SAFE_ID = /^[a-f0-9]{32}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function safeFrameFilename(value) {
  return typeof value === 'string' && SAFE_FRAME.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(value);
}

function privateAddress(input) {
  let address = String(input || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (address.startsWith('::ffff:')) address = address.slice(7);
  if (net.isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    return octets[0] === 127 || octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 169 && octets[1] === 254);
  }
  if (net.isIP(address) === 6) return address === '::1' || ((parseInt(address.split(':')[0], 16) & 0xfe00) === 0xfc00);
  return false;
}

function abortError() {
  const error = new Error('분석을 중지했습니다.');
  error.name = 'AbortError';
  return error;
}

function textValue(value, limit, label, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > limit || value.includes('\u0000')) throw new Error(`${label} 형식이 올바르지 않습니다.`);
  return value;
}

function validateMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('영상 정보가 올바르지 않습니다.');
  const allowed = new Set(['name', 'ext', 'sizeMB', 'duration', 'transcript', 'transcriptSource', 'frames', 'transcribeAudio', 'hasAudio']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('지원하지 않는 영상 정보가 포함되어 있습니다.');
  const name = textValue(input.name, 255, '파일명');
  if (!name || /[\\/\x00-\x1f]/.test(name)) throw new Error('파일명이 올바르지 않습니다.');
  const ext = textValue(input.ext, 16, '확장자');
  if (!/^[a-zA-Z0-9]{1,16}$/.test(ext)) throw new Error('확장자가 올바르지 않습니다.');
  if (typeof input.duration !== 'number' || !Number.isFinite(input.duration) || input.duration < 0 || input.duration > 7 * 86400) throw new Error('영상 길이가 올바르지 않습니다.');
  if (input.sizeMB !== undefined && (typeof input.sizeMB !== 'number' || !Number.isFinite(input.sizeMB) || input.sizeMB < 0)) throw new Error('영상 크기가 올바르지 않습니다.');
  if (input.transcribeAudio !== undefined && typeof input.transcribeAudio !== 'boolean') throw new Error('음성 인식 설정이 올바르지 않습니다.');
  if (input.hasAudio !== undefined && typeof input.hasAudio !== 'boolean') throw new Error('음성 정보가 올바르지 않습니다.');
  if (!Array.isArray(input.frames) || input.frames.length < 1 || input.frames.length > 20) throw new Error('대표 이미지는 1~20장 필요합니다.');
  const filenames = new Set();
  const frames = input.frames.map(frame => {
    if (!frame || typeof frame !== 'object' || !safeFrameFilename(frame.filename) || filenames.has(frame.filename.toLowerCase())
      || typeof frame.timestamp !== 'number' || !Number.isFinite(frame.timestamp) || frame.timestamp < 0 || frame.timestamp > input.duration + 1
      || Object.keys(frame).some(key => !['timestamp', 'filename'].includes(key))) throw new Error('대표 이미지 정보가 올바르지 않습니다.');
    filenames.add(frame.filename.toLowerCase());
    return { filename: frame.filename, timestamp: frame.timestamp, caption: '' };
  });
  const source = input.transcript === undefined ? [] : input.transcript;
  if (!Array.isArray(source) || source.length > 50000) throw new Error('대사 기록이 너무 크거나 올바르지 않습니다.');
  const transcript = source.map(segment => {
    if (!segment || typeof segment !== 'object' || typeof segment.start !== 'number' || typeof segment.end !== 'number'
      || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end < segment.start || segment.end > input.duration + 60
      || Object.keys(segment).some(key => !['start', 'end', 'text'].includes(key))) throw new Error('대사 시간 정보가 올바르지 않습니다.');
    return { start: segment.start, end: segment.end, text: textValue(segment.text, 10000, '대사') };
  });
  return { name, ext: ext.toUpperCase(), size: input.sizeMB || 0, duration: input.duration, transcript,
    transcriptSource: textValue(input.transcriptSource, 200, '대사 출처', 'none'), frames, transcribeAudio: input.transcribeAudio === true, hasAudio: input.hasAudio === true };
}

// Never expose paths or provider credentials from the host in the transport result.
function publicRecord(record, original) {
  const result = {};
  for (const key of ['id', 'path', 'name', 'ext', 'size', 'duration', 'hasAudio', 'analyzedAt', 'summary', 'plot', 'dialogueSummary', 'status', 'transcriptSource']) {
    if (original[key] !== undefined) result[key] = original[key];
  }
  for (const key of ['summary', 'plot', 'dialogueSummary', 'status', 'analyzedAt', 'error', 'transcriptSource']) {
    if (typeof record[key] === 'string') result[key] = record[key].slice(0, 100000);
  }
  result.labels = Array.isArray(record.labels) ? record.labels.filter(x => typeof x === 'string').slice(0, 50).map(x => x.slice(0, 100)) : [];
  result.warnings = Array.isArray(record.warnings) ? record.warnings.filter(x => typeof x === 'string').slice(0, 100).map(x => x.slice(0, 2000)) : [];
  let transcriptBytes = 0;
  result.transcript = Array.isArray(record.transcript) ? record.transcript.slice(0, 50000).filter(s => {
    if (!s || !Number.isFinite(s.start) || !Number.isFinite(s.end) || typeof s.text !== 'string') return false;
    transcriptBytes += Buffer.byteLength(s.text.slice(0, 10000));
    return transcriptBytes <= 4 * MB;
  }).map(s => ({ start: s.start, end: s.end, text: s.text.slice(0, 10000) })) : original.transcript;
  if (transcriptBytes > 4 * MB) {
    result.warnings.push('대사 기록이 응답 크기 제한을 초과해 일부만 전달되었습니다.');
    result.status = 'partial';
  }
  result.frames = original.frames.map(frame => ({ ...frame, caption: String(record.frames?.find(f => f.filename === frame.filename)?.caption || '').slice(0, 2000) }));
  return result;
}

function createLanAnalysis({ dataDir, processPackage } = {}) {
  if (typeof dataDir !== 'string' || typeof processPackage !== 'function') throw new Error('분석 서버 설정이 필요합니다.');
  const app = express();
  app.disable('x-powered-by');
  const jobs = new Map();
  const queue = [];
  const sockets = new Set();
  const uploading = new Set();
  let server = null;
  let connectionCode = '';
  let activeJob = null;
  let reserved = 0;
  let stopping = false;
  let startPromise = null;
  let stopPromise = null;

  function status() {
    return { running: Boolean(server?.listening) && !stopping, port: server?.address()?.port || null,
      connectionCode: stopping ? '' : connectionCode, active: activeJob ? 1 : 0, queued: queue.length };
  }

  function snapshot(job) {
    return { id: job.id, status: job.status, stage: job.stage, percent: job.percent,
      createdAt: job.createdAt, finishedAt: job.finishedAt || null, error: job.error || '', result: job.result || null };
  }

  async function cleanupAudio(job) {
    if (job.audioPath) await fsp.rm(job.audioPath, { force: true }).catch(() => {});
  }

  function prune() {
    for (const [id, job] of jobs) {
      if (jobs.size < 100) break;
      if (TERMINAL.has(job.status)) {
        jobs.delete(id);
        fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  function runNext() {
    if (activeJob || stopping || !server?.listening) return;
    const job = queue.shift();
    if (!job) return;
    activeJob = job;
    job.status = 'running';
    job.stage = '이 PC에서 분석 중';
    job.task = (async () => {
      try {
        const result = await processPackage({ record: job.record, framesDir: job.framesDir, audioPath: job.audioPath, transcribeAudio: job.transcribeAudio }, {
          signal: job.controller.signal,
          onProgress(stage, percent) {
            job.stage = String(stage || '').slice(0, 200);
            job.percent = Math.max(0, Math.min(100, Number(percent) || 0));
          }
        });
        if (job.controller.signal.aborted) throw abortError();
        job.result = publicRecord(result || {}, { ...job.record, id: job.id, path: 'remote-upload://' + job.id, frames: job.originalFrames });
        job.status = 'completed';
        job.stage = '분석 완료';
        job.percent = 100;
      } catch (error) {
        job.status = job.controller.signal.aborted ? 'cancelled' : 'failed';
        job.error = job.controller.signal.aborted ? '분석을 중지했습니다.' : String(error.message || error).slice(0, 2000);
        job.stage = job.status === 'cancelled' ? '분석 중지됨' : '분석 실패';
      } finally {
        await cleanupAudio(job);
        job.finishedAt = new Date().toISOString();
        if (activeJob === job) activeJob = null;
        setImmediate(runNext);
      }
    })();
  }

  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!privateAddress(req.socket.remoteAddress)) return res.status(403).json({ error: '같은 사설 네트워크의 PC만 연결할 수 있습니다.' });
    if (Object.keys(req.query).length) return res.status(400).json({ error: '연결 코드는 Authorization 헤더로 보내 주세요.' });
    const received = /^Bearer ([a-zA-Z0-9_-]{24,128})$/.exec(req.headers.authorization || '')?.[1] || '';
    const supplied = Buffer.from(received);
    const expected = Buffer.from(connectionCode);
    if (!connectionCode || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return res.status(401).json({ error: '분석 서버 연결 코드가 올바르지 않습니다.' });
    if (stopping) return res.status(503).json({ error: '분석 서버가 종료 중입니다.' });
    next();
  });

  app.get('/v1/status', (req, res) => res.json({ ready: true, protocol: 1, active: activeJob ? 1 : 0, queued: queue.length }));

  const storage = {
    _handleFile(req, file, callback) {
      const isImage = file.fieldname === 'frames';
      const destination = isImage ? req.uploadFramesDir : req.uploadDir;
      const filename = isImage ? file.originalname : 'audio.mp3';
      const target = path.join(destination, filename);
      let size = 0;
      let signature = Buffer.alloc(0);
      const validator = new Transform({
        transform(chunk, encoding, done) {
          size += chunk.length;
          if (size > (isImage ? MAX_IMAGE : MAX_AUDIO)) return done(new Error(isImage ? '이미지 한 장은 5MB 이하여야 합니다.' : '음성은 250MB 이하여야 합니다.'));
          if (signature.length < 3) signature = Buffer.concat([signature, chunk]).subarray(0, 3);
          if (signature.length === 3) {
            const valid = isImage ? signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff
              : signature.toString('ascii') === 'ID3' || (signature[0] === 0xff && (signature[1] & 0xe0) === 0xe0);
            if (!valid) return done(new Error(isImage ? 'JPEG 이미지만 전송할 수 있습니다.' : 'MP3 음성만 전송할 수 있습니다.'));
          }
          done(null, chunk);
        },
        flush(done) { done(signature.length < 3 ? new Error('빈 파일은 전송할 수 없습니다.') : null); }
      });
      pipeline(file.stream, validator, fs.createWriteStream(target, { flags: 'wx' }), error => {
        if (error) fsp.rm(target, { force: true }).catch(() => {});
        callback(error, error ? undefined : { destination, filename, path: target, size });
      });
    },
    _removeFile(req, file, callback) { fs.unlink(file.path, error => callback(error?.code === 'ENOENT' ? null : error)); }
  };
  const upload = multer({ storage, preservePath: true,
    limits: { files: 21, fields: 1, parts: 22, fieldSize: MAX_METADATA, fileSize: MAX_AUDIO, fieldNameSize: 100 },
    fileFilter(req, file, callback) {
      const image = file.fieldname === 'frames' && safeFrameFilename(file.originalname) && file.mimetype === 'image/jpeg';
      const audio = file.fieldname === 'audio' && file.originalname === 'audio.mp3' && file.mimetype === 'audio/mpeg';
      const key = file.fieldname + ':' + file.originalname.toLowerCase();
      if ((!image && !audio) || req.uploadNames.has(key)) return callback(new Error('파일명, 파일 종류 또는 중복 파일이 올바르지 않습니다.'));
      req.uploadNames.add(key);
      callback(null, true);
    }
  }).fields([{ name: 'frames', maxCount: 20 }, { name: 'audio', maxCount: 1 }]);

  app.post('/v1/jobs', async (req, res) => {
    if (queue.length + (activeJob ? 1 : 0) + reserved >= 20) return res.status(429).json({ error: '분석 대기열이 가득 찼습니다. 잠시 후 다시 시도해 주세요.' });
    const length = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(length) || length <= 0) return res.status(411).json({ error: '전송할 파일 크기 정보가 필요합니다.' });
    if (length > MAX_UPLOAD) return res.status(413).json({ error: '전송할 분석 자료가 너무 큽니다.' });
    reserved++;
    uploading.add(req);
    const id = crypto.randomBytes(16).toString('hex');
    const dir = path.resolve(dataDir, 'remote', 'jobs', id);
    req.uploadDir = dir;
    req.uploadFramesDir = path.join(dir, 'frames');
    req.uploadNames = new Set();
    let accepted = false;
    try {
      await fsp.mkdir(req.uploadFramesDir, { recursive: true });
      if (stopping || req.aborted) throw abortError();
      await new Promise((resolve, reject) => upload(req, res, error => error ? reject(error) : resolve()));
      if (stopping || req.aborted) throw abortError();
      if (typeof req.body?.metadata !== 'string' || Object.keys(req.body).length !== 1) throw new Error('영상 정보가 필요합니다.');
      const metadata = validateMetadata(JSON.parse(req.body.metadata));
      const files = req.files?.frames || [];
      if (files.length !== metadata.frames.length || metadata.frames.some(frame => !files.some(file => file.filename === frame.filename))) throw new Error('대표 이미지 목록과 전송된 파일이 일치하지 않습니다.');
      const audioPath = req.files?.audio?.[0]?.path || null;
      if (metadata.transcribeAudio && !audioPath) throw new Error('전체 대사 인식을 위한 음성 파일이 필요합니다.');
      if (!metadata.transcribeAudio && audioPath) throw new Error('음성 인식 설정 없이 음성 파일을 전송할 수 없습니다.');
      const { transcribeAudio, ...baseRecord } = metadata;
      const record = { ...baseRecord, hasAudio: Boolean(audioPath), id, path: 'remote-upload://' + id, summary: '', plot: '', dialogueSummary: '', labels: [], warnings: [], status: 'pending', analyzedAt: new Date().toISOString() };
      const job = { id, dir, record, originalFrames: metadata.frames.map(frame => ({ ...frame })), framesDir: req.uploadFramesDir, audioPath, transcribeAudio, controller: new AbortController(),
        status: 'queued', stage: '이 PC의 분석 순서 대기', percent: 0, createdAt: new Date().toISOString() };
      prune();
      if (jobs.size >= 100) throw new Error('저장할 수 있는 분석 작업 수를 초과했습니다.');
      jobs.set(id, job);
      queue.push(job);
      accepted = true;
      res.status(202).json(snapshot(job));
      setImmediate(runNext);
    } catch (error) {
      if (!res.headersSent && !req.aborted && !res.destroyed) res.status(error.code?.startsWith('LIMIT_') ? 413 : 400).json({ error: String(error.message || '분석 자료 전송 실패').slice(0, 2000) });
    } finally {
      reserved--;
      uploading.delete(req);
      if (!accepted) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  app.get('/v1/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: '분석 작업을 찾을 수 없습니다.' });
    res.json(snapshot(job));
  });

  app.post('/v1/jobs/:id/cancel', async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: '분석 작업을 찾을 수 없습니다.' });
    if (!TERMINAL.has(job.status)) {
      job.controller.abort();
      const index = queue.indexOf(job);
      if (index >= 0) {
        queue.splice(index, 1);
        job.status = 'cancelled';
        job.stage = '분석 중지됨';
        job.finishedAt = new Date().toISOString();
        await cleanupAudio(job);
      } else job.status = 'cancelling';
    }
    res.json(snapshot(job));
  });

  app.get('/v1/jobs/:id/frames/:filename', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || !SAFE_ID.test(req.params.id) || !safeFrameFilename(req.params.filename) || !job.originalFrames.some(frame => frame.filename === req.params.filename)) return res.status(404).json({ error: '대표 이미지를 찾을 수 없습니다.' });
    res.type('jpeg').sendFile(path.join(job.framesDir, req.params.filename), error => {
      if (error && !res.headersSent) res.status(404).json({ error: '대표 이미지 파일이 없습니다.' });
    });
  });

  async function start({ port = 3001, host = '0.0.0.0' } = {}) {
    if (stopPromise) await stopPromise;
    if (server?.listening) return status();
    if (startPromise) return startPromise;
    if (!Number.isInteger(port) || port < 0 || port > 65535 || !['0.0.0.0', '127.0.0.1', '::', '::1'].includes(host)) throw new Error('분석 서버 주소 또는 포트가 올바르지 않습니다.');
    stopping = false;
    connectionCode = crypto.randomBytes(24).toString('base64url');
    startPromise = (async () => {
      await fsp.mkdir(path.join(dataDir, 'remote', 'jobs'), { recursive: true });
      const candidate = http.createServer(app);
      candidate.requestTimeout = 10 * 60 * 1000;
      candidate.headersTimeout = 15000;
      candidate.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      try {
        await new Promise((resolve, reject) => { candidate.once('error', reject); candidate.listen(port, host, resolve); });
        server = candidate;
        setImmediate(runNext);
        return status();
      } catch (error) {
        connectionCode = '';
        candidate.close();
        throw error;
      }
    })();
    try { return await startPromise; } finally { startPromise = null; }
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (startPromise) await startPromise.catch(() => {});
      stopping = true;
      connectionCode = '';
      for (const job of queue.splice(0)) {
        job.controller.abort();
        job.status = 'cancelled';
        job.stage = '분석 서버 종료';
        job.finishedAt = new Date().toISOString();
        await cleanupAudio(job);
      }
      activeJob?.controller.abort();
      for (const req of uploading) req.destroy();
      const previous = server;
      server = null;
      if (previous) {
        const closed = new Promise(resolve => previous.close(resolve));
        for (const socket of sockets) socket.destroy();
        await closed;
      }
      // A provider receives the abort signal; stop does not hang on an uncooperative provider.
      if (activeJob?.task) await Promise.race([activeJob.task, new Promise(resolve => { const timer = setTimeout(resolve, 5000); timer.unref?.(); })]);
      for (const job of jobs.values()) await cleanupAudio(job);
      return status();
    })();
    try { return await stopPromise; } finally { stopPromise = null; }
  }

  return { app, start, stop, status };
}

function validateRemoteUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('분석 서버 주소가 올바르지 않습니다.'); }
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('분석 서버는 사설 네트워크의 http://주소:포트 형식으로 입력해 주세요.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname) && !privateAddress(hostname)) throw new Error('같은 사설 네트워크의 PC 주소를 입력해 주세요.');
  if (!net.isIP(hostname) && (!/^[a-zA-Z0-9.-]{1,253}$/.test(hostname) || (hostname.includes('.') && !/\.(local|lan)$/i.test(hostname)))) throw new Error('사설 IP 주소 또는 같은 네트워크의 PC 이름을 입력해 주세요.');
  return url;
}

async function resolveRemoteUrl(value) {
  const url = validateRemoteUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(entry => !privateAddress(entry.address))) throw new Error('공인 인터넷 주소에는 영상을 전송할 수 없습니다. 같은 사설 네트워크의 PC 주소를 입력해 주세요.');
  return { hostname: addresses[0].address, port: Number(url.port || 80), hostHeader: url.host };
}

async function checkRemoteServer({ remoteUrl, connectionCode, signal } = {}) {
  if (!/^[a-zA-Z0-9_-]{24,128}$/.test(connectionCode || '')) throw new Error('분석 PC에 표시된 연결 코드를 입력해 주세요.');
  const target = await resolveRemoteUrl(remoteUrl);
  const status = JSON.parse((await requestBuffer(target, '/v1/status', { headers: { Authorization: 'Bearer ' + connectionCode }, signal })).toString('utf8'));
  if (!status.ready || status.protocol !== 1) throw new Error('분석 PC의 서버를 먼저 켜 주세요.');
  return status;
}

function requestBuffer(target, endpoint, { method = 'GET', headers = {}, body, signal, maxBytes = 12 * MB, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const request = http.request({ hostname: target.hostname, port: target.port, path: endpoint, method, headers: { Host: target.hostHeader, ...headers } }, response => {
      let bytes = 0;
      const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { request.destroy(new Error('분석 서버 응답이 너무 큽니다.')); response.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          let message = `분석 서버 요청 실패 (${response.statusCode})`;
          try { message = JSON.parse(buffer.toString('utf8')).error || message; } catch {}
          return reject(new Error(String(message).slice(0, 2000)));
        }
        resolve(buffer);
      });
    });
    const abort = () => request.destroy(abortError());
    signal?.addEventListener('abort', abort, { once: true });
    request.on('close', () => signal?.removeEventListener('abort', abort));
    request.on('error', reject);
    request.setTimeout(timeout, () => request.destroy(new Error('분석 서버 연결 시간이 초과되었습니다.')));
    if (body?.pipe) { body.on('error', error => request.destroy(error)); body.pipe(request); }
    else request.end(body);
  });
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(abortError()); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function sendRemoteAnalysis(record, { remoteUrl, connectionCode, audioPath = null, dataDir, signal, onProgress = () => {} } = {}) {
  if (!/^[a-zA-Z0-9_-]{24,128}$/.test(connectionCode || '')) throw new Error('분석 PC에 표시된 연결 코드를 입력해 주세요.');
  if (!record || !SAFE_ID.test(record.id) || typeof dataDir !== 'string') throw new Error('전송할 영상 분석 결과가 올바르지 않습니다.');
  const target = await resolveRemoteUrl(remoteUrl);
  const auth = { Authorization: 'Bearer ' + connectionCode };
  const jsonRequest = async (endpoint, options = {}) => JSON.parse((await requestBuffer(target, endpoint, { headers: auth, signal, ...options })).toString('utf8'));
  onProgress('분석 PC 연결 확인', 30);
  const host = await jsonRequest('/v1/status');
  if (!host.ready || host.protocol !== 1) throw new Error('분석 PC의 서버를 먼저 켜 주세요.');
  const metadata = {
    name: record.name, ext: record.ext, sizeMB: record.size || 0, duration: record.duration,
    transcript: record.transcript || [], transcriptSource: record.transcriptSource || 'none',
    frames: (record.frames || []).map(frame => ({ timestamp: frame.timestamp, filename: frame.filename })), transcribeAudio: Boolean(audioPath), hasAudio: Boolean(audioPath)
  };
  validateMetadata(metadata);
  const serialized = JSON.stringify(metadata);
  if (Buffer.byteLength(serialized) > MAX_METADATA) throw new Error('대사 기록이 전송 크기 제한을 초과했습니다.');
  const form = new FormData();
  form.append('metadata', serialized);
  let jobId = null;
  let receivedResult = null;
  try {
    for (const frame of metadata.frames) {
      const source = path.resolve(dataDir, 'frames', record.id, frame.filename);
      const info = await fsp.stat(source);
      if (!info.isFile() || info.size > MAX_IMAGE) throw new Error('대표 이미지 파일이 없거나 5MB를 초과했습니다.');
      form.append('frames', fs.createReadStream(source), { filename: frame.filename, contentType: 'image/jpeg', knownLength: info.size });
    }
    if (audioPath) {
      const info = await fsp.stat(audioPath);
      if (!info.isFile() || info.size > MAX_AUDIO) throw new Error('전송할 음성은 250MB 이하여야 합니다.');
      form.append('audio', fs.createReadStream(audioPath), { filename: 'audio.mp3', contentType: 'audio/mpeg', knownLength: info.size });
    }
    const length = await new Promise((resolve, reject) => form.getLength((error, size) => error ? reject(error) : resolve(size)));
    if (length > MAX_UPLOAD) throw new Error('전송할 분석 자료가 너무 큽니다.');
    onProgress('음성과 대표 이미지를 분석 PC로 전송', 35);
    let job = await jsonRequest('/v1/jobs', { method: 'POST', body: form, timeout: 10 * 60 * 1000, headers: { ...auth, ...form.getHeaders(), 'Content-Length': String(length) } });
    if (!SAFE_ID.test(job.id)) throw new Error('분석 서버가 올바르지 않은 작업 정보를 반환했습니다.');
    jobId = job.id;
    while (!TERMINAL.has(job.status)) {
      onProgress(job.stage || '분석 PC에서 처리 중', 40 + Math.max(0, Math.min(100, Number(job.percent) || 0)) * 0.55);
      await pause(1000, signal);
      job = await jsonRequest('/v1/jobs/' + jobId);
    }
    if (job.status !== 'completed' || !job.result) throw new Error(job.error || '분석 PC에서 처리를 완료하지 못했습니다.');
    const result = publicRecord(job.result, { ...record, frames: metadata.frames });
    result.id = record.id;
    result.path = record.path;
    receivedResult = result;
    const destination = path.resolve(dataDir, 'frames', record.id);
    await fsp.mkdir(destination, { recursive: true });
    for (const frame of result.frames) {
      if (signal?.aborted) throw abortError();
      const buffer = await requestBuffer(target, `/v1/jobs/${jobId}/frames/${encodeURIComponent(frame.filename)}`, { headers: auth, signal, maxBytes: MAX_IMAGE });
      if (buffer.length < 3 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) throw new Error('분석 서버의 이미지 응답이 올바르지 않습니다.');
      await fsp.writeFile(path.join(destination, frame.filename), buffer);
    }
    onProgress('completed', 100);
    return result;
  } catch (error) {
    if (receivedResult) {
      // The text has already arrived. Preserve it even if the server is
      // disconnected during image retrieval, together with valid local JPEGs.
      const availableFrames = [];
      for (const frame of receivedResult.frames) {
        try {
          const bytes = await fsp.readFile(path.join(dataDir, 'frames', record.id, frame.filename));
          if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) availableFrames.push(frame);
        } catch (_) { /* Only list images that remain available on this PC. */ }
      }
      receivedResult.frames = availableFrames;
      receivedResult.status = 'partial';
      receivedResult.error = error.message;
      receivedResult.warnings = [...new Set([...(receivedResult.warnings || []), '서버 분석 내용은 받았지만 이미지 수신을 완료하지 못했습니다. 받은 줄거리·대사와 이 PC의 이미지는 보관했습니다.'])];
      error.record = receivedResult;
    }
    if (jobId && signal?.aborted) await requestBuffer(target, `/v1/jobs/${jobId}/cancel`, { method: 'POST', headers: auth, timeout: 5000 }).catch(() => {});
    throw error;
  } finally {
    form.destroy();
  }
}

module.exports = { createLanAnalysis, sendRemoteAnalysis, checkRemoteServer, privateAddress, validateRemoteUrl, resolveRemoteUrl, validateMetadata };
