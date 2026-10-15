const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const { createAnalysisService } = require('../lib/analysis-service');
const { createLanAnalysis, sendRemoteAnalysis } = require('../lib/lan-analysis');
const { subtitleText } = require('../lib/subtitle-utils');
const { httpFixtureResponse } = require('./http-json-fixture');

const transcript = [{ start: 0.525, end: 3.25, text: '駅へ行きましょう。' }, { start: 7.125, end: 10.875, text: '次の列車です。' }];
const korean = ['역으로 갑시다.', '다음 열차입니다.'];
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function translated(file) {
  return { ...file, duration: 12, hasAudio: true, status: 'completed', summary: '열차 안내 검증 자료', plot: '', dialogueSummary: '', labels: [],
    transcriptSource: 'sidecar:fixture.ja.srt', transcriptLanguage: 'ja', transcript: transcript.map(cue => ({ ...cue })),
    subtitleLanguage: 'ko', subtitleTranslation: transcript.map((cue, index) => ({ ...cue, text: korean[index] })),
    frames: [], warnings: [], analyzedAt: new Date().toISOString() };
}

function incomplete(file, completedCues = 1) {
  const record = translated(file);
  delete record.subtitleLanguage; delete record.subtitleTranslation;
  return { ...record, status: 'partial', subtitleError: 'Synthetic translation stopped before completion',
    subtitleTranslationPartial: transcript.slice(0, completedCues).map((cue, index) => ({ ...cue, text: korean[index] })),
    subtitleTranslationProgress: { version: 1, language: 'ko', totalCues: transcript.length, completedCues, complete: false, sourceComplete: false,
      sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex') } };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-sidecar-service-'));
  const mediaDir = path.join(root, 'media'), dataDir = path.join(root, 'catalog');
  await fs.mkdir(mediaDir);
  const video = path.join(mediaDir, '열차 안내.mp4');
  await fs.writeFile(video, 'Owned fixture: decoding is replaced with neutral timed cues.');
  const clients = [], hosts = [];
  async function mount({ analyze = async file => translated(file), subtitleWriter } = {}) {
    const calls = { tools: 0, provider: 0, analysis: 0 };
    const service = createAnalysisService({ dataDir, subtitleWriter, engine: {
      getToolsStatus: async () => { calls.tools++; return { available: true }; },
      getProviderStatus: async () => { calls.provider++; return { codex: { loggedIn: true }, speech: { available: true } }; },
      analyzeVideo: async (...args) => { calls.analysis++; return analyze(...args); }
    } });
    await service.ready;
    service.registerFiles([{ path: video, name: path.basename(video) }]);
    const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
    const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const base = `http://127.0.0.1:${server.address().port}/api/analysis`;
    const client = {
      service, calls,
      raw(endpoint, body, method = body === undefined ? 'GET' : 'POST') {
        return httpFixtureResponse(base + endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      },
      async request(endpoint, body, method) {
        const response = await this.raw(endpoint, body, method);
        const value = await response.json(); assert(response.ok, value.error); return value;
      },
      async close() { await service.stop(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
    };
    clients.push(client); return client;
  }
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const host of hosts) await host.stop();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('videorandom-sidecar-service-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, dataDir, mediaDir, video, mount, hosts };
}

async function until(check) {
  for (let index = 0; index < 500; index++) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('Owned sidecar fixture did not finish.');
}
async function finish(client, id) {
  return until(async () => { const job = await client.request('/jobs/' + id); return ['completed', 'cancelled', 'failed'].includes(job.status) ? job : null; });
}
async function start(client, video, extra = {}) {
  return client.request('/jobs', { files: [video], options: { mode: 'codex', subtitleLanguage: 'ko', ...extra } });
}

async function seedPartialResult(f, changes = {}) {
  const record = { ...incomplete({ id: '11223344556677889900aabbccddeeff', path: f.video, name: path.basename(f.video) }), ...changes };
  await fs.mkdir(path.join(f.dataDir, 'results'), { recursive: true });
  await fs.writeFile(path.join(f.dataDir, 'results', record.id + '.json'), JSON.stringify(record), 'utf8');
  return record;
}

test('saved partial results can write their sidecar without analysis and retain metadata after restarting', async t => {
  const f = await fixture(t);
  const original = await seedPartialResult(f, { status: 'failed', error: 'Synthetic interrupted legacy attempt' });
  const player = path.join(f.mediaDir, '열차 안내.ko.srt');
  await fs.writeFile(player, 'Existing complete player subtitles');
  const client = await f.mount({ analyze: async () => { throw new Error('The saved-subtitle endpoint must not analyze'); } });
  const result = await client.request(`/results/${original.id}/subtitles/save`, {});
  assert.deepEqual(client.calls, { tools: 0, provider: 0, analysis: 0 });
  assert.equal(result.record.status, 'partial');
  assert.equal(result.record.error, original.error);
  assert.equal(result.subtitleAutoSave.partial, true);
  assert.equal(result.subtitleAutoSave.status, 'saved');
  assert.equal(result.subtitleAutoSave.generated, true);
  assert.equal(result.subtitleAutoSave.path, path.join(f.mediaDir, '열차 안내.ko.partial.srt'));
  assert.deepEqual(result.record.subtitleAutoSave, result.subtitleAutoSave);
  assert.equal(await fs.readFile(result.subtitleAutoSave.path, 'utf8'), subtitleText(original, { language: 'ko', partial: true }));
  assert.equal(await fs.readFile(player, 'utf8'), 'Existing complete player subtitles');
  const repeated = await client.request(`/results/${original.id}/subtitles/save`, { path: 'untrusted://request-path', subtitleTranslationPartial: [] });
  assert.equal(repeated.subtitleAutoSave.status, 'unchanged');
  assert.equal(repeated.subtitleAutoSave.generated, true);
  assert.deepEqual(client.calls, { tools: 0, provider: 0, analysis: 0 });
  await client.close();
  const reopened = await f.mount({ subtitleWriter: async () => { throw new Error('A passive read must not write'); } });
  const restored = (await reopened.request('/results')).results.find(record => record.id === original.id);
  assert.deepEqual(restored.subtitleAutoSave, repeated.subtitleAutoSave);
  assert.equal(await fs.readFile(restored.subtitleAutoSave.path, 'utf8'), subtitleText(restored, { language: 'ko', partial: true }));
  assert.deepEqual(reopened.calls, { tools: 0, provider: 0, analysis: 0 });
});

test('saved-subtitle endpoint rejects missing or invalid cues and reports write failure metadata without provider calls', async t => {
  const f = await fixture(t);
  const original = await seedPartialResult(f);
  const client = await f.mount({ subtitleWriter: async () => { throw new Error('Synthetic saved subtitle write failure'); } });
  assert.equal((await client.raw('/results/' + '0'.repeat(32) + '/subtitles/save', {})).status, 404);
  const failed = await client.request(`/results/${original.id}/subtitles/save`, {});
  assert.equal(failed.subtitleAutoSave.status, 'failed');
  assert.equal(failed.subtitleAutoSave.partial, true);
  assert.deepEqual(failed.record.subtitleAutoSave, failed.subtitleAutoSave);
  assert.match(failed.record.warnings.join('\n'), /한국어 부분 SRT 자동 저장 실패/);
  const persisted = JSON.parse(await fs.readFile(path.join(f.dataDir, 'results', original.id + '.json'), 'utf8'));
  assert.deepEqual(persisted.subtitleAutoSave, failed.subtitleAutoSave);
  assert.deepEqual(client.calls, { tools: 0, provider: 0, analysis: 0 });
  await client.close();
  await seedPartialResult(f, { subtitleTranslationPartial: [], subtitleTranslationProgress: { ...original.subtitleTranslationProgress, completedCues: 0 } });
  let writes = 0;
  const invalid = await f.mount({ subtitleWriter: async () => { writes++; throw new Error('Invalid cues must not reach the writer'); } });
  assert.equal((await invalid.raw(`/results/${original.id}/subtitles/save`, {})).status, 400);
  assert.equal(writes, 0);
  assert.deepEqual(invalid.calls, { tools: 0, provider: 0, analysis: 0 });
});

test('saved-subtitle endpoint exposes native I/O failure metadata while retaining reviewed partial cues', async t => {
  const f = await fixture(t);
  const original = await seedPartialResult(f);
  const client = await f.mount();
  await fs.unlink(f.video);
  const result = await client.request(`/results/${original.id}/subtitles/save`, {});
  assert.equal(result.subtitleAutoSave.status, 'failed');
  assert.equal(result.subtitleAutoSave.partial, true);
  assert.equal(result.subtitleAutoSave.code, 'ENOENT');
  assert.deepEqual(result.record.subtitleTranslationPartial, original.subtitleTranslationPartial);
  assert.deepEqual(result.record.subtitleAutoSave, result.subtitleAutoSave);
  assert.match(result.record.warnings.join('\n'), /한국어 부분 SRT 자동 저장 실패/);
  assert.deepEqual(client.calls, { tools: 0, provider: 0, analysis: 0 });
});

test('saved-subtitle endpoint blocks the same active video but allows a different video during analysis', async t => {
  const f = await fixture(t);
  const original = await seedPartialResult(f);
  let started, release;
  const entered = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const client = await f.mount({ analyze: async file => { started(); await held; return translated(file); } });
  const job = await start(client, f.video); await entered;
  assert.equal((await client.raw(`/results/${original.id}/subtitles/save`, {})).status, 409);
  release(); await finish(client, job.id);
  await client.close();
  const otherVideo = path.join(f.mediaDir, '다른 합성 영상.mp4');
  await fs.writeFile(otherVideo, 'Another owned synthetic fixture');
  let startedOther, releaseOther;
  const otherEntered = new Promise(resolve => { startedOther = resolve; });
  const otherHeld = new Promise(resolve => { releaseOther = resolve; });
  const other = await f.mount({ analyze: async file => { startedOther(); await otherHeld; return translated(file); } });
  other.service.registerFiles([{ path: otherVideo, name: path.basename(otherVideo) }]);
  const otherJob = await start(other, otherVideo); await otherEntered;
  const result = await other.request(`/results/${original.id}/subtitles/save`, {});
  assert.equal(result.subtitleAutoSave.partial, true);
  assert.equal(result.subtitleAutoSave.status, 'saved');
  releaseOther(); await finish(other, otherJob.id);
});

test('manual analysis writes Korean SRT beside the client video and preserves metadata after restart without rewriting on reads or edits', async t => {
  const f = await fixture(t);
  const client = await f.mount({ analyze: async file => ({ ...translated(file), path: 'remote-upload://untrusted-provider-path' }) });
  const record = (await finish(client, (await start(client, f.video)).id)).results[0];
  const sidecar = path.join(f.mediaDir, '열차 안내.ko.srt');
  assert.equal(record.subtitleAutoSave.status, 'saved');
  assert.equal(record.subtitleAutoSave.path, sidecar);
  assert.match(record.subtitleAutoSave.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await fs.readFile(sidecar, 'utf8')).replace(/^\uFEFF/, ''), subtitleText(record, { language: 'ko' }));
  assert.match(await fs.readFile(sidecar, 'utf8'), /00:00:00,525 --> 00:00:03,250/);
  const stored = JSON.parse(await fs.readFile(path.join(f.dataDir, 'results', record.id + '.json'), 'utf8'));
  assert.deepEqual(stored.subtitleAutoSave, record.subtitleAutoSave);
  await client.close();
  let writes = 0;
  const reopened = await f.mount({ subtitleWriter: async () => { writes++; throw new Error('Passive operations must not write a sidecar.'); } });
  assert.deepEqual((await reopened.request('/results')).results[0].subtitleAutoSave, record.subtitleAutoSave);
  await reopened.request('/results/' + record.id, { summary: '검토한 요약' }, 'PUT');
  assert.equal(writes, 0);
});

test('repair reuses an identical SRT and passes only trusted persisted provenance to extraction', async t => {
  const f = await fixture(t);
  const contexts = [];
  const client = await f.mount({ analyze: async (file, options, context) => {
    contexts.push(context.generatedSubtitleFiles); return translated(file);
  } });
  const first = (await finish(client, (await start(client, f.video, { generatedSubtitleFiles: [{ path: 'caller-input', sha256: 'f'.repeat(64) }] })).id)).results[0];
  assert.deepEqual(contexts[0], []);
  const oldJson = await fs.readFile(path.join(f.dataDir, 'results', first.id + '.json'));
  const sidecarBytes = await fs.readFile(first.subtitleAutoSave.path);
  const repair = await client.request(`/results/${first.id}/repair`, { options: { mode: 'codex', subtitleLanguage: 'ko' } });
  const record = (await finish(client, repair.id)).results[0];
  assert.equal(record.subtitleAutoSave.status, 'unchanged');
  assert.equal(record.subtitleAutoSave.path, first.subtitleAutoSave.path);
  assert.deepEqual(contexts[1], [{ path: first.subtitleAutoSave.path, sha256: first.subtitleAutoSave.sha256 }]);
  assert.deepEqual(await fs.readFile(first.subtitleAutoSave.path), sidecarBytes);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'results', first.id + '.json')), oldJson);
});

