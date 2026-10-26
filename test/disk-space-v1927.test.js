const test = require('node:test');
const assert = require('node:assert/strict');
const { createDiskSpaceMonitor, checkDiskSpace, estimateAnalysisDiskBytes, DEFAULT_RESERVE_BYTES, LOW_SPACE_MESSAGE } = require('../lib/disk-space');

const MiB = 1024 * 1024;
const target = 'C:\\synthetic-data\\results';
const win = extra => ({ platform: 'win32', windowsRoot: 'C:\\Windows', ...extra });
const native = available => ({ statfs: async () => ({ bsize: 1n, bavail: BigInt(available) }) });
const callbackProbe = value => (_command, _args, _options, callback) => { callback(null, JSON.stringify(value)); return {}; };

test('native statfs uses user-available blocks and supports bigint results', async () => {
  let called;
  const monitor = createDiskSpaceMonitor(win({ fs: { statfs: async (...args) => {
    called = args;
    return { bsize: 4096n, bavail: 128n, bfree: 900n };
  } }, execFile: () => assert.fail('A successful native probe must not spawn PowerShell') }));
  assert.deepEqual(await monitor.probe(target), { known: true, availableBytes: 524288, source: 'statfs' });
  assert.deepEqual(called, [target, { bigint: true }]);
});

test('native numeric statfs results work without a subprocess', async () => {
  const monitor = createDiskSpaceMonitor({ platform: 'linux', fs: { statfs: async () => ({ bsize: 4096, bavail: 256 }) },
    execFile: () => assert.fail('No subprocess should run') });
  assert.equal((await monitor.probe('/synthetic/data')).availableBytes, MiB);
});

test('zero available blocks is a known full volume, not an unavailable probe', async () => {
  const result = await checkDiskSpace({ path: target, requiredBytes: 1, reserveBytes: 0 }, win({ fs: native(0) }));
  assert.equal(result.known, true);
  assert.equal(result.availableBytes, 0);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STORAGE_SPACE_LOW');
});

test('new data directories probe the nearest existing parent without writing', async () => {
  const calls = [];
  const monitor = createDiskSpaceMonitor(win({ fs: { statfs: async current => {
    calls.push(current);
    if (calls.length === 1) throw Object.assign(new Error('Synthetic missing directory'), { code: 'ENOENT' });
    if (calls.length === 2) throw Object.assign(new Error('Synthetic non-directory'), { code: 'ENOTDIR' });
    return { bsize: 4096n, bavail: 12n };
  } } }));
  const result = await monitor.probe('C:\\parent\\not-created\\result');
  assert.deepEqual(calls, ['C:\\parent\\not-created\\result', 'C:\\parent\\not-created', 'C:\\parent']);
  assert.equal(result.availableBytes, 49152);
});

