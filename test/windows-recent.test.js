const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const fs = require('fs');
const path = require('path');
const { recoverRecentVideos } = require('../lib/windows-recent');

const environment = { APPDATA: 'C:\\Users\\영상 사용자\\AppData\\Roaming', SystemRoot: 'C:\\Windows' };
const recent = path.win32.join(environment.APPDATA, 'Microsoft', 'Windows', 'Recent');
const observedAt = '2026-10-14T02:03:04.1234567Z';
function shortcut(target, link = '영상.lnk', time = observedAt) {
    return { path: target, sourcePath: path.win32.join(recent, link), observedAt: time };
}

function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.killed = 0;
    child.kill = () => { child.killed++; return true; };
    return child;
}

function successfulSpawn(payload, onCall) {
    return (...args) => {
        if (onCall) onCall(...args);
        const child = fakeChild();
        setImmediate(() => {
            const data = Buffer.from(JSON.stringify(payload), 'utf8');
            // Split inside a multibyte sequence; decoding must happen after concatenation.
            child.stdout.write(data.subarray(0, 17));
            child.stdout.write(data.subarray(17));
            child.emit('close', 0);
        });
        return child;
    };
}

test('non-Windows and missing roaming directory return useful warnings without spawning', async () => {
    const spawnImpl = () => { throw new Error('Must not spawn'); };
    for (const options of [{ platform: 'linux', environment }, { platform: 'win32', environment: {} }, { platform: 'win32', environment: { APPDATA: 'relative' } }]) {
        const result = await recoverRecentVideos({ ...options, spawnImpl });
        assert.deepEqual(result.entries, []);
        assert.equal(result.warnings.length, 1);
    }
});