test('repair updates the trusted player subtitle at the same path and retains the previous bytes as a backup', async t => {
  const f = await fixture(t);
  let attempts = 0;
  const client = await f.mount({ analyze: async file => {
    const record = translated(file);
    if (++attempts > 1) record.subtitleTranslation[1].text = '뒤쪽에서 인식한 다음 열차 안내입니다.';
    return record;
  } });
  const first = (await finish(client, (await start(client, f.video)).id)).results[0];
  const previous = await fs.readFile(first.subtitleAutoSave.path);
  const repair = await client.request(`/results/${first.id}/repair`, { options: { mode: 'codex', subtitleLanguage: 'ko' } });
  const record = (await finish(client, repair.id)).results[0];
  assert.equal(record.subtitleAutoSave.status, 'saved');
  assert.equal(record.subtitleAutoSave.updated, true);
  assert.equal(record.subtitleAutoSave.generated, true);
  assert.equal(record.subtitleAutoSave.path, first.subtitleAutoSave.path);
  assert.match(record.subtitleAutoSave.backupPath, /\.bak$/);
  assert.deepEqual(await fs.readFile(record.subtitleAutoSave.backupPath), previous);
  assert.equal(await fs.readFile(record.subtitleAutoSave.path, 'utf8'), subtitleText(record, { language: 'ko' }));
  assert.notEqual(record.subtitleAutoSave.sha256, first.subtitleAutoSave.sha256);
});

