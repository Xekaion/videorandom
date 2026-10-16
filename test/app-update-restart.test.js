const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createUpdateRestarter, fileHash, contained } = require('../lib/app-update-restart');

const workspace = path.resolve(__dirname, '..', '.test-data', 'app-update-restart-tests');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture(t, overrides = {}) {
  await fs.mkdir(workspace, { recursive: true });
  const root = await fs.mkdtemp(path.join(workspace, 'owned-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), workspace);
    await fs.rm(root, { recursive: true, force: true });
  });
  const dataDir = path.join(root, 'persistent data');
  const stagePath = path.join(dataDir, 'app-updates', '1.9.1', 'videorandom.exe');
  const target = path.join(root, 'Video Random fixture.exe');
  const helper = path.join(root, 'fixture-helper.ps1');
  const oldBytes = Buffer.from('MZ synthetic-old-executable-for-tests-only');
  const newBytes = Buffer.from('MZ synthetic-new-executable-for-tests-only');
  await fs.mkdir(path.dirname(stagePath), { recursive: true });
  await fs.writeFile(stagePath, newBytes);
  await fs.writeFile(target, oldBytes);
  await fs.writeFile(helper, '# Fixture only. This file is never executed.\n');
  const calls = [], children = [], writes = [];
  const environment = { PORT: 'original-port', VIDEORANDOM_DATA_DIR: 'original-dir', VIDEORANDOM_START_HOST: 'original-host', SYNTHETIC_KEEP: 'unchanged' };
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.unrefs = 0; child.unref = () => { child.unrefs += 1; };
    calls.push({ command, args, options }); children.push(child);
    const planPath = args[args.indexOf('-PlanPath') + 1];
    const write = (async () => {
      const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
      if (overrides.onSpawn) await overrides.onSpawn({ plan, planPath, child, command, args, options });
      else await fs.writeFile(planPath + '.status.json', JSON.stringify({ token: plan.token, phase: 'waiting-parent' }));
    })();
    writes.push(write);
    write.catch(error => queueMicrotask(() => child.emit('error', error)));
    return child;
  };
  const settings = { dataDir, currentVersion: '1.9.0', platform: 'win32', packaged: true,
    execPath: target, parentPid: 98765, spawnImpl, environment, helperSource: helper, receiptTimeoutMs: 5000, pollMs: 2, ...overrides.settings };
  const restarter = createUpdateRestarter(settings);
  const staged = { path: stagePath, version: '1.9.1', sha256: sha(newBytes), sizeBytes: newBytes.length };
  const armOptions = { port: 3281, storeId: 'a'.repeat(64), hostRunning: true, hostPort: 3282 };
  return { root, dataDir, stagePath, target, helper, oldBytes, newBytes, staged, armOptions, restarter, calls, children, writes, environment, settings };
}

test('restarter verifies bytes and arms only after its own helper acknowledges the plan', async t => {
  let acknowledge, planRead;
  const receiptReady = new Promise(resolve => { planRead = resolve; });
  const gate = new Promise(resolve => { acknowledge = resolve; });
  const fx = await fixture(t, { onSpawn: async ({ plan, planPath }) => {
    planRead(); await gate;
    await fs.writeFile(planPath + '.status.json', JSON.stringify({ token: plan.token, phase: 'waiting-parent' }));
  } });
  let completed = false;
  const pending = fx.restarter.arm(fx.staged, fx.armOptions).then(value => { completed = true; return value; });
  await receiptReady;
  assert.equal(completed, false);
  await assert.rejects(fx.restarter.arm(fx.staged, fx.armOptions), /이미/);
  assert.equal(fx.calls.length, 1);
  assert.equal(fx.children[0].unrefs, 0);
  assert.deepEqual(await fs.readFile(fx.target), fx.oldBytes);
  acknowledge();
  const armed = await pending;
  assert.match(armed.token, /^[a-f0-9]{32}$/);
  assert.ok(contained(path.join(fx.dataDir, 'app-updates'), armed.planPath));
  const plan = JSON.parse(await fs.readFile(armed.planPath, 'utf8'));
  assert.equal(plan.token, armed.token);
  assert.equal(plan.parentPid, 98765);
  assert.equal(plan.targetPath, fx.target);
  assert.equal(plan.stagePath, fx.stagePath);
  assert.equal(plan.sha256, sha(fx.newBytes));
  assert.equal(plan.oldSha256, sha(fx.oldBytes));
  assert.equal(plan.port, 3281);
  assert.equal(plan.storeId, fx.armOptions.storeId);
  assert.equal(fx.children[0].unrefs, 1);
  assert.deepEqual(await fs.readFile(fx.target), fx.oldBytes);
  await assert.rejects(fx.restarter.arm(fx.staged, fx.armOptions), /이미/);
  await fx.restarter.cancel();
  assert.equal(await fs.readFile(armed.planPath + '.cancel', 'utf8'), armed.token);
});

