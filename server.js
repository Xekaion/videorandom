const express = require('express');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const { exec, spawn } = require('child_process');
const open = require('open');
const { createAnalysisService, defaultDataDir } = require('./lib/analysis-service');
const { createHistoryService } = require('./lib/history-service');
const { recoverRecentVideos } = require('./lib/windows-recent');
const { startLocalServer, startExistingAnalysisHost } = require('./lib/app-server');

const app = express();
const APP_VERSION = require('./package.json').version;
const requestedPort = Number(process.env.PORT || 3000);
let PORT = requestedPort;
let startupInfo = { requestedPort, port: PORT, portConflict: false };
// A second launch may reuse an existing app. It must not submit that app's
// restored analysis queue before local server ownership is decided.
const analysisService = createAnalysisService({ deferAutoStart: true });
const historyService = createHistoryService({ dataDir: defaultDataDir() });

// Middleware
app.use('/api/history/import-json', express.json({ limit: '64mb' }));
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) return res.status(403).json({ error: '로컬 주소로 접속해 주세요.' });
  next();
});
// The catalog may contain private media. Keep access on this computer and
// reject browser requests from unrelated origins, including other local ports.
app.use('/api', (req, res, next) => {
  const origin = req.get('Origin');
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const expectedPort = String(PORT);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(originUrl.hostname) || originUrl.protocol !== 'http:' || (originUrl.port || '80') !== expectedPort) return res.status(403).json({ error: '이 프로그램의 화면에서 요청해 주세요.' });
    } catch (error) { return res.status(403).json({ error: '요청 출처가 올바르지 않습니다.' }); }
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));
app.use('/api/analysis', analysisService.router);
app.use('/api/history', historyService.router);
app.get('/api/app-info', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ application: 'videorandom', version: APP_VERSION, features: ['catalog', 'history'], ...startupInfo });
});
app.post('/api/history/recover-windows', async (req, res) => {
  try {
    const recovered = await recoverRecentVideos();
    const result = await historyService.importWindowsRecent(recovered.entries);
    res.json({ ...result, warnings: [...(result.warnings || []), ...recovered.warnings] });
  } catch (error) { res.status(500).json({ error: 'Windows 최근 영상 흔적을 읽지 못했습니다: ' + error.message }); }
});

// Video file extensions to search
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.wmv', '.avi', '.mpg', '.mpeg', 
  '.asf', '.flv', '.webm', '.mov', '.3gp', '.ts', 
  '.m4v', '.tp', '.m2ts'
]);

// Directories to skip for performance and safety
const EXCLUDED_DIRS = new Set([
  '$recycle.bin',
  'system volume information',
  'node_modules',
  '.git',
  '.vscode',
  'appdata',
  'program files',
  'program files (x86)',
  'windows',
  'boot',
  'recovery'
]);

/**
 * Executes a command with a strict timeout to prevent indefinite hangs
 */