test('automatic random picks also save Korean SRT without a manual analysis click', async t => {
  const f = await fixture(t), client = await f.mount();
  await client.request('/auto-pick', { options: { mode: 'codex', subtitleLanguage: 'ko' } }, 'PUT');
  assert.equal((await client.request('/auto-pick', { filePath: f.video })).status, 'queued');
  const record = await until(async () => (await client.request('/results')).results.find(record => record.subtitleAutoSave?.status === 'saved'));
  assert.equal(record.analysisMode, 'codex');
  assert.equal(record.subtitleAutoSave.path, path.join(f.mediaDir, '열차 안내.ko.srt'));
  assert(await fs.readFile(record.subtitleAutoSave.path, 'utf8'));
});

test('reviewed partial Korean subtitles auto-save separately, remain downloadable and preserve complete player subtitles', async t => {
  const f = await fixture(t);
  const playerSubtitle = path.join(f.mediaDir, '열차 안내.ko.srt');
  await fs.writeFile(playerSubtitle, 'existing player subtitles');
  const client = await f.mount({ analyze: async file => incomplete(file) });
  const record = (await finish(client, (await start(client, f.video)).id)).results[0];
  assert.equal(record.subtitleAutoSave.status, 'saved');
  assert.equal(record.subtitleAutoSave.partial, true);
  assert.equal(record.subtitleAutoSave.generated, true);
  assert.equal(record.subtitleAutoSave.path, path.join(f.mediaDir, '열차 안내.ko.partial.srt'));
  assert.equal(await fs.readFile(playerSubtitle, 'utf8'), 'existing player subtitles');
  assert.equal((await client.raw(`/results/${record.id}/subtitles?language=ko`)).status, 400);
  const response = await client.raw(`/results/${record.id}/subtitles?language=ko&partial=1`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /ko-partial\.srt/);
  const text = await response.text();
  assert.match(text, /00:00:00,525 --> 00:00:03,250\n역으로 갑시다\./);
  assert.equal(text.includes('다음 열차'), false);
  assert.equal(await fs.readFile(record.subtitleAutoSave.path, 'utf8'), text);
  assert.equal(await fs.readFile(playerSubtitle, 'utf8'), 'existing player subtitles');
  await client.close();
  let writes = 0;
  const reopened = await f.mount({ subtitleWriter: async () => { writes++; throw new Error('Passive restart must not rewrite partial subtitles'); } });
  const restored = (await reopened.request('/results')).results.find(item => item.id === record.id);
  assert.deepEqual(restored.subtitleAutoSave, record.subtitleAutoSave);
  assert.equal(await fs.readFile(restored.subtitleAutoSave.path, 'utf8'), text);
  assert.equal(writes, 0);
});

