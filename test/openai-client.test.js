const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Writable, Readable } = require('stream');
const { structuredResponse, transcribeAudio } = require('../lib/openai-client');
const { getToolsStatus, analyzeVideo, runProcess } = require('../lib/video-analysis');

const TEST_KEY = 'unit-test-credential-never-real';
const SCHEMA = { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } }, required: ['summary'] };
const responseFor = result => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] });

// This intercepts the native HTTP transport. None of these tests can contact OpenAI.
function mockTransport(t, handler) {
    const requests = [];
    t.mock.method(https, 'request', options => {
        const capture = { options, chunks: [] };
        requests.push(capture);
        const request = new Writable({
            write(chunk, encoding, callback) { capture.chunks.push(Buffer.from(chunk)); callback(); },
            final(callback) {
                capture.body = Buffer.concat(capture.chunks);
                callback();
                queueMicrotask(() => {
                    if (!request.destroyed || request.writableFinished) handler(request, capture);
                });
            }
        });
        request.setTimeout = (milliseconds, callback) => { capture.timeout = milliseconds; request.timeoutHandler = callback; return request; };
        request.respond = (status, body, raw = false) => {
            const response = Readable.from([Buffer.from(raw ? body : JSON.stringify(body))]);
            response.statusCode = status;
            request.emit('response', response);
        };
        return request;
    });
    return requests;
}

function summarize(options = {}) {
    return structuredResponse({
        apiKey: TEST_KEY, model: 'gpt-4.1-mini', instructions: 'Only analyze supplied evidence.',
        content: [{ type: 'input_text', text: 'Provided transcript' }, { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/2Q==', detail: 'auto' }],
        schema: SCHEMA, schemaName: 'test_summary', ...options
    });
}

test('Responses request uses structured text.format, actual images, and store:false', async t => {
    const requests = mockTransport(t, request => request.respond(200, responseFor({ summary: '검증된 요약' })));
    const result = await summarize();
    assert.deepEqual(result, { summary: '검증된 요약' });
    assert.equal(requests.length, 1);
    const { options, body } = requests[0];
    assert.equal(options.hostname, 'api.openai.com');
    assert.equal(options.path, '/v1/responses');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, `Bearer ${TEST_KEY}`);
    assert.equal(options.headers['Content-Length'], body.length);
    const payload = JSON.parse(body.toString('utf8'));
    assert.equal(payload.store, false);
    assert.equal(payload.model, 'gpt-4.1-mini');
    assert.deepEqual(payload.text.format, { type: 'json_schema', name: 'test_summary', strict: true, schema: SCHEMA });
    assert.equal(payload.input[0].content[1].type, 'input_image');
    assert.match(payload.input[0].content[1].image_url, /^data:image\/jpeg;base64,/);
    assert.equal(payload.instructions, 'Only analyze supplied evidence.');
});

test('Responses refusals and incomplete outputs are errors, not successful summaries', async t => {
    const results = [
        { status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'No analysis.' }] }] },
        { status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' } },
        { status: 'completed', output: [{ content: [{ type: 'output_text', text: 'invalid JSON' }] }] }
    ];
    mockTransport(t, request => request.respond(200, results.shift()));
    await assert.rejects(summarize(), /거절/);
    await assert.rejects(summarize(), /incomplete/);
    await assert.rejects(summarize(), /JSON/);
});

test('provider errors retain HTTP status and redact credential before persistence', async t => {
    mockTransport(t, request => request.respond(401, { error: { message: `Invalid key ${TEST_KEY}`, code: 'invalid_api_key' } }));
    await assert.rejects(summarize(), error => {
        assert.equal(error.statusCode, 401);
        assert.equal(error.code, 'invalid_api_key');
        assert.match(error.message, /REDACTED/);
        assert.ok(!error.message.includes(TEST_KEY));
        return true;
    });
});

test('cancellation aborts both before request and during a pending response', async t => {
    const before = new AbortController();
    before.abort();
    const during = new AbortController();
    const requests = mockTransport(t, () => during.abort());
    await assert.rejects(summarize({ signal: before.signal }), { name: 'AbortError' });
    assert.equal(requests.length, 0);
    await assert.rejects(summarize({ signal: during.signal }), { name: 'AbortError' });
    assert.equal(requests.length, 1);
});

