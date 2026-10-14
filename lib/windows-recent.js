const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const VIDEO_EXTENSIONS = new Set([
    '.mp4', '.mkv', '.wmv', '.avi', '.mpg', '.mpeg', '.asf', '.flv',
    '.webm', '.mov', '.3gp', '.ts', '.m4v', '.tp', '.m2ts'
]);
const MAX_ENTRIES = 50000;
const DEFAULT_TIMEOUT = 20000;
const DEFAULT_OUTPUT_LIMIT = 16 * 1024 * 1024;

function abortError() {
    const error = new Error('최근 항목 확인이 취소되었습니다.');
    error.name = 'AbortError';
    return error;
}

function fullWindowsPath(value) {
    if (typeof value !== 'string' || !value || value.length > 32767 || /[\x00-\x1f]/.test(value)) return null;
    const normalized = path.win32.normalize(value);
    // A rooted path such as \\movie.mp4 is not fully qualified. Reject devices too.
    const checked = normalized.startsWith('\\\\?\\UNC\\')
        ? `\\\\${normalized.slice(8)}`
        : normalized.startsWith('\\\\?\\') ? normalized.slice(4) : normalized;
    if (!/^[a-z]:\\/i.test(checked) && !/^\\\\[^\\.?:*"<>|]+\\[^\\?:*"<>|]+\\/.test(checked)) return null;
    return normalized;
}

function normalizeEntries(payload, recentDirectory) {
    const entries = [];
    const warnings = Array.isArray(payload.warnings)
        ? payload.warnings.filter(warning => typeof warning === 'string').slice(0, 20).map(warning => warning.slice(0, 300))
        : [];
    const seen = new Set();
    const rawEntries = Array.isArray(payload.entries) ? payload.entries : [];
    if (rawEntries.length > MAX_ENTRIES) warnings.push('최근 항목 결과가 50,000개를 넘어 처음 50,000개만 표시했습니다.');
    for (const item of rawEntries.slice(0, MAX_ENTRIES)) {
        if (!item || typeof item !== 'object') continue;
        const targetPath = fullWindowsPath(item.path);
        const sourcePath = fullWindowsPath(item.sourcePath);
        if (!targetPath || !sourcePath) continue;
        if (path.win32.dirname(sourcePath).toLowerCase() !== recentDirectory.toLowerCase() || path.win32.extname(sourcePath).toLowerCase() !== '.lnk') continue;
        const ext = path.win32.extname(targetPath).toLowerCase();
        if (!VIDEO_EXTENSIONS.has(ext)) continue;
        if (typeof item.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/.test(item.observedAt)) continue;
        const timestamp = Date.parse(item.observedAt);
        if (!Number.isFinite(timestamp)) continue;
        const key = `${sourcePath.toLowerCase()}\n${new Date(timestamp).toISOString()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ path: targetPath, name: path.win32.basename(targetPath), ext, observedAt: new Date(timestamp).toISOString(), sourcePath });
    }
    entries.sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.path.localeCompare(b.path));
    return { entries, warnings };
}

/**
 * Recover evidence from Windows Recent shortcuts, not confirmed VideoRandom plays.
 * No media, shortcut target, or shortcut arguments are ever executed.
 */
async function recoverRecentVideos({
    environment = process.env, platform = process.platform, spawnImpl = spawn,
    signal, timeoutMs = DEFAULT_TIMEOUT, maxOutputBytes = DEFAULT_OUTPUT_LIMIT
} = {}) {
    if (signal && signal.aborted) throw abortError();
    if (platform !== 'win32') return { entries: [], warnings: ['Windows에서만 최근 항목을 가져올 수 있습니다.'] };
    const appData = fullWindowsPath(environment.APPDATA);
    if (!appData) return { entries: [], warnings: ['Windows 최근 항목 폴더를 찾을 수 없습니다.'] };
    const recentDirectory = path.win32.join(appData, 'Microsoft', 'Windows', 'Recent');
    let script;
    try {
        // fs.readFile also reads pkg's immutable snapshot asset; no temporary script needed.
        script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'recover_recent.ps1'), 'utf8');
    } catch (error) {
        return { entries: [], warnings: ['최근 항목 복구 도구를 읽을 수 없습니다. 프로그램을 다시 다운로드해 주세요.'] };
    }
    const timeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(DEFAULT_TIMEOUT, timeoutMs)) : DEFAULT_TIMEOUT;
    const outputLimit = Number.isFinite(maxOutputBytes) ? Math.max(1, Math.min(DEFAULT_OUTPUT_LIMIT, maxOutputBytes)) : DEFAULT_OUTPUT_LIMIT;
    const powershell = path.win32.join(environment.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
    return new Promise((resolve, reject) => {
        let child;
        let timer;
        let settled = false;
        let bytes = 0;
        const output = [];
        const finish = (error, warning, payload) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            if (error) reject(error);
            else if (warning) resolve({ entries: [], warnings: [warning] });
            else resolve(normalizeEntries(payload, recentDirectory));
        };
        const stop = (error, warning) => {
            finish(error, warning);
            if (child) { try { child.kill(); } catch (killError) { /* already exited */ } }
        };
        const onAbort = () => stop(abortError());
        try {
            child = spawnImpl(powershell, args, {
                shell: false, windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'ignore']
            });
        } catch (error) {
            finish(null, 'Windows 최근 항목 복구 도구를 시작할 수 없습니다.');
            return;
        }
        timer = setTimeout(() => stop(null, '최근 항목 확인 시간이 초과되었습니다. 항목 수가 많거나 Windows 응답이 지연될 수 있습니다.'), timeout);
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', chunk => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
            bytes += buffer.length;
            if (bytes > outputLimit) stop(null, '최근 항목 결과가 너무 커서 가져오기를 중단했습니다.');
            else output.push(buffer);
        });
        child.on('error', () => finish(null, 'Windows 최근 항목 복구 도구를 실행할 수 없습니다.'));
        child.on('close', code => {
            if (settled) return;
            if (code !== 0) { finish(null, 'Windows 최근 항목을 읽지 못했습니다.'); return; }
            try {
                const payload = JSON.parse(Buffer.concat(output).toString('utf8').replace(/^\uFEFF/, ''));
                if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid result');
                finish(null, null, payload);
            } catch (error) {
                finish(null, 'Windows 최근 항목 결과를 읽지 못했습니다.');
            }
        });
        if (signal && signal.aborted) onAbort();
    });
}

module.exports = { recoverRecentVideos };
