const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Reuse the owned in-memory browser fixture without registering that file's
// existing tests or touching a real browser, network, provider or video.
const fixtureFile = path.join(__dirname, 'auto-pick-ui.test.js');
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8');
const fixtureEnd = fixtureSource.indexOf('\ntest(');
assert(fixtureEnd > 0, 'the established UI fixture declarations precede its first test');
const fixtureModule = { exports: {} };
vm.runInNewContext(fixtureSource.slice(0, fixtureEnd) + '\nmodule.exports = { boot, picked, baseQueue };', {
  module: fixtureModule, require: createRequire(fixtureFile), __dirname, setImmediate, TextEncoder, URL, Blob, console
}, { filename: fixtureFile });
const { boot, picked, baseQueue } = fixtureModule.exports;
const publicDir = path.join(__dirname, '..', 'public');
const flush = () => new Promise(setImmediate);
const connection = () => ({ remoteUrl: 'http://192.168.55.166:3001', connectionCode: 'owned-turbo-ui-code', remembered: true });
const settings = (extra = {}) => ({ mode: 'remote', frameCount: 10, transcriptLanguage: 'ja', subtitleLanguage: 'ko',
  subtitleQuality: 'turbo', transcribeAudio: false, remoteUrl: connection().remoteUrl, ...extra });
const capabilities = ['timed-subtitles-v1', 'subtitle-quality-v3', 'turbo-subtitles-v1'];
const saved = ui => JSON.parse(ui.preferences.get('video_catalog_settings'));
const latestSettingsRequest = ui => ui.calls.filter(call => call.method === 'PUT' && call.url === '/api/analysis/auto-pick').at(-1);
const syntheticRecord = () => ({ ...picked('합성 초고속 안내.mp4'), id: 'owned-turbo-ui', status: 'partial', analysisMode: 'remote',
  summary: '합성 열차 안내', frames: [], duration: 60, transcriptSource: 'audio:faster-whisper small', transcriptLanguage: 'ja',
  transcript: [{ start: 1, end: 3, text: '合成の列車です。' }, { start: 5, end: 8, text: '出発時刻を確認してください。' }] });

async function selectQuality(ui, value) {
  ui.elements.get('catalogSubtitleQuality').value = value;
  await ui.elements.get('catalogSubtitleQuality').dispatch('change');
}

async function openDetail(ui) {
  await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
}

test('turbo remains an explicit quality choice with a visible speed and accuracy tradeoff', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const quality = html.match(/<select id="catalogSubtitleQuality">([\s\S]*?)<\/select>/)?.[1];
  assert(quality, 'the actual quality dropdown exists');
  assert.match(quality, /<option value="turbo"[^>]*>[^<]*초고속/);
  assert.match(html.slice(html.indexOf('id="catalogSubtitleQuality"'), html.indexOf('id="catalogSubtitleQuality"') + 3500),
    /초고속[\s\S]*(?:정확도|오인식|품질|검수)/);
  assert.match(quality, /value="fast"/);
  assert.match(quality, /value="accurate"/);
});

test('selecting turbo autosaves that exact profile, preserves connection options and restores it after reopening', async () => {
  const ui = await boot({ savedSettings: settings({ subtitleQuality: 'accurate' }), initialConnection: connection(), remoteCapabilities: capabilities });
  assert.equal(ui.elements.get('catalogSubtitleQuality').value, 'accurate', 'an update does not silently select a lower quality');
  await selectQuality(ui, 'turbo');
  await ui.runTimers(450);
  const options = latestSettingsRequest(ui).body.options;
  assert.equal(options.subtitleQuality, 'turbo');
  assert.equal(options.mode, 'remote');
  assert.equal(options.remoteUrl, connection().remoteUrl);
  assert.equal(options.connectionCode, connection().connectionCode);
  assert.equal(options.transcriptLanguage, 'ja');
  assert.equal(options.subtitleLanguage, 'ko');
  assert.equal(saved(ui).subtitleQuality, 'turbo');
  assert(!JSON.stringify(saved(ui)).includes(connection().connectionCode), 'the browser preference never stores the connection code');
  assert.match(ui.elements.get('catalogSettingsSummary').textContent, /초고속/);
  const reopened = await boot({ savedSettings: saved(ui), initialConnection: connection(), remoteCapabilities: capabilities });
  assert.equal(reopened.elements.get('catalogSubtitleQuality').value, 'turbo');
  assert.equal(latestSettingsRequest(reopened).body.options.subtitleQuality, 'turbo');
});

