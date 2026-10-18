const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { getFrameTimestamps, extractRepresentativeFrames, runProcess } = require('../lib/video-analysis');

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-frames-concurrency-'));
    const parent = await fs.realpath(os.tmpdir());
    t.after(async () => {
        const real = await fs.realpath(directory);
        assert.equal(path.dirname(real), parent);
        assert.ok(path.basename(real).startsWith('videorandom-frames-concurrency-'));
        await fs.rm(real, { recursive: true, force: true });
    });
    return directory;
}

function frameIndex(args, timestamps) {
    return timestamps.findIndex(timestamp => timestamp.toFixed(3) === args[args.indexOf('-ss') + 1]);
}

test('ten frames use at most two processes and retain sample order, names and FFmpeg quality arguments', async t => {
    const directory = await fixture(t), timestamps = getFrameTimestamps(7200);
    const completed = [], calls = [], progress = [];
    let active = 0, maximum = 0;
    const run = async (binary, args, options) => {
        const index = frameIndex(args, timestamps);
        calls.push({ binary, args, signal: options.signal });
        maximum = Math.max(maximum, ++active);
        try {
            await pause(index % 2 === 0 ? 15 : 1);
            await fs.writeFile(args.at(-1), `synthetic frame ${index}`);
            completed.push(index);
        } finally { active--; }
    };
    const result = await extractRepresentativeFrames({ ffmpeg: 'fixture-ffmpeg.exe', videoPath: 'fixture-video.mp4',
        frameDir: directory, timestamps, run, concurrency: 100, onProgress: (stage, percent) => progress.push({ stage, percent }) });
    assert.equal(maximum, 2, 'requested concurrency is always capped at two');
    assert.equal(active, 0);
    assert.equal(calls.length, 10);
    assert.notDeepEqual(completed, Array.from({ length: 10 }, (_, index) => index));
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.frames, timestamps.map((timestamp, index) => ({ timestamp, filename: `frame-${String(index + 1).padStart(2, '0')}.jpg`, caption: '' })));
    for (const [index, frame] of result.frames.entries()) {
        assert.equal(await fs.readFile(path.join(directory, frame.filename), 'utf8'), `synthetic frame ${index}`);
    }
    for (const call of calls) {
        const index = frameIndex(call.args, timestamps);
        assert.equal(call.binary, 'fixture-ffmpeg.exe');
        assert.ok(call.signal instanceof AbortSignal);
        assert.deepEqual(call.args.slice(0, -1), ['-nostdin', '-v', 'error', '-y', '-ss', timestamps[index].toFixed(3), '-i', 'fixture-video.mp4',
            '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn', '-vf', 'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2', '-q:v', '3']);
    }
    assert.deepEqual((await fs.readdir(directory)).sort(), result.frames.map(frame => frame.filename));
    assert.ok(progress.every((item, index) => item.stage === 'frames' && item.percent >= 5 && item.percent <= 30
        && (!index || item.percent >= progress[index - 1].percent)), 'out-of-order completions must not make progress go backwards');
});

test('a failed or empty image is discarded while the remaining frames continue in sample order', async t => {
    const directory = await fixture(t), timestamps = getFrameTimestamps(1800);
    let calls = 0;
    const run = async (_binary, args) => {
        const index = frameIndex(args, timestamps);
        calls++;
        await fs.writeFile(args.at(-1), index === 3 ? '' : `synthetic frame ${index}`);
        if (index === 1) throw new Error('synthetic decode failure');
    };
    const result = await extractRepresentativeFrames({ ffmpeg: 'fixture', videoPath: 'fixture', frameDir: directory, timestamps, run });
    assert.equal(calls, 10);
    assert.deepEqual(result.frames.map(frame => frame.timestamp), timestamps.filter((_, index) => index !== 1 && index !== 3));
    assert.equal(result.warnings.length, 2);
    assert.match(result.warnings[0], /synthetic decode failure/);
    assert.match(result.warnings[1], /이미지가 비어/);
    assert.deepEqual((await fs.readdir(directory)).sort(), result.frames.map(frame => frame.filename));
});

test('parent cancellation stops new work, waits for both processes and retains only finished frames', async t => {
    const directory = await fixture(t), timestamps = getFrameTimestamps(1000), controller = new AbortController();
    let calls = 0, active = 0, abortedChildSettled = false, releaseBoth;
    const bothStarted = new Promise(resolve => { releaseBoth = resolve; });
    const run = async (_binary, args, { signal }) => {
        const index = frameIndex(args, timestamps);
        calls++; active++;
        if (calls === 2) releaseBoth();
        try {
            await bothStarted;
            if (index === 0) { await fs.writeFile(args.at(-1), 'completed synthetic image'); return; }
            await fs.writeFile(args.at(-1), 'truncated synthetic image');
            await new Promise(resolve => {
                if (signal.aborted) resolve();
                else signal.addEventListener('abort', resolve, { once: true });
            });
            await pause(20);
            abortedChildSettled = true;
            throw Object.assign(new Error('fixture child closed'), { name: 'AbortError' });
        } finally { active--; }
    };
    let failure;
    try {
        await extractRepresentativeFrames({ ffmpeg: 'fixture', videoPath: 'fixture', frameDir: directory, timestamps, signal: controller.signal, run,
            onProgress: (_stage, percent) => { if (percent > 5) controller.abort(); } });
    } catch (error) { failure = error; }
    assert.equal(failure?.name, 'AbortError');
    assert.equal(calls, 2);
    assert.equal(active, 0, 'cancellation must not return while a process remains in flight');
    assert.equal(abortedChildSettled, true);
    assert.deepEqual(failure.frameExtraction.frames, [{ timestamp: timestamps[0], filename: 'frame-01.jpg', caption: '' }]);
    assert.deepEqual(await fs.readdir(directory), ['frame-01.jpg']);
});

test('an already cancelled request never starts a process or creates an image', async t => {
    const directory = await fixture(t), controller = new AbortController();
    controller.abort();
    let calls = 0;
    await assert.rejects(extractRepresentativeFrames({ ffmpeg: 'fixture', videoPath: 'fixture', frameDir: directory,
        timestamps: getFrameTimestamps(30), signal: controller.signal, run: async () => { calls++; } }), { name: 'AbortError' });
    assert.equal(calls, 0);
    assert.deepEqual(await fs.readdir(directory), []);
});

test('real owned child cancellation waits for process close and removes its unfinished image', async t => {
    const directory = await fixture(t), controller = new AbortController(), timestamps = getFrameTimestamps(20, 2);
    const ready = path.join(directory, 'child-ready.txt');
    let calls = 0;
    const run = async (_binary, args, { signal }) => {
        calls++;
        return runProcess(process.execPath, ['-e', "const fs=require('fs');fs.writeFileSync(process.argv[1],'unfinished fixture');fs.appendFileSync(process.argv[2],'ready\\n');setInterval(()=>{},1000)", args.at(-1), ready], { signal });
    };
    const pending = extractRepresentativeFrames({ ffmpeg: 'fixture', videoPath: 'fixture', frameDir: directory, timestamps, signal: controller.signal, run });
    for (let attempt = 0; attempt < 200; attempt++) {
        if ((await fs.readFile(ready, 'utf8').catch(() => '')).split('\n').filter(Boolean).length === 2) break;
        await pause(10);
    }
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(calls, 2);
    assert.deepEqual((await fs.readdir(directory)).filter(name => name !== 'child-ready.txt'), []);
});