test('repair updates verified partial progress with backup and a later complete analysis creates the complete SRT separately', async t => {
  const f = await fixture(t); let calls = 0;
  const client = await f.mount({ analyze: async file => ++calls < 3 ? incomplete(file, calls) : translated(file) });
  const first = (await finish(client, (await start(client, f.video)).id)).results[0];
  const firstBytes = await fs.readFile(first.subtitleAutoSave.path);
  const firstJson = await fs.readFile(path.join(f.dataDir, 'results', first.id + '.json'));
  const next = await client.request(`/results/${first.id}/repair`, { options: { mode: 'codex', subtitleLanguage: 'ko' } });
  const partial = (await finish(client, next.id)).results[0];
  assert.equal(partial.repairOf, first.id);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.subtitleAutoSave.partial, true);
  assert.equal(partial.subtitleAutoSave.updated, true);
  assert.equal(partial.subtitleAutoSave.path, first.subtitleAutoSave.path);
  assert.deepEqual(await fs.readFile(partial.subtitleAutoSave.backupPath), firstBytes);
  assert.equal(await fs.readFile(partial.subtitleAutoSave.path, 'utf8'), subtitleText(partial, { language: 'ko', partial: true }));
  const partialBytes = await fs.readFile(partial.subtitleAutoSave.path);
  const completed = await client.request(`/results/${partial.id}/repair`, { options: { mode: 'codex', subtitleLanguage: 'ko' } });
  const full = (await finish(client, completed.id)).results[0];
  assert.equal(calls, 3);
  assert.equal(full.status, 'completed');
  assert.equal(full.subtitleAutoSave.partial, undefined);
  assert.equal(full.subtitleAutoSave.path, path.join(f.mediaDir, '열차 안내.ko.srt'));
  assert.equal(await fs.readFile(full.subtitleAutoSave.path, 'utf8'), subtitleText(full, { language: 'ko' }));
  assert.deepEqual(await fs.readFile(partial.subtitleAutoSave.path), partialBytes);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'results', first.id + '.json')), firstJson);
});

