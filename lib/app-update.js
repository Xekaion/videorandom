const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const MANIFEST_URL = 'https://raw.githubusercontent.com/Xekaion/videorandom/main/update.json';
const ASSET_PREFIX = 'https://raw.githubusercontent.com/Xekaion/videorandom/v';
const ASSET_SUFFIX = '/videorandom.exe';
const MAX_ASSET_BYTES = 180 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16384;
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const MESSAGES = {
  UPDATE_VERSION: '프로그램 버전 정보가 올바르지 않습니다.',
  UPDATE_MANIFEST: '업데이트 정보가 올바르지 않습니다. 잠시 뒤 다시 확인해 주세요.',
  UPDATE_URL: '허용되지 않은 업데이트 주소입니다.',
  UPDATE_NETWORK: '업데이트 서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.',
  UPDATE_HTTP: '업데이트 서버가 파일을 제공하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
  UPDATE_REDIRECT: '업데이트 주소 이동을 확인하지 못했습니다.',
  UPDATE_TIMEOUT: '업데이트 다운로드 시간이 초과되었습니다. 다시 시도해 주세요.',
  UPDATE_SIZE: '업데이트 파일 크기가 일치하지 않아 적용하지 않았습니다.',
  UPDATE_HASH: '업데이트 파일 검증에 실패하여 적용하지 않았습니다.',
  UPDATE_BINARY: 'Windows 실행 파일 형식이 올바르지 않아 적용하지 않았습니다.',
  UPDATE_IO: '업데이트 파일을 저장하지 못했습니다. 저장 공간과 폴더 권한을 확인해 주세요.',
  UPDATE_NONE: '현재 최신 버전을 사용하고 있습니다.'
};

function updateError(code) {
  const error = new Error(MESSAGES[code] || MESSAGES.UPDATE_NETWORK);
  error.code = code;
  return error;
}

function versionParts(value) {
  if (typeof value !== 'string' || !VERSION.test(value)) throw updateError('UPDATE_VERSION');
  return value.split('.').map(Number);
}

function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function assetUrlForVersion(version) {
  versionParts(version);
  return ASSET_PREFIX + version + ASSET_SUFFIX;
}

// Exact URLs also reject alternate ports, credentials, query strings, encoded
// traversal and another repository on the otherwise trusted GitHub host.
function validateUpdateUrl(value, kind) {
  if (kind === 'manifest' && value === MANIFEST_URL) return value;
  if (kind === 'asset' && typeof value === 'string' && value.startsWith(ASSET_PREFIX) && value.endsWith(ASSET_SUFFIX)) {
    const version = value.slice(ASSET_PREFIX.length, -ASSET_SUFFIX.length);
    try { if (assetUrlForVersion(version) === value) return value; } catch (_) {}
  }
  throw updateError('UPDATE_URL');
}

function hasOnlyKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validateManifest(value) {
  if (!hasOnlyKeys(value, ['schemaVersion', 'updateProtocol', 'version', 'asset']) || value.schemaVersion !== 1 || value.updateProtocol !== 1
    || !hasOnlyKeys(value.asset, ['url', 'sha256', 'sizeBytes'])) throw updateError('UPDATE_MANIFEST');
  try { versionParts(value.version); } catch (_) { throw updateError('UPDATE_MANIFEST'); }
  validateUpdateUrl(value.asset.url, 'asset');
  if (value.asset.url !== assetUrlForVersion(value.version)) throw updateError('UPDATE_URL');
  if (typeof value.asset.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value.asset.sha256)
    || !Number.isSafeInteger(value.asset.sizeBytes) || value.asset.sizeBytes < 1
    || value.asset.sizeBytes > MAX_ASSET_BYTES) throw updateError('UPDATE_MANIFEST');
  return Object.freeze({ schemaVersion: 1, updateProtocol: 1, version: value.version,
    asset: Object.freeze({ url: assetUrlForVersion(value.version), sha256: value.asset.sha256.toLowerCase(), sizeBytes: value.asset.sizeBytes }) });
}

function abortError() { return updateError('UPDATE_TIMEOUT'); }

