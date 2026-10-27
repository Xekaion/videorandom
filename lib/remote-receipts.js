const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const RECORD_ID = /^[a-f0-9]{32}$/;
const HEX_ID = /^[a-f0-9]{16,64}$/;
const FILENAME = /^[a-f0-9]{64}\.json$/;
const MAX_BYTES = 64 * 1024 * 1024;
const CAPABILITIES = new Set(['timed-subtitles-v1', 'subtitle-quality-v1', 'subtitle-quality-v2', 'subtitle-quality-v3',
  'subtitle-translation-only-v1', 'managed-update-v1', 'diagnostics-v1', 'original-frame-fingerprints-v1', 'turbo-subtitles-v1', 'sparse-subtitles-v1']);
const SYSTEM_CODES = new Set(['ENOENT', 'ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'EMFILE', 'ENFILE', 'ENOTDIR', 'EISDIR',
  'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EEXIST', 'ENAMETOOLONG', 'EINVAL', 'EBUSY']);
const SECRET_KEY = /^(?:connection|connectionCode|remoteConnectionCode|apiKey|api_key|token|accessToken|refreshToken|authorization|password|secret|credentials)$/i;

function failure(code, error) {
  const result = Object.assign(new Error(code === 'LAN_RECEIPT_READ_FAILED'
    ? '접수된 분석 서버 작업의 보관 기록을 읽지 못했습니다. 기록 파일은 유지했습니다.'
    : '접수된 분석 서버 작업의 연결 기록을 저장하지 못했습니다. 서버 작업을 새로 요청하지 않았습니다.'), { code });
  const systemCode = SYSTEM_CODES.has(error?.systemCode) ? error.systemCode : SYSTEM_CODES.has(error?.code) ? error.code : undefined;
  if (systemCode) result.systemCode = systemCode;
  return result;
}