test('an unexpected partial sidecar write exception preserves partial failure metadata and manual export', async t => {
  const f = await fixture(t);
  const client = await f.mount({ analyze: async file => incomplete(file), subtitleWriter: async () => { throw new Error('Synthetic partial-folder permission error'); } });
  const job = await finish(client, (await start(client, f.video)).id), record = job.results[0];
  assert.equal(job.status, 'completed'); assert.equal(record.status, 'partial');
  assert.equal(record.subtitleLanguage, undefined);
  assert.equal(record.subtitleAutoSave.status, 'failed'); assert.equal(record.subtitleAutoSave.partial, true);
  assert.match(record.subtitleAutoSave.error, /partial-folder permission/);
  assert.match(record.warnings.join('\n'), /한국어 부분 SRT 자동 저장 실패/);
  const response = await client.raw(`/results/${record.id}/subtitles?language=ko&partial=1`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), subtitleText(record, { language: 'ko', partial: true }));
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'results', record.id + '.json'), 'utf8'));
  assert.deepEqual(saved.subtitleAutoSave, record.subtitleAutoSave);
});

test('provider interruption preserves reviewed partial cues once without retrying the provider', async t => {
  const f = await fixture(t); let calls = 0;
  const client = await f.mount({ analyze: async file => {
    calls++;
    const error = new Error('Synthetic provider refused an additional request'); error.record = incomplete(file); throw error;
  } });
  const record = (await finish(client, (await start(client, f.video)).id)).results[0];
  assert.equal(calls, 1); assert.equal(record.status, 'partial');
  assert.match(record.error, /provider refused/);
  assert.equal(record.subtitleAutoSave.partial, true);
  assert.equal(record.subtitleAutoSave.status, 'saved');
  assert.equal(await fs.readFile(record.subtitleAutoSave.path, 'utf8'), subtitleText(record, { language: 'ko', partial: true }));
});