test('network timeout rejects instead of leaving a request pending', async t => {
    mockTransport(t, request => request.timeoutHandler());
    await assert.rejects(summarize(), /시간이 초과/);
});

test('audio upload uses whisper verbose_json timed segments and enforces size before HTTP', async t => {
    const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'videorandom-audio-client-'));
    try {
        const audio = path.join(folder, 'sample.mp3');
        await fs.promises.writeFile(audio, Buffer.from('local-test-audio-bytes'));
        const requests = mockTransport(t, request => request.respond(200, { text: '대사', segments: [{ start: 0, end: 1, text: '대사' }] }));
        const result = await transcribeAudio(audio, TEST_KEY);
        assert.equal(result.segments[0].text, '대사');
        assert.equal(requests.length, 1);
        assert.equal(requests[0].options.path, '/v1/audio/transcriptions');
        assert.match(requests[0].options.headers['content-type'], /^multipart\/form-data; boundary=/);
        assert.equal(requests[0].options.headers['Content-Length'], requests[0].body.length);
        const upload = requests[0].body.toString('utf8');
        assert.match(upload, /name="model"\r\n\r\nwhisper-1/);
        assert.match(upload, /name="response_format"\r\n\r\nverbose_json/);
        assert.match(upload, /name="timestamp_granularities\[\]"\r\n\r\nsegment/);
        assert.match(upload, /filename="audio.mp3"/);
        assert.match(upload, /local-test-audio-bytes/);
        const large = path.join(folder, 'too-large.mp3');
        const handle = await fs.promises.open(large, 'w');
        await handle.truncate(25 * 1024 * 1024);
        await handle.close();
        await assert.rejects(transcribeAudio(large, TEST_KEY), /업로드 제한/);
        assert.equal(requests.length, 1, 'oversized audio must not start an HTTP request');
    } finally {
        await fs.promises.rm(folder, { recursive: true, force: true });
    }
});

test('mocked AI analysis attaches real sampled image captions and full local transcript', async t => {
    const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'videorandom-ai-analysis-'));
    const dataDir = path.join(folder, 'results');
    try {
        const tools = await getToolsStatus(dataDir);
        if (!tools.available) { t.skip('ffmpeg/ffprobe dependencies are unavailable'); return; }
        const video = path.join(folder, 'do-not-guess-from-this-name.mp4');
        await runProcess(tools.ffmpeg.path, ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
        await fs.promises.writeFile(path.join(folder, 'do-not-guess-from-this-name.srt'), '1\n00:00:00,100 --> 00:00:01,500\n전체 자막 대사가 유지됩니다.\n', 'utf8');
        const requests = mockTransport(t, request => request.respond(200, responseFor({
            summary: '표본 장면 요약', plot: '기록을 기반으로 한 줄거리', dialogueSummary: '대사 요약', labels: ['테스트', '테스트', '영상'],
            frames: [{ index: 1, caption: '뒤 장면' }, { index: 0, caption: '앞 장면' }], limitations: []
        })));
        const record = await analyzeVideo({ path: video, id: 'mocked-ai' }, { mode: 'ai', apiKey: TEST_KEY, frameCount: 2 }, { dataDir });
        assert.equal(record.status, 'completed', record.error || record.warnings.join('\n'));
        assert.deepEqual(record.frames.map(frame => frame.caption), ['앞 장면', '뒤 장면']);
        assert.deepEqual(record.labels, ['테스트', '영상']);
        assert.equal(record.transcript[0].text, '전체 자막 대사가 유지됩니다.');
        assert.ok(!JSON.stringify(record).includes(TEST_KEY));
        assert.equal(requests.length, 1, 'subtitle-backed AI analysis should not upload audio');
        const payload = JSON.parse(requests[0].body.toString('utf8'));
        const content = payload.input[0].content;
        assert.equal(content.filter(item => item.type === 'input_image').length, 2);
        assert.match(content[0].text, /전체 자막 대사가 유지됩니다/);
        assert.ok(!content[0].text.includes('do-not-guess-from-this-name'));
    } finally {
        await fs.promises.rm(folder, { recursive: true, force: true });
    }
});
