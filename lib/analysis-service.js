const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { recordHealth, normalizeAttempt } = require('./record-health');
const { normalizeLanguageHint, normalizeSubtitleLanguage, subtitleText, validateTranslation, validatePartialTranslation } = require('./subtitle-utils');
const { saveKoreanSubtitle } = require('./subtitle-sidecar');
const { normalizeSubtitleQuality, isProcessedTranscription } = require('./subtitle-quality');
const { catalogRecord, subtitleMetadata } = require('./catalog-record');
const { stageIdentity, createMetrics } = require('./job-metrics');
const { normalizeProgressDetails, ageProgressDetails } = require('../public/js/analysis-progress');
const { reportedRemoteServerVersion, stampAnalysisProvenance } = require('./analysis-provenance');
const APP_VERSION = require('../package.json').version;

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

function hasValidatedPartialSubtitle(record) {
  try { return validatePartialTranslation(record).length > 0; } catch (_) { return false; }
}

function validPauseCause(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['attempt-failed', 'user-cancel', 'missing-file', 'storage-error', 'queue-read-error'].includes(value.kind)
    || Object.keys(value).some(key => !['kind', 'path', 'resultId'].includes(key))) return null;
  if (value.path !== undefined && (typeof value.path !== 'string' || value.path.length > 32768
    || /[\x00-\x1f]/.test(value.path) || !path.isAbsolute(value.path)
    || !VIDEO_EXTENSIONS.has(path.extname(value.path).toLowerCase()))) return null;
  if (value.resultId !== undefined && (typeof value.resultId !== 'string' || !SAFE_ID.test(value.resultId))) return null;
  if (value.kind === 'attempt-failed' && (!value.path || !value.resultId)
    || value.kind === 'missing-file' && !value.path) return null;
  return { kind: value.kind, ...(value.path ? { path: path.resolve(value.path) } : {}), ...(value.resultId ? { resultId: value.resultId } : {}) };
}

