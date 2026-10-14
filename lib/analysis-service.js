const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.wmv', '.avi', '.mpg', '.mpeg', '.asf', '.flv', '.webm', '.mov', '.3gp', '.ts', '.m4v', '.tp', '.m2ts']);
const SAFE_ID = /^[a-f0-9]{16,64}$/;
const STAGE_LABELS = { probe: '영상 정보 읽기', frames: '대표 이미지 추출', subtitles: '자막 읽기', transcription: '전체 음성의 대사 인식', summary: '줄거리와 라벨 생성', completed: '분석 완료' };

function defaultDataDir() {
  return process.env.VIDEORANDOM_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'VideoRandom', 'catalog');
}

function fileKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function validateOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('분석 설정이 올바르지 않습니다.');
  const mode = input.mode || 'local';
  if (!['local', 'codex', 'remote'].includes(mode)) throw new Error('분석 방식은 로컬 추출, 이 PC의 Codex, 분석 서버 연결 중에서 선택해 주세요.');
  const frameCount = input.frameCount === undefined ? 10 : input.frameCount;
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 20) throw new Error('대표 이미지는 1~20장 사이로 설정해 주세요.');
  // Old browser preferences may still contain fixed times. Each video's
  // duration now determines its evenly spaced representative scenes.
  const timestamps = null;
  let remoteUrl = '', connectionCode = '';
  if (mode === 'remote') {
    if (typeof input.remoteUrl !== 'string' || typeof input.connectionCode !== 'string' || !input.connectionCode.trim()) throw new Error('분석 서버 주소와 연결 코드를 입력해 주세요.');
    const parsed = new URL(input.remoteUrl);
    const hostname = parsed.hostname;
    const privateAddress = /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.)\d/.test(hostname);
    if (parsed.protocol !== 'http:' || !privateAddress || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) throw new Error('서버 주소는 같은 공유기의 내부 IP 주소로 입력해 주세요. 예: http://192.168.55.166:3001');
    remoteUrl = parsed.origin;
    connectionCode = input.connectionCode.trim();
    if (connectionCode.length > 256 || /[\r\n]/.test(connectionCode)) throw new Error('연결 코드가 올바르지 않습니다.');
  }
  return { mode, apiKey: '', frameCount, timestamps, remoteUrl, connectionCode, transcribeAudio: mode !== 'local' && input.transcribeAudio === true };
}

