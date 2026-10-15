const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { createAnalysisService } = require('../lib/analysis-service');
const { createLanAnalysis, sendRemoteAnalysis } = require('../lib/lan-analysis');
const { subtitleText } = require('../lib/subtitle-utils');

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

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-sidecar-service-'));
  const mediaDir = path.join(root, 'media'), dataDir = path.join(root, 'catalog');
  await fs.mkdir(mediaDir);
  const video = path.join(mediaDir, '열차 안내.mp4');
  await fs.writeFile(video, 'Owned fixture: decoding is replaced with neutral timed cues.');
  const clients = [], hosts = [];
  async function mount({ analyze = async file => translated(file), subtitleWriter } = {}) {
    const service = createAnalysisService({ dataDir, subtitleWriter, engine: {
      getToolsStatus: async () => ({ available: true }),
      getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }), analyzeVideo: analyze
    } });
    await service.ready;
    service.registerFiles([{ path: video, name: path.basename(video) }]);
    const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
    const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const base = `http://127.0.0.1:${server.address().port}/api/analysis`;
    const client = {
      service,
      raw(endpoint, body, method = body === undefined ? 'GET' : 'POST') {
        return fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
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

test('automatic random picks also save Korean SRT without a manual analysis click', async t => {
  const f = await fixture(t), client = await f.mount();
  await client.request('/auto-pick', { options: { mode: 'codex', subtitleLanguage: 'ko' } }, 'PUT');
  assert.equal((await client.request('/auto-pick', { filePath: f.video })).status, 'queued');
  const record = await until(async () => (await client.request('/results')).results.find(record => record.subtitleAutoSave?.status === 'saved'));
  assert.equal(record.analysisMode, 'codex');
  assert.equal(record.subtitleAutoSave.path, path.join(f.mediaDir, '열차 안내.ko.srt'));
  assert(await fs.readFile(record.subtitleAutoSave.path, 'utf8'));
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

test('cancelling after cues were generated never auto-saves a sidecar', async t => {
  const f = await fixture(t); let entered;
  const started = new Promise(resolve => { entered = resolve; }); let writes = 0;
  const client = await f.mount({ subtitleWriter: async () => { writes++; }, analyze: async (file, options, context) => {
    entered(); await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
    const error = new Error('Owned cancellation'); error.record = translated(file); throw error;
  } });
  const job = await start(client, f.video); await started;
  await client.request(`/jobs/${job.id}/cancel`, {});
  const result = await finish(client, job.id);
  assert.equal(result.status, 'cancelled'); assert.equal(writes, 0);
  assert.equal(result.results[0].subtitleAutoSave, undefined);
  assert.deepEqual(await fs.readdir(f.mediaDir), [path.basename(f.video)]);
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
