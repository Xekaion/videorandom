const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { getFrameTimestamps, getAudioChunks, parseTimestamp, parseSubtitles, splitTranscript, getToolsStatus, analyzeVideo, runProcess, retryBusyExecutable } = require('../lib/video-analysis');

test('temporary executable locks retry within a bounded schedule and preserve the final failure', async () => {
    let attempts = 0;
    const result = await retryBusyExecutable(async () => {
        if (++attempts < 3) throw Object.assign(new Error('scanner lock'), { code: attempts === 1 ? 'EBUSY' : 'ETXTBSY' });
        return 'tool ready';
    }, { delays: [0, 0] });
    assert.equal(result, 'tool ready');
    assert.equal(attempts, 3);
    const finalError = Object.assign(new Error('still locked'), { code: 'EBUSY' });
    attempts = 0;
    await assert.rejects(retryBusyExecutable(async () => { attempts++; throw finalError; }, { delays: [0, 0] }), error => error === finalError);
    assert.equal(attempts, 3);
    for (const error of [Object.assign(new Error('permission'), { code: 'EACCES' }), new Error('processing exit code 1')]) {
        attempts = 0;
        await assert.rejects(retryBusyExecutable(async () => { attempts++; throw error; }, { delays: [0, 0] }), failure => failure === error);
        assert.equal(attempts, 1, 'permission and processing failures must not retry');
    }
});

test('cancelling during a locked executable retry stops before a second launch', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const pending = retryBusyExecutable(async () => {
        attempts++;
        setImmediate(() => controller.abort());
        throw Object.assign(new Error('scanner lock'), { code: 'EBUSY' });
    }, { signal: controller.signal });
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(attempts, 1);
});

test('default captures cover the complete running time and custom timestamps are validated', () => {
    const timestamps = getFrameTimestamps(3600);
    assert.equal(timestamps.length, 10);
    assert.equal(timestamps[0], 180);
    assert.equal(timestamps.at(-1), 3420);
    assert.deepEqual(getFrameTimestamps(3600, 10, [300, 900, 1800, 900, -1, 4000, NaN]), [300, 900, 1800]);
    assert.throws(() => getFrameTimestamps(0), /영상 길이/);
    assert.throws(() => getFrameTimestamps(10, 10, [11]), /벗어/);
});

test('audio chunks stay under 10 minutes and cover every second with small overlap', () => {
    for (const duration of [0.3, 600, 601, 3600, 7203]) {
        const chunks = getAudioChunks(duration);
        assert.equal(chunks[0].start, 0);
        assert.equal(chunks.at(-1).start + chunks.at(-1).duration, duration);
        chunks.forEach((chunk, index) => {
            assert.ok(chunk.duration <= 600 && chunk.duration > 0);
            if (index) assert.ok(chunk.start <= chunks[index - 1].start + chunks[index - 1].duration);
        });
    }
});

test('SRT and VTT preserve timed Korean multiline dialogue and ignore malformed cues', () => {
    const srt = '\uFEFF1\r\n00:00:01,500 --> 00:00:03,000\r\n<b>안녕</b>\r\n잘 지냈어?\r\n\r\n2\r\n00:00:04,000 --> 00:00:02,000\r\ninvalid\r\n';
    assert.deepEqual(parseSubtitles(srt), [{ start: 1.5, end: 3, text: '안녕\n잘 지냈어?' }]);
    const vtt = 'WEBVTT\n\nNOTE ignore\ncomment\n\ncue\n01:30.000 --> 01:33.250 align:start position:0%\n<c.green>Go &amp; find it.</c>\n';
    assert.deepEqual(parseSubtitles(vtt, 'vtt'), [{ start: 90, end: 93.25, text: 'Go & find it.' }]);
    assert.equal(parseTimestamp('1:02:03.45'), 3723.45);
    assert.ok(Number.isNaN(parseTimestamp('00:61:12.000')));
});

test('ASS reads Events format and retains commas and line breaks inside dialogue', () => {
    const ass = '[Script Info]\nTitle: ignored\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:02.50,0:00:05.00,Default,,0,0,0,,{\\i1}안녕, 친구\\N다시 만났네{\\i0}\n';
    assert.deepEqual(parseSubtitles(ass, 'ass'), [{ start: 2.5, end: 5, text: '안녕, 친구\n다시 만났네' }]);
});

test('long transcript chunking retains every character in order', () => {
    const transcript = [{ start: 1, end: 2, text: '처음' }, { start: 10, end: 11, text: '가'.repeat(24001) }, { start: 50, end: 51, text: '마지막' }];
    const small = splitTranscript(transcript, 500);
    assert.ok(small.length > 40);
    assert.ok(small.every(chunk => chunk.length <= 500));
    assert.equal(small.join(''), splitTranscript(transcript, 100000).join(''));
});