test('turbo durable queue settings restore and an in-flight explicit turbo choice survives older accurate configuration', async () => {
  const queue = { ...baseQueue(), configured: true, mode: 'codex', options: settings({ mode: 'codex' }) };
  const restored = await boot({ initialQueue: queue });
  assert.equal(restored.elements.get('catalogSubtitleQuality').value, 'turbo');
  const older = { ...queue, options: { ...queue.options, subtitleQuality: 'accurate' } };
  const edited = await boot({ initialQueue: older, delayConfig: true });
  await selectQuality(edited, 'turbo');
  edited.releaseConfig(); await flush(); await flush();
  assert.equal(edited.elements.get('catalogSubtitleQuality').value, 'turbo');
  assert.equal(latestSettingsRequest(edited).body.options.subtitleQuality, 'turbo');
});

test('a supported analysis server resumes the exact turbo options after a connection check', async () => {
  const ui = await boot({ savedSettings: settings(), initialConnection: connection(), remoteCapabilities: capabilities });
  const start = ui.calls.length;
  await ui.elements.get('catalogRemoteCheck').dispatch('click');
  const resumed = ui.calls.slice(start).find(call => call.url === '/api/analysis/auto-pick' && call.method === 'PUT' && call.body.resume);
  assert(resumed, 'a capable server permits the normal explicit connection resume');
  assert.equal(resumed.body.options.subtitleQuality, 'turbo');
  assert.equal(ui.elements.get('catalogRemoteStatus').classList.contains('catalog-error'), false);
});

test('an older server lacking turbo capability gives a clear update error without resuming or downgrading the choice', async () => {
  const ui = await boot({ savedSettings: settings(), initialConnection: connection(),
    remoteCapabilities: ['timed-subtitles-v1', 'subtitle-quality-v3'] });
  const start = ui.calls.length;
  await ui.elements.get('catalogRemoteCheck').dispatch('click');
  assert.match(ui.elements.get('catalogRemoteStatus').textContent, /초고속/);
  assert.match(ui.elements.get('catalogRemoteStatus').textContent, /업데이트|지원/);
  assert.equal(ui.elements.get('catalogRemoteStatus').classList.contains('catalog-error'), true);
  assert(!ui.calls.slice(start).some(call => call.url === '/api/analysis/auto-pick' && call.body?.resume));
  assert.equal(ui.elements.get('catalogSubtitleQuality').value, 'turbo');
  assert.equal(saved(ui).subtitleQuality, 'turbo');
});

test('random-pick automatic queue and selected manual analysis send turbo unchanged to the remote backend', async () => {
  for (const manual of [false, true]) {
    const ui = await boot({ savedSettings: settings(), initialConnection: connection(), remoteCapabilities: capabilities });
    const file = picked(manual ? '합성 선택 분석.mp4' : '합성 무작위 분석.mp4');
    const start = ui.calls.length;
    if (manual) {
      ui.sandbox.videoCatalog.onScan([file]);
      const checkbox = ui.elements.get('catalogRows').childNodes[0].childNodes[0].childNodes[0];
      checkbox.checked = true; await checkbox.dispatch('change');
      await ui.elements.get('catalogAnalyze').dispatch('click');
    } else await ui.sandbox.videoCatalog.onPick(file);
    const submitted = ui.calls.slice(start).find(call => call.method === 'POST'
      && call.url === (manual ? '/api/analysis/jobs' : '/api/analysis/auto-pick'));
    assert(submitted, manual ? 'the selected file starts manual analysis' : 'the picked file is queued automatically');
    assert.equal(submitted.body.options.subtitleQuality, 'turbo');
    assert.equal(submitted.body.options.mode, 'remote');
    assert.equal(submitted.body.options.remoteUrl, connection().remoteUrl);
    assert.equal(submitted.body.options.connectionCode, connection().connectionCode);
  }
});

