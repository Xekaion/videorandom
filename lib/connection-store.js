const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CODE = /^[a-zA-Z0-9_-]{24,128}$/;
const WAIT = ms => new Promise(resolve => setTimeout(resolve, ms));

// Secrets travel through stdin, never a shell command or process arguments.
const DPAPI_SCRIPT = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $raw=[Convert]::FromBase64String([Console]::In.ReadToEnd()); if ($operation -eq 'protect') { $out=[System.Security.Cryptography.ProtectedData]::Protect($raw,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser) } else { $out=[System.Security.Cryptography.ProtectedData]::Unprotect($raw,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser) }; [Console]::Out.Write([Convert]::ToBase64String($out))";

function dpapi(bytes, operation) {
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = (operation === 'protect' ? "$operation='protect'; " : "$operation='unprotect'; ") + DPAPI_SCRIPT;
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', finished = false;
    const fail = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error('Windows에서 연결 코드를 보호하거나 읽지 못했습니다. 현재 Windows 계정과 저장 폴더를 확인해 주세요.'));
    };
    const timer = setTimeout(() => { child.kill(); fail(); }, 15000);
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('data', chunk => { output += chunk.toString('ascii'); if (output.length > 65536) { child.kill(); fail(); } });
    child.stderr.resume();
    child.on('close', code => {
      if (finished) return;
      if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) return fail();
      finished = true;
      clearTimeout(timer);
      resolve(Buffer.from(output, 'base64'));
    });
    child.stdin.end(bytes.toString('base64'));
  });
}

function createConnectionStore({ dataDir, protector } = {}) {
  if (typeof dataDir !== 'string') throw new Error('연결 설정 저장 폴더가 필요합니다.');
  const directory = path.join(path.resolve(dataDir), 'connection');
  async function key() {
    const keyPath = path.join(directory, 'owner.key');
    try { return await fs.readFile(keyPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const value = crypto.randomBytes(32);
      try { await fs.writeFile(keyPath, value, { flag: 'wx', mode: 0o600 }); return value; }
      catch (writeError) { if (writeError.code === 'EEXIST') return fs.readFile(keyPath); throw writeError; }
    }
  }
  const codec = protector || (process.platform === 'win32' ? {
    name: 'windows-current-user-dpapi',
    protect: value => dpapi(value, 'protect'), unprotect: value => dpapi(value, 'unprotect')
  } : {
    name: 'owner-aes-256-gcm',
    async protect(value) {
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', await key(), nonce);
      const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    async unprotect(value) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', await key(), value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]);
    }
  });
  if (!codec.name || typeof codec.protect !== 'function' || typeof codec.unprotect !== 'function') throw new Error('연결 코드 보호 방식이 올바르지 않습니다.');

  async function read(kind) {
    try {
      const envelope = JSON.parse(await fs.readFile(path.join(directory, kind + '.json'), 'utf8'));
      if (envelope.schemaVersion !== 1 || envelope.protection !== codec.name || typeof envelope.value !== 'string' || envelope.value.length > 65536) throw new Error('Invalid protected settings');
      return JSON.parse((await codec.unprotect(Buffer.from(envelope.value, 'base64'))).toString('utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('저장된 연결 설정을 읽지 못했습니다. 같은 Windows 계정으로 실행하거나 연결 설정을 다시 저장해 주세요.');
    }
  }

  async function update(kind, modify, replace = false) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = path.join(directory, kind + '.lock');
    let handle;
    for (let attempt = 0; attempt < 320; attempt++) {
      try { handle = await fs.open(lockPath, 'wx', 0o600); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw new Error('연결 설정 저장 폴더에 접근하지 못했습니다.');
        // Recover a lock left by a terminated process; active DPAPI operations
        // have a much shorter timeout and cannot outlive this lease.
        const stale = await fs.stat(lockPath).then(stat => Date.now() - stat.mtimeMs > 120000, () => false);
        if (stale) await fs.unlink(lockPath).catch(() => {});
        else await WAIT(25);
      }
    }
    if (!handle) throw new Error('다른 실행 창이 연결 설정을 저장 중입니다. 잠시 뒤 다시 시도해 주세요.');
    const target = path.join(directory, kind + '.json');
    const temporary = target + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    try {
      const next = await modify(replace ? null : await read(kind));
      const protectedValue = await codec.protect(Buffer.from(JSON.stringify(next), 'utf8'));
      await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, protection: codec.name, value: protectedValue.toString('base64') }), { mode: 0o600 });
      await fs.rename(temporary, target);
      return next;
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      if (/저장된 연결 설정|Windows에서 연결 코드/.test(error.message)) throw error;
      throw new Error('연결 설정을 이 PC에 저장하지 못했습니다. 저장 폴더를 확인해 주세요.');
    } finally { await handle.close(); await fs.unlink(lockPath).catch(() => {}); }
  }

  const empty = () => ({ remoteUrl: '', connectionCode: '', remembered: false });
  async function getConnection() {
    const value = await read('client');
    if (!value || !value.remoteUrl || !value.connectionCode) return empty();
    const { validateRemoteUrl } = require('./lan-analysis');
    if (typeof value.remoteUrl !== 'string' || !CODE.test(value.connectionCode) || validateRemoteUrl(value.remoteUrl).origin !== value.remoteUrl) throw new Error('저장된 분석 서버 연결 설정이 올바르지 않습니다.');
    return { remoteUrl: value.remoteUrl, connectionCode: value.connectionCode, remembered: true };
  }
  async function saveConnection({ remoteUrl, connectionCode }) {
    const { validateRemoteUrl } = require('./lan-analysis');
    const url = validateRemoteUrl(remoteUrl).origin;
    if (!CODE.test(connectionCode || '')) throw new Error('분석 PC에 표시된 연결 코드를 입력해 주세요.');
    await update('client', () => ({ remoteUrl: url, connectionCode }), true);
    return { remoteUrl: url, connectionCode, remembered: true };
  }
  async function clearConnection() { await update('client', () => ({ remoteUrl: '', connectionCode: '' }), true); return empty(); }
  async function getHostState() {
    const value = await read('host');
    if (!value) return { enabled: false, connectionCode: '' };
    if (!CODE.test(value.connectionCode || '') || typeof value.enabled !== 'boolean') throw new Error('저장된 분석 서버 설정이 올바르지 않습니다.');
    return { enabled: value.enabled, connectionCode: value.connectionCode };
  }
  async function getHostCode() {
    const existing = await getHostState();
    if (existing.connectionCode) return existing.connectionCode;
    const state = await update('host', previous => previous || { enabled: false, connectionCode: crypto.randomBytes(24).toString('base64url') });
    if (!CODE.test(state.connectionCode || '')) throw new Error('저장된 분석 서버 코드가 올바르지 않습니다.');
    return state.connectionCode;
  }
  async function setHostCode(connectionCode) {
    if (!CODE.test(connectionCode || '')) throw new Error('분석 서버 연결 코드가 올바르지 않습니다.');
    return update('host', previous => ({ enabled: previous?.enabled === true, connectionCode }));
  }
  async function setHostEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('분석 서버 사용 설정이 올바르지 않습니다.');
    return update('host', previous => ({ connectionCode: previous?.connectionCode || crypto.randomBytes(24).toString('base64url'), enabled }));
  }
  return { getConnection, saveConnection, clearConnection, getHostState, getHostCode, setHostCode, setHostEnabled, directory };
}

module.exports = { createConnectionStore };