test('empty or mismatched partial progress never writes a file or claims automatic save metadata', async t => {
  for (const invalid of ['empty', 'fingerprint', 'timing']) {
    const f = await fixture(t);
    const client = await f.mount({ analyze: async file => {
      const record = incomplete(file);
      if (invalid === 'empty') { record.subtitleTranslationPartial = []; record.subtitleTranslationProgress.completedCues = 0; }
      if (invalid === 'fingerprint') record.subtitleTranslationProgress.sourceFingerprint = '0'.repeat(64);
      if (invalid === 'timing') record.subtitleTranslationPartial[0].end += 0.1;
      return record;
    } });
    const record = (await finish(client, (await start(client, f.video)).id)).results[0];
    assert.equal(record.subtitleAutoSave, undefined, invalid);
    assert.deepEqual(await fs.readdir(f.mediaDir), [path.basename(f.video)], invalid);
  }
});

test('reusing an identical user-authored Korean SRT does not claim it as generated input', async t => {
  const f = await fixture(t), contexts = [];
  const existing = path.join(f.mediaDir, '열차 안내.ko.srt');
  const bytes = subtitleText(translated({}), { language: 'ko' });
  await fs.writeFile(existing, bytes, 'utf8');
  const client = await f.mount({ analyze: async (file, options, context) => {
    contexts.push(context.generatedSubtitleFiles); return translated(file);
  } });
  const first = (await finish(client, (await start(client, f.video)).id)).results[0];
  assert.equal(first.subtitleAutoSave.status, 'unchanged');
  assert.equal(first.subtitleAutoSave.generated, false);
  const next = await client.request(`/results/${first.id}/repair`, { options: { mode: 'codex', subtitleLanguage: 'ko' } });
  await finish(client, next.id);
  assert.deepEqual(contexts, [[], []]);
  assert.equal(await fs.readFile(existing, 'utf8'), bytes);
});

test('sidecar write failure preserves successful analysis, Korean cues and manual SRT download', async t => {
  const f = await fixture(t), client = await f.mount({ subtitleWriter: async () => { throw new Error('EPERM: owned fixture read-only folder'); } });
  const job = await finish(client, (await start(client, f.video)).id), record = job.results[0];
  assert.equal(job.status, 'completed'); assert.equal(record.status, 'completed');
  assert.equal(record.subtitleAutoSave.status, 'failed'); assert.match(record.subtitleAutoSave.error, /EPERM/);
  assert.equal(record.summary, '열차 안내 검증 자료'); assert.equal(record.subtitleError, undefined);
  assert.match(record.warnings.join('\n'), /한국어 SRT 자동 저장 실패/);
  const downloaded = await client.raw(`/results/${record.id}/subtitles?language=ko`);
  assert(downloaded.ok); assert.match(await downloaded.text(), /역으로 갑시다/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.dataDir, 'results', record.id + '.json'), 'utf8')).subtitleAutoSave, record.subtitleAutoSave);
});

test('cancelling after reviewed partial cues were generated saves only those cues without another analysis call', async t => {
  const f = await fixture(t); let entered;
  const started = new Promise(resolve => { entered = resolve; }); let calls = 0;
  const client = await f.mount({ analyze: async (file, options, context) => {
    calls++;
    entered(); await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
    const error = new Error('Owned cancellation'); error.record = incomplete(file); throw error;
  } });
  const job = await start(client, f.video); await started;
  await client.request(`/jobs/${job.id}/cancel`, {});
  const result = await finish(client, job.id);
  assert.equal(result.status, 'cancelled'); assert.equal(calls, 1);
  const record = result.results[0];
  assert.equal(record.status, 'partial');
  assert.equal(record.subtitleAutoSave.status, 'saved'); assert.equal(record.subtitleAutoSave.partial, true);
  assert.match(record.subtitleAutoSave.path, /\.ko\.partial\.srt$/);
  assert.equal(await fs.readFile(record.subtitleAutoSave.path, 'utf8'), subtitleText(record, { language: 'ko', partial: true }));
  await assert.rejects(fs.stat(path.join(f.mediaDir, '열차 안내.ko.srt')), { code: 'ENOENT' });
});

