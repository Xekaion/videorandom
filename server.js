const express = require('express');
const path = require('path');
const fs = require('fs');
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
  '.m4v', '.tp', '.ts', '.m2ts'
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
 * Helper to execute command and return output as promise
 */
function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/**
 * GET /api/drives
 * Detects all active local and external drives using PowerShell
 */
app.get('/api/drives', async (req, res) => {
  try {
    // Run PowerShell to get drive letters and friendly names
    const psCommand = `powershell -Command "Get-Volume | Where-Object {$_.DriveLetter} | Select-Object DriveLetter, FriendlyName | ConvertTo-Json -Compress"`;
    const output = await runCommand(psCommand);
    
    if (!output.trim()) {
      return res.json([]);
    }

    let parsed = JSON.parse(output);
    // If only one drive is found, ConvertTo-Json might output a single object instead of an array
    if (!Array.isArray(parsed)) {
      parsed = [parsed];
    }

    const drives = parsed.map(d => ({
      letter: `${d.DriveLetter}:\\`,
      label: d.FriendlyName ? `${d.FriendlyName} (${d.DriveLetter}:)` : `${d.DriveLetter}: 드라이브`
    }));

    res.json(drives);
  } catch (err) {
    console.error('Error detecting drives:', err);
    // Fallback: search common drive letters (C to Z)
    const drives = [];
    for (let charCode = 67; charCode <= 90; charCode++) {
      const letter = String.fromCharCode(charCode) + ':\\';
      try {
        if (fs.existsSync(letter)) {
          drives.push({
            letter: letter,
            label: `${String.fromCharCode(charCode)}: 드라이브`
          });
        }
      } catch (e) {
        // Skip inaccessible drives
      }
    }
    res.json(drives);
  }
});

/**
 * POST /api/scan
 * Recursively scans the given directory for video files
 */
app.post('/api/scan', async (req, res) => {
  const { directory } = req.body;

  if (!directory) {
    return res.status(400).json({ error: 'Directory path is required' });
  }

  // Validate path existence
  if (!fs.existsSync(directory)) {
    return res.status(400).json({ error: '존재하지 않는 디렉터리 경로입니다.' });
  }

  console.log(`Starting scan in: ${directory}`);
  
  const videoFiles = [];
  const formatStats = {}; // To count occurrences of each extension
  const errors = [];
  
  // Use BFS (Breadth-First Search) queue to avoid stack overflow for extremely deep folders
  const queue = [directory];
  let scannedFoldersCount = 0;
  const startTime = Date.now();

  try {
    while (queue.length > 0) {
      const currentDir = queue.shift();
      scannedFoldersCount++;

      // Safety limit: if someone scans the entire C:\ drive, it might explode.
      // We limit to 300,000 files or 15,000 directories, but let's make it robust.
      if (videoFiles.length > 100000) {
        console.warn('Reached safety scan limit of 100,000 video files. Stopping scan.');
        break;
      }

      let files = [];
      try {
        files = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch (err) {
        // Skip directories without permission (e.g. system files)
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
              const stats = fs.statSync(fullPath);
              sizeMb = Math.round((stats.size / (1024 * 1024)) * 10) / 10; // 1 decimal place
            } catch (e) {
              // Ignore file stats error
            }

            videoFiles.push({
              name: file.name,
              path: fullPath,
              dir: currentDir,
              ext: ext.substring(1).toUpperCase(), // e.g. "MP4"
              size: sizeMb
            });

            // Update stats
            const extUpper = ext.substring(1).toUpperCase();
            formatStats[extUpper] = (formatStats[extUpper] || 0) + 1;
          }
        }
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`Scan completed in ${duration}s. Found ${videoFiles.length} videos.`);

    res.json({
      success: true,
      scanTime: `${duration}초`,
      foldersScanned: scannedFoldersCount,
      filesCount: videoFiles.length,
      files: videoFiles,
      stats: formatStats
    });

  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: '스캔 작업 중 에러가 발생했습니다: ' + err.message });
  }
});

/**
 * POST /api/open
 * Opens the file's parent folder and highlights the file in Windows Explorer
 */
app.post('/api/open', (req, res) => {
  const { filePath } = req.body;

  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(400).json({ error: '유효한 파일 경로가 아닙니다.' });
  }

  console.log(`Opening folder for: ${filePath}`);
  
  // Highlight the file in Windows Explorer
  // explorer.exe /select,"<filePath>"
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
app.post('/api/play', (req, res) => {
  const { filePath } = req.body;

  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(400).json({ error: '유효한 파일 경로가 아닙니다.' });
  }

  console.log(`Playing file: ${filePath}`);

  // launch file using CMD start
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
    // Automatically open the browser
    await open(localUrl);
    console.log(`🚀 Browser opened automatically!`);
  } catch (err) {
    console.log(`⚠️  Could not open browser automatically. Please open: ${localUrl}`);
  }
});
