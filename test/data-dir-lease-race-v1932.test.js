'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const leaseFile = path.resolve(__dirname, '../lib/data-dir-lease.js');
const leaseSource = fs.readFileSync(leaseFile, 'utf8');
const nonce = value => value.repeat(32);
async function directory(t) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'videorandom-lease-race-v1932-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    return root;
}
function deadClaim(root, pid = 900001, claimNonce = nonce('a'), changes = {}) {
    const folder = path.join(root, '.app-owner');
    fs.mkdirSync(folder, { recursive: true });
    const filename = path.join(folder, `owner-${pid}-${claimNonce}.json`);
    fs.writeFileSync(filename, JSON.stringify({ pid, nonce: claimNonce, version: 'owned-fixture', ...changes }));
    return filename;
}
function actor(pid, { filesystem = fs, live = new Set([900002, 900003]) } = {}) {
    const module = { exports: {} };
    vm.runInNewContext(leaseSource, { module, exports: module.exports,
        require: name => name === 'fs' ? filesystem : require(name),
        process: { pid, platform: process.platform, kill(target) {
            if (live.has(target)) return true;
            throw Object.assign(new Error('Owned synthetic dead process'), { code: 'ESRCH' });
        } } }, { filename: leaseFile });
    return module.exports;
}

test('a delayed stale handle cannot move or remove the independent claim of an already live owner', async t => {
    const root = await directory(t), original = deadClaim(root);
    const lockDir = path.join(root, '.app-owner');
    let firstLease, firstPublished = false;
    const first = actor(900002);
    const secondFs = Object.create(fs);
    function publishFirst() {
        if (firstPublished) return;
        firstPublished = true;
        firstLease = first.acquireDataDirLease(root, { version: 'first-owned-fixture' });
        t.after(() => firstLease.release());
    }
    secondFs.renameSync = (source, target) => {
        if (source !== original) return fs.renameSync(source, target);
        // Model Windows opening the old source handle before A completes its
        // rename. The historical implementation allowed that same inode to be
        // renamed again after A's final ownership check had already returned.
        const openedInode = fs.statSync(source).ino;
        publishFirst();
        const movedSource = fs.readdirSync(lockDir).map(name => path.join(lockDir, name))
            .find(filename => fs.statSync(filename).ino === openedInode);
        if (!movedSource) throw Object.assign(new Error('Owned stale inode was removed'), { code: 'ENOENT' });
        return fs.renameSync(movedSource, target);
    };
    secondFs.unlinkSync = filename => {
        if (filename === original) publishFirst();
        return fs.unlinkSync(filename);
    };
    const second = actor(900003, { filesystem: secondFs });
    let secondLease, error;
    try { secondLease = second.acquireDataDirLease(root); }
    catch (failure) { error = failure; }
    t.after(() => secondLease?.release());
    assert(firstPublished, 'the first actor completes ownership during the second actor\'s stale operation');
    assert(firstLease);
    assert.equal(secondLease, undefined, 'the delayed contender cannot also own the live store');
    assert.equal(error?.code, 'VIDEORANDOM_DATA_BUSY');
    const claims = fs.readdirSync(lockDir);
    assert.equal(claims.length, 1);
    assert.match(claims[0], /^owner-900002-/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockDir, claims[0]), 'utf8')).pid, 900002);
});

test('several valid dead claims recover through a fresh claim with its own PID and nonce', async t => {
    const root = await directory(t);
    deadClaim(root, 900001, nonce('a'));
    deadClaim(root, 900004, nonce('b'));
    const lease = actor(900002).acquireDataDirLease(root, { version: 'owned-new-version' });
    t.after(() => lease.release());
    const lockDir = path.join(root, '.app-owner'), names = fs.readdirSync(lockDir);
    assert.equal(names.length, 1);
    assert.match(names[0], /^owner-900002-[a-f0-9]{32}\.json$/);
    const stored = JSON.parse(fs.readFileSync(path.join(lockDir, names[0]), 'utf8'));
    assert.equal(stored.pid, 900002);
    assert.equal(stored.version, 'owned-new-version');
    assert.equal(names[0], `owner-900002-${stored.nonce}.json`);
    lease.release();
    assert.deepEqual(fs.readdirSync(root), [], 'the old and newly prepared claims are cleaned without leftovers');
});

