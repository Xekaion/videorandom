const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const ExcelJS = require('exceljs');
const { createAnalysisService } = require('../lib/analysis-service');
const { createLanAnalysis, sendRemoteAnalysis } = require('../lib/lan-analysis');
const { getFrameTimestamps } = require('../lib/video-analysis');
const { httpFixtureResponse } = require('./http-json-fixture');

// A real 16 x 9 JPEG: the offline XLSX round trip must embed actual pixels.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAJABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDjqKKK+kPAP//Z', 'base64');

async function mount(service) {
  await service.ready;
  const app = express();
  app.use(express.json());
  app.use('/api/analysis', service.router);
  const server = await new Promise(resolve => {
    const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/analysis`;
  return {
    service,
    request(endpoint, body, method = body === undefined ? 'GET' : 'POST') {
      return httpFixtureResponse(base + endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    },
    async close() {
      await service.stop();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  };
}

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-persistence-'));
  const clients = [];
  const hosts = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const host of hosts) await host.stop();
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(dataDir));
    assert.ok(relative.startsWith('videorandom-persistence-') && !relative.includes(path.sep));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const filePath = path.join(dataDir, '두 시간 영상.mp4');
  await fs.writeFile(filePath, 'media decoder is replaced only in this persistence integration test');
  async function client(engine) {
    const mounted = await mount(createAnalysisService({ dataDir, engine }));
    clients.push(mounted);
    return mounted;
  }
  return { dataDir, filePath, client, hosts };
}

function engine(analyzeVideo) {
  return {
    getToolsStatus: async () => ({ available: true }),
    getProviderStatus: async () => ({ codex: { available: false, loggedIn: false }, speech: { available: false } }),
    analyzeVideo
  };
}

async function extracted(file, options, context, summary = '자동 추출한 분석 내용') {
  assert.equal(options.timestamps, null);
  const directory = path.join(context.dataDir, 'frames', file.id);
  await fs.mkdir(directory, { recursive: true });
  const frames = getFrameTimestamps(7200, options.frameCount, options.timestamps).map((timestamp, index) => ({ timestamp, filename: `frame-${index + 1}.jpg`, caption: `장면 ${index + 1}` }));
  await Promise.all(frames.map(frame => fs.writeFile(path.join(directory, frame.filename), JPEG)));
  return { ...file, duration: 7200, status: 'completed', summary, plot: '처음부터 끝까지의 줄거리', dialogueSummary: '전체 대사 요약', labels: ['영상'], hasAudio: true,
    transcriptSource: 'sidecar:srt', transcript: Array.from({ length: 40 }, (_, index) => ({ start: index * 150, end: index * 150 + 20, text: `전체 대사 ${index + 1} — 안녕하세요 😊` })),
    frames, warnings: [], analyzedAt: new Date().toISOString() };
}

async function finished(client, id) {
  for (let index = 0; index < 1000; index++) {
    const job = await (await client.request('/jobs/' + id)).json();
    if (!['running', 'cancelling'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Analysis did not finish');
}

async function start(client, filePath, options = { mode: 'local', timestamps: [300, 900, 1800] }) {
  const response = await client.request('/jobs', { files: [filePath], options });
  assert.equal(response.status, 202, await response.clone().text());
  return response.json();
}

function sheetTexts(sheet, header) {
  let column;
  sheet.getRow(1).eachCell(cell => { if (cell.value === header) column = cell.col; });
  assert.ok(column, header);
  return Array.from({ length: sheet.rowCount - 1 }, (_, index) => sheet.getCell(index + 2, column).text);
}

async function assertOfflineResult(client, expected) {
  const response = await client.request('/results');
  assert.equal(response.status, 200);
  const { results } = await response.json();
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], expected);
  for (const frame of expected.frames) {
    const image = await client.request(`/frames/${expected.id}/${frame.filename}`);
    assert.equal(image.status, 200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), JPEG);
  }
  const responseXlsx = await client.request('/export', { ids: [expected.id] });
  assert.equal(responseXlsx.status, 200, await responseXlsx.clone().text());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await responseXlsx.arrayBuffer()));
  assert.deepEqual(sheetTexts(workbook.getWorksheet('영상 목록'), '요약'), [expected.summary]);
  assert.deepEqual(sheetTexts(workbook.getWorksheet('전체 대사'), '전체 대사'), expected.transcript.map(segment => segment.text));
  assert.equal(workbook.getWorksheet('장면 이미지').getImages().length, 10);
}

test('local completed text, full transcript and ten JPEGs reopen and export without rescanning', async t => {
  const f = await fixture(t);
  const first = await f.client(engine(extracted));
  first.service.registerFiles([{ path: f.filePath }]);
  const job = await finished(first, (await start(first, f.filePath)).id);
  assert.equal(job.status, 'completed');
  const record = job.results[0];
  assert.match(record.id, /^[a-f0-9]{32}$/);
  assert.ok(Number.isFinite(Date.parse(record.savedAt)));
  assert.equal(record.frames.length, 10);
  assert.deepEqual(record.frames.map(frame => frame.timestamp), [360, 1080, 1800, 2520, 3240, 3960, 4680, 5400, 6120, 6840]);
  await first.close();
  const reopened = await f.client(engine(async () => { throw new Error('Must not reanalyze saved results'); }));
  const config = await (await reopened.request('/config')).json();
  assert.deepEqual(config.storage, { directory: f.dataDir, resultsDirectory: path.join(f.dataDir, 'results'), framesDirectory: path.join(f.dataDir, 'frames'), savedCount: 1 });
  await assertOfflineResult(reopened, record);
});

test('LAN analysis saves on client and survives host shutdown and client restart with offline XLSX', async t => {
  const f = await fixture(t);
  const host = createLanAnalysis({ dataDir: path.join(f.dataDir, 'host'), processPackage: async ({ record }) => ({ ...record, status: 'completed', summary: '서버에서 만든 줄거리', plot: '모든 장면과 대사를 참고한 줄거리', labels: ['서버 분석'], frames: record.frames.map(frame => ({ ...frame, caption: '서버가 인식한 장면' })) }) });
  f.hosts.push(host);
  const status = await host.start({ port: 0, host: '127.0.0.1' });
  const first = await f.client(engine(async (file, options, context) => sendRemoteAnalysis(await extracted(file, options, context), { ...options, dataDir: context.dataDir, signal: context.signal })));
  first.service.registerFiles([{ path: f.filePath }]);
  const job = await finished(first, (await start(first, f.filePath, { mode: 'remote', remoteUrl: `http://127.0.0.1:${status.port}`, connectionCode: status.connectionCode, timestamps: [300] })).id);
  assert.equal(job.status, 'completed', job.error);
  const record = job.results[0];
  assert.equal(record.status, 'completed');
  assert.equal(record.summary, '서버에서 만든 줄거리');
  assert.equal(record.path, f.filePath);
  assert.equal(record.transcript.length, 40);
  assert.equal(record.frames[0].caption, '서버가 인식한 장면');
  await host.stop();
  await first.close();
  const reopened = await f.client(engine(async () => { throw new Error('No host or media processing is needed'); }));
  await assertOfflineResult(reopened, record);
});

test('interrupted reanalysis keeps the original completed JSON and every JPEG untouched', async t => {
  const f = await fixture(t);
  let attempts = 0;
  let notifyReanalysis;
  const reanalysisStarted = new Promise(resolve => { notifyReanalysis = resolve; });
  const client = await f.client(engine(async (file, options, context) => {
    const record = await extracted(file, options, context, attempts++ ? '중지된 새로운 분석' : '이전에 완료한 줄거리');
    if (attempts === 1) return record;
    notifyReanalysis();
    await new Promise(resolve => {
      if (context.signal.aborted) resolve();
      else context.signal.addEventListener('abort', resolve, { once: true });
    });
    const error = new Error('Interrupted reanalysis');
    error.record = record;
    throw error;
  }));
  client.service.registerFiles([{ path: f.filePath }]);
  const completed = (await finished(client, (await start(client, f.filePath)).id)).results[0];
  const originalJson = await fs.readFile(path.join(f.dataDir, 'results', completed.id + '.json'));
  const originalJpegs = await Promise.all(completed.frames.map(frame => fs.readFile(path.join(f.dataDir, 'frames', completed.id, frame.filename))));
  const next = await start(client, f.filePath);
  await reanalysisStarted;
  await client.request('/jobs/' + next.id + '/cancel', {});
  const cancelled = await finished(client, next.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.notEqual(cancelled.results[0].id, completed.id);
  assert.equal(cancelled.results[0].status, 'partial');
  assert.match(cancelled.results[0].warnings.join(' '), /이전에 완료한 분석 결과와 이미지.*보관/);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'results', completed.id + '.json')), originalJson);
  assert.deepEqual(await Promise.all(completed.frames.map(frame => fs.readFile(path.join(f.dataDir, 'frames', completed.id, frame.filename)))), originalJpegs);
  await client.close();
  const reopened = await f.client(engine(async () => { throw new Error('No reanalysis expected'); }));
  const results = (await (await reopened.request('/results')).json()).results;
  assert.equal(results.length, 2);
  assert.equal(results.find(record => record.id === completed.id).summary, '이전에 완료한 줄거리');
});

