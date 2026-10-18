// Synthetic scheduling benchmark only. It does not launch FFmpeg, read videos,
// measure disk seek performance, or predict full analysis / model throughput.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { getFrameTimestamps, extractRepresentativeFrames } = require('../lib/video-analysis');

async function main() {
    const argument = process.argv.slice(2);
    if (argument.length && (argument.length !== 2 || argument[0] !== '--delay-ms' || !/^\d+$/.test(argument[1]))) {
        throw new Error('Usage: node scripts/benchmark_frame_extraction.js [--delay-ms 1..1000]');
    }
    const delayMs = argument.length ? Number(argument[1]) : 40;
    if (delayMs < 1 || delayMs > 1000) throw new Error('Synthetic delay must be between 1 and 1000 milliseconds.');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-frame-benchmark-'));
    const temporaryParent = await fs.realpath(os.tmpdir()), samples = getFrameTimestamps(7200);
    const results = [];
    try {
        for (const concurrency of [1, 2]) {
            const frameDir = path.join(directory, `workers-${concurrency}`);
            await fs.mkdir(frameDir);
            let active = 0, maximum = 0, requests = 0;
            const run = async (_binary, args) => {
                requests++; maximum = Math.max(maximum, ++active);
                try {
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                    await fs.writeFile(args.at(-1), `synthetic image at ${args[args.indexOf('-ss') + 1]}`);
                } finally { active--; }
            };
            const started = performance.now();
            const extracted = await extractRepresentativeFrames({ ffmpeg: 'synthetic-unused', videoPath: 'synthetic-unused',
                frameDir, timestamps: samples, run, concurrency });
            const elapsedMs = performance.now() - started;
            assert.equal(active, 0);
            assert.equal(requests, 10);
            assert.equal(maximum, concurrency);
            assert.deepEqual(extracted.warnings, []);
            const content = await Promise.all(extracted.frames.map(frame => fs.readFile(path.join(frameDir, frame.filename), 'utf8')));
            if (results.length) assert.deepEqual(content, results[0].content);
            results.push({ concurrency, requests, maximumInFlight: maximum, frameCount: extracted.frames.length,
                elapsedMs: Math.round(elapsedMs * 100) / 100, content });
        }
        process.stdout.write(JSON.stringify({ benchmark: 'synthetic frame scheduling', fixedMockDelayMs: delayMs,
            limitation: 'Fixed mock latency only; actual FFmpeg, disk, ASR, AI and full analysis speed are not measured.',
            outputsIdentical: true, results: results.map(({ content, ...result }) => result),
            syntheticSpeedup: Math.round(results[0].elapsedMs / results[1].elapsedMs * 100) / 100 }, null, 2) + '\n');
    } finally {
        const real = await fs.realpath(directory);
        assert.equal(path.dirname(real), temporaryParent);
        assert.ok(path.basename(real).startsWith('videorandom-frame-benchmark-'));
        await fs.rm(real, { recursive: true, force: true });
    }
}

main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