for (const invalid of ['unknown-file', 'invalid-json', 'invalid-provenance', 'live-owner'])
    test(`${invalid} still fails closed and preserves the existing claim bytes`, async t => {
        const root = await directory(t);
        let filename = deadClaim(root, invalid === 'live-owner' ? 900003 : 900001);
        if (invalid === 'unknown-file') {
            const next = path.join(root, '.app-owner', 'unknown-file'); fs.renameSync(filename, next); filename = next;
        }
        if (invalid === 'invalid-json') fs.writeFileSync(filename, '{owned synthetic invalid json');
        if (invalid === 'invalid-provenance') fs.writeFileSync(filename, JSON.stringify({ pid: 0, nonce: 'invalid' }));
        const bytes = fs.readFileSync(filename);
        assert.throws(() => actor(900002).acquireDataDirLease(root), { code: 'VIDEORANDOM_DATA_BUSY' });
        assert.deepEqual(fs.readFileSync(filename), bytes);
        assert.deepEqual(fs.readdirSync(root), ['.app-owner'], 'failed attempts remove only their own prepared temporary file');
    });

test('a delayed rmdir cannot remove another fresh, nonempty owned claim', async t => {
    const root = await directory(t); deadClaim(root);
    const lockDir = path.join(root, '.app-owner');
    const delayedFs = Object.create(fs);
    let winner;
    delayedFs.rmdirSync = filename => {
        if (filename === lockDir && !winner) {
            fs.rmdirSync(lockDir);
            winner = actor(900002).acquireDataDirLease(root);
            t.after(() => winner.release());
        }
        return fs.rmdirSync(filename);
    };
    assert.throws(() => actor(900003, { filesystem: delayedFs }).acquireDataDirLease(root), { code: 'VIDEORANDOM_DATA_BUSY' });
    assert(winner);
    const claims = fs.readdirSync(lockDir);
    assert.equal(claims.length, 1); assert.match(claims[0], /^owner-900002-/);
});

test('IPC-gated stale recovery retains exactly one live owner until every contender has answered', { timeout: 60000 }, async t => {
    const root = await directory(t);
    const code = `
        const { acquireDataDirLease } = require(process.argv[1]);
        let lease;
        process.on('message', command => {
            if (command === 'acquire') {
                try { lease = acquireDataDirLease(process.argv[2]); process.send({ result: 'owned', pid: process.pid }); }
                catch (error) { process.send({ result: error.code === 'VIDEORANDOM_DATA_BUSY' ? 'busy' : 'error', code: error.code }); }
            }
            if (command === 'release') { lease?.release(); process.disconnect(); }
        });
        process.send({ ready: true });
    `;
    for (let round = 0; round < 5; round++) {
        const folder = path.join(root, `owned-round-${round}`); await fsp.mkdir(folder);
        const stale = spawn(process.execPath, ['-e', 'require(process.argv[1]).acquireDataDirLease(process.argv[2]);', leaseFile, folder],
            { windowsHide: true, stdio: 'ignore' });
        assert.equal(await new Promise(resolve => stale.once('close', resolve)), 0);
        const contenders = Array.from({ length: 6 }, () => {
            const child = spawn(process.execPath, ['-e', code, leaseFile, folder], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
            let readyResolve, outcomeResolve, rejectReady, rejectOutcome;
            const ready = new Promise((resolve, reject) => { readyResolve = resolve; rejectReady = reject; });
            const outcome = new Promise((resolve, reject) => { outcomeResolve = resolve; rejectOutcome = reject; });
            const closed = new Promise(resolve => child.once('close', resolve));
            child.on('message', message => message.ready ? readyResolve() : outcomeResolve(message));
            child.on('error', error => { rejectReady(error); rejectOutcome(error); });
            closed.then(() => { const error = new Error('Owned contender exited before responding'); rejectReady(error); rejectOutcome(error); });
            t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; });
            return { child, ready, outcome, closed };
        });
        await Promise.all(contenders.map(item => item.ready));
        for (const contender of contenders) contender.child.send('acquire');
        const outcomes = await Promise.all(contenders.map(item => item.outcome));
        assert.equal(outcomes.filter(item => item.result === 'owned').length, 1, JSON.stringify({ round, outcomes }));
        assert.equal(outcomes.filter(item => item.result === 'busy').length, 5, JSON.stringify({ round, outcomes }));
        const ownerIndex = outcomes.findIndex(item => item.result === 'owned');
        const owner = contenders[ownerIndex].child;
        assert.equal(owner.exitCode, null); assert.equal(owner.signalCode, null);
        assert.equal(process.kill(owner.pid, 0), true, 'the sole owner remains alive before the explicit release');
        const claims = await fsp.readdir(path.join(folder, '.app-owner'));
        assert.equal(claims.length, 1); assert(claims[0].startsWith(`owner-${owner.pid}-`));
        for (const contender of contenders) contender.child.send('release');
        assert.deepEqual(await Promise.all(contenders.map(item => item.closed)), Array(6).fill(0));
        assert.deepEqual(await fsp.readdir(folder), []);
    }
});