test('native permission errors are not mistaken for an empty disk or traversed indefinitely', async () => {
  let calls = 0;
  const result = await createDiskSpaceMonitor({ platform: 'linux', fs: { statfs: async () => {
    calls++;
    throw Object.assign(new Error('Synthetic private path'), { code: 'EACCES' });
  } } }).probe('/synthetic/private');
  assert.equal(calls, 1);
  assert.equal(result.known, false);
  assert.equal(result.availableBytes, null);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('missing volume root terminates ancestor traversal and remains unknown', async () => {
  const calls = [];
  const result = await createDiskSpaceMonitor({ platform: 'linux', fs: { statfs: async current => {
    calls.push(current);
    throw Object.assign(new Error('Missing'), { code: 'ENOENT' });
  } } }).probe('/not-present/data');
  assert.deepEqual(calls, ['/not-present/data', '/not-present', '/']);
  assert.deepEqual(result, { known: false, availableBytes: null, source: 'unknown', reason: 'PROBE_UNAVAILABLE' });
});

test('native probe of a UNC target can report a valid remote volume', async () => {
  const unc = '\\\\synthetic-host\\share\\results';
  const monitor = createDiskSpaceMonitor(win({ fs: { statfs: async current => {
    assert.equal(current, unc);
    return { bsize: 1024n, bavail: 4096n };
  } } }));
  assert.equal((await monitor.probe(unc)).availableBytes, 4 * MiB);
});

test('pkg Node 18 fallback reads free space through a bounded hidden static DriveInfo helper', async () => {
  let invocation;
  const monitor = createDiskSpaceMonitor(win({ fs: {}, execFile: (command, args, options, callback) => {
    invocation = { command, args, options };
    callback(null, '{"availableBytes":"4294967296"}');
    return {};
  } }));
  assert.deepEqual(await monitor.probe(target), { known: true, availableBytes: 4294967296, source: 'powershell' });
  assert.equal(invocation.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(invocation.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.shell, false);
  assert(invocation.options.timeout > 0 && invocation.options.timeout <= 4000);
  assert.equal(invocation.options.maxBuffer, 4096);
  const script = Buffer.from(invocation.args[4], 'base64').toString('utf16le');
  assert(script.includes('[IO.Path]::GetPathRoot($target)'));
  assert(script.includes('$drive.AvailableFreeSpace'));
  assert.equal(script.includes(target), false);
  assert.equal(/Remove-Item|Set-Content|New-Item|Start-Process|Invoke-Expression/.test(script), false);
});

test('PowerShell path payload cannot become executable script text', async () => {
  const hostile = "C:\\synthetic ' ; $(Write-Output PRIVATE)\\결과";
  let script;
  const monitor = createDiskSpaceMonitor(win({ fs: {}, execFile: (_command, args, _options, callback) => {
    script = Buffer.from(args[4], 'base64').toString('utf16le');
    callback(null, '{"availableBytes":"1234567"}');
  } }));
  assert.equal((await monitor.probe(hostile)).availableBytes, 1234567);
  const payload = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
  assert(payload);
  assert.equal(Buffer.from(payload, 'base64').toString('utf8'), hostile);
  assert.equal(script.includes('PRIVATE'), false);
  assert.equal(script.includes('Write-Output'), false);
});

test('unsupported native statfs falls back to DriveInfo on Windows', async () => {
  let called = 0;
  const monitor = createDiskSpaceMonitor(win({ fs: { statfs: async () => {
    throw Object.assign(new Error('Synthetic old runtime'), { code: 'ENOSYS' });
  } }, execFile: (...args) => { called++; return callbackProbe({ availableBytes: '1000' })(...args); } }));
  assert.equal((await monitor.probe(target)).availableBytes, 1000);
  assert.equal(called, 1);
});

for (const [name, output] of [
  ['unknown UNC volume', '{"availableBytes":null}'],
  ['malformed JSON', 'not JSON'],
  ['negative bytes', '{"availableBytes":-1}'],
  ['fractional bytes', '{"availableBytes":12.5}'],
  ['unsafe integer', '{"availableBytes":"9999999999999999"}'],
  ['missing bytes', '{}'],
  ['boolean bytes', '{"availableBytes":true}'],
  ['empty bytes', '{"availableBytes":""}'],
  ['extra output', 'unexpected\n{"availableBytes":1}'],
  ['oversized output', ' '.repeat(4097)]
]) test(`PowerShell ${name} remains unknown without claiming zero free bytes`, async () => {
  const result = await createDiskSpaceMonitor(win({ fs: {}, execFile: (_command, _args, _options, callback) => callback(null, output) })).probe('\\\\synthetic-host\\share\\data');
  assert.equal(result.known, false);
  assert.equal(result.availableBytes, null);
});

for (const [name, result] of [
  ['absent results', null],
  ['missing bavail', { bsize: 1024n, bfree: 2n }],
  ['zero block size', { bsize: 0n, bavail: 2n }],
  ['negative available blocks', { bsize: 1024n, bavail: -1n }],
  ['fractional blocks', { bsize: 1024, bavail: 1.2 }],
  ['unsafe multiplication', { bsize: 4096n, bavail: 9007199254740991n }],
  ['nonfinite blocks', { bsize: 1024, bavail: Infinity }]
]) test(`native ${name} remains unknown`, async () => {
  const actual = await createDiskSpaceMonitor({ platform: 'linux', fs: { statfs: async () => result } }).probe('/synthetic');
  assert.equal(actual.known, false);
  assert.equal(actual.availableBytes, null);
});

test('a failed or synchronously unavailable helper remains unknown and does not expose raw stderr', async () => {
  for (const execFile of [
    (_command, _args, _options, callback) => callback(new Error('Synthetic C:\\private\\secrets'), '', 'private'),
    () => { throw new Error('Synthetic C:\\private\\secrets'); }
  ]) {
    const result = await createDiskSpaceMonitor(win({ fs: {}, execFile })).probe(target);
    assert.equal(result.availableBytes, null);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('a stuck native probe is bounded and cannot launch a second unbounded helper', async () => {
  const monitor = createDiskSpaceMonitor(win({ timeoutMs: 15, fs: { statfs: () => new Promise(() => {}) },
    execFile: () => assert.fail('Native timeout must consume the overall deadline') }));
  const result = await monitor.probe(target);
  assert.equal(result.reason, 'PROBE_TIMEOUT');
  assert.equal(result.availableBytes, null);
});

test('a stuck helper is bounded and only its own returned child is terminated', async () => {
  let killed = 0;
  const result = await createDiskSpaceMonitor(win({ timeoutMs: 15, fs: {}, execFile: () => ({ kill: () => { killed++; } }) })).probe(target);
  assert.equal(result.known, false);
  assert.equal(result.availableBytes, null);
  assert.equal(killed, 1);
});

for (const invalidPath of [undefined, null, '', ' ', 'C:\\bad\0path', 'x'.repeat(32768), 42]) {
  test(`invalid path ${typeof invalidPath}/${String(invalidPath).length} never performs I/O`, async () => {
    const monitor = createDiskSpaceMonitor(win({ fs: { statfs: () => assert.fail('No native probe') }, execFile: () => assert.fail('No helper') }));
    assert.deepEqual(await monitor.probe(invalidPath), { known: false, availableBytes: null, source: 'unknown', reason: 'INVALID_PATH' });
  });
}

test('low space returns a typed path-free result and assert throws the same technical fields', async () => {
  const monitor = createDiskSpaceMonitor(win({ fs: native(1000) }));
  const options = { path: 'C:\\PRIVATE\\folder', requiredBytes: 750, reserveBytes: 500 };
  const result = await monitor.check(options);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STORAGE_SPACE_LOW');
  assert.equal(result.message, LOW_SPACE_MESSAGE);
  assert.equal(result.availableBytes, 1000);
  assert.equal(result.requiredBytes, 750);
  assert.equal(result.reserveBytes, 500);
  assert.equal(result.totalRequiredBytes, 1250);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  await assert.rejects(monitor.assert(options), error => {
    assert.equal(error.code, 'STORAGE_SPACE_LOW');
    assert.equal(error.message, LOW_SPACE_MESSAGE);
    assert.equal(error.availableBytes, 1000);
    assert.equal(error.totalRequiredBytes, 1250);
    return true;
  });
});

test('exactly sufficient available space passes and asserts return the probe result', async () => {
  const monitor = createDiskSpaceMonitor(win({ fs: native(1250) }));
  const result = await monitor.assert({ path: target, requiredBytes: 750, reserveBytes: 500 });
  assert.equal(result.ok, true);
  assert.equal(result.code, null);
  assert.equal(result.message, '');
});

test('unknown disk availability does not become a false zero-space failure', async () => {
  const result = await checkDiskSpace({ path: '/synthetic', requiredBytes: MiB }, { platform: 'linux', fs: {} });
  assert.equal(result.ok, true);
  assert.equal(result.known, false);
  assert.equal(result.availableBytes, null);
  assert.equal(result.reserveBytes, DEFAULT_RESERVE_BYTES);
  assert.equal(result.code, null);
});

test('disk availability is read again after space is recovered rather than cached', async () => {
  let available = 0;
  const monitor = createDiskSpaceMonitor(win({ fs: { statfs: async () => ({ bsize: 1, bavail: available }) } }));
  assert.equal((await monitor.check({ path: target, requiredBytes: 100, reserveBytes: 50 })).ok, false);
  available = 150;
  assert.equal((await monitor.check({ path: target, requiredBytes: 100, reserveBytes: 50 })).ok, true);
});

test('default reserve protects result/checkpoint persistence separately from incoming payload', async () => {
  assert.equal(DEFAULT_RESERVE_BYTES, 512 * MiB);
  const result = await checkDiskSpace({ path: target, requiredBytes: MiB }, win({ fs: native(DEFAULT_RESERVE_BYTES) }));
  assert.equal(result.totalRequiredBytes, 513 * MiB);
  assert.equal(result.ok, false);
});

test('translation-only estimation reserves incoming payload plus modest checkpoint space', () => {
  assert.equal(estimateAnalysisDiskBytes({ uploadBytes: MiB, durationSeconds: 7200, translationOnly: true }), 33 * MiB);
});

test('fresh audio estimate scales with duration and PCM size rather than a video-size multiplier', () => {
  const short = estimateAnalysisDiskBytes({ durationSeconds: 1800 });
  const long = estimateAnalysisDiskBytes({ durationSeconds: 7200 });
  assert.equal(short, 52 * MiB + Math.ceil(1800 * 32000 * 1.05));
  assert.equal(long - short, Math.ceil(7200 * 32000 * 1.05) - Math.ceil(1800 * 32000 * 1.05));
  assert(long < 300 * MiB);
});

test('existing audio is not reserved again and upload bytes remain distinct', () => {
  assert.equal(estimateAnalysisDiskBytes({ durationSeconds: 7200, audioExists: true, uploadBytes: 100 * MiB }), 152 * MiB);
  assert.equal(estimateAnalysisDiskBytes({ durationSeconds: 7200, audioExists: true, frameCount: 0 }), 32 * MiB);
});

test('estimates stay finite and nonnegative for malformed or extreme metadata', () => {
  assert.equal(estimateAnalysisDiskBytes({ uploadBytes: -1, durationSeconds: Infinity, frameCount: -1 }), 52 * MiB);
  assert.equal(estimateAnalysisDiskBytes({ uploadBytes: Number.MAX_SAFE_INTEGER, durationSeconds: 7200 }), Number.MAX_SAFE_INTEGER);
  assert.equal(estimateAnalysisDiskBytes({ durationSeconds: 9999999999, frameCount: 500 }), 72 * MiB + Math.ceil(7 * 86400 * 32000 * 1.05));
});