function createAnalysisService({ dataDir = defaultDataDir(), engine, exporter, lan, connectionStore, deferAutoStart = false } = {}) {
  dataDir = path.resolve(dataDir);
  connectionStore = connectionStore || require('./connection-store').createConnectionStore({ dataDir });
  engine = engine || require('./catalog-engine');
  exporter = exporter || require('./excel-export');
  lan = lan || require('./lan-analysis').createLanAnalysis({
    dataDir, connectionStore,
    processPackage: async (pkg, context) => require('./no-key-provider').analyzeExtracted(pkg.record, {
      dataDir, framesDir: pkg.framesDir, audioPath: pkg.audioPath,
      transcribeAudio: pkg.transcribeAudio, signal: context.signal, onProgress: context.onProgress
    })
  });
  const router = express.Router();
  const records = new Map();
  const scanned = new Map();
  const jobs = new Map();
  let activeJob = null;
  let exportInProgress = false;
  const autoQueuePath = path.join(dataDir, 'auto-pick.json');
  let autoPick = { enabled: true, paused: false, pauseReason: '', safeOptions: null, entries: [] };
  let remoteCode = '', remoteCodeUrl = '', autoWaitingReason = '';
  let rememberedConnection = { remoteUrl: '', connectionCode: '', remembered: false }, connectionGeneration = 0, connectionError = '';
  let autoActivated = !deferAutoStart;
  let mutation = Promise.resolve(), autoScheduled = false, stopped = false;
  // Every job start and queue mutation shares this lock. Filesystem/provider
  // checks await without allowing a second request to start another job.
  function serialize(task) {
    const operation = mutation.then(task);
    mutation = operation.catch(() => {});
    return operation;
  }

  function safeAutoOptions(input) {
    // A picked video must remain queued while its server address/code is being
    // configured. Network validation is mandatory again before starting it.
    if (input?.mode !== 'remote') {
      const validated = validateOptions(input);
      return { mode: validated.mode, frameCount: validated.frameCount, transcribeAudio: validated.transcribeAudio, remoteUrl: '' };
    }
    const validated = validateOptions({ ...input, mode: 'local' });
    let remoteUrl = typeof input.remoteUrl === 'string' ? input.remoteUrl.trim().slice(0, 2048) : '';
    try {
      // Only a validated private origin can reach the journal. Even malformed
      // URLs may contain credentials, so discard every invalid raw address.
      if (/[\r\n]/.test(remoteUrl)) throw new Error('Invalid server address');
      remoteUrl = validateOptions({ mode: 'remote', remoteUrl, connectionCode: 'configuration-check-only' }).remoteUrl;
    } catch (_) { remoteUrl = ''; }
    if (input.connectionCode !== undefined && (typeof input.connectionCode !== 'string' || input.connectionCode.length > 256 || /[\r\n]/.test(input.connectionCode))) throw new Error('연결 코드가 올바르지 않습니다.');
    return { mode: 'remote', frameCount: validated.frameCount, transcribeAudio: input.transcribeAudio === true, remoteUrl };
  }

  function configuredCredentials(input, options) {
    if (options.mode !== 'remote') return { code: '', url: '' };
    const supplied = typeof input.connectionCode === 'string' ? input.connectionCode.trim() : '';
    return { code: supplied || (rememberedConnection.remoteUrl === options.remoteUrl ? rememberedConnection.connectionCode : '') || (remoteCodeUrl === options.remoteUrl ? remoteCode : ''), url: options.remoteUrl };
  }

  function resolveOptions(input = {}) {
    if (input?.mode !== 'remote') return validateOptions(input);
    const safe = safeAutoOptions(input);
    const credentials = configuredCredentials(input, safe);
    return validateOptions({ ...input, remoteUrl: safe.remoteUrl, connectionCode: credentials.code });
  }

  async function rememberCredentials(credentials) {
    if (!credentials.code || !credentials.url) return;
    if (rememberedConnection.remoteUrl === credentials.url && rememberedConnection.connectionCode === credentials.code) return;
    rememberedConnection = await connectionStore.saveConnection({ remoteUrl: credentials.url, connectionCode: credentials.code });
    connectionError = '';
    connectionGeneration++;
  }

  function applyCredentials(credentials) {
    if (remoteCode !== credentials.code || remoteCodeUrl !== credentials.url) connectionGeneration++;
    remoteCode = credentials.code;
    remoteCodeUrl = credentials.url;
  }

  async function saveAutoQueue(next) {
    const temporary = autoQueuePath + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, enabled: next.enabled, paused: next.paused, pauseReason: next.pauseReason, safeOptions: next.safeOptions, entries: next.entries }), 'utf8');
      await fs.rename(temporary, autoQueuePath);
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw new Error('자동 분석 대기 목록을 이 PC에 저장하지 못했습니다. 저장 폴더를 확인해 주세요.');
    }
  }

  function completedPath(filePath) {
    const key = fileKey(filePath);
    return [...records.values()].some(record => record.status === 'completed' && fileKey(record.path) === key);
  }

  function autoSnapshot() {
    const activeAutoPath = activeJob?.source === 'auto-pick' ? activeJob.files[0]?.path || '' : '';
    const pending = autoPick.entries.filter(entry => !activeAutoPath || fileKey(entry.path) !== fileKey(activeAutoPath)).map(({ name, path: filePath, queuedAt }) => ({ name, path: filePath, queuedAt }));
    let waitingReason = autoWaitingReason;
    if (!autoPick.enabled) waitingReason = '무작위 영상 자동 분석이 꺼져 있습니다.';
    else if (autoPick.paused) waitingReason = autoPick.pauseReason || '자동 분석이 일시 중지되었습니다. 계속하려면 재개를 눌러 주세요.';
    else if (autoPick.entries.length && !autoPick.safeOptions) waitingReason = '분석 설정을 선택하면 자동 분석을 시작합니다.';
    else if (autoPick.entries.length && autoPick.safeOptions?.mode === 'remote' && !autoOptionsConfigured()) waitingReason = '분석 서버 주소와 연결 코드를 입력하면 저장된 자동 분석 대기 목록을 이어서 처리합니다.';
    else if (autoPick.entries.length && autoPick.safeOptions?.mode === 'remote' && (!remoteCode || remoteCodeUrl !== autoPick.safeOptions.remoteUrl)) waitingReason = '서버 연결 코드를 다시 입력하면 저장된 자동 분석 대기 목록을 이어서 처리합니다.';
    else if (pending.length && activeJob) waitingReason = '진행 중인 분석이 끝나면 자동 분석을 이어서 처리합니다.';
    return { enabled: autoPick.enabled, paused: autoPick.paused, pendingCount: pending.length, pending, waitingReason, connectionError, activeAutoPath, configured: autoOptionsConfigured(), mode: autoPick.safeOptions?.mode || null, options: autoPick.safeOptions ? { ...autoPick.safeOptions } : null, savedCount: records.size, activeJob: snapshot(activeJob) };
  }

  function autoOptionsConfigured() {
    if (!autoPick.safeOptions) return false;
    try { validateOptions({ ...autoPick.safeOptions, connectionCode: 'configuration-check-only' }); return true; }
    catch (_) { return false; }
  }

  function createJob(files, options, source = 'manual') {
    const job = { id: crypto.randomBytes(16).toString('hex'), source, pairingGeneration: connectionGeneration, status: 'running', total: files.length, completed: 0, currentFile: '', stage: '분석 시작', percent: 0, error: '', results: [], startedAt: new Date().toISOString(), files, options, controller: new AbortController() };
    while (jobs.size >= 20) jobs.delete(jobs.keys().next().value);
    jobs.set(job.id, job);
    activeJob = job;
    setImmediate(() => runJob(job));
    return job;
  }

  function scheduleAuto() {
    if (autoScheduled || stopped || !autoActivated) return;
    autoScheduled = true;
    setImmediate(() => {
      autoScheduled = false;
      serialize(drainAutoQueue).catch(() => { autoWaitingReason = '자동 분석 대기 목록을 저장하지 못했습니다. 결과 불러오기 후 다시 시도해 주세요.'; });
    });
  }

  async function drainAutoQueue() {
    if (stopped || !autoActivated || activeJob || !autoPick.enabled || autoPick.paused || !autoPick.entries.length || !autoPick.safeOptions) return;
    autoWaitingReason = '';
    if (!autoOptionsConfigured()) return;
    const options = { ...autoPick.safeOptions, connectionCode: remoteCodeUrl === autoPick.safeOptions.remoteUrl ? remoteCode : '' };
    if (options.mode === 'remote' && !options.connectionCode) return;
    try {
      const tools = await engine.getToolsStatus(dataDir);
      if (!tools.available) throw new Error('FFmpeg / FFprobe가 준비되면 자동 분석을 재개할 수 있습니다.');
      if (options.mode === 'codex' && engine.getProviderStatus) {
        const providers = await engine.getProviderStatus(dataDir);
        if (!providers.codex?.loggedIn || !providers.speech?.available) throw new Error('이 PC의 Codex 로그인과 음성 인식 준비를 확인한 뒤 자동 분석을 재개해 주세요.');
      }
    } catch (error) { autoWaitingReason = error.message; return; }
    if (stopped) return;
    while (autoPick.entries.length) {
      const entry = autoPick.entries[0];
      if (completedPath(entry.path)) {
        const next = { ...autoPick, entries: autoPick.entries.slice(1) };
        await saveAutoQueue(next);
        autoPick = next;
        continue;
      }
      try {
        const stats = await fs.stat(entry.path);
        if (!stats.isFile() || !VIDEO_EXTENSIONS.has(path.extname(entry.path).toLowerCase())) throw new Error('파일을 찾을 수 없습니다.');
        const file = { ...entry, id: crypto.randomBytes(16).toString('hex'), size: Math.round(stats.size / 104857.6) / 10 };
        createJob([file], validateOptions(options), 'auto-pick');
        return;
      } catch (error) {
        const next = { ...autoPick, paused: true, pauseReason: `${entry.name} 파일에 접근할 수 없어 자동 분석을 일시 중지했습니다. 파일을 확인한 뒤 재개해 주세요.`, entries: autoPick.entries.slice(1) };
        await saveAutoQueue(next);
        autoPick = next;
        return;
      }
    }
  }
  function hostStatus() {
    const status = lan.status();
    const addresses = [];
    for (const [name, entries] of Object.entries(os.networkInterfaces())) {
      if (/vEthernet|WSL|VMware|VirtualBox|loopback/i.test(name)) continue;
      for (const entry of entries || []) {
        if (entry.family === 'IPv4' && !entry.internal && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(entry.address)) addresses.push({ name, url: `http://${entry.address}:${status.port || 3001}` });
      }
    }
    addresses.sort((a, b) => Number(/\d/.test(a.name)) - Number(/\d/.test(b.name)) || a.name.localeCompare(b.name));
    return { ...status, addresses: addresses.map(address => address.url) };
  }
  async function startHost() {
    const providers = await engine.getProviderStatus(dataDir);
    if (!providers.codex.loggedIn || !providers.speech.available) throw new Error('이 PC에서 Codex 로그인과 로컬 음성 인식 준비를 먼저 완료해 주세요.');
    await lan.start({ port: Number(process.env.VIDEORANDOM_HOST_PORT) || 3001 });
    await connectionStore.setHostEnabled(true);
    return hostStatus();
  }
  const resultsDir = path.join(dataDir, 'results');
  const ready = (async () => {
    await fs.mkdir(resultsDir, { recursive: true });
    try { rememberedConnection = await connectionStore.getConnection(); }
    catch (error) { connectionError = error.message; }
    const names = await fs.readdir(resultsDir);
    for (const name of names) {
      if (!/^[a-f0-9]{16,64}\.json$/.test(name)) continue;
      try {
        const record = JSON.parse(await fs.readFile(path.join(resultsDir, name), 'utf8'));
        if (record.id === name.slice(0, -5) && typeof record.path === 'string') records.set(record.id, record);
      } catch (error) {
        console.warn('저장된 영상 분석 결과를 읽지 못했습니다:', name, error.message);
      }
    }
    try {
      const saved = JSON.parse(await fs.readFile(autoQueuePath, 'utf8'));
      if (saved.schemaVersion !== 1 || !Array.isArray(saved.entries)) throw new Error('잘못된 자동 분석 대기 목록');
      const seen = new Set();
      const entries = saved.entries.slice(0, 1000).filter(entry => {
        if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path) || !VIDEO_EXTENSIONS.has(path.extname(entry.path).toLowerCase())) return false;
        const key = fileKey(entry.path);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).map(entry => ({ path: path.resolve(entry.path), name: path.basename(entry.path), ext: path.extname(entry.path).slice(1).toUpperCase(), size: Number(entry.size) || 0, queuedAt: typeof entry.queuedAt === 'string' ? entry.queuedAt : new Date().toISOString() }));
      autoPick = { enabled: saved.enabled !== false, paused: saved.paused === true, pauseReason: typeof saved.pauseReason === 'string' ? saved.pauseReason : '', safeOptions: saved.safeOptions ? safeAutoOptions(saved.safeOptions) : null, entries };
      registerFiles(entries);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        autoPick.paused = true;
        autoPick.pauseReason = '저장된 자동 분석 대기 목록을 읽지 못했습니다. 설정을 확인하고 재개해 주세요.';
      }
    }
    if (autoPick.safeOptions?.mode === 'remote' && autoPick.safeOptions.remoteUrl === rememberedConnection.remoteUrl) {
      remoteCode = rememberedConnection.connectionCode;
      remoteCodeUrl = rememberedConnection.remoteUrl;
    }
  })();
  ready.then(scheduleAuto, () => {});

  router.use(async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try { await ready; next(); } catch (error) { res.status(500).json({ error: '분석 저장 폴더에 접근할 수 없습니다: ' + error.message }); }
  });

  function registerFiles(files) {
    for (const file of files) scanned.set(fileKey(file.path), { ...file, path: path.resolve(file.path) });
  }

  async function saveRecord(record) {
    record.savedAt = new Date().toISOString();
    const target = path.join(resultsDir, record.id + '.json');
    const temporary = target + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(record), 'utf8');
    await fs.rename(temporary, target);
    records.set(record.id, record);
  }

  function snapshot(job) {
    if (!job) return null;
    const { controller, options, files, pairingGeneration, ...publicJob } = job;
    return publicJob;
  }

  async function runJob(job) {
    try {
      for (const file of job.files) {
        if (job.controller.signal.aborted) break;
        job.currentFile = file.name;
        job.stage = '영상 분석 준비';
        job.percent = 0;
        let record;
        try {
          record = await engine.analyzeVideo(file, job.options, {
            dataDir,
            signal: job.controller.signal,
            onProgress(stage, percent) {
              job.stage = STAGE_LABELS[stage] || String(stage);
              job.percent = Math.max(0, Math.min(100, Number(percent) || 0));
            }
          });
        } catch (error) {
          record = error.record || { ...file, duration: 0, summary: '', plot: '', dialogueSummary: '', labels: [], transcriptSource: '', transcript: [], frames: [], warnings: [], analyzedAt: new Date().toISOString() };
          record.status = job.controller.signal.aborted ? 'partial' : 'failed';
          record.error = job.controller.signal.aborted ? '사용자가 분석을 중지했습니다.' : error.message;
          if (job.controller.signal.aborted) record.warnings = [...(record.warnings || []), '중지 전까지 추출한 결과입니다. 대사와 장면이 일부만 포함될 수 있습니다.'];
        }
        record.id = file.id;
        record.path = file.path;
        if (record.status !== 'completed' && [...records.values()].some(previous => previous.status === 'completed' && fileKey(previous.path) === fileKey(file.path))) {
          record.warnings = [...new Set([...(record.warnings || []), '재분석이 완료되지 않았습니다. 이전에 완료한 분석 결과와 이미지는 그대로 보관했습니다.'])];
        }
        await saveRecord(record);
        if (job.options.mode === 'remote' && record.status === 'completed') {
          await serialize(async () => {
            if (job.pairingGeneration !== connectionGeneration) return;
            try {
              await rememberCredentials({ code: job.options.connectionCode, url: job.options.remoteUrl });
              job.pairingGeneration = connectionGeneration;
            } catch (error) { connectionError = error.message; }
          });
        }
        job.results.push(record);
        job.completed++;
        if (job.controller.signal.aborted) break;
      }
      job.status = job.controller.signal.aborted ? 'cancelled' : 'completed';
      job.stage = job.status === 'cancelled' ? '분석 중지됨' : '분석 완료';
      job.percent = job.status === 'completed' ? 100 : job.percent;
    } catch (error) {
      job.status = 'failed';
      job.error = '분석 결과 저장 중 오류가 발생했습니다: ' + error.message;
    } finally {
      job.finishedAt = new Date().toISOString();
      job.currentFile = '';
      job.options.apiKey = '';
      job.options.connectionCode = '';
      await serialize(async () => {
        if (job.source === 'auto-pick' && !stopped) {
          const successful = job.status === 'completed' && job.results.every(record => record.status === 'completed');
          // A failed result write has no durable terminal record. Retain its
          // journal entry so a later explicit resume can recover the attempt.
          const next = { ...autoPick, entries: job.results.length ? autoPick.entries.filter(entry => fileKey(entry.path) !== fileKey(job.files[0].path)) : autoPick.entries };
          if (!successful) {
            next.paused = true;
            next.pauseReason = job.status === 'cancelled' ? '자동 분석을 중지했습니다. 대기 중인 영상은 재개를 누르면 이어서 처리합니다.' : `자동 분석이 완료되지 않아 대기 목록을 일시 중지했습니다. ${job.error || job.results.find(record => record.status !== 'completed')?.error || '분석 환경을 확인한 뒤 재개해 주세요.'}`;
          }
          try { await saveAutoQueue(next); autoPick = next; }
          catch (error) { autoPick.paused = true; autoPick.pauseReason = error.message; }
        }
        if (activeJob === job) activeJob = null;
      });
      scheduleAuto();
    }
  }

  router.get('/config', async (req, res) => {
    try {
      const [tools, providers] = await Promise.all([
        engine.getToolsStatus(dataDir),
        engine.getProviderStatus ? engine.getProviderStatus(dataDir) : Promise.resolve(null)
      ]);
      res.json({ tools, providers, host: hostStatus(), connection: { ...rememberedConnection, ...(connectionError ? { error: connectionError } : {}) }, storage: { directory: dataDir, resultsDirectory: resultsDir, framesDirectory: path.join(dataDir, 'frames'), savedCount: records.size }, defaultMode: providers?.codex?.loggedIn && providers?.speech?.available ? 'codex' : 'local', activeJob: snapshot(activeJob), autoPick: autoSnapshot() });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  router.get('/host/status', (req, res) => res.json(hostStatus()));
  router.post('/host/start', async (req, res) => {
    try {
      res.json(await startHost());
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.post('/host/stop', async (req, res) => {
    try { await lan.stop(); await connectionStore.setHostEnabled(false); res.json(hostStatus()); } catch (error) { res.status(500).json({ error: error.message }); }
  });
  router.get('/connection', async (req, res) => {
    try { rememberedConnection = await connectionStore.getConnection(); connectionError = ''; res.json(rememberedConnection); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.put('/connection', async (req, res) => {
    try {
      const connection = await serialize(async () => {
        const options = resolveOptions({ ...req.body, mode: 'remote' });
        rememberedConnection = await connectionStore.saveConnection(options);
        connectionGeneration++;
        connectionError = '';
        if (autoPick.safeOptions?.remoteUrl === options.remoteUrl) { remoteCode = options.connectionCode; remoteCodeUrl = options.remoteUrl; }
        return rememberedConnection;
      });
      scheduleAuto();
      res.json(connection);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.delete('/connection', async (req, res) => {
    try {
      const connection = await serialize(async () => {
        rememberedConnection = await connectionStore.clearConnection();
        connectionGeneration++;
        connectionError = '';
        remoteCode = ''; remoteCodeUrl = '';
        return rememberedConnection;
      });
      res.json(connection);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.post('/remote/check', async (req, res) => {
    try {
      const generation = ++connectionGeneration;
      const options = resolveOptions({ ...req.body, mode: 'remote' });
      const status = await require('./lan-analysis').checkRemoteServer(options);
      const connection = await serialize(async () => {
        if (generation !== connectionGeneration) return null;
        rememberedConnection = await connectionStore.saveConnection(options);
        connectionError = '';
        if (autoPick.safeOptions?.remoteUrl === options.remoteUrl) { remoteCode = options.connectionCode; remoteCodeUrl = options.remoteUrl; }
        return rememberedConnection;
      });
      scheduleAuto();
      res.json({ ...status, ...(connection ? { connection } : {}) });
    } catch (error) { res.status(400).json({ error: '분석 서버에 연결하지 못했습니다: ' + error.message }); }
  });

  router.get('/results', (req, res) => {
    res.json({ results: [...records.values()].sort((a, b) => String(b.savedAt || b.analyzedAt).localeCompare(String(a.savedAt || a.analyzedAt))) });
  });

  router.get('/auto-pick', (req, res) => { scheduleAuto(); res.json(autoSnapshot()); });

  router.put('/auto-pick', async (req, res) => {
    try {
      const queue = await serialize(async () => {
        const body = req.body || {};
        if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new Error('자동 분석 사용 여부가 올바르지 않습니다.');
        if (body.resume !== undefined && typeof body.resume !== 'boolean') throw new Error('자동 분석 재개 설정이 올바르지 않습니다.');
        const options = body.options === undefined ? autoPick.safeOptions : safeAutoOptions(body.options);
        const credentials = body.options === undefined ? { code: remoteCode, url: remoteCodeUrl } : configuredCredentials(body.options, options);
        const next = { ...autoPick, enabled: body.enabled === undefined ? autoPick.enabled : body.enabled, safeOptions: options };
        if (body.resume === true) { next.paused = false; next.pauseReason = ''; }
        await saveAutoQueue(next);
        autoPick = next;
        applyCredentials(credentials);
        autoWaitingReason = '';
        return autoSnapshot();
      });
      scheduleAuto();
      res.json({ ...queue, queue });
    } catch (error) { res.status(400).json({ error: error.message, queue: autoSnapshot() }); }
  });

  router.post('/auto-pick', async (req, res) => {
    try {
      const result = await serialize(async () => {
        const body = req.body || {};
        if (!autoPick.enabled) return { status: 'disabled', queue: autoSnapshot() };
        if (typeof body.filePath !== 'string' || !body.filePath) throw new Error('자동 분석할 영상 경로가 필요합니다.');
        const key = fileKey(body.filePath);
        const registered = scanned.get(key) || [...records.values()].find(record => fileKey(record.path) === key);
        if (!registered || !VIDEO_EXTENSIONS.has(path.extname(body.filePath).toLowerCase())) throw new Error('스캔 목록에 없는 파일입니다. 먼저 해당 폴더를 스캔해 주세요.');
        if (completedPath(registered.path)) return { status: 'already-completed', queue: autoSnapshot() };
        if (autoPick.entries.some(entry => fileKey(entry.path) === key) || activeJob?.files.some(file => fileKey(file.path) === key)) return { status: 'already-queued', queue: autoSnapshot() };
        if (autoPick.entries.length >= 1000) throw new Error('자동 분석 대기 목록은 최대 1,000개입니다. 기존 분석이 끝난 뒤 다시 뽑아 주세요.');
        const stats = await fs.stat(registered.path);
        if (!stats.isFile()) throw new Error('영상 파일에 접근할 수 없습니다.');
        const options = body.options === undefined ? autoPick.safeOptions : safeAutoOptions(body.options);
        const credentials = body.options === undefined ? { code: remoteCode, url: remoteCodeUrl } : configuredCredentials(body.options, options);
        const entry = { path: path.resolve(registered.path), name: path.basename(registered.path), ext: path.extname(registered.path).slice(1).toUpperCase(), size: Math.round(stats.size / 104857.6) / 10, queuedAt: new Date().toISOString() };
        const next = { ...autoPick, safeOptions: options, entries: [...autoPick.entries, entry] };
        await saveAutoQueue(next);
        autoPick = next;
        applyCredentials(credentials);
        autoWaitingReason = '';
        return { status: 'queued', queue: autoSnapshot() };
      });
      scheduleAuto();
      res.status(result.status === 'queued' ? 202 : 200).json(result);
    } catch (error) { res.status(400).json({ error: error.message, queue: autoSnapshot() }); }
  });

  router.delete('/auto-pick/pending', async (req, res) => {
    try {
      const queue = await serialize(async () => {
        const activePath = activeJob?.source === 'auto-pick' ? fileKey(activeJob.files[0].path) : '';
        const next = { ...autoPick, entries: autoPick.entries.filter(entry => activePath && fileKey(entry.path) === activePath) };
        await saveAutoQueue(next);
        autoPick = next;
        return autoSnapshot();
      });
      res.json({ ...queue, queue });
    } catch (error) { res.status(400).json({ error: error.message, queue: autoSnapshot() }); }
  });

  router.post('/jobs', async (req, res) => {
    try {
      const job = await serialize(async () => {
      if (activeJob) {
        const error = new Error('진행 중인 분석이 있습니다. 완료되거나 중지한 뒤 다시 시작해 주세요.');
        error.status = 409;
        throw error;
      }
      const options = resolveOptions(req.body.options);
      const paths = req.body.files;
      if (!Array.isArray(paths) || !paths.length || paths.length > 1000 || paths.some(p => typeof p !== 'string' || !p)) throw new Error('분석할 영상을 1~1,000개 선택해 주세요.');
      const files = [];
      const seen = new Set();
      for (const filePath of paths) {
        const key = fileKey(filePath);
        if (seen.has(key)) continue;
        seen.add(key);
        const registered = scanned.get(key) || [...records.values()].find(r => fileKey(r.path) === key);
        if (!registered || !VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw new Error('스캔 목록에 없는 파일입니다. 먼저 해당 폴더를 스캔해 주세요.');
        const stats = await fs.stat(registered.path);
        if (!stats.isFile()) throw new Error('영상 파일에 접근할 수 없습니다: ' + registered.name);
        // A new attempt gets its own files. Reanalysis must never overwrite
        // images referenced by an already saved, completed analysis.
        const id = crypto.randomBytes(16).toString('hex');
        files.push({ id, name: path.basename(registered.path), path: registered.path, ext: path.extname(registered.path).slice(1).toUpperCase(), size: Math.round(stats.size / 104857.6) / 10 });
      }
      const tools = await engine.getToolsStatus(dataDir);
      if (!tools.available) throw new Error('영상 분석 도구를 실행할 수 없습니다. FFmpeg / FFprobe 경로를 확인해 주세요.');
      if (options.mode === 'codex' && engine.getProviderStatus) {
        const providers = await engine.getProviderStatus(dataDir);
        if (!providers.codex.loggedIn || !providers.speech.available) throw new Error('이 PC의 Codex 로그인과 로컬 음성 인식 준비를 확인해 주세요.');
      }
      return createJob(files, options);
      });
      res.status(202).json(snapshot(job));
    } catch (error) { res.status(error.status || 400).json({ error: error.message, ...(error.status === 409 ? { job: snapshot(activeJob) } : {}) }); }
  });

  router.get('/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: '분석 작업을 찾을 수 없습니다. 저장된 결과를 다시 불러와 주세요.' });
    res.json(snapshot(job));
  });

  router.post('/jobs/:id/cancel', async (req, res) => {
    try {
      const result = await serialize(async () => {
        const job = jobs.get(req.params.id);
        if (!job) { const error = new Error('분석 작업을 찾을 수 없습니다.'); error.status = 404; throw error; }
        if (job.status === 'running') {
          if (job.source === 'auto-pick' || autoPick.entries.length) {
            const next = { ...autoPick, paused: true, pauseReason: '분석을 중지했습니다. 자동 분석 대기 목록은 재개를 누르면 이어서 처리합니다.' };
            await saveAutoQueue(next);
            autoPick = next;
          }
          job.status = 'cancelling';
          job.stage = '분석 중지 중';
          job.controller.abort();
        }
        return snapshot(job);
      });
      res.json(result);
    } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
  });

  router.put('/results/:id', async (req, res) => {
    const previous = records.get(req.params.id);
    if (!previous) return res.status(404).json({ error: '분석 결과를 찾을 수 없습니다.' });
    if (activeJob && activeJob.files.some(f => f.id === previous.id)) return res.status(409).json({ error: '이 영상은 분석 중입니다. 완료 후 수정해 주세요.' });
    try {
      const next = { ...previous };
      for (const field of ['summary', 'plot', 'dialogueSummary']) {
        if (req.body[field] !== undefined) {
          if (typeof req.body[field] !== 'string' || req.body[field].length > 100000) throw new Error('요약은 100,000자 이내의 텍스트로 입력해 주세요.');
          next[field] = req.body[field];
        }
      }
      if (req.body.labels !== undefined) {
        if (!Array.isArray(req.body.labels) || req.body.labels.length > 50 || req.body.labels.some(l => typeof l !== 'string' || l.length > 100)) throw new Error('라벨은 100자 이내의 텍스트로 최대 50개까지 입력해 주세요.');
        next.labels = [...new Set(req.body.labels.map(l => l.trim()).filter(Boolean))];
      }
      next.editedAt = new Date().toISOString();
      await saveRecord(next);
      res.json(next);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.get('/frames/:id/:filename', async (req, res) => {
    const { id, filename } = req.params;
    const record = records.get(id);
    if (!SAFE_ID.test(id) || !/^[a-zA-Z0-9_-]+\.jpe?g$/.test(filename) || !record || !record.frames?.some(f => f.filename === filename)) return res.status(404).json({ error: '대표 이미지를 찾을 수 없습니다.' });
    res.sendFile(path.resolve(dataDir, 'frames', id, filename), error => {
      if (error && !res.headersSent) res.status(404).json({ error: '대표 이미지 파일이 없습니다.' });
    });
  });

  router.post('/export', async (req, res) => {
    if (exportInProgress) return res.status(409).json({ error: '엑셀을 만드는 중입니다. 잠시 후 다시 시도해 주세요.' });
    try {
      const ids = req.body.ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => typeof id !== 'string' || !records.has(id))) return res.status(400).json({ error: '엑셀로 내보낼 분석 결과를 1~1,000개 선택해 주세요.' });
      const selected = [...new Set(ids)].map(id => records.get(id));
      if (activeJob && selected.some(record => activeJob.files.some(file => file.id === record.id))) return res.status(409).json({ error: '선택한 영상의 분석이 끝난 후 엑셀로 저장해 주세요.' });
      exportInProgress = true;
      const buffer = await exporter.createCatalogWorkbook(selected, { dataDir });
      const date = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="video-catalog-${date}.xlsx"`);
      res.send(Buffer.from(buffer));
    } catch (error) { res.status(500).json({ error: '엑셀 저장에 실패했습니다: ' + error.message }); }
    finally { exportInProgress = false; }
  });

  return { router, registerFiles, ready, dataDir, startHost,
    async getHostAutoStart() { return (await connectionStore.getHostState()).enabled; },
    async activateAutoAnalysis() { await ready; if (!stopped) { autoActivated = true; scheduleAuto(); } },
    stop() { stopped = true; if (activeJob) activeJob.controller.abort(); return lan.stop(); } };
}

module.exports = { createAnalysisService, validateOptions, defaultDataDir };
