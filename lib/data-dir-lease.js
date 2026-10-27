const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OWNER_NAME = /^owner-([1-9][0-9]*)-([a-f0-9]{32})\.json$/;
const DIRECTORY_CONTENTION = new Set(['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EBUSY', ...(process.platform === 'win32' ? ['EPERM'] : [])]);
const EMPTY_CLAIM_STALE_MS = 30000;

function dataStoreId(dataDir) {
  let resolved = path.resolve(dataDir);
  if (process.platform === 'win32') resolved = resolved.toLowerCase();
  return crypto.createHash('sha256').update(resolved).digest('hex');
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; return true; }
}

function busyError() {
  const error = new Error('같은 저장 폴더를 사용하는 VideoRandom이 실행 중입니다. 기존 프로그램을 종료한 뒤 새 버전을 다시 실행해 주세요.');
  error.code = 'VIDEORANDOM_DATA_BUSY';
  return error;
}

// Reclaim only exact dead filenames, then compete for a fresh directory.
// Never rename a dead inode into a live claim: on Windows, two pending
// source handles can both rename that inode and each report ownership.
function acquireDataDirLease(dataDir, { version = '' } = {}) {
  dataDir = path.resolve(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const lockDir = path.join(dataDir, '.app-owner');
  const nonce = crypto.randomBytes(16).toString('hex');
  const filename = `owner-${process.pid}-${nonce}.json`;
  const ownerPath = path.join(lockDir, filename);
  const preparedPath = path.join(dataDir, `.app-owner-${process.pid}-${nonce}.tmp`);
  const initialContents = JSON.stringify({ pid: process.pid, nonce, version, createdAt: new Date().toISOString() });
  let expectedContents = initialContents;
  let owned = false;

  function release() {
    if (!owned) return;
    owned = false;
    try {
      if (fs.readFileSync(ownerPath, 'utf8') !== expectedContents) return;
      fs.unlinkSync(ownerPath);
      try { fs.rmdirSync(lockDir); } catch (error) { if (!DIRECTORY_CONTENTION.has(error.code)) throw error; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  fs.writeFileSync(preparedPath, initialContents, { flag: 'wx', mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      let created = false;
      try { fs.mkdirSync(lockDir); created = true; }
      catch (error) { if (error.code !== 'EEXIST') { if (DIRECTORY_CONTENTION.has(error.code)) throw busyError(); throw error; } }
      if (created) {
        try {
          fs.renameSync(preparedPath, ownerPath);
          owned = true;
          const claims = fs.readdirSync(lockDir);
          if (claims.length !== 1 || claims[0] !== filename) throw busyError();
          return { dataStoreId: dataStoreId(dataDir), release };
        } catch (error) {
          if (owned) release();
          else { try { fs.rmdirSync(lockDir); } catch (_) {} }
          if (DIRECTORY_CONTENTION.has(error.code)) throw busyError();
          throw error;
        }
      }

      let names;
      try { names = fs.readdirSync(lockDir); } catch (error) { if (error.code === 'ENOENT') continue; if (DIRECTORY_CONTENTION.has(error.code)) throw busyError(); throw error; }
      if (!names.length) {
        // Another launcher may be between mkdir and atomic publication. Only
        // recover an empty directory left behind long enough to be orphaned.
        let stat;
        try { stat = fs.statSync(lockDir); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (Date.now() - stat.mtimeMs < EMPTY_CLAIM_STALE_MS) throw busyError();
        try { fs.rmdirSync(lockDir); } catch (error) { if (!DIRECTORY_CONTENTION.has(error.code)) throw error; }
        continue;
      }
      const deadClaims = [];
      for (const name of names.sort()) {
        const match = OWNER_NAME.exec(name);
        if (!match || processIsAlive(Number(match[1]))) throw busyError();
        let contents, owner;
        try {
          const stat = fs.lstatSync(path.join(lockDir, name));
          if (!stat.isFile() || stat.size > 4096) throw busyError();
          contents = fs.readFileSync(path.join(lockDir, name), 'utf8');
          owner = JSON.parse(contents);
        } catch (error) { if (error.code === 'ENOENT') continue; throw busyError(); }
        // The unique filename is the ownership claim. JSON is immutable
        // creation provenance and may predate an earlier atomic takeover.
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !/^[a-f0-9]{32}$/.test(owner.nonce || '')) throw busyError();
        deadClaims.push({ name, contents });
      }
      if (!deadClaims.length) continue;
      for (const dead of deadClaims) {
        try { fs.unlinkSync(path.join(lockDir, dead.name)); }
        catch (error) { if (error.code !== 'ENOENT') { if (DIRECTORY_CONTENTION.has(error.code)) throw busyError(); throw error; } }
      }
      // rmdir cannot remove a directory containing another launcher's fresh
      // unique claim. A delayed removal of its still-empty publication gap
      // makes that launcher fail closed; the next mkdir competes normally.
      try { fs.rmdirSync(lockDir); }
      catch (error) { if (!DIRECTORY_CONTENTION.has(error.code)) throw error; }
    }
    throw busyError();
  } finally {
    try { fs.unlinkSync(preparedPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function assertCompatibleInstances(conflicts, currentStoreId) {
  for (const conflict of conflicts || []) {
    if (!conflict.version) continue;
    if (!conflict.dataStoreId || conflict.dataStoreId === currentStoreId) {
      throw new Error(`기존 VideoRandom v${conflict.version}이 ${conflict.port}번 포트에서 실행 중입니다. 기존 프로그램을 종료한 뒤 새 버전을 다시 실행해 주세요. 분석 결과와 연결 설정은 그대로 유지됩니다.`);
    }
  }
}

module.exports = { acquireDataDirLease, dataStoreId, assertCompatibleInstances };
