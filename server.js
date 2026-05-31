const express = require('express');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const { exec, spawn } = require('child_process');
const open = require('open');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  const { directory } = req.body;

  if (!directory) {
    return res.status(400).json({ error: '디렉터리 경로가 필요합니다.' });
  }

  try {
    // Asynchronous folder accessibility check
    await fsPromises.access(directory, fs.constants.F_OK);
  } catch (e) {
    return res.status(400).json({ error: '존재하지 않거나 접근이 거부된 디렉터리 경로입니다.' });
  }

  console.log(`Starting non-blocking async scan in: ${directory}`);
  
  const videoFiles = [];
  const formatStats = {}; 
  const errors = [];
  
  // Asynchronous Breadth-First Search queue
  const queue = [directory];
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

  try {
    await fsPromises.access(filePath, fs.constants.F_OK);
  } catch (e) {
    return res.status(400).json({ error: '파일이 디스크에 존재하지 않습니다.' });
  }

  console.log(`Opening folder for: ${filePath}`);
  
  const explorer = spawn('explorer.exe', [`/select,${filePath}`]);

  explorer.on('error', (err) => {
    console.error('Failed to open explorer:', err);
    return res.status(500).json({ error: '폴더를 열지 못했습니다.' });
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

  try {
    await fsPromises.access(filePath, fs.constants.F_OK);
  } catch (e) {
    return res.status(400).json({ error: '파일이 디스크에 존재하지 않습니다.' });
  }

  console.log(`Playing file: ${filePath}`);

  const playProcess = spawn('cmd.exe', ['/c', 'start', '', filePath]);

  playProcess.on('error', (err) => {
    console.error('Failed to play file:', err);
    return res.status(500).json({ error: '영상을 실행하지 못했습니다.' });
  });

  return res.json({ success: true });
});

// Start Server
app.listen(PORT, async () => {
  const localUrl = `http://localhost:${PORT}`;
  console.log(`===================================================`);
  console.log(`🎬 Video Roulette Server is running!`);
  console.log(`🔗 Local URL: ${localUrl}`);
  console.log(`===================================================`);

  try {
    await open(localUrl);
    console.log(`🚀 Browser opened automatically!`);
  } catch (err) {
    console.log(`⚠️  Could not open browser automatically. Please open: ${localUrl}`);
  }
});