function runCommandWithTimeout(command, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const child = exec(command, { encoding: 'utf8' }, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

/**
 * GET /api/drives
 * Detects all active local and external drives asynchronously in a non-blocking way
 */
app.get('/api/drives', async (req, res) => {
  console.log('Detecting drives requested...');
  
  try {
    // Run PowerShell with a 2-second timeout limit
    const psCommand = `powershell -Command "Get-Volume | Where-Object {$_.DriveLetter} | Select-Object DriveLetter, FriendlyName | ConvertTo-Json -Compress"`;
    const output = await runCommandWithTimeout(psCommand, 2000);
    
    if (output && output.trim()) {
      let parsed = JSON.parse(output);
      if (!Array.isArray(parsed)) {
        parsed = [parsed];
      }

      const drives = parsed.map(d => ({
        letter: `${d.DriveLetter}:\\`,
        label: d.FriendlyName ? `${d.FriendlyName} (${d.DriveLetter}:)` : `${d.DriveLetter}: 드라이브`
      }));

      return res.json(drives);
    }
    
    throw new Error('Empty PowerShell output');
  } catch (err) {
    console.warn('PowerShell drive detection failed or timed out. Using fast parallel async fallback:', err.message);
    
    // Fast parallel async fallback: check C to Z letters asynchronously
    const drives = [];
    const checkPromises = [];

    for (let charCode = 67; charCode <= 90; charCode++) {
      const letter = String.fromCharCode(charCode) + ':\\';
      
      // Asynchronous non-blocking file access check
      checkPromises.push(
        fsPromises.access(letter, fs.constants.F_OK)
          .then(() => {
            drives.push({
              letter: letter,
              label: `${String.fromCharCode(charCode)}: 드라이브`
            });
          })
          .catch(() => {
            // Drive letter not active or inaccessible
          })
      );
    }

    // Wait for all letter checks in parallel (does not block Node event loop)
    await Promise.all(checkPromises);
    
    // Sort drives by letter name
    drives.sort((a, b) => a.letter.localeCompare(b.letter));
    
    return res.json(drives);
  }
});

/**
 * POST /api/browse
 * Opens native Windows folder browser dialog via PowerShell and returns the selected path
 */
app.post('/api/browse', async (req, res) => {
  console.log('Opening native folder browser dialog...');
  
  // Script uses [System.Windows.Forms.FolderBrowserDialog] in STA mode
  const psCommand = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = '스캔할 드라이브 또는 폴더를 선택하세요'; $dialog.ShowNewFolderButton = $false; if ($dialog.ShowDialog() -eq 'OK') { Write-Output $dialog.SelectedPath }"`;

  try {
    // 60 seconds timeout so user has plenty of time to choose a folder
    const output = await runCommandWithTimeout(psCommand, 60000);
    const selectedPath = output.trim();
    
    if (selectedPath) {
      console.log('Selected folder path:', selectedPath);
      return res.json({ selectedPath });
    }
    
    return res.json({ selectedPath: null });
  } catch (err) {
    console.warn('Folder dialog cancelled or failed:', err.message);
    return res.json({ selectedPath: null });
  }
});

/**
 * POST /api/scan
 * Recursively scans the given directory asynchronously for video files without blocking the server
 */
app.post('/api/scan', async (req, res) => {
  const { directory, excludeDirs } = req.body;

  if (!directory) {
    return res.status(400).json({ error: '디렉터리 경로가 필요합니다.' });
  }

  // Parse custom exclusions
  const userExcludeDirs = Array.isArray(excludeDirs) ? excludeDirs : [];
  const customExcludeNames = new Set();
  const customExcludePaths = [];

  for (const item of userExcludeDirs) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.includes('\\') || trimmed.includes('/')) {
      customExcludePaths.push(path.normalize(trimmed).toLowerCase());
    } else {
      customExcludeNames.add(trimmed.toLowerCase());
    }
  }

  // Parse comma-separated paths (e.g. "D:\, E:\")
  const paths = typeof directory === 'string'
    ? directory.split(',').map(d => d.trim()).filter(Boolean)
    : [directory];

  if (paths.length === 0) {
    return res.status(400).json({ error: '유효한 디렉터리 경로가 없습니다.' });
  }

  const validDirs = [];
  for (const dir of paths) {
    try {
      // Check folder accessibility asynchronously
      await fsPromises.access(dir, fs.constants.F_OK);
      validDirs.push(dir);
    } catch (e) {
      console.warn(`Directory not accessible: ${dir}`);
    }
  }

  if (validDirs.length === 0) {
    return res.status(400).json({ error: '지정된 모든 디렉터리가 존재하지 않거나 접근이 거부되었습니다.' });
  }

  console.log(`Starting non-blocking async scan in: ${validDirs.join(', ')}`);
  if (userExcludeDirs.length > 0) {
    console.log(`Excluding custom directories/paths: ${userExcludeDirs.join(', ')}`);
  }
  
  const videoFiles = [];
  const formatStats = {}; 
  const errors = [];
  
  // Asynchronous Breadth-First Search queue initialized with multiple roots
  const queue = [...validDirs];
  let scannedFoldersCount = 0;
  const startTime = Date.now();

  try {
    while (queue.length > 0) {
      const currentDir = queue.shift();
      scannedFoldersCount++;

      // Safety scanning limit
      if (videoFiles.length > 100000) {
        console.warn('Reached safety scan limit of 100,000 video files. Stopping scan.');
        break;
      }

      let files = [];
      try {
        // Asynchronous readdir (does not block Node event loop)
        files = await fsPromises.readdir(currentDir, { withFileTypes: true });
      } catch (err) {
        // Skip inaccessible directories
        errors.push({ path: currentDir, message: err.message });
        continue;
      }

      for (const file of files) {
        const fullPath = path.join(currentDir, file.name);

        if (file.isDirectory()) {
          const dirNameLower = file.name.toLowerCase();
          
          // Skip system/excluded directories
          if (EXCLUDED_DIRS.has(dirNameLower) || dirNameLower.startsWith('.')) {
            continue;
          }

          // Skip custom excluded names (e.g. Cache)
          if (customExcludeNames.has(dirNameLower)) {
            continue;
          }

          // Skip custom excluded paths (e.g. D:\huge_folder)
          if (customExcludePaths.length > 0) {
            const normFullPath = path.normalize(fullPath).toLowerCase();
            const shouldSkipPath = customExcludePaths.some(p => {
              const rel = path.relative(p, normFullPath);
              return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
            });
            if (shouldSkipPath) {
              continue;
            }
          }

          queue.push(fullPath);
        } else if (file.isFile()) {
          const ext = path.extname(file.name).toLowerCase();
          
          if (VIDEO_EXTENSIONS.has(ext)) {
            let sizeMb = 0;
            try {
              // Asynchronous file stat
              const stats = await fsPromises.stat(fullPath);
              sizeMb = Math.round((stats.size / (1024 * 1024)) * 10) / 10;
            } catch (e) {
              // Ignore stats gathering error
            }

            videoFiles.push({
              name: file.name,
              path: fullPath,
              dir: currentDir,
              ext: ext.substring(1).toUpperCase(),
              size: sizeMb
            });

            const extUpper = ext.substring(1).toUpperCase();
            formatStats[extUpper] = (formatStats[extUpper] || 0) + 1;
          }
        }
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`Scan completed in ${duration}s. Found ${videoFiles.length} videos.`);
    analysisService.registerFiles(videoFiles);

    return res.json({
      success: true,
      scanTime: `${duration}초`,
      foldersScanned: scannedFoldersCount,
      filesCount: videoFiles.length,
      files: videoFiles,
      stats: formatStats
    });

  } catch (err) {
    console.error('Scan error:', err);
    return res.status(500).json({ error: '스캔 작업 중 에러가 발생했습니다: ' + err.message });
  }
});

/**
 * POST /api/open
 * Opens the file's parent folder and highlights the file in Windows Explorer
 */
app.post('/api/open', async (req, res) => {
  const { filePath } = req.body;

  if (!filePath) {
    return res.status(400).json({ error: '파일 경로가 누락되었습니다.' });
  }

  // Standardize to Windows backslashes and normalize
  const winPath = path.normalize(filePath).replace(/\//g, '\\');

  try {
    await fsPromises.access(winPath, fs.constants.F_OK);
  } catch (e) {
    return res.status(400).json({ error: '파일이 디스크에 존재하지 않습니다.' });
  }

  console.log(`Opening folder and highlighting: ${winPath}`);
  
  // Use exec to bypass Node's argument escaping and pass raw quotes to Explorer
  exec(`explorer.exe /select,"${winPath}"`, (err) => {
    if (err) {
      console.error('Failed to execute explorer command:', err);
    }
  });

  return res.json({ success: true });
});

/**
 * POST /api/play
 * Plays the video using Windows default media player
 */
app.post('/api/play', async (req, res) => {
  const { filePath } = req.body;

  if (!filePath) {
    return res.status(400).json({ error: '파일 경로가 누락되었습니다.' });
  }

  // Standardize to Windows backslashes and normalize
  const winPath = path.normalize(filePath).replace(/\//g, '\\');

  try {
    await fsPromises.access(winPath, fs.constants.F_OK);
  } catch (e) {
    return res.status(400).json({ error: '파일이 디스크에 존재하지 않습니다.' });
  }

  console.log(`Playing file: ${winPath}`);

  try {
    await open(winPath);
  } catch (error) { return res.status(500).json({ error: '기본 플레이어로 영상을 실행하지 못했습니다.' }); }
  try {
    const stat = await fsPromises.stat(winPath);
    await historyService.recordPlayback({ path: path.resolve(winPath), name: path.basename(winPath), ext: path.extname(winPath).toLowerCase(), size: Math.round(stat.size / (1024 * 1024) * 10) / 10 });
    return res.json({ success: true, historySaved: true });
  } catch (error) {
    return res.json({ success: true, historySaved: false, warning: '재생은 실행했지만 기록을 저장하지 못했습니다. 저장 폴더를 확인해 주세요.' });
  }
});

// Start Server
async function start() {
  const result = await startLocalServer(app, { port: requestedPort, version: APP_VERSION });
  PORT = result.port;
  startupInfo = { requestedPort, port: PORT, portConflict: result.portConflict };
  if (result.server) result.server.on('error', error => console.error('프로그램 서버 오류:', error.message));
  if (result.server) {
    await analysisService.ready;
    await analysisService.activateAutoAnalysis();
  } else {
    await analysisService.stop();
  }
  const localUrl = `http://localhost:${PORT}`;
  console.log(`===================================================`);
  console.log(`🎬 Video Roulette v${APP_VERSION} ${result.reused ? 'is already running' : 'Server is running'}!`);
  console.log(`🔗 Local URL: ${localUrl}`);
  console.log(`===================================================`);

  try {
    if (result.portConflict) console.log('기존 프로그램이 사용 중인 포트를 피해 새 버전을 열었습니다. 이전 브라우저 기록은 기존 프로그램 종료 후 같은 브라우저의 localhost:3000에서 가져올 수 있습니다.');
    try {
      const hostPreference = process.env.VIDEORANDOM_START_HOST;
      const shouldStartHost = hostPreference === '1' || (hostPreference !== '0' && await analysisService.getHostAutoStart());
      if (shouldStartHost) {
        const host = result.reused ? await startExistingAnalysisHost(PORT) : await analysisService.startHost();
        console.log('분석 서버 시작:', host.addresses.join(', '));
      }
    } catch (error) { console.error('분석 서버 시작 실패:', error.message); }
    if (process.env.VIDEORANDOM_NO_OPEN === '1') return;
    await open(localUrl);
    console.log(`🚀 Browser opened automatically!`);
  } catch (err) {
    console.log(`⚠️  Could not open browser automatically. Please open: ${localUrl}`);
  }
}
start().catch(error => {
  console.error('프로그램 시작 실패:', error.message);
  process.exitCode = 1;
});