test('cancelling without a valid reviewed prefix does not create a subtitle file', async t => {
  const f = await fixture(t); let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const client = await f.mount({ analyze: async (file, options, context) => {
    entered(); await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
    const record = incomplete(file);
    record.subtitleTranslationProgress.sourceFingerprint = '0'.repeat(64);
    const error = new Error('Owned invalid-prefix cancellation'); error.record = record; throw error;
  } });
  const job = await start(client, f.video); await started;
  await client.request(`/jobs/${job.id}/cancel`, {});
  const result = await finish(client, job.id);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.results[0].subtitleAutoSave, undefined);
  assert.deepEqual(await fs.readdir(f.mediaDir), [path.basename(f.video)]);
  assert.equal(client.calls.analysis, 1);
});

test('LAN partial progress saves a real partial SRT only beside the original client video', async t => {
  const f = await fixture(t), hostDir = path.join(f.root, 'partial-host');
  const host = createLanAnalysis({ dataDir: hostDir, processPackage: async ({ record }) => ({ ...incomplete(record), frames: record.frames }) });
  f.hosts.push(host); const status = await host.start({ port: 0, host: '127.0.0.1' });
  const client = await f.mount({ analyze: async (file, options, context) => {
    const local = translated(file); delete local.subtitleLanguage; delete local.subtitleTranslation;
    local.frames = [{ timestamp: 4, filename: 'frame-01.jpg' }];
    await fs.mkdir(path.join(f.dataDir, 'frames', file.id), { recursive: true });
    await fs.writeFile(path.join(f.dataDir, 'frames', file.id, 'frame-01.jpg'), jpeg);
    return sendRemoteAnalysis(local, { ...options, dataDir: f.dataDir, signal: context.signal });
  } });
  const job = await finish(client, (await start(client, f.video, { mode: 'remote', remoteUrl: `http://127.0.0.1:${status.port}`, connectionCode: status.connectionCode })).id);
  assert.equal(job.status, 'completed'); const record = job.results[0];
  assert.equal(record.status, 'partial');
  assert.equal(record.subtitleAutoSave.partial, true);
  assert.equal(record.subtitleAutoSave.path, path.join(f.mediaDir, '열차 안내.ko.partial.srt'));
  assert.equal(await fs.readFile(record.subtitleAutoSave.path, 'utf8'), subtitleText(record, { language: 'ko', partial: true }));
  await assert.rejects(fs.stat(path.join(f.mediaDir, '열차 안내.ko.srt')), { code: 'ENOENT' });
  async function walk(folder) {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? walk(path.join(folder, entry.name)) : [entry.name]))).flat();
  }
  assert.equal((await walk(hostDir)).some(name => name.endsWith('.srt')), false);
});

test('LAN results create SRT only beside the original client video, never inside uploaded host packages', async t => {
  const f = await fixture(t), hostDir = path.join(f.root, 'host');
  const host = createLanAnalysis({ dataDir: hostDir, processPackage: async ({ record }) => {
    assert.match(record.path, /^remote-upload:\/\//); return { ...translated(record), frames: record.frames };
  } });
  f.hosts.push(host); const status = await host.start({ port: 0, host: '127.0.0.1' });
  const client = await f.mount({ analyze: async (file, options, context) => {
    const local = translated(file); delete local.subtitleLanguage; delete local.subtitleTranslation;
    local.frames = [{ timestamp: 4, filename: 'frame-01.jpg' }];
    await fs.mkdir(path.join(f.dataDir, 'frames', file.id), { recursive: true });
    await fs.writeFile(path.join(f.dataDir, 'frames', file.id, 'frame-01.jpg'), jpeg);
    return sendRemoteAnalysis(local, { ...options, dataDir: f.dataDir, signal: context.signal });
  } });
  const job = await finish(client, (await start(client, f.video, { mode: 'remote', remoteUrl: `http://127.0.0.1:${status.port}`, connectionCode: status.connectionCode })).id);
  assert.equal(job.status, 'completed'); const record = job.results[0];
  assert.equal(record.subtitleAutoSave.path, path.join(f.mediaDir, '열차 안내.ko.srt'));
  assert.equal((await fs.readFile(record.subtitleAutoSave.path, 'utf8')).replace(/^\uFEFF/, ''), subtitleText(record, { language: 'ko' }));
  async function walk(folder) {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? walk(path.join(folder, entry.name)) : [entry.name]))).flat();
  }
  assert.equal((await walk(hostDir)).some(name => name.endsWith('.srt')), false);
});
