const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');

const MiB = 1024 * 1024;
const DEFAULT_RESERVE_BYTES = 512 * MiB;
const DEFAULT_TIMEOUT_MS = 4000;
const LOW_SPACE_MESSAGE = '분석에 필요한 저장 공간이 부족합니다. 공간이 확보되면 보관한 대기 작업을 다시 진행할 수 있습니다.';
// Only the base64 payload changes. The path is never executable PowerShell text.
const DRIVE_INFO_SCRIPT = `$ErrorActionPreference = 'Stop'
try {
  $target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PATH_BASE64__'))
  $root = [IO.Path]::GetPathRoot($target)
  if ([String]::IsNullOrEmpty($root)) { throw 'No volume' }
  $drive = New-Object -TypeName System.IO.DriveInfo -ArgumentList $root
  if (!$drive.IsReady) { throw 'Volume not ready' }
  [Console]::Out.Write((@{availableBytes = [String]$drive.AvailableFreeSpace} | ConvertTo-Json -Compress))
} catch {
  [Console]::Out.Write('{"availableBytes":null}')
}`;

function bytes(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function byteValue(value) {
  if (typeof value === 'string' && !/^\d{1,16}$/.test(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return null;
  try {
    const integer = typeof value === 'bigint' ? value : BigInt(value);
    return integer >= 0n && integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : null;
  } catch (_) { return null; }
}

function statfsBytes(info) {
  if (!info || typeof info !== 'object') return null;
  const size = byteValue(info.bsize), available = byteValue(info.bavail);
  if (size === null || size <= 0 || available === null) return null;
  return byteValue(BigInt(size) * BigInt(available));
}

function unknown(reason = 'PROBE_UNAVAILABLE') {
  return { known: false, availableBytes: null, source: 'unknown', reason };
}

function bounded(promise, timeoutMs) {
  if (timeoutMs <= 0) return Promise.reject(Object.assign(new Error('Disk probe timed out'), { code: 'DISK_PROBE_TIMEOUT' }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('Disk probe timed out'), { code: 'DISK_PROBE_TIMEOUT' })), timeoutMs);
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function powershellProbe(target, options, timeoutMs) {
  return new Promise(resolve => {
    let child, timer, settled = false;
    const finish = (error, stdout) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error || typeof stdout !== 'string' || Buffer.byteLength(stdout) > 4096) return resolve(unknown());
      try {
        const value = byteValue(JSON.parse(stdout.trim()).availableBytes);
        return resolve(value === null ? unknown() : { known: true, availableBytes: value, source: 'powershell' });
      } catch (_) { return resolve(unknown()); }
    };
    const script = DRIVE_INFO_SCRIPT.replace('__PATH_BASE64__', Buffer.from(target, 'utf8').toString('base64'));
    const command = path.win32.join(options.windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      child = options.execFile(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, shell: false, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4096 }, finish);
      if (!settled) timer = setTimeout(() => {
        // This is only the child created above for this read-only probe.
        try { child?.kill?.(); } catch (_) { /* The result remains unknown. */ }
        finish(Object.assign(new Error('Disk probe timed out'), { code: 'DISK_PROBE_TIMEOUT' }));
      }, timeoutMs);
    } catch (_) { finish(new Error('Disk probe unavailable')); }
  });
}

function createDiskSpaceMonitor(options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const io = options.fs || fs;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(30000, Math.floor(options.timeoutMs))) : DEFAULT_TIMEOUT_MS;
  const windowsRoot = options.windowsRoot || process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const subprocess = options.execFile || execFile;

  async function probe(target) {
    if (typeof target !== 'string' || !target.trim() || target.includes('\0') || target.length > 32767) return unknown('INVALID_PATH');
    let resolved;
    try { resolved = pathApi.resolve(target); } catch (_) { return unknown('INVALID_PATH'); }
    const deadline = Date.now() + timeoutMs;
    if (typeof io.statfs === 'function') {
      let current = resolved;
      // A new data directory may not exist yet. Query its nearest existing
      // ancestor without creating a directory or a disposable write-test file.
      for (let depth = 0; depth < 64; depth++) {
        try {
          const availableBytes = statfsBytes(await bounded(io.statfs(current, { bigint: true }), deadline - Date.now()));
          if (availableBytes !== null) return { known: true, availableBytes, source: 'statfs' };
          break;
        } catch (error) {
          if (error?.code === 'DISK_PROBE_TIMEOUT') return unknown('PROBE_TIMEOUT');
          const parent = pathApi.dirname(current);
          if (!['ENOENT', 'ENOTDIR'].includes(error?.code) || parent === current) break;
          current = parent;
        }
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return unknown('PROBE_TIMEOUT');
    // pkg's Node 18 may not expose statfs. DriveInfo reads volume metadata only;
    // disconnected drives and unsupported UNC roots remain unknown.
    if (platform === 'win32') return powershellProbe(resolved, { execFile: subprocess, windowsRoot }, remaining);
    return unknown();
  }

  async function check({ path: target, requiredBytes = 0, reserveBytes = DEFAULT_RESERVE_BYTES } = {}) {
    requiredBytes = bytes(requiredBytes);
    reserveBytes = bytes(reserveBytes, DEFAULT_RESERVE_BYTES);
    const totalRequiredBytes = Math.min(Number.MAX_SAFE_INTEGER, requiredBytes + reserveBytes);
    const result = await probe(target);
    const low = result.known && result.availableBytes < totalRequiredBytes;
    return { ...result, ok: !low, requiredBytes, reserveBytes, totalRequiredBytes,
      code: low ? 'STORAGE_SPACE_LOW' : null, message: low ? LOW_SPACE_MESSAGE : '' };
  }

  async function assert(options) {
    const result = await check(options);
    if (!result.ok) throw Object.assign(new Error(result.message), result);
    return result;
  }

  return { probe, check, assert };
}

// Reserve only files that this operation still needs to create. A pre-existing
// FLAC is decoded into memory by ASR and must not be reserved a second time.
// These estimates exclude the separately applied 512 MiB safety reserve.
function estimateAnalysisDiskBytes({ uploadBytes = 0, durationSeconds = 0, translationOnly = false, audioExists = false, frameCount = 10 } = {}) {
  const incoming = bytes(uploadBytes);
  const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.min(durationSeconds, 7 * 86400) : 0;
  const frames = Number.isInteger(frameCount) && frameCount >= 0 ? Math.min(frameCount, 20) : 10;
  const working = 32 * MiB + (translationOnly ? 0 : frames * 2 * MiB);
  const audio = !translationOnly && !audioExists ? Math.ceil(duration * 16000 * 2 * 1.05) : 0;
  return Math.min(Number.MAX_SAFE_INTEGER, incoming + working + audio);
}

async function checkDiskSpace(options, dependencies) {
  return createDiskSpaceMonitor(dependencies).check(options);
}

module.exports = { createDiskSpaceMonitor, checkDiskSpace, estimateAnalysisDiskBytes, DEFAULT_RESERVE_BYTES, LOW_SPACE_MESSAGE };
