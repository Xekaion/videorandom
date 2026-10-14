const fs = require('fs');
const https = require('https');

function abortError() {
    const error = new Error('분석이 중지되었습니다.');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal) {
    if (signal && signal.aborted) throw abortError();
}

// The credential is used only for this request; it is never written to disk.
function requestOpenAI(endpoint, apiKey, body, headers, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        let settled = false;
        const request = https.request({
            hostname: 'api.openai.com',
            path: `/v1/${endpoint}`,
            method: 'POST',
            headers: { ...headers, Authorization: `Bearer ${apiKey}` }
        });
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            if (signal) signal.removeEventListener('abort', onAbort);
            if (body && typeof body.destroy === 'function') body.destroy();
            error ? reject(error) : resolve(result);
        };
        const onAbort = () => {
            request.destroy(abortError());
            finish(abortError());
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        request.setTimeout(10 * 60 * 1000, () => {
            request.destroy(new Error('OpenAI 요청 시간이 초과되었습니다.'));
        });
        request.on('error', error => finish(signal && signal.aborted ? abortError() : error));
        request.on('response', response => {
            const chunks = [];
            let size = 0;
            response.on('data', chunk => {
                size += chunk.length;
                if (size > 16 * 1024 * 1024) {
                    response.destroy(new Error('OpenAI 응답이 너무 큽니다.'));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('error', error => finish(error));
            response.on('end', () => {
                let result;
                try {
                    result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                } catch (_) {
                    finish(new Error(`OpenAI 응답을 읽을 수 없습니다. (HTTP ${response.statusCode})`));
                    return;
                }
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    const message = String(result.error && result.error.message || '요청 실패').split(apiKey).join('[REDACTED]');
                    const error = new Error(`OpenAI HTTP ${response.statusCode}: ${message.slice(0, 600)}`);
                    error.statusCode = response.statusCode;
                    error.code = result.error && result.error.code;
                    finish(error);
                    return;
                }
                finish(null, result);
            });
        });
        if (body && typeof body.pipe === 'function') {
            body.on('error', error => { request.destroy(error); finish(error); });
            body.pipe(request);
        } else {
            request.end(body);
        }
        if (signal && signal.aborted) onAbort();
    });
}

async function transcribeAudio(audioPath, apiKey, signal) {
    throwIfAborted(signal);
    const FormData = require('form-data');
    const stat = await fs.promises.stat(audioPath);
    if (stat.size > 24 * 1024 * 1024) throw new Error('음성 조각이 API 업로드 제한을 초과했습니다.');
    const stream = fs.createReadStream(audioPath);
    const form = new FormData();
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    form.append('file', stream, { filename: 'audio.mp3', contentType: 'audio/mpeg', knownLength: stat.size });
    try {
        const length = await new Promise((resolve, reject) => form.getLength((error, value) => error ? reject(error) : resolve(value)));
        return await requestOpenAI('audio/transcriptions', apiKey, form,
            { ...form.getHeaders(), 'Content-Length': length }, signal);
    } finally {
        stream.destroy();
        form.destroy();
    }
}

async function structuredResponse({ apiKey, model, instructions, content, schema, schemaName, signal, maxOutputTokens = 4500 }) {
    const body = JSON.stringify({
        model,
        store: false,
        instructions,
        input: [{ role: 'user', content }],
        max_output_tokens: maxOutputTokens,
        text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } }
    });
    const result = await requestOpenAI('responses', apiKey, body,
        { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, signal);
    if (result.status !== 'completed') {
        throw new Error(`AI 요약을 완료하지 못했습니다. (${result.status || '알 수 없는 상태'})`);
    }
    const contents = (result.output || []).flatMap(item => item.content || []);
    const refusal = contents.find(item => item.type === 'refusal');
    if (refusal) throw new Error(`AI가 분석을 거절했습니다: ${String(refusal.refusal || '').slice(0, 300)}`);
    const output = contents.filter(item => item.type === 'output_text').map(item => item.text).join('');
    if (!output) throw new Error('AI 요약 응답이 비어 있습니다.');
    try {
        return JSON.parse(output);
    } catch (_) {
        throw new Error('AI 요약의 JSON 형식이 올바르지 않습니다.');
    }
}

module.exports = { abortError, throwIfAborted, transcribeAudio, structuredResponse };