test('helper launch uses fixed hidden PowerShell flags without DETACHED_PROCESS and copies the parent environment', async t => {
  const fx = await fixture(t);
  const before = { ...fx.environment };
  const armed = await fx.restarter.arm(fx.staged, fx.armOptions);
  assert.equal(fx.calls.length, 1);
  const call = fx.calls[0];
  assert.equal(call.command, path.win32.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  assert.deepEqual(call.args.slice(0, 6), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(path.dirname(armed.planPath), 'launch-update.ps1')]);
  assert.deepEqual(call.args.slice(6), ['-PlanPath', armed.planPath]);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.detached, false);
  assert.equal(call.options.stdio, 'ignore');
  assert.equal(call.options.env.PORT, '3281');
  assert.equal(call.options.env.VIDEORANDOM_DATA_DIR, fx.dataDir);
  assert.equal(call.options.env.VIDEORANDOM_NO_OPEN, '1');
  assert.equal(call.options.env.VIDEORANDOM_START_HOST, '1');
  assert.equal(call.options.env.VIDEORANDOM_HOST_PORT, '3282');
  assert.equal(call.options.env.VIDEORANDOM_UPDATE_BOOTSTRAP, armed.token);
  assert.equal(call.options.env.SYNTHETIC_KEEP, 'unchanged');
  assert.deepEqual(fx.environment, before);
  assert.notEqual(call.options.env, fx.environment);
  assert.equal(await fs.readFile(path.join(path.dirname(armed.planPath), 'apply-update.ps1'), 'utf8'), '# Fixture only. This file is never executed.\n');
});

test('unsupported execution environments reject before filesystem or helper access', async t => {
  for (const settings of [{ platform: 'linux', packaged: true }, { platform: 'win32', packaged: false }]) await t.test(JSON.stringify(settings), async () => {
    let touched = false;
    const restarter = createUpdateRestarter({ ...settings, dataDir: 'unused', io: new Proxy({}, { get() { touched = true; throw new Error('No I/O expected'); } }), spawnImpl() { touched = true; } });
    assert.equal(restarter.supported, false);
    await assert.rejects(restarter.arm({}, {}), /Windows/);
    assert.equal(touched, false);
  });
});

test('invalid hash, size, path escape, executable path, or launch metadata never spawns a helper', async t => {
  const cases = [
    ['hash mismatch', fx => ({ staged: { ...fx.staged, sha256: 'b'.repeat(64) } }), /무결성/],
    ['size mismatch', fx => ({ staged: { ...fx.staged, sizeBytes: fx.staged.sizeBytes + 1 } }), /파일/],
    ['path escape', fx => ({ staged: { ...fx.staged, path: path.join(fx.root, 'outside.exe') } }), /실행 정보/],
    ['root path', fx => ({ staged: { ...fx.staged, path: path.join(fx.dataDir, 'app-updates') } }), /실행 정보/],
    ['invalid version', fx => ({ staged: { ...fx.staged, version: '1.9.1; arbitrary-command' } }), /실행 정보/],
    ['invalid port', fx => ({ options: { ...fx.armOptions, port: 65536 } }), /실행 정보/],
    ['invalid identity', fx => ({ options: { ...fx.armOptions, storeId: '../outside' } }), /실행 정보/],
    ['invalid host port', fx => ({ options: { ...fx.armOptions, hostPort: 0 } }), /실행 정보/]
  ];
  for (const [name, mutate, error] of cases) await t.test(name, async t => {
    const fx = await fixture(t), input = mutate(fx);
    await assert.rejects(fx.restarter.arm(input.staged || fx.staged, input.options || fx.armOptions), error);
    assert.equal(fx.calls.length, 0);
    assert.deepEqual(await fs.readFile(fx.target), fx.oldBytes);
  });
  await t.test('non-exe target', async t => {
    const fx = await fixture(t, { settings: { execPath: path.join(workspace, 'fixture.txt') } });
    await assert.rejects(fx.restarter.arm(fx.staged, fx.armOptions), /실행 정보/);
    assert.equal(fx.calls.length, 0);
  });
  await t.test('target is stage', async t => {
    const fx = await fixture(t);
    const restarter = createUpdateRestarter({ ...fx.settings, execPath: fx.stagePath });
    await assert.rejects(restarter.arm(fx.staged, fx.armOptions), /실행 정보/);
    assert.equal(fx.calls.length, 0);
  });
});

test('stage or target reported as a symlink is rejected without launching', async t => {
  for (const name of ['stage', 'target']) await t.test(name, async t => {
    const fx = await fixture(t);
    const rejectPath = name === 'stage' ? fx.stagePath : fx.target;
    const io = { ...fs, lstat: async filename => {
      const stat = await fs.lstat(filename);
      if (filename !== rejectPath) return stat;
      return { isFile: () => true, isSymbolicLink: () => true, size: stat.size };
    } };
    const restarter = createUpdateRestarter({ ...fx.settings, io });
    await assert.rejects(restarter.arm(fx.staged, fx.armOptions), /파일/);
    assert.equal(fx.calls.length, 0);
  });
});