// request is injectable so redirect, transport and timeout behavior can be
// tested without opening a socket. Never delegate redirect following to fetch.
async function openTrustedResponse(url, { kind, signal, request = https.get, redirects = 0 } = {}) {
  validateUpdateUrl(url, kind);
  if (signal?.aborted) throw abortError();
  const response = await new Promise((resolve, reject) => {
    let req, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => { req?.destroy(); finish(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // The mutable manifest can remain stale at different GitHub CDN edges.
      // Only transport adds this nonce after exact canonical-URL validation;
      // caller URLs, redirect targets and immutable assets stay strictly pinned.
      const requestUrl = kind === 'manifest' ? url + '?check=' + crypto.randomBytes(16).toString('hex') : url;
      const headers = { 'User-Agent': 'VideoRandom-Updater', Accept: kind === 'manifest' ? 'application/json' : 'application/octet-stream', 'Accept-Encoding': 'identity' };
      if (kind === 'manifest') {
        headers['Cache-Control'] = 'no-cache, no-store, max-age=0';
        headers.Pragma = 'no-cache';
      }
      req = request(requestUrl, { headers }, value => finish(null, value));
      req.on('error', () => finish(signal?.aborted ? abortError() : updateError('UPDATE_NETWORK')));
      req.setTimeout?.(30000, () => { req.destroy(); finish(updateError('UPDATE_TIMEOUT')); });
    } catch (_) { finish(updateError('UPDATE_NETWORK')); }
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.destroy?.();
    if (redirects >= 3) throw updateError('UPDATE_REDIRECT');
    validateUpdateUrl(response.headers?.location, kind);
    if (response.headers.location !== url) throw updateError('UPDATE_URL');
    return openTrustedResponse(response.headers.location, { kind, signal, request, redirects: redirects + 1 });
  }
  if (response.statusCode !== 200) {
    response.destroy?.();
    throw updateError('UPDATE_HTTP');
  }
  if (response.headers?.['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
    response.destroy?.();
    throw updateError('UPDATE_HTTP');
  }
  return response;
}

async function* downloadUpdateAsset({ url, maxBytes = MAX_ASSET_BYTES, signal, request } = {}) {
  const response = await openTrustedResponse(url, { kind: 'asset', signal, request });
  const advertised = response.headers?.['content-length'];
  if (advertised !== undefined && (!/^\d+$/.test(String(advertised)) || Number(advertised) !== maxBytes)) {
    response.destroy?.();
    throw updateError('UPDATE_SIZE');
  }
  const onAbort = () => response.destroy?.(abortError());
  signal?.addEventListener('abort', onAbort, { once: true });
  let received = 0;
  try {
    for await (const chunk of response) {
      if (signal?.aborted) throw abortError();
      received += chunk.length;
      if (received > maxBytes) { response.destroy?.(); throw updateError('UPDATE_SIZE'); }
      yield chunk;
    }
  } catch (error) {
    if (error.code?.startsWith('UPDATE_')) throw error;
    throw signal?.aborted ? abortError() : updateError('UPDATE_NETWORK');
  } finally { signal?.removeEventListener('abort', onAbort); }
}

async function fetchUpdateManifest({ url = MANIFEST_URL, maxBytes = MAX_MANIFEST_BYTES, signal, request } = {}) {
  const response = await openTrustedResponse(url, { kind: 'manifest', signal, request });
  const advertised = response.headers?.['content-length'];
  if (advertised !== undefined && (!/^\d+$/.test(String(advertised)) || Number(advertised) > maxBytes)) {
    response.destroy?.();
    throw updateError('UPDATE_MANIFEST');
  }
  const chunks = [];
  let received = 0;
  const onAbort = () => response.destroy?.(abortError());
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of response) {
      if (signal?.aborted) throw abortError();
      const bytes = Buffer.from(chunk);
      received += bytes.length;
      if (received > maxBytes) { response.destroy?.(); throw updateError('UPDATE_MANIFEST'); }
      chunks.push(bytes);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch (_) { throw updateError('UPDATE_MANIFEST'); }
  } catch (error) {
    if (error.code?.startsWith('UPDATE_')) throw error;
    throw signal?.aborted ? abortError() : updateError('UPDATE_NETWORK');
  } finally { signal?.removeEventListener('abort', onAbort); }
}

function createAppUpdateService({ currentVersion, dataDir, fetchManifest = fetchUpdateManifest,
  downloadAsset = downloadUpdateAsset, fs: io = fs, now = () => new Date(),
  timeoutMs = 10 * 60 * 1000, manifestTimeoutMs = 30000 } = {}) {
  versionParts(currentVersion);
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw updateError('UPDATE_IO');
  if (typeof fetchManifest !== 'function' || typeof downloadAsset !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60 * 1000
    || !Number.isSafeInteger(manifestTimeoutMs) || manifestTimeoutMs < 1 || manifestTimeoutMs > 30000) throw updateError('UPDATE_MANIFEST');
  const directory = path.join(path.resolve(dataDir), 'app-updates');
  let manifest = null, staged = null, operation = null, operationKind = null;
  let state = { status: 'idle', currentVersion, latestVersion: null, updateAvailable: false,
    downloadedBytes: 0, totalBytes: 0, checkedAt: null, readyAt: null,
    error: '', errorCode: '', stagedVersion: null };
  const getState = () => ({ ...state });
  const getStagedUpdate = () => state.status === 'ready' && staged ? { ...staged } : null;
  const timestamp = () => new Date(now()).toISOString();
  function fail(error) {
    const known = updateError(MESSAGES[error?.code] ? error.code : 'UPDATE_IO');
    state = { ...state, status: 'error', error: known.message, errorCode: known.code };
    throw known;
  }
  async function readManifest(signal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), manifestTimeoutMs);
    timer.unref?.();
    let checked;
    try {
      checked = validateManifest(await fetchManifest({ url: MANIFEST_URL, maxBytes: MAX_MANIFEST_BYTES, signal: controller.signal }));
      if (controller.signal.aborted) throw abortError();
    } catch (error) {
      if (controller.signal.aborted) throw abortError();
      if (error.code?.startsWith('UPDATE_')) throw error;
      throw updateError('UPDATE_NETWORK');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    manifest = checked;
    const updateAvailable = compareVersions(currentVersion, checked.version) < 0;
    state = { ...state, latestVersion: checked.version, updateAvailable, checkedAt: timestamp(),
      totalBytes: checked.asset.sizeBytes, error: '', errorCode: '' };
    return checked;
  }
  function run(kind, action) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    operationKind = kind;
    operation = Promise.resolve().then(() => action(controller.signal))
      .catch(error => fail(controller.signal.aborted ? abortError() : error))
      .finally(() => { clearTimeout(timeout); operation = null; operationKind = null; });
    return operation;
  }
  function check() {
    if (operation) return operation;
    return run('check', async signal => {
      state = { ...state, status: 'checking', error: '', errorCode: '' };
      const checked = await readManifest(signal);
      state.status = staged?.version === checked.version && staged.sha256 === checked.asset.sha256
        ? 'ready' : state.updateAvailable ? 'available' : 'current';
      return getState();
    });
  }
  function stage() {
    if (operation) return operationKind === 'stage' ? operation : operation.then(() => stage());
    return run('stage', async signal => {
      if (!manifest) await readManifest(signal);
      if (compareVersions(currentVersion, manifest.version) >= 0) throw updateError('UPDATE_NONE');
      if (staged?.version === manifest.version && staged.sha256 === manifest.asset.sha256) {
        state = { ...state, status: 'ready', error: '', errorCode: '' };
        return getState();
      }
      const selected = manifest;
      const targetDirectory = path.join(directory, selected.version + '-' + selected.asset.sha256.slice(0, 16));
      const targetPath = path.join(targetDirectory, 'videorandom.exe');
      const temporary = path.join(targetDirectory, '.download-' + crypto.randomBytes(12).toString('hex') + '.tmp');
      let handle = null;
      state = { ...state, status: 'downloading', downloadedBytes: 0, totalBytes: selected.asset.sizeBytes,
        error: '', errorCode: '', readyAt: null, stagedVersion: null };
      try {
        await io.mkdir(targetDirectory, { recursive: true, mode: 0o700 });
        handle = await io.open(temporary, 'wx', 0o600);
        const hash = crypto.createHash('sha256');
        let signature = Buffer.alloc(0);
        const stream = await downloadAsset({ url: selected.asset.url, maxBytes: selected.asset.sizeBytes, signal });
        if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw updateError('UPDATE_NETWORK');
        for await (const item of stream) {
          if (signal.aborted) throw abortError();
          if (!Buffer.isBuffer(item) && !(item instanceof Uint8Array)) throw updateError('UPDATE_NETWORK');
          const chunk = Buffer.from(item);
          if (state.downloadedBytes + chunk.length > selected.asset.sizeBytes) throw updateError('UPDATE_SIZE');
          if (signature.length < 2) signature = Buffer.concat([signature, chunk.subarray(0, 2 - signature.length)]);
          await handle.writeFile(chunk);
          hash.update(chunk);
          state.downloadedBytes += chunk.length;
        }
        if (signal.aborted) throw abortError();
        if (state.downloadedBytes !== selected.asset.sizeBytes) throw updateError('UPDATE_SIZE');
        if (hash.digest('hex') !== selected.asset.sha256) throw updateError('UPDATE_HASH');
        if (signature.toString('ascii') !== 'MZ') throw updateError('UPDATE_BINARY');
        await handle.sync();
        await handle.close();
        handle = null;
        if (signal.aborted) throw abortError();
        await io.rename(temporary, targetPath);
        staged = { version: selected.version, path: targetPath, sha256: selected.asset.sha256, sizeBytes: selected.asset.sizeBytes };
        state = { ...state, status: 'ready', stagedVersion: selected.version, readyAt: timestamp(), error: '', errorCode: '' };
        return getState();
      } finally {
        if (handle) await handle.close().catch(() => {});
        await io.unlink(temporary).catch(() => {});
      }
    });
  }
  return { getState, getStagedUpdate, check, stage, directory };
}

module.exports = { createAppUpdateService, compareVersions, assetUrlForVersion, validateManifest, validateUpdateUrl,
  openTrustedResponse, fetchUpdateManifest, downloadUpdateAsset,
  MANIFEST_URL, MAX_ASSET_BYTES, MAX_MANIFEST_BYTES };
