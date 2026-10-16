const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

async function fileHash(filename, io = fs) {
  const handle = await io.open(filename, 'r');
  const hash = crypto.createHash('sha256');
  try {
    const bytes = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, null);
      if (!bytesRead) break;
      hash.update(bytes.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
  return hash.digest('hex');
}

function contained(root, filename) {
  const relative = path.relative(path.resolve(root), path.resolve(filename));
  return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

function createUpdateRestarter({ dataDir, currentVersion, platform = process.platform, packaged = Boolean(process.pkg),
  execPath = process.execPath, parentPid = process.pid, spawnImpl = spawn, io = fs,
  environment = process.env, helperSource = path.join(__dirname, '..', 'scripts', 'apply_update.ps1'),
  launcherSource = path.join(__dirname, '..', 'scripts', 'launch_update.ps1'),
  receiptTimeoutMs = 15000, pollMs = 100 } = {}) {
  const supported = platform === 'win32' && packaged;
  let armed = null;
  let arming = null;
  async function armOnce(staged, { port, storeId, hostRunning = false, hostPort = 3001 } = {}) {
    if (!supported) throw new Error('자동 적용은 Windows 실행 파일에서 사용할 수 있습니다. 새 실행 파일을 한 번 실행해 주세요.');
    if (armed) throw new Error('이미 업데이트를 준비하고 있습니다.');
    const root = path.resolve(dataDir, 'app-updates');
    const target = path.resolve(execPath);
    if (!staged || !/^\d+\.\d+\.\d+$/.test(staged.version || '') || !/^[a-f0-9]{64}$/i.test(staged.sha256 || '')
      || !Number.isSafeInteger(staged.sizeBytes) || staged.sizeBytes <= 0 || !contained(root, staged.path || root)
      || path.extname(target).toLowerCase() !== '.exe' || target === path.resolve(staged.path)
      || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{64}$/i.test(storeId || '')
      || !Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) throw new Error('업데이트 실행 정보가 올바르지 않습니다.');
    const [sourceStat, targetStat] = await Promise.all([io.lstat(staged.path), io.lstat(target)]);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size !== staged.sizeBytes
      || !targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error('업데이트 파일을 확인하지 못했습니다.');
    const [realRoot, realStage, realTarget] = await Promise.all([io.realpath(root), io.realpath(staged.path), io.realpath(target)]);
    if (!contained(realRoot, realStage) || realStage.toLowerCase() === realTarget.toLowerCase()) throw new Error('업데이트 파일의 실제 저장 위치가 올바르지 않습니다.');
    const sourceHandle = await io.open(staged.path, 'r');
    try {
      const header = Buffer.alloc(2);
      const { bytesRead } = await sourceHandle.read(header, 0, 2, 0);
      if (bytesRead !== 2 || header.toString('ascii') !== 'MZ') throw new Error('Windows 업데이트 실행 파일이 아닙니다.');
    } finally { await sourceHandle.close(); }
    if (await fileHash(staged.path, io) !== staged.sha256.toLowerCase()) throw new Error('다운로드한 업데이트의 무결성 확인에 실패했습니다.');
    const token = crypto.randomBytes(16).toString('hex');
    const handoffDir = path.join(root, 'handoff', token);
    await io.mkdir(handoffDir, { recursive: true });
    const planPath = path.join(handoffDir, 'plan.json'), scriptPath = path.join(handoffDir, 'apply-update.ps1');
    const launcherPath = path.join(handoffDir, 'launch-update.ps1');
    const nextPath = target + '.updating-' + token + '.exe';
    const backupPath = target + '.previous-' + token + '.exe';
    // Test write permissions before waiting for or stopping any application.
    const probe = await io.open(nextPath, 'wx');
    await probe.close();
    await io.unlink(nextPath);
    const plan = { schemaVersion: 1, token, parentPid, targetPath: target, stagePath: path.resolve(staged.path),
      dataDir: path.resolve(dataDir), currentVersion, version: staged.version, sha256: staged.sha256.toLowerCase(),
      oldSha256: await fileHash(target, io), sizeBytes: staged.sizeBytes, nextPath, backupPath, port, storeId };
    await io.writeFile(scriptPath, await io.readFile(helperSource), { flag: 'wx', mode: 0o600 });
    await io.writeFile(launcherPath, await io.readFile(launcherSource), { flag: 'wx', mode: 0o600 });
    await io.writeFile(planPath, JSON.stringify(plan), { flag: 'wx', mode: 0o600 });
    const cancelPath = planPath + '.cancel';
    let child;
    try {
      const powershell = path.win32.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      child = spawnImpl(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcherPath, '-PlanPath', planPath], {
        // The short launcher creates the independent hidden helper console.
        detached: false, windowsHide: true, stdio: 'ignore', shell: false,
        env: { ...environment, PORT: String(port), VIDEORANDOM_DATA_DIR: path.resolve(dataDir), VIDEORANDOM_NO_OPEN: '1',
          VIDEORANDOM_START_HOST: hostRunning ? '1' : '0', VIDEORANDOM_HOST_PORT: String(hostPort), VIDEORANDOM_UPDATE_BOOTSTRAP: token }
      });
      let launchError;
      child.once('error', error => { launchError = error; });
      const deadline = Date.now() + receiptTimeoutMs;
      while (Date.now() < deadline) {
        if (launchError) throw new Error('업데이트 도우미를 실행하지 못했습니다.');
        try {
          const stat = await io.stat(planPath + '.status.json');
          if (stat.size > 4096) throw new Error('업데이트 도우미의 응답이 올바르지 않습니다.');
          const receipt = JSON.parse(await io.readFile(planPath + '.status.json', 'utf8'));
          if (receipt.token !== token) throw new Error('업데이트 도우미의 소유권을 확인하지 못했습니다.');
          if (receipt.phase === 'waiting-parent') {
            const pointer = path.join(root, 'last-attempt.json');
            const temporary = pointer + '.' + token + '.tmp';
            await io.writeFile(temporary, JSON.stringify({ schemaVersion: 1, token }), { flag: 'wx', mode: 0o600 });
            await io.rename(temporary, pointer);
            armed = { planPath, cancelPath, token };
            child.unref?.();
            return { token, planPath };
          }
          if (receipt.phase === 'error') throw new Error('업데이트 도우미가 파일을 확인하지 못했습니다. 기존 프로그램은 계속 실행됩니다.');
        } catch (error) { if (!['ENOENT'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
        await new Promise(resolve => setTimeout(resolve, pollMs));
      }
      throw new Error('업데이트 도우미 준비 시간이 초과되었습니다. 기존 프로그램은 계속 실행됩니다.');
    } catch (error) {
      await io.writeFile(cancelPath, token).catch(() => {});
      child?.unref?.();
      throw error;
    }
  }
  async function cancel() {
    if (!armed) return;
    await io.writeFile(armed.cancelPath, armed.token);
    armed = null;
  }
  function arm(...args) {
    if (arming) return Promise.reject(new Error('이미 업데이트를 준비하고 있습니다.'));
    arming = armOnce(...args);
    return arming.finally(() => { arming = null; });
  }
  return { supported, arm, cancel };
}

async function readUpdateOutcome(dataDir, io = fs) {
  try {
    const root = path.resolve(dataDir, 'app-updates');
    const pointerPath = path.join(root, 'last-attempt.json');
    if ((await io.stat(pointerPath)).size > 1024) return null;
    const pointer = JSON.parse(await io.readFile(pointerPath, 'utf8'));
    if (pointer.schemaVersion !== 1 || !/^[a-f0-9]{32}$/.test(pointer.token || '')) return null;
    const receiptPath = path.join(root, 'handoff', pointer.token, 'plan.json.status.json');
    if ((await io.stat(receiptPath)).size > 4096) return null;
    const receipt = JSON.parse(await io.readFile(receiptPath, 'utf8'));
    if (receipt.token !== pointer.token || !/^\d+\.\d+\.\d+$/.test(receipt.version || '')
      || !['completed', 'rolled-back', 'error', 'activation-needed', 'starting', 'waiting-parent', 'cancelled'].includes(receipt.phase)) return null;
    return { phase: receipt.phase, version: receipt.version };
  } catch (_) { return null; }
}

module.exports = { createUpdateRestarter, fileHash, contained, readUpdateOutcome };