test('whole-analysis repair and translation-only repair preserve the explicit turbo profile', async () => {
  for (const translationOnly of [false, true]) {
    const record = syntheticRecord();
    const ui = await boot({ savedSettings: settings(), initialConnection: connection(), remoteCapabilities: capabilities, records: [record] });
    await openDetail(ui);
    await ui.elements.get(translationOnly ? 'catalogSubtitleRepair' : 'catalogDetailRepair').dispatch('click');
    const url = `/api/analysis/results/${record.id}/${translationOnly ? 'subtitles/repair' : 'repair'}`;
    const submitted = ui.calls.find(call => call.method === 'POST' && call.url === url);
    assert(submitted, 'the requested repair starts without replacing its profile');
    assert.equal(submitted.body.options.subtitleQuality, 'turbo');
    assert.equal(submitted.body.options.mode, 'remote');
    assert.equal(submitted.body.options.connectionCode, connection().connectionCode);
    if (translationOnly) {
      assert.equal(submitted.body.options.transcribeAudio, false);
      assert.equal(submitted.body.options.subtitleLanguage, 'ko');
      assert(!ui.calls.some(call => call.method === 'POST' && call.url === `/api/analysis/results/${record.id}/repair`));
    }
  }
});

test('turbo runtime metadata accepts only known batch sizes and renders the measured profile without inferring accuracy', () => {
  const progress = require('../public/js/analysis-progress');
  for (const batchSize of [1, 4]) {
    const metadata = { model: 'small', profile: 'turbo', device: 'cuda', computeType: 'int8_float16', workers: 1, batchSize };
    assert.deepEqual(progress.normalizeSpeechMetadata(metadata), metadata);
    const text = progress.formatSpeechMetadata(metadata);
    assert.match(text, /초고속/);
    assert.match(text, new RegExp(`(?:${batchSize}.*(?:묶음|배치)|(?:묶음|배치).*${batchSize})`));
    assert.doesNotMatch(text, /정확도 우선/);
    assert.equal(progress.normalizeProgressDetails({ phase: 'transcription', completedSeconds: 10, totalSeconds: 60, ...metadata }).batchSize, batchSize);
  }
  for (const batchSize of [undefined, 0, 2, 3, 5, 4.5, '4', NaN, Infinity]) {
    assert.equal(Object.hasOwn(progress.normalizeSpeechMetadata({ profile: 'turbo', batchSize }), 'batchSize'), false);
  }
  assert.deepEqual(progress.normalizeSpeechMetadata({ profile: 'untrusted', batchSize: 999, prompt: 'PRIVATE', path: 'PRIVATE' }), {});
});

test('the active dashboard displays the actual turbo profile and batch size reported by the server', async () => {
  const file = picked('합성 초고속 처리 중.mp4');
  const running = { id: 'owned-turbo-runtime', status: 'running', source: 'auto-pick', total: 1, completed: 0,
    percent: 50, currentFile: file.name, currentFilePath: file.path, stage: '음성 인식', results: [],
    phaseProgress: { phase: 'transcription', completedSeconds: 30, totalSeconds: 60,
      model: 'small', profile: 'turbo', device: 'cuda', computeType: 'int8_float16', workers: 1, batchSize: 4 } };
  const queue = { ...baseQueue(), configured: true, activeAutoPath: file.path, activeJob: running, mode: 'remote', options: settings() };
  const ui = await boot({ initialActiveJob: running, initialQueue: queue, initialConnection: connection(), savedSettings: settings() });
  const text = ui.elements.get('catalogJobText').textContent;
  assert.match(text, /small.*초고속.*GPU \(CUDA\).*int8_float16/);
  assert.match(text, /(?:4.*(?:묶음|배치)|(?:묶음|배치).*4)/);
  assert.doesNotMatch(text, /large-v3|정확도 우선/);
});