test('runs only the static trusted script with encoded arguments and preserves Unicode metadata', async () => {
    const maliciousEnvironment = { ...environment, APPDATA: `${environment.APPDATA}; Write-Output SECRET` };
    const sourcePath = path.win32.join(maliciousEnvironment.APPDATA, 'Microsoft', 'Windows', 'Recent', '한글.lnk');
    const payload = { entries: [{ path: 'D:\\영상\\줄거리 🎬.MP4', observedAt, sourcePath }], warnings: [] };
    const result = await recoverRecentVideos({ platform: 'win32', environment: maliciousEnvironment, spawnImpl: successfulSpawn(payload, (binary, args, options) => {
        assert.equal(binary, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
        assert.equal(Buffer.from(args[4], 'base64').toString('utf16le'), fs.readFileSync(path.join(__dirname, '..', 'scripts', 'recover_recent.ps1'), 'utf8'));
        assert.equal(args.length, 5);
        assert.equal(options.shell, false);
        assert.equal(options.windowsHide, true);
        assert.equal(options.env, maliciousEnvironment);
        assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore']);
    }) });
    assert.deepEqual(result, { entries: [{ path: 'D:\\영상\\줄거리 🎬.MP4', name: '줄거리 🎬.MP4', ext: '.mp4', observedAt: '2026-10-14T02:03:04.123Z', sourcePath }], warnings: [] });
});

test('filters unsafe, non-video, malformed timestamp and foreign source targets while retaining missing-file evidence', async () => {
    const valid = shortcut('Z:\\지금은 없는 영상\\이전영상.MKV');
    const entries = [
        valid,
        { ...valid },
        shortcut('movie.mp4', 'relative.lnk'),
        shortcut('C:movie.mp4', 'driveRelative.lnk'),
        shortcut('\\movie.mp4', 'rooted.lnk'),
        shortcut('https://example.com/movie.mp4', 'url.lnk'),
        shortcut('C:\\영상\\run.exe', 'program.lnk'),
        shortcut('C:\\영상\\nul\u0000.mp4', 'null.lnk'),
        shortcut('\\\\.\\device\\movie.mp4', 'device.lnk'),
        { ...shortcut('C:\\영상\\movie.mp4'), sourcePath: 'C:\\Elsewhere\\foreign.lnk' },
        { ...shortcut('C:\\영상\\movie.mp4'), sourcePath: path.win32.join(recent, 'nested', 'foreign.lnk') },
        { ...shortcut('C:\\영상\\movie.mp4'), sourcePath: path.win32.join(recent, 'notShortcut.txt') },
        shortcut('C:\\영상\\movie.mp4', 'bad-date.lnk', 'not a date'),
        shortcut('C:\\영상\\movie.mp4', 'infinite-date.lnk', '2026-99-99T99:99:99Z'),
        shortcut('\\\\server\\share\\영상.mov', 'network.lnk', '2026-10-14T03:00:00Z'),
        shortcut('\\\\?\\C:\\길어진 경로\\영상.ts', 'long-path.lnk', '2026-10-14T01:00:00Z'),
        null
    ];
    const result = await recoverRecentVideos({ platform: 'win32', environment, spawnImpl: successfulSpawn({ entries, warnings: ['Windows 최근 항목 기록입니다.'] }) });
    assert.equal(result.entries.length, 3);
    assert.equal(result.entries[0].path, '\\\\server\\share\\영상.mov');
    assert.equal(result.entries[1].path, valid.path);
    assert.equal(result.entries[2].path, '\\\\?\\C:\\길어진 경로\\영상.ts');
    assert.deepEqual(result.warnings, ['Windows 최근 항목 기록입니다.']);
});

test('shortcut observations on different dates remain distinguishable', async () => {
    const result = await recoverRecentVideos({ platform: 'win32', environment, spawnImpl: successfulSpawn({ entries: [shortcut('C:\\영상\\movie.mp4'), shortcut('C:\\영상\\movie.mp4', '영상.lnk', '2026-10-13T03:00:00Z')], warnings: [] }) });
    assert.equal(result.entries.length, 2);
    assert.notEqual(result.entries[0].observedAt, result.entries[1].observedAt);
});

test('failed startup, child failure and malformed output return safe errors without private output', async () => {
    const providers = [
        () => { throw new Error('secret C:\\private\\account'); },
        () => { const child = fakeChild(); setImmediate(() => child.emit('error', new Error('secret'))); return child; },
        () => { const child = fakeChild(); setImmediate(() => child.emit('close', 5)); return child; },
        successfulSpawn(null),
        successfulSpawn([]),
        () => { const child = fakeChild(); setImmediate(() => { child.stdout.write('not JSON secret'); child.emit('close', 0); }); return child; }
    ];
    for (const spawnImpl of providers) {
        const result = await recoverRecentVideos({ platform: 'win32', environment, spawnImpl });
        assert.deepEqual(result.entries, []);
        assert.equal(result.warnings.length, 1);
        assert.doesNotMatch(result.warnings[0], /secret|private/);
    }
});

test('oversized output and process timeout stop the child with bounded warnings', async () => {
    for (const kind of ['output', 'timeout']) {
        const child = fakeChild();
        const pending = recoverRecentVideos({ platform: 'win32', environment, maxOutputBytes: 16, timeoutMs: kind === 'timeout' ? 5 : 1000, spawnImpl: () => {
            if (kind === 'output') setImmediate(() => child.stdout.write(Buffer.alloc(17)));
            return child;
        } });
        const result = await pending;
        assert.deepEqual(result.entries, []);
        assert.equal(result.warnings.length, 1);
        assert.equal(child.killed, 1);
        child.emit('close', 0);
    }
});

test('cancellation stops a running process and never spawns when already cancelled', async () => {
    const initial = new AbortController();
    initial.abort();
    await assert.rejects(recoverRecentVideos({ platform: 'win32', environment, signal: initial.signal, spawnImpl: () => { throw new Error('Should not spawn'); } }), { name: 'AbortError' });
    const controller = new AbortController();
    const child = fakeChild();
    const pending = recoverRecentVideos({ platform: 'win32', environment, signal: controller.signal, spawnImpl: () => child });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(child.killed, 1);
});

test('PowerShell reads only direct shortcuts and never runs media or writes shortcuts', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'recover_recent.ps1'), 'utf8');
    assert.match(script, /Get-ChildItem -LiteralPath \$recentDirectory -Filter '\*\.lnk' -File/);
    assert.match(script, /\.CreateShortcut\(\$link\.FullName\)/);
    assert.match(script, /\$shortcut\.TargetPath/);
    assert.match(script, /\$link\.LastWriteTimeUtc\.ToString\('o'\)/);
    assert.doesNotMatch(script, /-Recurse|Invoke-Item|Start-Process|\.Save\(/);
    assert.match(script, /\$limit = 50000/);
});