test('received remote summary and full transcript are preserved when frame download fails', async t => {
  const f = await fixture(t);
  const host = createLanAnalysis({ dataDir: path.join(f.dataDir, 'host'), processPackage: async ({ record, framesDir }) => {
    // Remove only the temporary upload frame in this test-owned directory.
    await fs.rm(path.join(framesDir, record.frames[0].filename));
    return { ...record, status: 'completed', summary: '이미지 수신 전에 도착한 줄거리', dialogueSummary: '도착한 전체 대사 요약' };
  } });
  f.hosts.push(host);
  const status = await host.start({ port: 0, host: '127.0.0.1' });
  const local = await extracted({ id: 'd'.repeat(32), name: path.basename(f.filePath), path: f.filePath, ext: 'MP4', size: 1 }, { timestamps: null, frameCount: 10 }, { dataDir: f.dataDir });
  let failure;
  try {
    await sendRemoteAnalysis(local, { remoteUrl: `http://127.0.0.1:${status.port}`, connectionCode: status.connectionCode, dataDir: f.dataDir });
  } catch (error) { failure = error; }
  assert.ok(failure);
  assert.equal(failure.record.status, 'partial');
  assert.equal(failure.record.summary, '이미지 수신 전에 도착한 줄거리');
  assert.deepEqual(failure.record.transcript, local.transcript);
  assert.equal(failure.record.frames.length, 10);
  assert.match(failure.record.warnings.join(' '), /이미지 수신을 완료하지 못했습니다/);
});