function usableAutoResult(record, options, { repair = false } = {}) {
  if (!record || record.error || record.summaryError || record.subtitleError) return false;
  const summaryAvailable = recordHealth(record).summaryState === 'available';
  if (repair && !summaryAvailable) return false;
  if (record.status === 'completed') {
    if (repair && options.subtitleLanguage === 'ko') {
      try { subtitleText(record, { format: 'srt', language: 'ko' }); } catch (_) { return false; }
    }
    return true;
  }
  // A quality warning describes this result; it is not a provider outage.
  // Continue only with explicit proof that every source sample was processed.
  if (record.status !== 'partial' || !summaryAvailable || record.transcriptionQuality?.processingComplete !== true
    || !isProcessedTranscription(record, 'accurate')) return false;
  if (options.subtitleLanguage !== 'ko') return true;
  const progress = record.subtitleTranslationProgress;
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(record.transcript.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex');
  if (progress?.version !== 1 || progress.language !== 'ko' || progress.translationComplete !== true
    || progress.totalCues !== record.transcript.length || progress.completedCues !== record.transcript.length
    || typeof progress.sourceFingerprint !== 'string' || progress.sourceFingerprint.toLowerCase() !== fingerprint
    || typeof progress.complete !== 'boolean' || typeof progress.sourceComplete !== 'boolean') return false;
  try {
    if (record.subtitleLanguage === 'ko' && progress.complete === true) {
      validateTranslation(record.subtitleTranslation, record.transcript);
      if (record.subtitleTranslation.some((cue, index) => cue.id !== undefined && cue.id !== record.transcript[index].id)) return false;
      return true;
    }
    return validatePartialTranslation(record).length === record.transcript.length;
  } catch (_) { return false; }
}

function subtitleSaveKind(record) {
  if (!record || !['completed', 'partial'].includes(record.status)) return null;
  if (record.subtitleLanguage === 'ko' && !record.subtitleError) {
    try { subtitleText(record, { format: 'srt', language: 'ko' }); return { partial: false }; } catch (_) { /* Check the validated prefix below. */ }
  }
  return hasValidatedPartialSubtitle(record) ? { partial: true } : null;
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
  return { mode, apiKey: '', frameCount, timestamps, remoteUrl, connectionCode, transcribeAudio: mode !== 'local' && input.transcribeAudio === true,
    transcriptLanguage: normalizeLanguageHint(input.transcriptLanguage), subtitleLanguage: normalizeSubtitleLanguage(input.subtitleLanguage),
    subtitleQuality: normalizeSubtitleQuality(input.subtitleQuality) };
}

function createAnalysisService({ dataDir = defaultDataDir(), engine, exporter, lan, connectionStore, subtitleWriter = saveKoreanSubtitle, journalIO = fs, deferAutoStart = false } = {}) {
  dataDir = path.resolve(dataDir);
  connectionStore = connectionStore || require('./connection-store').createConnectionStore({ dataDir });
  engine = engine || require('./catalog-engine');
  exporter = exporter || require('./excel-export');
  lan = lan || require('./lan-analysis').createLanAnalysis({
    dataDir, connectionStore,
    processPackage: async (pkg, context) => require('./no-key-provider')[pkg.operation === 'translation-only' ? 'translateKoreanOnly' : 'analyzeExtracted'](pkg.record, {
      dataDir, framesDir: pkg.framesDir, audioPath: pkg.audioPath,
      transcribeAudio: pkg.transcribeAudio, transcriptLanguage: pkg.transcriptLanguage, subtitleLanguage: pkg.subtitleLanguage, subtitleQuality: pkg.subtitleQuality,
      forceTranslation: pkg.forceTranslation,
      signal: context.signal, onProgress: context.onProgress
    })
  });
  const router = express.Router();
  const records = new Map();
  const scanned = new Map();
  const jobs = new Map();
  let activeJob = null;
  let exportInProgress = false;
  const autoQueuePath = path.join(dataDir, 'auto-pick.json');
  const jobJournalPath = path.join(dataDir, 'jobs.json');
  let durableJobs = new Map(), jobRecoveryError = '';
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
      return { mode: validated.mode, frameCount: validated.frameCount, transcribeAudio: validated.transcribeAudio, remoteUrl: '',
        transcriptLanguage: validated.transcriptLanguage, subtitleLanguage: validated.subtitleLanguage, subtitleQuality: validated.subtitleQuality };
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
    return { mode: 'remote', frameCount: validated.frameCount, transcribeAudio: input.transcribeAudio === true, remoteUrl,
      transcriptLanguage: validated.transcriptLanguage, subtitleLanguage: validated.subtitleLanguage, subtitleQuality: validated.subtitleQuality };
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
      const pauseCause = next.paused ? validPauseCause(next.pauseCause) : null;
      await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, enabled: next.enabled, paused: next.paused, pauseReason: next.pauseReason,
        ...(pauseCause ? { pauseCause } : {}), safeOptions: next.safeOptions, entries: next.entries }), 'utf8');
      await fs.rename(temporary, autoQueuePath);
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw new Error('자동 분석 대기 목록을 이 PC에 저장하지 못했습니다. 저장 폴더를 확인해 주세요.');
    }
  }

  function completedPath(filePath) {
    const key = fileKey(filePath);
    return [...records.values()].some(record => record.status === 'completed' && recordHealth(record).summaryState !== 'missing' && fileKey(record.path) === key);
  }

  function autoSnapshot({ compact = false } = {}) {
    const activeAutoPath = activeJob?.source === 'auto-pick' ? activeJob.files[0]?.path || '' : '';
    const pending = autoPick.entries.filter(entry => !activeAutoPath || fileKey(entry.path) !== fileKey(activeAutoPath)).map(({ name, path: filePath, queuedAt }) => ({ name, path: filePath, queuedAt }));
    let waitingReason = autoWaitingReason;
    if (!autoPick.enabled) waitingReason = '무작위 영상 자동 분석이 꺼져 있습니다.';
    else if (autoPick.paused) waitingReason = autoPick.pauseReason || '자동 분석이 일시 중지되었습니다. 계속하려면 재개를 눌러 주세요.';
    else if (autoPick.entries.length && !autoPick.safeOptions) waitingReason = '분석 설정을 선택하면 자동 분석을 시작합니다.';
    else if (autoPick.entries.length && autoPick.safeOptions?.mode === 'remote' && !autoOptionsConfigured()) waitingReason = '분석 서버 주소와 연결 코드를 입력하면 저장된 자동 분석 대기 목록을 이어서 처리합니다.';
    else if (autoPick.entries.length && autoPick.safeOptions?.mode === 'remote' && (!remoteCode || remoteCodeUrl !== autoPick.safeOptions.remoteUrl)) waitingReason = '서버 연결 코드를 다시 입력하면 저장된 자동 분석 대기 목록을 이어서 처리합니다.';
    else if (pending.length && activeJob) waitingReason = '진행 중인 분석이 끝나면 자동 분석을 이어서 처리합니다.';
    return { enabled: autoPick.enabled, paused: autoPick.paused, ...(autoPick.pauseCause ? { pauseCause: { kind: autoPick.pauseCause.kind } } : {}), pendingCount: pending.length, pending, waitingReason, connectionError, activeAutoPath, configured: autoOptionsConfigured(), mode: autoPick.safeOptions?.mode || null, options: autoPick.safeOptions ? { ...autoPick.safeOptions } : null, savedCount: records.size, activeJob: snapshot(activeJob, { compact }) };
  }

  function autoOptionsConfigured() {
    if (!autoPick.safeOptions) return false;
    try { validateOptions({ ...autoPick.safeOptions, connectionCode: 'configuration-check-only' }); return true; }
    catch (_) { return false; }
  }

  function repairsPausedAttempt(job) {
    const cause = validPauseCause(autoPick.pauseCause);
    if (!autoPick.paused || cause?.kind !== 'attempt-failed' || job.source !== 'repair'
      || !job.results.length || !job.results.every(record => usableAutoResult(record, job.options, { repair: true })
        && fileKey(record.path) === fileKey(cause.path))) return false;
    const failed = records.get(cause.resultId);
    if (!failed || fileKey(failed.path) !== fileKey(cause.path)) return false;
    const visited = new Set();
    let id = job.repairOf;
    for (let depth = 0; depth < 10 && SAFE_ID.test(id || '') && !visited.has(id); depth++) {
      visited.add(id);
      const previous = records.get(id);
      if (!previous || typeof previous.path !== 'string' || fileKey(previous.path) !== fileKey(cause.path)) return false;
      if (id === cause.resultId) return true;
      id = previous.repairOf;
    }
    return false;
  }

  function durableCompleted(entry) {
    // The cursor is only a journal hint. A result actually loaded from its
    // durable JSON, with the same ID/path, is the authority after a restart.
    const completed = new Set();
    for (const file of entry.files) if (records.get(file.id)?.path && fileKey(records.get(file.id).path) === fileKey(file.path)) completed.add(file.id);
    return completed;
  }

  function interruptedJobs() {
    return [...durableJobs.values()].filter(entry => entry.status === 'interrupted').map(entry => {
      const completedIds = durableCompleted(entry), completed = completedIds.size;
      return { id: entry.id, source: entry.source, status: 'interrupted', total: entry.files.length, completed,
        remainingCount: entry.files.filter(file => !completedIds.has(file.id)).length, startedAt: entry.startedAt,
        ...(entry.repairOf ? { repairOf: entry.repairOf } : {}), options: { ...entry.safeOptions },
        ...(entry.operation === 'translation-only' ? { operation: entry.operation } : {}),
        resumeNotice: '완료되어 저장된 파일은 건너뛰고 남은 파일을 새 분석으로 시작합니다. 처리 중이던 파일은 처음부터 다시 분석하며 자동 재시도하지 않습니다.' };
    }).filter(entry => entry.remainingCount > 0);
  }

  async function saveJobJournal(next) {
    if (jobRecoveryError) throw new Error(jobRecoveryError);
    const temporary = jobJournalPath + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    let handle;
    try {
      handle = await journalIO.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ schemaVersion: 1, jobs: [...next.values()] }), 'utf8');
      await handle.sync(); await handle.close(); handle = null;
      await journalIO.rename(temporary, jobJournalPath);
      durableJobs = next;
    } finally { if (handle) await handle.close().catch(() => {}); await journalIO.unlink(temporary).catch(() => {}); }
  }

  async function checkpointJob(job, status = job.status) {
    const previous = durableJobs.get(job.id);
    if (!previous) return;
    const next = new Map(durableJobs);
    if (job.controller?.signal.aborted || status === 'cancelling') status = 'cancelled';
    next.set(job.id, { ...previous, status, updatedAt: new Date().toISOString(), completedIds: [...durableCompleted(previous)],
      ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}) });
    await saveJobJournal(next);
  }

  async function createJob(files, options, source = 'manual', details = {}) {
    const job = { id: crypto.randomBytes(16).toString('hex'), source, ...details, pairingGeneration: connectionGeneration, status: 'running', total: files.length, completed: 0, currentFile: '', currentFilePath: '', stage: '분석 시작', percent: 0, error: '', results: [], startedAt: new Date().toISOString(), files, options, controller: new AbortController() };
    job.stageKey = 'prepare'; job.lastProgressAt = job.startedAt; job._stageStartedAt = job.startedAt;
    if (['manual', 'repair'].includes(source)) {
      const next = new Map(durableJobs);
      if (details.resumedFrom && next.has(details.resumedFrom)) next.set(details.resumedFrom, { ...next.get(details.resumedFrom), status: 'resumed', resumedBy: job.id });
      while (next.size >= 20) {
        const removable = [...next].find(([, entry]) => !['interrupted', 'running'].includes(entry.status));
        if (!removable) throw new Error('중단된 분석 작업이 20개 있습니다. 기존 중단 작업을 재개한 뒤 새 작업을 시작해 주세요.');
        next.delete(removable[0]);
      }
      next.set(job.id, { id: job.id, source, status: 'running', startedAt: job.startedAt, updatedAt: job.startedAt,
        ...(details.repairOf ? { repairOf: details.repairOf } : {}), ...(details.resumedFrom ? { resumedFrom: details.resumedFrom } : {}),
        ...(details.operation === 'translation-only' ? { operation: details.operation, forceTranslation: options.forceTranslation === true } : {}),
        safeOptions: safeAutoOptions(options), completedIds: [], files: files.map(file => ({ id: file.id, path: file.path,
          sourceIdentity: { ...file.sourceIdentity } })) });
      await saveJobJournal(next);
      if (details.resumedFrom && jobs.has(details.resumedFrom)) jobs.get(details.resumedFrom).status = 'resumed';
    }
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
        await createJob([file], validateOptions(options), 'auto-pick');
        return;
      } catch (error) {
        const next = { ...autoPick, paused: true, pauseCause: { kind: 'missing-file', path: entry.path }, pauseReason: `${entry.name} 파일에 접근할 수 없어 자동 분석을 일시 중지했습니다. 파일을 확인한 뒤 재개해 주세요.`, entries: autoPick.entries.slice(1) };
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
      const journalInfo = await fs.stat(jobJournalPath);
      if (!journalInfo.isFile() || journalInfo.size > 8 * 1024 * 1024) throw new Error('Invalid job journal size');
      const saved = JSON.parse(await fs.readFile(jobJournalPath, 'utf8'));
      if (saved.schemaVersion !== 1 || !Array.isArray(saved.jobs) || saved.jobs.length > 20) throw new Error('Invalid job journal');
      const restored = new Map();
      for (const item of saved.jobs) {
        if (!item || !SAFE_ID.test(item.id) || restored.has(item.id) || !['manual', 'repair'].includes(item.source)
          || !['running', 'interrupted', 'completed', 'cancelled', 'failed', 'resumed'].includes(item.status)
          || !Number.isFinite(Date.parse(item.startedAt)) || !Array.isArray(item.files) || !item.files.length || item.files.length > 1000
          || !Array.isArray(item.completedIds) || item.completedIds.some(id => !SAFE_ID.test(id))
          || item.repairOf !== undefined && !SAFE_ID.test(item.repairOf)
          || item.operation !== undefined && item.operation !== 'translation-only'
          || item.operation === 'translation-only' && (item.source !== 'repair' || !SAFE_ID.test(item.repairOf || ''))
          || item.operation === 'translation-only' && item.files.length !== 1
          || item.forceTranslation !== undefined && typeof item.forceTranslation !== 'boolean') throw new Error('Invalid job journal entry');
        const ids = new Set(), paths = new Set();
        const files = item.files.map(file => {
          if (!file || !SAFE_ID.test(file.id) || ids.has(file.id) || typeof file.path !== 'string' || !path.isAbsolute(file.path)
            || !VIDEO_EXTENSIONS.has(path.extname(file.path).toLowerCase()) || paths.has(fileKey(file.path))
            || !Number.isSafeInteger(file.sourceIdentity?.sizeBytes) || file.sourceIdentity.sizeBytes < 0 || !Number.isFinite(file.sourceIdentity.mtimeMs)) throw new Error('Invalid job file identity');
          ids.add(file.id); paths.add(fileKey(file.path));
          return { id: file.id, path: path.resolve(file.path), sourceIdentity: { sizeBytes: file.sourceIdentity.sizeBytes, mtimeMs: file.sourceIdentity.mtimeMs } };
        });
        if (item.completedIds.some(id => !ids.has(id))) throw new Error('Invalid completed job cursor');
        const entry = { id: item.id, source: item.source, status: item.status, startedAt: item.startedAt, files,
          updatedAt: Number.isFinite(Date.parse(item.updatedAt || '')) ? item.updatedAt : item.startedAt,
          completedIds: [...new Set(item.completedIds)], safeOptions: safeAutoOptions(item.safeOptions),
          ...(item.repairOf ? { repairOf: item.repairOf } : {}), ...(SAFE_ID.test(item.resumedFrom || '') ? { resumedFrom: item.resumedFrom } : {}),
          ...(item.operation === 'translation-only' ? { operation: item.operation, forceTranslation: item.forceTranslation === true } : {}),
          ...(SAFE_ID.test(item.resumedBy || '') ? { resumedBy: item.resumedBy } : {}), ...(item.finishedAt ? { finishedAt: item.finishedAt } : {}) };
        entry.completedIds = [...durableCompleted(entry)];
        if (['running', 'interrupted', 'failed'].includes(entry.status)) entry.status = entry.completedIds.length < files.length ? 'interrupted' : 'completed';
        restored.set(entry.id, entry);
      }
      await saveJobJournal(restored);
      for (const entry of restored.values()) {
        const resultList = entry.files.map(file => records.get(file.id)).filter(Boolean);
        jobs.set(entry.id, { id: entry.id, source: entry.source, status: entry.status, total: entry.files.length, completed: entry.completedIds.length,
          remainingCount: entry.files.length - entry.completedIds.length, currentFile: '', currentFilePath: '', stage: entry.status === 'interrupted' ? '재시작으로 중단됨 · 명시적으로 재개할 수 있습니다.' : '저장된 작업',
          stageKey: 'interrupted', percent: 0, error: '', results: resultList, startedAt: entry.startedAt, finishedAt: entry.finishedAt || entry.updatedAt,
          lastProgressAt: entry.updatedAt,
          ...(entry.repairOf ? { repairOf: entry.repairOf } : {}), files: entry.files, options: entry.safeOptions });
        if (entry.operation === 'translation-only') jobs.get(entry.id).operation = entry.operation;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') jobRecoveryError = '저장된 작업 기록을 읽거나 저장하지 못했습니다. jobs.json을 보존한 뒤 저장 폴더를 확인해 주세요.';
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
      // Older saved settings predate the subtitle preference. Adopt the new
      // Korean subtitle default only during that upgrade; ordinary API calls
      // still default to original subtitles for legacy LAN compatibility.
      const migrateSubtitles = ['codex', 'remote'].includes(saved.safeOptions?.mode)
        && !Object.prototype.hasOwnProperty.call(saved.safeOptions, 'subtitleLanguage');
      let savedOptions = migrateSubtitles ? { ...saved.safeOptions, subtitleLanguage: 'ko' } : saved.safeOptions;
      const migrateQuality = ['codex', 'remote'].includes(savedOptions?.mode) && savedOptions.subtitleLanguage === 'ko'
        && !Object.prototype.hasOwnProperty.call(savedOptions, 'subtitleQuality');
      if (migrateQuality) savedOptions = { ...savedOptions, subtitleQuality: 'fast' };
      const pauseCause = saved.paused === true ? validPauseCause(saved.pauseCause) : null;
      autoPick = { enabled: saved.enabled !== false, paused: saved.paused === true, pauseReason: typeof saved.pauseReason === 'string' ? saved.pauseReason : '',
        ...(pauseCause ? { pauseCause } : {}), safeOptions: savedOptions ? safeAutoOptions(savedOptions) : null, entries };
      if (migrateSubtitles || migrateQuality) await saveAutoQueue(autoPick);
      registerFiles(entries);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        autoPick.paused = true;
        autoPick.pauseCause = { kind: 'queue-read-error' };
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
    record.health = recordHealth(record);
    record.savedAt = new Date().toISOString();
    const target = path.join(resultsDir, record.id + '.json');
    const temporary = target + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(record), 'utf8');
      await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temporary, target);
      records.set(record.id, record);
    } finally { if (handle) await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
  }

  function snapshot(job, { compact = false } = {}) {
    if (!job) return null;
    const { controller, options, files, pairingGeneration, _stageStartedAt, _phaseProgressAt, ...publicJob } = job;
    const end = Number.isFinite(Date.parse(job.finishedAt || '')) ? Date.parse(job.finishedAt) : Date.now();
    if (job.status === 'running' && job.phaseProgress) {
      publicJob.phaseProgress = ageProgressDetails(job.phaseProgress, Math.max(0, (end - (_phaseProgressAt || end)) / 1000));
    } else delete publicJob.phaseProgress;
    return { ...publicJob, elapsedMs: Math.max(0, end - Date.parse(job.startedAt)),
      stageElapsedMs: Math.max(0, end - Date.parse(_stageStartedAt || job.finishedAt || job.startedAt)),
      results: (job.results || []).map(record => compact ? catalogRecord(record) : ({ ...record, ...subtitleMetadata(record) })) };
  }

  function generatedSubtitleFilesFor(videoPath) {
    const known = new Map();
    for (const previous of records.values()) {
      const saved = previous.subtitleAutoSave;
      if (typeof previous.path !== 'string' || fileKey(previous.path) !== fileKey(videoPath)
          || !saved || !(saved.status === 'saved' || (saved.status === 'unchanged' && saved.generated === true)) || typeof saved.path !== 'string'
          || !path.isAbsolute(saved.path) || !/^[a-f0-9]{64}$/.test(saved.sha256 || '')) continue;
      known.set(fileKey(saved.path) + ':' + saved.sha256, { path: saved.path, sha256: saved.sha256 });
    }
    return [...known.values()];
  }

  async function saveSubtitleForRecord(record, { signal, generatedSubtitleFiles = [] } = {}) {
    let subtitleSave;
    try { subtitleSave = await subtitleWriter(record, { signal, generatedSubtitleFiles }); }
    catch (error) {
      const kind = subtitleSaveKind(record);
      if (kind) subtitleSave = { status: 'failed', path: '', error: error.message || '자막 파일을 저장하지 못했습니다.',
        ...(kind.partial ? { partial: true } : {}) };
    }
    if (!subtitleSave) return null;
    if (['saved', 'unchanged'].includes(subtitleSave.status)) {
      // Identical user-authored subtitles are preserved and reused,
      // but only files actually generated by us are excluded as inputs.
      subtitleSave.generated = subtitleSave.status === 'saved' || generatedSubtitleFiles.some(saved =>
        saved.sha256 === subtitleSave.sha256 && fileKey(saved.path) === fileKey(subtitleSave.path));
      record.warnings = (record.warnings || []).filter(warning => !/^한국어 (?:부분 )?SRT 자동 저장 실패:/.test(warning));
    }
    record.subtitleAutoSave = subtitleSave;
    if (subtitleSave.status === 'failed') record.warnings = [...new Set([...(record.warnings || []),
      `한국어 ${subtitleSave.partial ? '부분 ' : ''}SRT 자동 저장 실패: ${subtitleSave.error || '영상 폴더에 쓸 수 없습니다.'} 번역 결과는 보관되며 SRT 저장 버튼으로 내려받을 수 있습니다.`])];
    return subtitleSave;
  }

  function hasCompleteKorean(record) {
    try { subtitleText(record, { format: 'srt', language: 'ko' }); return true; }
    catch (_) {
      try { return record.transcript?.length > 0 && validatePartialTranslation(record).length === record.transcript.length; }
      catch (_) { return false; }
    }
  }

  async function translationFile(previous) {
    if (!path.isAbsolute(previous.path) || !VIDEO_EXTENSIONS.has(path.extname(previous.path).toLowerCase())) throw new Error('저장된 영상 경로가 올바르지 않습니다.');
    const stats = await fs.stat(previous.path).catch(() => null);
    if (!stats?.isFile()) throw new Error('원본 영상 파일에 접근할 수 없습니다. 파일을 확인한 뒤 자막 번역을 복구해 주세요.');
    if (previous.sourceFile && (stats.size !== previous.sourceFile.sizeBytes || stats.mtimeMs !== previous.sourceFile.mtimeMs)) {
      throw Object.assign(new Error('분석 후 원본 영상이 변경되었습니다. 현재 영상에 맞게 전체 분석을 먼저 실행해 주세요.'), { status: 409 });
    }
    if (!Array.isArray(previous.transcript) || !previous.transcript.length) throw new Error('저장된 원문 대사가 없어 번역만 복구할 수 없습니다. 먼저 음성 인식을 실행해 주세요.');
    validateTranslation(previous.transcript, previous.transcript);
    return { id: crypto.randomBytes(16).toString('hex'), name: path.basename(previous.path), path: previous.path,
      ext: path.extname(previous.path).slice(1).toUpperCase(), size: Math.round(stats.size / 104857.6) / 10,
      sourceIdentity: { sizeBytes: stats.size, mtimeMs: stats.mtimeMs } };
  }

  async function translationAttempt(previous, file) {
    const record = JSON.parse(JSON.stringify(previous));
    record.id = file.id; record.path = file.path; record.operation = 'translation-only';
    delete record.subtitleRepairStatus;
    record.extractionReusedFrom = previous.id;
    const destination = path.join(dataDir, 'frames', file.id);
    await fs.mkdir(destination, { recursive: true });
    const frames = [];
    for (const frame of record.frames || []) {
      if (typeof frame.filename !== 'string' || path.basename(frame.filename) !== frame.filename || /[\\/]/.test(frame.filename)) continue;
      try {
        await fs.copyFile(path.join(dataDir, 'frames', previous.id, frame.filename), path.join(destination, frame.filename));
        frames.push(frame);
      } catch (_) { record.warnings = [...(record.warnings || []), '기존 대표 이미지 일부를 읽지 못했습니다. 원래 저장 결과는 보관됩니다.']; }
    }
    record.frames = frames;
    return record;
  }

  async function runJob(job) {
    let outcome = 'completed';
    try {
      for (const file of job.files) {
        if (job.controller.signal.aborted) break;
        job.currentFile = file.name;
        job.currentFilePath = file.path;
        job.stage = '영상 분석 준비';
        job.stageKey = 'prepare'; job._stageStartedAt = new Date().toISOString(); job.lastProgressAt = job._stageStartedAt;
        job.percent = 0;
        delete job.phaseProgress;
        const metrics = createMetrics();
        const generatedSubtitleFiles = generatedSubtitleFilesFor(file.path);
        let record;
        let sourceFile;
        if (job.options.mode !== 'local' && job.options.subtitleQuality === 'accurate') {
          const source = await fs.stat(file.path).catch(() => null);
          if (source?.isFile() && Number.isSafeInteger(source.size) && Number.isFinite(source.mtimeMs)) {
            sourceFile = { sizeBytes: source.size, mtimeMs: source.mtimeMs };
          }
        }
        try {
          const context = {
            dataDir,
            signal: job.controller.signal,
            generatedSubtitleFiles,
            onProgress(stage, percent, details) {
              const identity = stageIdentity(stage), now = new Date().toISOString();
              const sameStage = job.stageKey === identity.stageKey;
              if (!sameStage) job._stageStartedAt = now;
              job.stageKey = identity.stageKey; job.lastProgressAt = now;
              metrics.stage(stage);
              job.stage = STAGE_LABELS[stage] || String(stage);
              const nextPercent = Math.max(0, Math.min(100, Number(percent) || 0));
              job.percent = sameStage ? Math.max(job.percent, nextPercent) : nextPercent;
              const phaseProgress = normalizeProgressDetails(details);
              if (phaseProgress) { job.phaseProgress = phaseProgress; job._phaseProgressAt = Date.now(); }
              else delete job.phaseProgress;
            }
          };
          if (job.operation === 'translation-only') {
            record = await translationAttempt(job.options.repairRecord, file);
            if (typeof engine.translateSubtitles !== 'function') throw new Error('이 버전의 분석 엔진은 자막 번역만 복구를 지원하지 않습니다.');
            const translate = await engine.translateSubtitles(record, job.options, context);
            if (translate) record = translate;
          } else record = await engine.analyzeVideo(file, job.options, context);
        } catch (error) {
          record = error.record || (job.operation === 'translation-only' ? record : null) || { ...file, duration: 0, summary: '', plot: '', dialogueSummary: '', labels: [], transcriptSource: '', transcript: [], frames: [], warnings: [], analyzedAt: new Date().toISOString() };
          record.status = job.controller.signal.aborted || hasValidatedPartialSubtitle(record) ? 'partial' : 'failed';
          if (job.operation === 'translation-only') {
            record.subtitleError = job.controller.signal.aborted ? '사용자가 자막 번역을 중지했습니다.' : error.message;
            record.subtitleRepairStatus = 'failed';
          }
          else record.error = job.controller.signal.aborted ? '사용자가 분석을 중지했습니다.' : error.message;
          if (job.controller.signal.aborted) record.warnings = [...(record.warnings || []), '중지 전까지 추출한 결과입니다. 대사와 장면이 일부만 포함될 수 있습니다.'];
        }
        record.id = file.id;
        record.path = file.path;
        const reusedSource = job.source === 'repair' && record.extractionReusedFrom === job.repairOf ? job.options.repairRecord?.sourceFile : null;
        if (reusedSource && Number.isSafeInteger(reusedSource.sizeBytes) && reusedSource.sizeBytes >= 0 && Number.isFinite(reusedSource.mtimeMs)) {
          // Reused dialogue still belongs to that earlier source snapshot,
          // including when the user explicitly requests legacy fast mode.
          sourceFile = { sizeBytes: reusedSource.sizeBytes, mtimeMs: reusedSource.mtimeMs };
        }
        // A transport/provider record cannot supply local file identity.
        delete record.sourceFile;
        if (sourceFile) record.sourceFile = sourceFile;
        if (job.source === 'repair') record.repairOf = job.repairOf;
        if (job.operation === 'translation-only') {
          record.operation = 'translation-only';
          record.analysisMode = job.options.repairRecord.analysisMode || record.analysisMode;
          if (record.subtitleRepairStatus === 'completed' && record.status === 'failed') record.status = 'partial';
          if (record.subtitleError && record.status === 'completed') record.status = 'partial';
          record.health = recordHealth(record);
        } else normalizeAttempt(record, job.options.mode);
        const operation = job.operation === 'translation-only' ? 'translation-only' : 'analysis';
        const serverVersion = job.options.mode === 'remote' ? reportedRemoteServerVersion(record) : undefined;
        stampAnalysisProvenance(record, { clientVersion: APP_VERSION, serverVersion, operation });
        if (record.status !== 'completed' && [...records.values()].some(previous => previous.status === 'completed' && fileKey(previous.path) === fileKey(file.path))) {
          record.warnings = [...new Set([...(record.warnings || []), '재분석이 완료되지 않았습니다. 이전에 완료한 분석 결과와 이미지는 그대로 보관했습니다.'])];
        }
        // Only the PC that owns the original video writes a sidecar. LAN host
        // processing uses uploaded packages and never reaches this job loop.
        delete record.subtitleAutoSave;
        // Cancellation stops recognition/translation. At this final persistence
        // boundary, already reviewed cues may still be saved without another
        // provider call. A signal that aborts during the write is still honored.
        const subtitleSignal = job.controller.signal.aborted ? undefined : job.controller.signal;
        metrics.stage('saving');
        await saveSubtitleForRecord(record, { signal: subtitleSignal, generatedSubtitleFiles });
        if (job.operation === 'translation-only') record.translationMetrics = metrics.finish();
        else record.analysisMetrics = metrics.finish();
        await saveRecord(record);
        job.results.push(record);
        job.completed++;
        await serialize(() => checkpointJob(job));
        if (job.options.mode === 'remote' && record.status === 'completed') {
          await serialize(async () => {
            if (job.pairingGeneration !== connectionGeneration) return;
            try {
              await rememberCredentials({ code: job.options.connectionCode, url: job.options.remoteUrl });
              job.pairingGeneration = connectionGeneration;
            } catch (error) { connectionError = error.message; }
          });
        }
        if (job.controller.signal.aborted) break;
      }
      outcome = job.controller.signal.aborted ? 'cancelled' : 'completed';
    } catch (error) {
      outcome = 'failed';
      job.error = '분석 결과 저장 중 오류가 발생했습니다: ' + error.message;
    } finally {
      job.options.apiKey = '';
      job.options.connectionCode = '';
      delete job.options.repairRecord;
      await serialize(async () => {
        let terminal = job.controller.signal.aborted ? 'cancelled' : outcome;
        const persistTerminal = async () => {
          try { await checkpointJob({ ...job, finishedAt: new Date().toISOString() }, terminal); }
          catch (_) { job.error = job.error || '작업 기록을 저장하지 못했습니다. 이미 저장된 영상 결과는 보존했습니다.'; }
        };
        await persistTerminal();
        // stop() can abort without waiting on the mutation lock. Preserve that
        // cancellation even if it arrived while the terminal journal was syncing.
        if (terminal !== 'cancelled' && job.controller.signal.aborted) { terminal = 'cancelled'; await persistTerminal(); }
        if (job.source === 'auto-pick' && !stopped) {
          const successful = terminal === 'completed' && !job.error && job.results.length === job.files.length
            && job.results.every(record => usableAutoResult(record, job.options));
          // A failed result write has no durable terminal record. Retain its
          // journal entry so a later explicit resume can recover the attempt.
          const next = { ...autoPick, entries: job.results.length ? autoPick.entries.filter(entry => fileKey(entry.path) !== fileKey(job.files[0].path)) : autoPick.entries };
          if (!successful) {
            next.paused = true;
            const failed = job.results.find(record => !usableAutoResult(record, job.options));
            next.pauseCause = terminal === 'cancelled' ? { kind: 'user-cancel', path: job.files[0].path }
              : failed ? { kind: 'attempt-failed', path: failed.path, resultId: failed.id }
                : { kind: 'storage-error', path: job.files[0].path };
            const failureReason = job.error || failed?.subtitleError || failed?.summaryError || failed?.error
              || (failed ? recordHealth(failed).reason : '분석 환경을 확인한 뒤 재개해 주세요.');
            next.pauseReason = terminal === 'cancelled' ? '자동 분석을 중지했습니다. 대기 중인 영상은 재개를 누르면 이어서 처리합니다.' : `자동 분석이 완료되지 않아 대기 목록을 일시 중지했습니다. ${failureReason}`;
          }
          try { await saveAutoQueue(next); autoPick = next; }
          catch (error) { autoPick.paused = true; autoPick.pauseCause = { kind: 'storage-error' }; autoPick.pauseReason = error.message; }
        } else if (!stopped && terminal === 'completed' && !job.error && repairsPausedAttempt(job)) {
          // Only this failed attempt's explicit, successful repair can release
          // its pause. User cancellations and legacy/other failures stay paused.
          const next = { ...autoPick, paused: false, pauseReason: '' };
          delete next.pauseCause;
          try {
            await saveAutoQueue(next);
            // stop() does not acquire this lock; it must not silently resume
            // durable waiting work while the successful repair is shutting down.
            if (stopped || job.controller.signal.aborted) await saveAutoQueue(autoPick);
            else { autoPick = next; autoWaitingReason = ''; }
          }
          catch (error) { autoPick.pauseCause = { kind: 'storage-error' }; autoPick.pauseReason = error.message; }
        }
        if (terminal !== 'cancelled' && job.controller.signal.aborted) { terminal = 'cancelled'; await persistTerminal(); }
        // Publish terminal status and release active ownership together, with no
        // await between them. A client can now rely on terminal => coordinator free.
        job.finishedAt = new Date().toISOString(); job.lastProgressAt = job.finishedAt;
        job.status = terminal;
        job.stage = terminal === 'cancelled' ? '분석 중지됨' : terminal === 'failed' ? '분석 실패' : '분석 완료';
        if (terminal === 'completed') job.percent = 100;
        job.currentFile = ''; job.currentFilePath = '';
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
      const compact = req.query.view === 'summary';
      res.json({ tools, providers, host: hostStatus(), connection: { ...rememberedConnection, ...(connectionError ? { error: connectionError } : {}) }, storage: { directory: dataDir, resultsDirectory: resultsDir, framesDirectory: path.join(dataDir, 'frames'), savedCount: records.size }, defaultMode: providers?.codex?.loggedIn && providers?.speech?.available ? 'codex' : 'local', activeJob: snapshot(activeJob, { compact }), autoPick: autoSnapshot({ compact }), interruptedJobs: interruptedJobs(), ...(jobRecoveryError ? { jobRecoveryError } : {}) });
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
    const compact = req.query.view === 'summary';
    res.json({ results: [...records.values()].map(record => compact ? catalogRecord(record) : ({ ...record, ...subtitleMetadata(record), health: recordHealth(record) }))
      .sort((a, b) => String(b.savedAt || b.analyzedAt).localeCompare(String(a.savedAt || a.analyzedAt))) });
  });

  router.get('/results/:id', (req, res) => {
    const record = SAFE_ID.test(req.params.id) && records.get(req.params.id);
    if (!record) return res.status(404).json({ error: '분석 결과를 찾을 수 없습니다. 결과를 다시 불러와 주세요.' });
    res.json({ ...record, ...subtitleMetadata(record), health: recordHealth(record) });
  });

  router.post('/results/:id/repair', async (req, res) => {
    try {
      const job = await serialize(async () => {
        const previous = SAFE_ID.test(req.params.id) && records.get(req.params.id);
        if (!previous) { const error = new Error('복구할 저장 결과를 찾을 수 없습니다.'); error.status = 404; throw error; }
        if (activeJob) { const error = new Error('진행 중인 분석이 있습니다. 완료되거나 중지한 뒤 복구 분석을 실행해 주세요.'); error.status = 409; throw error; }
        const options = resolveOptions(req.body?.options || autoPick.safeOptions || { mode: previous.analysisMode || 'local' });
        if (!path.isAbsolute(previous.path) || !VIDEO_EXTENSIONS.has(path.extname(previous.path).toLowerCase())) throw new Error('저장된 영상 경로가 올바르지 않습니다. 해당 폴더를 다시 스캔해 주세요.');
        const stats = await fs.stat(previous.path).catch(() => null);
        if (!stats?.isFile()) throw new Error('저장된 경로에서 영상 파일에 접근할 수 없습니다. 파일을 확인한 뒤 복구 분석을 실행해 주세요.');
        const tools = await engine.getToolsStatus(dataDir);
        if (!tools.available) throw new Error('영상 분석 도구를 실행할 수 없습니다. FFmpeg / FFprobe 경로를 확인해 주세요.');
        if (options.mode === 'codex' && engine.getProviderStatus) {
          const providers = await engine.getProviderStatus(dataDir);
          if (!providers.codex?.loggedIn || !providers.speech?.available) throw new Error('이 PC의 Codex 로그인과 로컬 음성 인식 준비를 확인해 주세요.');
        }
        // The explicit repair owns this path's next attempt; do not retry the
        // same waiting auto entry immediately if that repair fails.
        const next = { ...autoPick, entries: autoPick.entries.filter(entry => fileKey(entry.path) !== fileKey(previous.path)) };
        if (next.entries.length !== autoPick.entries.length) { await saveAutoQueue(next); autoPick = next; }
        const file = { id: crypto.randomBytes(16).toString('hex'), name: path.basename(previous.path), path: previous.path, sourceIdentity: { sizeBytes: stats.size, mtimeMs: stats.mtimeMs },
          ext: path.extname(previous.path).slice(1).toUpperCase(), size: Math.round(stats.size / 104857.6) / 10 };
        // Only an explicitly selected, saved result may supply reusable data.
        // A private snapshot cannot be substituted by request options and keeps
        // provider changes from mutating the earlier durable result in memory.
        options.repairRecord = JSON.parse(JSON.stringify(previous));
        return createJob([file], options, 'repair', { repairOf: previous.id });
      });
      res.status(202).json(snapshot(job));
    } catch (error) { res.status(error.status || 400).json({ error: error.message, ...(error.status === 409 ? { job: snapshot(activeJob) } : {}) }); }
  });

  router.post('/results/:id/subtitles/repair', async (req, res) => {
    try {
      const job = await serialize(async () => {
        const previous = SAFE_ID.test(req.params.id) && records.get(req.params.id);
        if (!previous) throw Object.assign(new Error('번역을 복구할 저장 결과를 찾을 수 없습니다.'), { status: 404 });
        if (activeJob) throw Object.assign(new Error('진행 중인 작업이 끝난 뒤 한국어 자막 번역을 복구해 주세요.'), { status: 409 });
        if (typeof engine.translateSubtitles !== 'function') throw new Error('이 버전의 분석 엔진은 자막 번역만 복구를 지원하지 않습니다.');
        const options = resolveOptions(req.body?.options || autoPick.safeOptions || { mode: previous.analysisMode || 'local' });
        if (!['codex', 'remote'].includes(options.mode)) throw new Error('한국어 자막 번역에는 이 PC의 Codex 또는 분석 서버 연결을 선택해 주세요.');
        if (req.body?.forceTranslation !== undefined && typeof req.body.forceTranslation !== 'boolean') throw new Error('번역 재시작 설정이 올바르지 않습니다.');
        const file = await translationFile(previous);
        options.subtitleLanguage = 'ko'; options.transcribeAudio = false;
        options.forceTranslation = req.body?.forceTranslation ?? hasCompleteKorean(previous);
        options.repairRecord = JSON.parse(JSON.stringify(previous));
        const next = { ...autoPick, entries: autoPick.entries.filter(entry => fileKey(entry.path) !== fileKey(previous.path)) };
        if (next.entries.length !== autoPick.entries.length) { await saveAutoQueue(next); autoPick = next; }
        return createJob([file], options, 'repair', { repairOf: previous.id, operation: 'translation-only' });
      });
      res.status(202).json(snapshot(job));
    } catch (error) { res.status(error.status || 400).json({ error: error.message, ...(error.status === 409 ? { job: snapshot(activeJob) } : {}) }); }
  });

  router.get(['/results/:id/subtitles', '/results/:id/subtitle'], (req, res) => {
    const record = SAFE_ID.test(req.params.id) && records.get(req.params.id);
    if (!record) return res.status(404).json({ error: '자막을 저장할 분석 결과를 찾을 수 없습니다.' });
    try {
      const format = req.query.format === undefined ? 'srt' : req.query.format;
      const language = req.query.language === undefined ? 'original' : req.query.language;
      const partial = req.query.partial === '1';
      const subtitles = subtitleText(record, { format, language, partial });
      res.setHeader('Content-Type', format === 'vtt' ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="video-${record.id}-${language}${partial ? '-partial' : ''}.${format}"`);
      res.send(subtitles);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.post('/results/:id/subtitles/save', async (req, res) => {
    try {
      const result = await serialize(async () => {
        const previous = SAFE_ID.test(req.params.id) && records.get(req.params.id);
        if (!previous) { const error = new Error('자막을 저장할 분석 결과를 찾을 수 없습니다.'); error.status = 404; throw error; }
        if (activeJob?.files.some(file => fileKey(file.path) === fileKey(previous.path))) {
          const error = new Error('이 영상은 분석 중입니다. 분석이 끝난 뒤 저장된 자막을 영상 폴더에 저장해 주세요.');
          error.status = 409; throw error;
        }
        // This endpoint operates only on an existing trusted result. It never
        // decodes the video or starts speech recognition, translation or repair.
        const record = { ...previous };
        if (record.status === 'failed' && hasValidatedPartialSubtitle(record)) record.status = 'partial';
        if (!subtitleSaveKind(record)) throw new Error('영상 폴더에 저장할 검증된 한국어 자막이 없습니다.');
        const subtitleAutoSave = await saveSubtitleForRecord(record, { generatedSubtitleFiles: generatedSubtitleFilesFor(previous.path) });
        if (!subtitleAutoSave) throw new Error('영상 폴더에 저장할 검증된 한국어 자막이 없습니다.');
        await saveRecord(record);
        return { record, subtitleAutoSave };
      });
      res.json(result);
    } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
  });

  router.get('/auto-pick', (req, res) => { scheduleAuto(); res.json(autoSnapshot({ compact: req.query.view === 'summary' })); });

  router.put('/auto-pick', async (req, res) => {
    try {
      const queue = await serialize(async () => {
        const body = req.body || {};
        if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new Error('자동 분석 사용 여부가 올바르지 않습니다.');
        if (body.resume !== undefined && typeof body.resume !== 'boolean') throw new Error('자동 분석 재개 설정이 올바르지 않습니다.');
        const options = body.options === undefined ? autoPick.safeOptions : safeAutoOptions(body.options);
        const credentials = body.options === undefined ? { code: remoteCode, url: remoteCodeUrl } : configuredCredentials(body.options, options);
        const next = { ...autoPick, enabled: body.enabled === undefined ? autoPick.enabled : body.enabled, safeOptions: options };
        if (body.resume === true) { next.paused = false; next.pauseReason = ''; delete next.pauseCause; }
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
        files.push({ id, name: path.basename(registered.path), path: registered.path, sourceIdentity: { sizeBytes: stats.size, mtimeMs: stats.mtimeMs }, ext: path.extname(registered.path).slice(1).toUpperCase(), size: Math.round(stats.size / 104857.6) / 10 });
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
    res.json(snapshot(job, { compact: req.query.view === 'summary' }));
  });

  router.post('/jobs/:id/resume', async (req, res) => {
    try {
      const job = await serialize(async () => {
        if (activeJob) { const error = new Error('진행 중인 분석이 끝난 뒤 중단 작업을 재개해 주세요.'); error.status = 409; throw error; }
        const previous = SAFE_ID.test(req.params.id) && durableJobs.get(req.params.id);
        if (!previous) { const error = new Error('재개할 작업 기록을 찾을 수 없습니다.'); error.status = 404; throw error; }
        if (previous.status !== 'interrupted') { const error = new Error('이 작업은 재시작으로 중단된 작업이 아닙니다. 취소한 영상은 직접 다시 선택해 주세요.'); error.status = 409; throw error; }
        const completed = durableCompleted(previous), remaining = previous.files.filter(file => !completed.has(file.id));
        if (!remaining.length) { const error = new Error('이 작업의 모든 파일은 이미 결과가 저장되어 있습니다.'); error.status = 409; throw error; }
        const options = resolveOptions(req.body?.options || previous.safeOptions);
        const files = [];
        for (const file of remaining) {
          const stat = await fs.stat(file.path).catch(() => null);
          if (!stat?.isFile() || stat.size !== file.sourceIdentity.sizeBytes || stat.mtimeMs !== file.sourceIdentity.mtimeMs) {
            const error = new Error('중단 후 영상 파일이 변경되었거나 접근할 수 없습니다. 원본을 확인하고 영상을 직접 다시 선택해 주세요.'); error.status = 409; throw error;
          }
          files.push({ id: crypto.randomBytes(16).toString('hex'), path: file.path, name: path.basename(file.path),
            ext: path.extname(file.path).slice(1).toUpperCase(), size: Math.round(stat.size / 104857.6) / 10,
            sourceIdentity: { sizeBytes: stat.size, mtimeMs: stat.mtimeMs } });
        }
        if (previous.operation !== 'translation-only') {
          const tools = await engine.getToolsStatus(dataDir);
          if (!tools.available) throw new Error('분석 도구를 준비한 뒤 중단 작업을 재개해 주세요.');
        }
        if (previous.operation !== 'translation-only' && options.mode === 'codex' && engine.getProviderStatus) {
          const providers = await engine.getProviderStatus(dataDir);
          if (!providers.codex?.loggedIn || !providers.speech?.available) throw new Error('Codex 로그인과 음성 인식을 준비한 뒤 중단 작업을 재개해 주세요.');
        }
        const details = { resumedFrom: previous.id };
        if (previous.source === 'repair' && previous.repairOf) {
          details.repairOf = previous.repairOf;
          const retained = records.get(previous.repairOf);
          if (retained && fileKey(retained.path) === fileKey(files[0].path)) options.repairRecord = JSON.parse(JSON.stringify(retained));
        }
        if (previous.operation === 'translation-only') {
          if (typeof engine.translateSubtitles !== 'function') throw new Error('이 버전의 분석 엔진은 자막 번역만 복구를 지원하지 않습니다.');
          if (!options.repairRecord) throw new Error('원문이 저장된 분석 결과를 찾을 수 없어 번역만 재개할 수 없습니다.');
          if (!['codex', 'remote'].includes(options.mode)) throw new Error('한국어 자막 번역에는 이 PC의 Codex 또는 분석 서버 연결을 선택해 주세요.');
          await translationFile(options.repairRecord);
          options.subtitleLanguage = 'ko'; options.transcribeAudio = false; options.forceTranslation = previous.forceTranslation === true;
          details.operation = 'translation-only';
        }
        return createJob(files, options, previous.source, details);
      });
      res.status(202).json(snapshot(job));
    } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
  });

  router.post('/jobs/:id/dismiss', async (req, res) => {
    try {
      const result = await serialize(async () => {
        const previous = SAFE_ID.test(req.params.id) && durableJobs.get(req.params.id);
        if (!previous) { const error = new Error('취소할 중단 작업을 찾을 수 없습니다.'); error.status = 404; throw error; }
        if (previous.status !== 'interrupted') { const error = new Error('재시작으로 중단된 대기 작업만 취소할 수 있습니다.'); error.status = 409; throw error; }
        const now = new Date().toISOString(), next = new Map(durableJobs);
        next.set(previous.id, { ...previous, status: 'cancelled', updatedAt: now, finishedAt: now });
        await saveJobJournal(next);
        const retained = jobs.get(previous.id);
        if (retained) { retained.status = 'cancelled'; retained.finishedAt = now; retained.stage = '중단 작업 대기 취소됨'; }
        return { id: previous.id, status: 'cancelled', interruptedJobs: interruptedJobs() };
      });
      res.json(result);
    } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
  });

  router.post('/jobs/:id/cancel', async (req, res) => {
    try {
      const result = await serialize(async () => {
        const job = jobs.get(req.params.id);
        if (!job) { const error = new Error('분석 작업을 찾을 수 없습니다.'); error.status = 404; throw error; }
        if (job.status === 'running') {
          if (job.source === 'auto-pick' || autoPick.entries.length) {
            const next = { ...autoPick, paused: true, pauseCause: { kind: 'user-cancel', ...(job.files[0]?.path ? { path: job.files[0].path } : {}) }, pauseReason: '분석을 중지했습니다. 자동 분석 대기 목록은 재개를 누르면 이어서 처리합니다.' };
            await saveAutoQueue(next);
            autoPick = next;
          }
          job.status = 'cancelling';
          job.stage = '분석 중지 중';
          try { await checkpointJob(job, 'cancelled'); }
          catch (_) { job.error = '중지 상태의 작업 기록을 저장하지 못했습니다. 새 분석은 자동으로 시작하지 않습니다.'; }
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
      res.json({ ...next, ...subtitleMetadata(next) });
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
