const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const TYPES = ['pick', 'play', 'legacy_pick', 'windows_recent'];
const SOURCES = { pick: 'VideoRandom', play: 'VideoRandom', legacy_pick: '기존 브라우저 기록', windows_recent: 'Windows 최근 영상' };
const SAFE_ID = /^[A-Za-z0-9_-]{16,128}$/;

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function text(value, maximum, label, optional = false) {
  if (optional && (value === undefined || value === null)) return '';
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || (!optional && !value.trim())) throw invalid(`${label}이 올바르지 않습니다.`);
  return value;
}

function date(value, label, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw invalid(`${label}이 올바르지 않습니다.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw invalid(`${label}이 올바르지 않습니다.`);
  return parsed.toISOString();
}

function normalizeVideo(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('영상 정보가 필요합니다.');
  const filePath = text(input.path, 32767, '영상 경로');
  const fullWindowsPath = /^[A-Za-z]:[\\/]/.test(filePath) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(filePath);
  if (!fullWindowsPath && !(process.platform !== 'win32' && path.isAbsolute(filePath))) throw invalid('영상 경로는 전체 경로로 입력해 주세요.');
  const fallbackName = path.win32.basename(filePath.replace(/\//g, '\\'));
  const name = text(input.name === undefined ? fallbackName : input.name, 8192, '영상 이름');
  const fallbackExt = path.win32.extname(fallbackName).slice(1).toUpperCase();
  const ext = input.ext === undefined ? fallbackExt : text(input.ext, 16, '영상 확장자', true).replace(/^\./, '').toUpperCase();
  if (ext && !/^[A-Z0-9]{1,16}$/.test(ext)) throw invalid('영상 확장자가 올바르지 않습니다.');
  const size = input.size === undefined ? 0 : input.size;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0 || size > 1e12) throw invalid('영상 크기가 올바르지 않습니다.');
  return { name, path: filePath, size, ext };
}

function normalizeEntry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.id !== 'string' || !SAFE_ID.test(input.id) || !TYPES.includes(input.type)) throw invalid('히스토리 항목이 올바르지 않습니다.');
  const legacy = input.type === 'legacy_pick' || input.type === 'windows_recent';
  const entry = { id: input.id, type: input.type, ...normalizeVideo(input), occurredAt: legacy ? null : date(input.occurredAt, '기록 시각'), source: SOURCES[input.type] };
  if (legacy) entry.importedAt = date(input.importedAt, '가져온 시각');
  if (input.type === 'legacy_pick') entry.legacyTime = text(input.legacyTime, 128, '기존 기록 시각', true);
  if (input.type === 'windows_recent') entry.observedAt = date(input.observedAt, 'Windows 기록 시각', true);
  return entry;
}

function stableId(type, parts) {
  return crypto.createHash('sha256').update(JSON.stringify([type, ...parts])).digest('hex');
}

function csvCell(value) {
  let output = value === null || value === undefined ? '' : String(value);
  // Quoting alone does not stop Excel from executing a formula on CSV import.
  if (/^\s*[=+@-]/.test(output) || /^[\t\r\n]/.test(output)) output = "'" + output;
  return '"' + output.replace(/"/g, '""') + '"';
}

function createHistoryService({ dataDir } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('히스토리 저장 폴더가 필요합니다.');
  const directory = path.join(dataDir, 'history');
  const logPath = path.join(directory, 'events.jsonl');
  const router = express.Router();
  const entries = [];
  const ids = new Set();
  const byId = new Map();
  const warnings = [];
  let needsSeparator = false;
  let writeQueue = Promise.resolve();
  let writeFailed = false;

  async function updateSeparator() {
    let handle;
    try {
      handle = await fsp.open(logPath, 'r');
      const stat = await handle.stat();
      if (!stat.size) { needsSeparator = false; return; }
      const lastByte = Buffer.alloc(1);
      await handle.read(lastByte, 0, 1, stat.size - 1);
      needsSeparator = lastByte[0] !== 10;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      needsSeparator = false;
    } finally { if (handle) await handle.close(); }
  }

  const ready = (async () => {
    await fsp.mkdir(directory, { recursive: true });
    try { await fsp.access(logPath); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    let malformed = 0;
    const lines = readline.createInterface({ input: fs.createReadStream(logPath, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = normalizeEntry(JSON.parse(line));
        if (!ids.has(entry.id)) { entries.push(entry); ids.add(entry.id); byId.set(entry.id, entry); }
      } catch (_) { malformed++; }
    }
    if (malformed) warnings.push(`읽을 수 없는 히스토리 ${malformed}개를 건너뛰었습니다. 원본 로그는 그대로 보관됩니다.`);
    await updateSeparator();
  })();

  function persist(candidates, initiallySkipped = 0) {
    const operation = writeQueue.then(async () => {
      await ready;
      const pendingIds = new Set();
      const additions = [];
      let skipped = initiallySkipped;
      for (const entry of candidates) {
        if (ids.has(entry.id) || pendingIds.has(entry.id)) { skipped++; continue; }
        additions.push(entry);
        pendingIds.add(entry.id);
      }
      if (additions.length) {
        const contents = (needsSeparator ? '\n' : '') + additions.map(entry => JSON.stringify(entry)).join('\n') + '\n';
        try { await fsp.appendFile(logPath, contents, 'utf8'); }
        catch (error) { await updateSeparator().catch(() => {}); throw error; }
        needsSeparator = false;
        for (const entry of additions) { entries.push(entry); ids.add(entry.id); byId.set(entry.id, entry); }
      }
      return { imported: additions.length, skipped };
    });
    writeQueue = operation.then(() => { writeFailed = false; }, () => { writeFailed = true; });
    return operation;
  }

  async function recordPick(video, { clientEventId, occurredAt } = {}) {
    const id = clientEventId === undefined ? crypto.randomUUID() : text(clientEventId, 128, '기록 ID');
    if (!SAFE_ID.test(id)) throw invalid('기록 ID가 올바르지 않습니다.');
    const entry = { id, type: 'pick', ...normalizeVideo(video), occurredAt: occurredAt === undefined ? new Date().toISOString() : date(occurredAt, '뽑은 시각'), source: SOURCES.pick };
    const result = await persist([entry]);
    return { ...result, entry: byId.get(id) };
  }

  async function recordPlayback(video) {
    const entry = { id: crypto.randomUUID(), type: 'play', ...normalizeVideo(video), occurredAt: new Date().toISOString(), source: SOURCES.play };
    await persist([entry]);
    return entry;
  }

  async function persistImport(additions, invalidCount) {
    const result = await persist(additions, invalidCount);
    return invalidCount ? { ...result, warnings: [`형식이 올바르지 않은 기록 ${invalidCount}개를 가져오지 못했습니다. 원본 기록을 확인해 주세요.`] } : result;
  }

  async function importLegacy({ sourceId, entries: input } = {}) {
    sourceId = text(sourceId, 128, '브라우저 ID');
    if (!Array.isArray(input) || input.length > 10000) throw invalid('기존 히스토리 목록이 올바르지 않습니다.');
    const importedAt = new Date().toISOString();
    const additions = [];
    let skipped = 0;
    // Legacy data is newest first; persist oldest first for the normal display order.
    for (const item of [...input].reverse()) {
      try {
        const video = normalizeVideo(item);
        const legacyTime = text(item.time, 128, '기존 기록 시각', true);
        additions.push({ id: stableId('legacy_pick', [sourceId, video, legacyTime]), type: 'legacy_pick', ...video, occurredAt: null, legacyTime, importedAt, source: SOURCES.legacy_pick });
      } catch (_) { skipped++; }
    }
    return persistImport(additions, skipped);
  }

  async function importWindowsRecent(input) {
    if (!Array.isArray(input)) throw invalid('Windows 최근 영상 목록이 올바르지 않습니다.');
    const importedAt = new Date().toISOString();
    const additions = [];
    let skipped = 0;
    // The Windows collector supplies newest shortcuts first.
    for (const item of [...input].reverse()) {
      try {
        const video = normalizeVideo(item);
        const observedAt = date(item.observedAt, 'Windows 기록 시각', true);
        additions.push({ id: stableId('windows_recent', [video.path.toLowerCase(), observedAt]), type: 'windows_recent', ...video, occurredAt: null, observedAt, importedAt, source: SOURCES.windows_recent });
      } catch (_) { skipped++; }
    }
    return persistImport(additions, skipped);
  }

  async function importJson(input) {
    if (!input || input.schemaVersion !== 1 || !Array.isArray(input.entries)) throw invalid('VideoRandom 히스토리 백업 파일이 필요합니다.');
    const additions = [];
    let skipped = 0;
    // Our backup is newest first.
    for (const entry of [...input.entries].reverse()) {
      try { additions.push(normalizeEntry(entry)); } catch (_) { skipped++; }
    }
    return persistImport(additions, skipped);
  }

  function select(params = {}) {
    const query = params.query === undefined ? '' : text(params.query, 2048, '검색어', true).toLowerCase();
    const type = params.type === undefined || params.type === '' || params.type === 'all' ? '' : params.type;
    if (type && !TYPES.includes(type)) throw invalid('히스토리 종류가 올바르지 않습니다.');
    const selected = entries.filter(entry => (!type || entry.type === type) && (!query || [entry.name, entry.path, entry.ext, entry.source, entry.legacyTime].some(value => (value || '').toLowerCase().includes(query)))).reverse();
    // A queued pick can arrive much later than its actual timestamp. Imported
    // legacy entries use their import time only for ordering, never as a date.
    return selected.sort((a, b) => (b.occurredAt || b.observedAt || b.importedAt || '').localeCompare(a.occurredAt || a.observedAt || a.importedAt || ''));
  }

  async function list(params = {}) {
    await ready;
    const matched = select(params);
    const positive = (value, fallback, maximum, label) => {
      if (value === undefined || value === '') return fallback;
      if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > maximum) throw invalid(`${label}이 올바르지 않습니다.`);
      return Number(value);
    };
    const pageSize = positive(params.pageSize, 50, 100, '페이지 크기');
    const pages = Math.max(1, Math.ceil(matched.length / pageSize));
    const page = Math.min(pages, positive(params.page, 1, Number.MAX_SAFE_INTEGER, '페이지 번호'));
    const counts = Object.fromEntries(TYPES.map(type => [type, 0]));
    for (const entry of entries) counts[entry.type]++;
    return { entries: matched.slice((page - 1) * pageSize, page * pageSize), total: matched.length, page, pageSize, pages, allTotal: entries.length, counts, warnings: [...warnings] };
  }

  router.use(async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try { await ready; next(); } catch (error) { res.status(500).json({ error: '히스토리 저장 폴더에 접근할 수 없습니다: ' + error.message }); }
  });
  const handler = action => async (req, res) => {
    try { await action(req, res); }
    catch (error) {
      if (res.headersSent) { res.destroy(error); return; }
      res.status(error.status || 500).json({ error: error.status ? error.message : '히스토리를 저장하거나 읽지 못했습니다: ' + error.message });
    }
  };
  router.get('/', handler(async (req, res) => res.json(await list(req.query))));
  router.post('/picks', handler(async (req, res) => res.json(await recordPick(req.body && req.body.video, req.body || {}))));
  router.post('/import-legacy', handler(async (req, res) => res.json(await importLegacy(req.body))));
  router.post('/import-json', handler(async (req, res) => res.json(await importJson(req.body))));

  async function write(res, content) {
    if (res.destroyed) throw new Error('다운로드 연결이 종료되었습니다.');
    if (!res.write(content)) await new Promise((resolve, reject) => {
      const cleanup = () => { res.off('drain', onDrain); res.off('close', onClose); res.off('error', onError); };
      const onDrain = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new Error('다운로드 연결이 종료되었습니다.')); };
      const onError = error => { cleanup(); reject(error); };
      res.once('drain', onDrain);
      res.once('close', onClose);
      res.once('error', onError);
    });
  }
  router.get('/export.csv', handler(async (req, res) => {
    const selected = select(req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="videorandom-history.csv"');
    await write(res, '\uFEFF' + ['파일명', '전체 경로', '기록 종류', '날짜', '시각', '크기(MB)', '확장자', '기록 출처', 'Windows 흔적 시각', '가져온 시각'].map(csvCell).join(',') + '\r\n');
    for (const entry of selected) {
      const parts = entry.occurredAt ? entry.occurredAt.split('T') : [];
      await write(res, [entry.name, entry.path, entry.type, parts[0] || '', parts[1] || entry.legacyTime || '', entry.size, entry.ext, entry.source, entry.observedAt || '', entry.importedAt || ''].map(csvCell).join(',') + '\r\n');
    }
    res.end();
  }));
  router.get('/export.json', handler(async (req, res) => {
    const selected = select(req.query);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="videorandom-history.json"');
    await write(res, '{"schemaVersion":1,"entries":[');
    for (let i = 0; i < selected.length; i++) await write(res, (i ? ',' : '') + JSON.stringify(selected[i]));
    await write(res, ']}');
    res.end();
  }));

  async function flush() {
    await ready;
    await writeQueue;
    if (writeFailed) throw new Error('히스토리 저장을 확인하지 못해 업데이트를 적용할 수 없습니다.');
  }
  return { router, ready, logPath, list, recordPick, recordPlayback, importLegacy, importWindowsRecent, importJson, flush };
}

module.exports = { createHistoryService };