test('a stage reached through an escaping parent junction is rejected before helper launch', async t => {
  const fx = await fixture(t);
  const outside = path.join(fx.root, 'outside-update-directory');
  const linked = path.join(fx.dataDir, 'app-updates', 'linked-stage');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'videorandom.exe'), fx.newBytes);
  await fs.symlink(outside, linked, 'junction');
  await assert.rejects(fx.restarter.arm({ ...fx.staged, path: path.join(linked, 'videorandom.exe') }, fx.armOptions), /실제 저장 위치/);
  assert.equal(fx.calls.length, 0);
  assert.deepEqual(await fs.readFile(fx.target), fx.oldBytes);
});

test('a hash-matching file without a Windows executable header is rejected', async t => {
  const fx = await fixture(t);
  const bytes = Buffer.from('This is a synthetic non-executable file.');
  await fs.writeFile(fx.stagePath, bytes);
  await assert.rejects(fx.restarter.arm({ ...fx.staged, sha256: sha(bytes), sizeBytes: bytes.length }, fx.armOptions), /Windows.*실행 파일/);
  assert.equal(fx.calls.length, 0);
});

test('a target directory write permission error leaves the old executable running and never launches', async t => {
  const fx = await fixture(t);
  const io = { ...fs, open: async (filename, flags, ...rest) => {
    if (flags === 'wx' && filename.startsWith(fx.target + '.updating-')) {
      const error = new Error('synthetic EACCES'); error.code = 'EACCES'; throw error;
    }
    return fs.open(filename, flags, ...rest);
  } };
  const restarter = createUpdateRestarter({ ...fx.settings, io });
  await assert.rejects(restarter.arm(fx.staged, fx.armOptions), { code: 'EACCES' });
  assert.equal(fx.calls.length, 0);
  assert.deepEqual(await fs.readFile(fx.target), fx.oldBytes);
});

test('missing, mismatched, oversized, or error receipt cancels the owned plan without arming', async t => {
  const modes = ['missing', 'wrong-token', 'oversized', 'error'];
  for (const mode of modes) await t.test(mode, async t => {
    let planPath;
    const fx = await fixture(t, { settings: { receiptTimeoutMs: mode === 'missing' ? 250 : 5000 }, onSpawn: async input => {
      planPath = input.planPath;
      if (mode === 'missing') return;
      const receipt = mode === 'oversized' ? 'x'.repeat(4097) : JSON.stringify({ token: mode === 'wrong-token' ? 'wrong-owner' : input.plan.token, phase: mode === 'error' ? 'error' : 'waiting-parent' });
      await fs.writeFile(input.planPath + '.status.json', receipt);
    } });
    await assert.rejects(fx.restarter.arm(fx.staged, fx.armOptions), mode === 'missing' ? /초과/ : mode === 'wrong-token' ? /소유권/ : mode === 'oversized' ? /응답/ : /확인하지 못했습니다/);
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
    assert.equal(await fs.readFile(planPath + '.cancel', 'utf8'), plan.token);
    assert.deepEqual(await fs.readFile(fx.target), fx.oldBytes);
    assert.equal(fx.children[0].unrefs, 1);
    await fx.restarter.cancel();
  });
});

test('synchronous helper launch failure writes cancellation and does not change executable bytes', async t => {
  const fx = await fixture(t);
  const restarter = createUpdateRestarter({ ...fx.settings, spawnImpl() { throw new Error('synthetic spawn failure'); } });
  await assert.rejects(restarter.arm(fx.staged, fx.armOptions), /synthetic spawn failure/);
  const folders = await fs.readdir(path.join(fx.dataDir, 'app-updates', 'handoff'));
  assert.equal(folders.length, 1);
  const planPath = path.join(fx.dataDir, 'app-updates', 'handoff', folders[0], 'plan.json');
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
  assert.equal(await fs.readFile(planPath + '.cancel', 'utf8'), plan.token);
  assert.deepEqual(await fs.readFile(fx.target), fx.oldBytes);
});

test('an asynchronous helper launch error cancels its own plan without arming', async t => {
  let planPath;
  const fx = await fixture(t, { onSpawn: async input => { planPath = input.planPath; throw new Error('synthetic async launch error'); } });
  await assert.rejects(fx.restarter.arm(fx.staged, fx.armOptions), /도우미를 실행하지 못했습니다/);
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
  assert.equal(await fs.readFile(planPath + '.cancel', 'utf8'), plan.token);
  assert.deepEqual(await fs.readFile(fx.target), fx.oldBytes);
  assert.equal(fx.children[0].unrefs, 1);
});

test('hash helper streams bytes and containment rejects root and sibling escapes', async t => {
  const fx = await fixture(t);
  assert.equal(await fileHash(fx.stagePath), sha(fx.newBytes));
  assert.equal(Boolean(contained(fx.root, fx.root)), false);
  assert.equal(contained(fx.root, fx.stagePath), true);
  assert.equal(contained(fx.root, fx.root + '-outside/file.exe'), false);
});