test('real local extraction, embedded subtitles, corrupt files and cancellation', async t => {
    const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'videorandom-analysis-'));
    const dataDir = path.join(folder, 'results');
    try {
        const tools = await getToolsStatus(dataDir);
        if (!tools.available) { t.skip('ffmpeg/ffprobe dependencies are unavailable'); return; }
        const videoPath = path.join(folder, '영상 테스트.mp4');
        await runProcess(tools.ffmpeg.path, ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10',
            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', videoPath]);
        const srtPath = path.join(folder, '영상 테스트.srt');
        await fs.promises.writeFile(srtPath, '1\n00:00:00,500 --> 00:00:01,500\n실제 테스트 대사입니다.\n\n2\n00:00:02,000 --> 00:00:02,800\n끝까지 기록합니다.\n', 'utf8');
        await t.test('local mode extracts 10 changing JPEGs and sidecar dialogue without inventing a plot', async () => {
            const record = await analyzeVideo({ path: videoPath, id: 'local-test' }, { mode: 'local' }, { dataDir });
            assert.equal(record.status, 'completed', record.error || record.warnings.join('\n'));
            assert.equal(record.frames.length, 10);
            assert.ok(record.duration >= 3 && record.duration < 3.2);
            assert.equal(record.transcript.length, 2);
            assert.equal(record.transcript[1].text, '끝까지 기록합니다.');
            assert.equal(record.summary, '');
            assert.equal(record.plot, '');
            assert.deepEqual(record.labels, []);
            const hashes = await Promise.all(record.frames.map(async frame => {
                const image = await fs.promises.readFile(path.join(dataDir, 'frames', record.id, frame.filename));
                assert.equal(image.readUInt16BE(0), 0xFFD8);
                return crypto.createHash('sha256').update(image).digest('hex');
            }));
            assert.ok(new Set(hashes).size > 5, 'time samples must come from distinct actual frames');
        });
        await t.test('embedded text subtitles are read when sidecar is absent', async () => {
            const embeddedPath = path.join(folder, 'embedded.mkv');
            await runProcess(tools.ffmpeg.path, ['-nostdin', '-v', 'error', '-y', '-i', videoPath, '-i', srtPath,
                '-map', '0', '-map', '1:0', '-c', 'copy', '-metadata:s:s:0', 'language=kor', embeddedPath]);
            const record = await analyzeVideo({ path: embeddedPath, id: 'embedded-test' }, { frameCount: 2 }, { dataDir });
            assert.equal(record.status, 'completed', record.error || record.warnings.join('\n'));
            assert.equal(record.transcriptSource, 'embedded:kor');
            assert.equal(record.transcript.length, 2);
        });
        await t.test('generated Korean output is excluded only when trusted path and exact bytes match', async t => {
            const generatedVideo = path.join(folder, 'generated-neutral.mp4');
            const koreanPath = path.join(folder, 'generated-neutral.ko.srt');
            const japanesePath = path.join(folder, 'generated-neutral.ja.srt');
            const originalJapanese = '1\n00:00:00,500 --> 00:00:02,500\n駅はどこですか。\n';
            const generatedKorean = '1\n00:00:00,500 --> 00:00:02,500\n역은 어디인가요?\n';
            await fs.promises.copyFile(videoPath, generatedVideo);
            await fs.promises.writeFile(koreanPath, generatedKorean, 'utf8');
            await fs.promises.writeFile(japanesePath, originalJapanese, 'utf8');
            const provenance = [{ path: process.platform === 'win32' ? koreanPath.toUpperCase() : koreanPath,
                sha256: crypto.createHash('sha256').update(Buffer.from(generatedKorean)).digest('hex') }];
            let attempt = 0;
            const extract = (context = {}, options = {}) => analyzeVideo({ path: generatedVideo, id: `generated-${++attempt}` },
                { mode: 'local', frameCount: 1, ...options }, { dataDir, ...context });
            await t.test('matching generated Korean file leaves original Japanese cues available', async () => {
                const record = await extract({ generatedSubtitleFiles: provenance });
                assert.equal(record.status, 'completed', record.error);
                assert.equal(record.transcriptSource, 'sidecar:generated-neutral.ja.srt');
                assert.equal(record.transcript[0].text, '駅はどこですか。');
            });
            await t.test('ordinary user Korean subtitles keep their existing priority', async () => {
                const record = await extract();
                assert.equal(record.transcriptSource, 'sidecar:generated-neutral.ko.srt');
                assert.equal(record.transcript[0].text, '역은 어디인가요?');
            });
            await t.test('API-style options cannot substitute trusted subtitle provenance', async () => {
                const record = await extract({}, { generatedSubtitleFiles: provenance });
                assert.equal(record.transcriptSource, 'sidecar:generated-neutral.ko.srt');
            });
            await t.test('matching hash for a different canonical path does not exclude user subtitles', async () => {
                const otherPath = path.join(folder, 'unrelated.ko.srt');
                await fs.promises.writeFile(otherPath, generatedKorean);
                const record = await extract({ generatedSubtitleFiles: [{ path: otherPath, sha256: provenance[0].sha256 }] });
                assert.equal(record.transcriptSource, 'sidecar:generated-neutral.ko.srt');
            });
            await t.test('edited generated Korean subtitles become readable user input', async () => {
                await fs.promises.writeFile(koreanPath, generatedKorean.replace('역은 어디인가요?', '사용자가 직접 고친 자막입니다.'));
                const record = await extract({ generatedSubtitleFiles: provenance });
                assert.equal(record.transcriptSource, 'sidecar:generated-neutral.ko.srt');
                assert.equal(record.transcript[0].text, '사용자가 직접 고친 자막입니다.');
                await fs.promises.writeFile(koreanPath, generatedKorean);
            });
            await t.test('generated-only subtitles leave audio available for fresh speech recognition', async () => {
                await fs.promises.unlink(japanesePath);
                const record = await extract({ generatedSubtitleFiles: provenance });
                assert.equal(record.hasAudio, true);
                assert.equal(record.transcriptSource, 'none');
                assert.deepEqual(record.transcript, []);
            });
            await t.test('owned generated Korean output does not hide embedded original subtitles', async () => {
                await fs.promises.writeFile(japanesePath, originalJapanese);
                const embeddedVideo = path.join(folder, 'generated-embedded.mkv');
                await runProcess(tools.ffmpeg.path, ['-nostdin', '-v', 'error', '-y', '-i', generatedVideo, '-i', japanesePath,
                    '-map', '0', '-map', '1:0', '-c', 'copy', '-metadata:s:s:0', 'language=jpn', embeddedVideo]);
                const embeddedKorean = path.join(folder, 'generated-embedded.ko.srt');
                await fs.promises.writeFile(embeddedKorean, generatedKorean);
                const record = await analyzeVideo({ path: embeddedVideo, id: 'generated-embedded' }, { frameCount: 1 }, {
                    dataDir, generatedSubtitleFiles: [{ path: embeddedKorean, sha256: provenance[0].sha256 }]
                });
                assert.equal(record.status, 'completed', record.error);
                assert.equal(record.transcriptSource, 'embedded:jpn');
                assert.equal(record.transcript[0].text, '駅はどこですか。');
            });
        });
        await t.test('a corrupt scanned video is failed and has no fabricated content', async () => {
            const invalidPath = path.join(folder, 'fake-story.mp4');
            await fs.promises.writeFile(invalidPath, 'This is a placeholder, not a video.');
            const record = await analyzeVideo({ path: invalidPath, id: 'corrupt-test' }, {}, { dataDir });
            assert.equal(record.status, 'failed');
            assert.equal(record.id, 'corrupt-test');
            assert.equal(record.frames.length, 0);
            assert.equal(record.summary, '');
            assert.ok(record.error);
        });
        await t.test('cancellation returns extracted frames in AbortError.record', async () => {
            const controller = new AbortController();
            await assert.rejects(analyzeVideo({ path: videoPath, id: 'cancel-test' }, {}, {
                dataDir, signal: controller.signal,
                onProgress(stage, percent) { if (stage === 'frames' && percent >= 10) controller.abort(); }
            }), error => {
                assert.equal(error.name, 'AbortError');
                assert.equal(error.record.id, 'cancel-test');
                assert.equal(error.record.status, 'partial');
                assert.equal(error.record.frames.length, 2);
                return true;
            });
        });
        await t.test('missing AI key preserves images and local transcript without calling API', async () => {
            const record = await analyzeVideo({ path: videoPath, id: 'no-key-test' }, { mode: 'ai', frameCount: 1 }, { dataDir });
            assert.equal(record.status, 'partial');
            assert.equal(record.frames.length, 1);
            assert.equal(record.transcript.length, 2);
            assert.match(record.error, /API 키/);
        });
    } finally {
        await fs.promises.rm(folder, { recursive: true, force: true });
    }
});