function invalid() { throw new Error('Invalid remote receipt'); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function recordId(value) { if (typeof value !== 'string' || !RECORD_ID.test(value)) invalid(); return value; }
function filename(id) { return crypto.createHash('sha256').update(recordId(id)).digest('hex') + '.json'; }
function clone(value) { return JSON.parse(JSON.stringify(value, (key, value) => SECRET_KEY.test(key) ? undefined : value)); }

function normalizeReceipt(input) {
  if (!object(input) || input.schemaVersion !== 1 || !RECORD_ID.test(input.serverJobId || '')
    || !RECORD_ID.test(input.recordId || '') || !/^[a-f0-9]{64}$/.test(input.sourceIdentity || '')
    || !['analysis', 'translation-only'].includes(input.operation)
    || typeof input.acceptedAt !== 'string' || input.acceptedAt.length > 40 || !Number.isFinite(Date.parse(input.acceptedAt))
    || typeof input.serverOrigin !== 'string' || input.serverOrigin.length > 2048) invalid();
  let origin;
  try { origin = new URL(input.serverOrigin); } catch (_) { invalid(); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.origin !== input.serverOrigin) invalid();
  return { schemaVersion: 1, serverJobId: input.serverJobId, serverOrigin: origin.origin, recordId: input.recordId,
    sourceIdentity: input.sourceIdentity, operation: input.operation, acceptedAt: input.acceptedAt,
    serverVersion: typeof input.serverVersion === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(input.serverVersion) ? input.serverVersion : null,
    capabilities: Array.isArray(input.capabilities) ? [...new Set(input.capabilities.filter(value => CAPABILITIES.has(value)))] : [] };
}

function normalizeContext(input) {
  const context = {};
  if (!object(input)) return context;
  if (Number.isSafeInteger(input.sourceFileSize) && input.sourceFileSize >= 0) context.sourceFileSize = input.sourceFileSize;
  if (Number.isFinite(input.sourceFileMtimeMs) && input.sourceFileMtimeMs >= 0) context.sourceFileMtimeMs = input.sourceFileMtimeMs;
  if (['fast', 'accurate', 'turbo'].includes(input.subtitleQuality)) context.subtitleQuality = input.subtitleQuality;
  if (['auto', 'ja', 'zh'].includes(input.transcriptLanguage)) context.transcriptLanguage = input.transcriptLanguage;
  if (['original', 'ko'].includes(input.subtitleLanguage)) context.subtitleLanguage = input.subtitleLanguage;
  if (input.sourceReanalysis === true) context.sourceReanalysis = true;
  for (const key of ['clientJobId', 'repairOf']) if (typeof input[key] === 'string' && HEX_ID.test(input[key])) context[key] = input[key];
  if (['accepted', 'waiting', 'blocked'].includes(input.state)) context.state = input.state;
  if (typeof input.blockedCode === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(input.blockedCode)) context.blockedCode = input.blockedCode;
  return context;
}

function normalizeEntry(receipt, sourceRecord, context) {
  const safeReceipt = normalizeReceipt(receipt);
  if (!object(sourceRecord) || sourceRecord.id !== safeReceipt.recordId) invalid();
  const source = clone(sourceRecord);
  if (!object(source) || source.id !== safeReceipt.recordId) invalid();
  return { receipt: safeReceipt, sourceRecord: source, context: normalizeContext(context) };
}

function createRemoteReceiptStore({ dataDir, fs: io = fs } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim() || dataDir.includes('\0')) throw new TypeError('Receipt data directory is required');
  const directory = path.join(path.resolve(dataDir), 'remote-receipts');
  let writes = Promise.resolve();
  const ready = Promise.resolve().then(() => io.mkdir(directory, { recursive: true })).catch(error => { throw failure('LAN_RECEIPT_SAVE_FAILED', error); });

  function enqueue(operation) {
    const next = writes.then(async () => { await ready; return operation(); });
    writes = next.catch(() => {});
    return next;
  }

  async function read(name, expectedId) {
    const target = path.join(directory, name);
    try {
      if (typeof io.lstat === 'function') {
        const info = await io.lstat(target);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) invalid();
      }
      const text = await io.readFile(target, 'utf8');
      if (Buffer.byteLength(text) > MAX_BYTES) invalid();
      const saved = JSON.parse(text);
      if (!object(saved) || saved.schemaVersion !== 1) invalid();
      const entry = normalizeEntry(saved.receipt, saved.sourceRecord, saved.context);
      if (filename(entry.receipt.recordId) !== name || expectedId !== undefined && entry.receipt.recordId !== expectedId) invalid();
      return entry;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw failure('LAN_RECEIPT_READ_FAILED', error);
    }
  }

  async function get(id) {
    let name;
    try { name = filename(id); } catch (error) { throw failure('LAN_RECEIPT_READ_FAILED', error); }
    await ready;
    await writes;
    return read(name, id);
  }

  async function list() {
    await ready;
    await writes;
    let names;
    try { names = await io.readdir(directory); } catch (error) { throw failure('LAN_RECEIPT_READ_FAILED', error); }
    const pending = [];
    // All surviving receipts are accepted jobs whose result has not been saved.
    // A blocked context remains visible, but grants no authority to retry it.
    for (const name of names.filter(name => typeof name === 'string' && FILENAME.test(name)).sort()) {
      const entry = await read(name);
      if (entry) pending.push(entry);
    }
    return pending;
  }

  function save(receipt, sourceRecord, context = {}) {
    let entry, text, name;
    try {
      entry = normalizeEntry(receipt, sourceRecord, context);
      name = filename(entry.receipt.recordId);
      text = JSON.stringify({ schemaVersion: 1, ...entry });
      if (Buffer.byteLength(text) > MAX_BYTES) invalid();
    } catch (error) { return Promise.reject(failure('LAN_RECEIPT_SAVE_FAILED', error)); }
    return enqueue(async () => {
      const target = path.join(directory, name);
      const temporary = target + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
      let handle, temporaryOwned = false;
      try {
        handle = await io.open(temporary, 'wx', 0o600);
        temporaryOwned = true;
        await handle.writeFile(text, 'utf8');
        if (typeof handle.sync === 'function') await handle.sync();
        await handle.close();
        handle = null;
        await io.rename(temporary, target);
        return clone(entry);
      } catch (error) { throw failure('LAN_RECEIPT_SAVE_FAILED', error); }
      finally {
        if (handle) await handle.close().catch(() => {});
        if (temporaryOwned) await io.unlink(temporary).catch(() => {});
      }
    });
  }

  function remove(id) {
    let name;
    try { name = filename(id); } catch (error) { return Promise.reject(failure('LAN_RECEIPT_SAVE_FAILED', error)); }
    return enqueue(async () => {
      try { await io.unlink(path.join(directory, name)); return true; }
      catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw failure('LAN_RECEIPT_SAVE_FAILED', error);
      }
    });
  }

  return { ready, list, get, save, remove };
}

module.exports = { createRemoteReceiptStore };
