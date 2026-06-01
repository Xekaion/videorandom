/* ==========================================================================
   🎬 VIDEO ROULETTE - Core Frontend JavaScript Engine
   ========================================================================== */

// Global State
let videoList = [];        // All scanned videos
let filteredList = [];     // Currently filtered videos (based on UI inputs)
let pickHistory = [];      // History of picked videos
let isSoundEnabled = true; // Web Audio API sound effects toggle

// Web Audio API Context (Lazily initialized)
let audioCtx = null;

// Sound FX Synthesizer
function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

/**
 * Synthesizes a futuristic robotic shuffle tick sound
 */
function playTickSound(frequency = 800, duration = 0.04) {
  if (!isSoundEnabled) return;
  try {
    initAudio();
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc.type = 'triangle'; // Cybernetic, warmer tone
    osc.frequency.setValueAtTime(frequency, audioCtx.currentTime);
    // Rapid pitch drop for futuristic "chirp" effect
    osc.frequency.exponentialRampToValueAtTime(100, audioCtx.currentTime + duration);

    gainNode.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);

    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (err) {
    console.error('Audio synthesis failed:', err);
  }
}

/**
 * Synthesizes a glorious spacey cyber winning chime (Major 7th Chord cascade)
 */
function playWinSound() {
  if (!isSoundEnabled) return;
  try {
    initAudio();
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    const now = audioCtx.currentTime;
    // Chime frequencies (C5, E5, G5, B5, C6)
    const freqs = [523.25, 659.25, 783.99, 987.77, 1046.50];
    
    freqs.forEach((freq, idx) => {
      const delay = idx * 0.08;
      
      const osc = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      const filterNode = audioCtx.createBiquadFilter();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + delay);
      
      // Vibrato
      const lfo = audioCtx.createOscillator();
      const lfoGain = audioCtx.createGain();
      lfo.frequency.value = 8; // Hz
      lfoGain.gain.value = 10; // Pitch variation depth
      
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      
      // Bandpass filter for a retro space radio effect
      filterNode.type = 'bandpass';
      filterNode.frequency.value = freq * 1.5;
      
      // Envelope
      gainNode.gain.setValueAtTime(0.001, now + delay);
      gainNode.gain.linearRampToValueAtTime(0.12, now + delay + 0.03);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.6);

      osc.connect(filterNode);
      filterNode.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      lfo.start(now + delay);
      osc.start(now + delay);
      
      lfo.stop(now + delay + 0.6);
      osc.stop(now + delay + 0.6);
    });
  } catch (err) {
    console.error('Audio synthesis failed:', err);
  }
}

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  // Load Settings
  loadSettings();

  // Detect drives
  detectDrives();

  // DOM Elements Event Listeners
  document.getElementById('browseBtn').addEventListener('click', openFolderBrowser);
  document.getElementById('scanBtn').addEventListener('click', startScan);
  document.getElementById('directoryInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') startScan();
  });

  document.getElementById('pickBtn').addEventListener('click', startRoulette);
  document.getElementById('repickBtn').addEventListener('click', startRoulette);
  
  // Filter Listeners
  document.getElementById('filterKeyword').addEventListener('input', applyFilters);
  document.getElementById('filterFormat').addEventListener('change', applyFilters);

  // Winner Actions
  document.getElementById('playWinnerBtn').addEventListener('click', () => {
    const filePath = document.getElementById('winnerPath').textContent;
    playVideo(filePath);
  });
  document.getElementById('openFolderBtn').addEventListener('click', () => {
    const filePath = document.getElementById('winnerPath').textContent;
    openFolder(filePath);
  });

  // Sound Toggle Listener
  document.getElementById('soundToggle').addEventListener('click', toggleSound);

  // Winner Path Copy Event
  document.getElementById('winnerPath').addEventListener('click', (e) => {
    const pathText = e.currentTarget.textContent;
    navigator.clipboard.writeText(pathText)
      .then(() => {
        showToast('경로가 클립보드에 복사되었습니다!');
      })
      .catch(err => {
        console.error('Could not copy path:', err);
      });
  });
});

// Toast Message Generator
function showToast(message) {
  let toast = document.getElementById('appToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'appToast';
    toast.style.cssText = `
      position: fixed;
      bottom: 30px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: rgba(16, 185, 129, 0.95);
      color: black;
      font-weight: 700;
      font-size: 13px;
      padding: 10px 24px;
      border-radius: 30px;
      z-index: 10000;
      box-shadow: 0 4px 20px rgba(16, 185, 129, 0.4);
      opacity: 0;
      transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    `;
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.style.opacity = '1';
  toast.style.transform = 'translateX(-50%) translateY(0)';

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
  }, 2200);
}

// Load / Save Settings via LocalStorage
function loadSettings() {
  // Sound FX
  const soundPref = localStorage.getItem('sound_enabled');
  if (soundPref !== null) {
    isSoundEnabled = soundPref === 'true';
  }
  updateSoundButtonUI();

  // History
  const historyPref = localStorage.getItem('pick_history');
  if (historyPref) {
    try {
      pickHistory = JSON.parse(historyPref);
      renderHistoryList();
    } catch (e) {
      console.error('Failed to parse pick history from local storage');
    }
  }
}

function toggleSound() {
  isSoundEnabled = !isSoundEnabled;
  localStorage.setItem('sound_enabled', isSoundEnabled);
  updateSoundButtonUI();
  
  if (isSoundEnabled) {
    playTickSound(900, 0.05);
  }
}

function updateSoundButtonUI() {
  const btn = document.getElementById('soundToggle');
  const icon = btn.querySelector('i');
  if (isSoundEnabled) {
    btn.classList.add('active');
    icon.className = 'fa-solid fa-volume-high';
    btn.title = '효과음 켜짐';
  } else {
    btn.classList.remove('active');
    icon.className = 'fa-solid fa-volume-xmark';
    btn.title = '효과음 꺼짐';
  }
}

// Native Windows Folder Browser dialog API call
async function openFolderBrowser() {
  const browseBtn = document.getElementById('browseBtn');
  const directoryInput = document.getElementById('directoryInput');
  
  playTickSound(750, 0.04);
  
  // Visual loading state
  const originalHTML = browseBtn.innerHTML;
  browseBtn.disabled = true;
  browseBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 열기 중...';
  
  try {
    const response = await fetch('/api/browse', { method: 'POST' });
    if (!response.ok) throw new Error();
    const data = await response.json();
    
    if (data.selectedPath) {
      directoryInput.value = data.selectedPath;
      showToast('폴더가 선택되었습니다!');
      playTickSound(900, 0.05);
      
      // Auto start scan when folder is selected
      startScan();
    }
  } catch (err) {
    console.error('Failed to open native folder browser:', err);
    showToast('폴더 선택 창을 열지 못했습니다.');
  } finally {
    browseBtn.disabled = false;
    browseBtn.innerHTML = originalHTML;
  }
}

// Drive Detection with smooth cybernetic scanning percentage
async function detectDrives() {
  const drivesGrid = document.getElementById('drivesGrid');
  const progressEl = document.getElementById('driveDetectProgress');
  
  progressEl.classList.remove('hidden');
  progressEl.textContent = '0%';
  
  // Start actual fetch in background
  const fetchPromise = fetch('/api/drives').then(res => {
    if (!res.ok) throw new Error();
    return res.json();
  });
  
  // Visual rapid sweep progress animation (simulates scanning drive letters)
  let percent = 0;
  const letters = 'CDEFGHIJKLMNO';
  
  const progressInterval = setInterval(() => {
    percent += Math.floor(Math.random() * 15) + 8;
    if (percent >= 100) {
      percent = 99;
    }
    const currentLetter = letters[Math.floor((percent / 100) * letters.length)] || 'C';
    progressEl.textContent = `${percent}% (${currentLetter}:\\)`;
  }, 45);
  
  try {
    const drives = await fetchPromise;
    clearInterval(progressInterval);
    progressEl.textContent = '100%';
    
    setTimeout(() => {
      progressEl.style.opacity = '0';
      setTimeout(() => {
        progressEl.classList.add('hidden');
        progressEl.style.opacity = '1';
      }, 300);
    }, 800);
    
    if (drives.length === 0) {
      drivesGrid.innerHTML = '<div class="drive-loading">연결된 외부 드라이브를 찾지 못했습니다.</div>';
      return;
    }

    drivesGrid.innerHTML = '';
    drives.forEach((drive, index) => {
      const card = document.createElement('div');
      // Auto-activate external drives, otherwise C:\
      card.className = `drive-card ${index === 0 && drive.letter !== 'C:\\' ? 'active' : ''}`;
      card.innerHTML = `
        <i class="fa-solid fa-hard-drive"></i>
        <span class="drive-letter">${drive.letter}</span>
        <span class="drive-name">${drive.label.replace(' 드라이브', '')}</span>
      `;
      
      // Toggle active state for multi-drive selection on click
      card.addEventListener('click', () => {
        card.classList.toggle('active');
        playTickSound(650, 0.03);
        
        const activeCards = drivesGrid.querySelectorAll('.drive-card.active');
        const selectedLetters = Array.from(activeCards).map(c => c.querySelector('.drive-letter').textContent);
        
        document.getElementById('directoryInput').value = selectedLetters.join(', ');
      });

      drivesGrid.appendChild(card);
    });

    // Auto set the first detected external drive (if any, otherwise C:\)
    const activeDrive = drivesGrid.querySelector('.drive-card.active');
    if (activeDrive) {
      document.getElementById('directoryInput').value = activeDrive.querySelector('.drive-letter').textContent;
    } else if (drives.length > 0) {
      document.getElementById('directoryInput').value = drives[0].letter;
      drivesGrid.querySelector('.drive-card').classList.add('active');
    }

  } catch (err) {
    clearInterval(progressInterval);
    progressEl.textContent = '에러';
    console.error('Error listing drives:', err);
    drivesGrid.innerHTML = '<div class="drive-loading"><i class="fa-solid fa-triangle-exclamation color-accent"></i> 로딩 실패 (자동 감지 우회)</div>';
  }
}

// Start Directory Scanner API call
async function startScan() {
  const pathInput = document.getElementById('directoryInput').value.trim();

  if (!pathInput) {
    alert('검색할 드라이브 또는 디렉터리 경로를 입력해 주세요.');
    return;
  }

  // Reset states
  videoList = [];
  filteredList = [];
  applyFiltersToUI(0);
  
  // UI transitions
  document.getElementById('scanProgressCard').classList.remove('hidden');
  document.getElementById('scanResultCard').classList.add('hidden');
  
  // Set Roulette back to Empty State
  setRouletteState('init');

  // Interactive scan progress simulations (because real scans can take a few seconds)
  let simulatedFolders = 0;
  let simulatedFiles = 0;
  const progressFoldersEl = document.getElementById('progressFolders');
  const progressFilesEl = document.getElementById('progressFiles');
  const scanningPathText = document.getElementById('scanningPathText');
  
  scanningPathText.textContent = `${pathInput} 에서 영상 데이터 인덱싱 중...`;

  const simulationInterval = setInterval(() => {
    simulatedFolders += Math.floor(Math.random() * 20) + 5;
    simulatedFiles += Math.floor(Math.random() * 8);
    progressFoldersEl.textContent = simulatedFolders;
    progressFilesEl.textContent = simulatedFiles;
    
    // Play light tick in backend scan
    if (simulatedFiles % 10 === 0) {
      playTickSound(1200, 0.01);
    }
  }, 100);

  try {
    const response = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: pathInput })
    });

    clearInterval(simulationInterval);

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || '디렉터리 스캔을 할 수 없습니다.');
    }

    const data = await response.json();
    
    // Set official results
    videoList = data.files;
    filteredList = [...videoList];

    // Hide scanning progress
    document.getElementById('scanProgressCard').classList.add('hidden');
    
    // Populate Results Stats
    document.getElementById('totalVideosCount').textContent = videoList.length;
    document.getElementById('scanDurationText').textContent = data.scanTime;
    document.getElementById('scannedFoldersText').textContent = data.foldersScanned;

    // Render Stats Pills
    renderFormatStats(data.stats);

    // Populate Format Filter Dropdown
    populateFormatFilter(data.stats);

    // Show result
    document.getElementById('scanResultCard').classList.remove('hidden');

    if (videoList.length > 0) {
      setRouletteState('ready');
      applyFilters();
      playWinSound();
    } else {
      setRouletteState('init');
      alert('스캔된 경로에 지원하는 포맷의 영상 파일이 존재하지 않습니다.');
    }

  } catch (err) {
    clearInterval(simulationInterval);
    document.getElementById('scanProgressCard').classList.add('hidden');
    setRouletteState('init');
    alert(`스캔 실패: ${err.message}`);
  }
}

// Render Stats badged pills
function renderFormatStats(stats) {
  const container = document.getElementById('formatStatsTags');
  container.innerHTML = '';
  
  const sortedFormats = Object.entries(stats).sort((a, b) => b[1] - a[1]);
  
  if (sortedFormats.length === 0) {
    container.innerHTML = '<span class="tag-badge">없음</span>';
    return;
  }

  sortedFormats.forEach(([format, count]) => {
    const badge = document.createElement('span');
    badge.className = 'tag-badge';
    badge.innerHTML = `🎬 ${format}: <strong>${count}</strong>`;
    container.appendChild(badge);
  });
}

// Populate Format select box options
function populateFormatFilter(stats) {
  const select = document.getElementById('filterFormat');
  // Clear previous options except the first one
  select.innerHTML = '<option value="">모든 포맷</option>';
  
  const sortedFormats = Object.keys(stats).sort();
  sortedFormats.forEach(format => {
    const opt = document.createElement('option');
    opt.value = format;
    opt.textContent = `${format} (${stats[format]})`;
    select.appendChild(opt);
  });
}

// Apply keyword/format filters to videoList
function applyFilters() {
  const keyword = document.getElementById('filterKeyword').value.trim().toLowerCase();
  const format = document.getElementById('filterFormat').value;

  filteredList = videoList.filter(video => {
    const matchesKeyword = !keyword || video.name.toLowerCase().includes(keyword);
    const matchesFormat = !format || video.ext === format;
    return matchesKeyword && matchesFormat;
  });

  applyFiltersToUI(filteredList.length);
}

function applyFiltersToUI(count) {
  const readyCount = document.getElementById('readyCount');
  const pickBtn = document.getElementById('pickBtn');
  
  if (readyCount) readyCount.textContent = count;
  
  if (pickBtn) {
    if (count === 0) {
      pickBtn.disabled = true;
      pickBtn.classList.add('btn-disabled');
      pickBtn.innerHTML = '<i class="fa-solid fa-ban"></i> 일치하는 영상 없음';
    } else {
      pickBtn.disabled = false;
      pickBtn.classList.remove('btn-disabled');
      pickBtn.innerHTML = '<span class="glow-effect"></span><i class="fa-solid fa-play"></i> 무작위 영상 뽑기!';
    }
  }

  // If roulette is in ready state, update slot message
  const track = document.getElementById('shufflerTrack');
  if (track && videoList.length > 0) {
    track.innerHTML = `<div class="shuffler-slot">필터링 완료: ${count}개 대기 중</div>`;
  }
}

// Manage state transitions for Roulette component
function setRouletteState(state) {
  const states = ['init', 'ready', 'picking', 'winner'];
  states.forEach(s => {
    const el = document.getElementById(`state${s.charAt(0).toUpperCase() + s.slice(1)}`);
    if (el) {
      if (s === state) {
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }
  });

  const container = document.getElementById('rouletteContainer');
  if (container) {
    if (state === 'init') {
      container.className = 'glass-card roulette-card empty-state';
    } else {
      container.className = 'glass-card roulette-card';
    }
  }
}

// Slot Machine Roulette Picker logic with friction deceleration
function startRoulette() {
  if (filteredList.length === 0) return;

  setRouletteState('picking');
  
  const pickingTrack = document.getElementById('pickingTrack');
  pickingTrack.innerHTML = '';

  // Animation configuration
  let currentTickDuration = 20; // Starts fast (ms per tick)
  const maxTickDuration = 550;  // Threshold to select winner and stop
  const friction = 1.12;        // Friction multiplier (speeds down exponentially)
  
  // Pick standard winner now, so we can animate and guarantee arriving at it!
  const randomIndex = Math.floor(Math.random() * filteredList.length);
  const winner = filteredList[randomIndex];

  // Shuffler sound & display tick loop
  function tick() {
    // Generate a random video name to display in the shuffling slot
    const tempIndex = Math.floor(Math.random() * filteredList.length);
    const tempVideo = filteredList[tempIndex];
    
    pickingTrack.innerHTML = `<div class="shuffler-slot">[${tempVideo.ext}] ${tempVideo.name}</div>`;
    
    // Cybernetic click chirp frequency rises as deceleration occurs (feels high tech)
    const pitch = 500 + (currentTickDuration * 1.5);
    playTickSound(pitch, 0.04);

    // Apply deceleration friction
    currentTickDuration = Math.round(currentTickDuration * friction);

    if (currentTickDuration < maxTickDuration) {
      setTimeout(tick, currentTickDuration);
    } else {
      // DECELERATION END: REVEAL WINNER!
      revealWinner(winner);
    }
  }

  // Launch shuffler loop
  setTimeout(tick, currentTickDuration);
}

// Reveal Winner details and invoke particle animations
function revealWinner(winner) {
  setRouletteState('winner');
  
  // Sound FX
  playWinSound();

  // Populate data
  document.getElementById('winnerName').textContent = winner.name;
  document.getElementById('winnerExt').textContent = winner.ext;
  document.getElementById('winnerExtLabel').textContent = winner.ext;
  document.getElementById('winnerSize').textContent = winner.size > 0 ? `${winner.size} MB` : '크기 확인 불가';
  document.getElementById('winnerPath').textContent = winner.path;

  // Visual Particle celebration burst
  burstConfetti();

  // Push to history array
  addToHistory(winner);
}

// Particle generator (Confetti inside winner card)
function burstConfetti() {
  const holder = document.getElementById('confettiHolder');
  holder.innerHTML = '';
  
  const particleCount = 65;
  const colors = ['#a855f7', '#06b6d4', '#ec4899', '#10b981', '#f59e0b', '#3b82f6'];

  for (let i = 0; i < particleCount; i++) {
    const particle = document.createElement('div');
    particle.className = 'confetti-particle';
    
    // Random sizes, colors and physics
    const color = colors[Math.floor(Math.random() * colors.length)];
    const size = Math.floor(Math.random() * 7) + 4;
    const xStart = Math.random() * 100; // %
    const duration = (Math.random() * 1.5) + 1; // seconds
    const delay = Math.random() * 0.3;
    const rotation = Math.floor(Math.random() * 360);

    particle.style.cssText = `
      left: ${xStart}%;
      top: -10px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${Math.random() > 0.5 ? '50%' : '2px'};
      box-shadow: 0 0 6px ${color};
      transform: rotate(${rotation}deg);
      animation: fallConfetti ${duration}s cubic-bezier(0.1, 0.8, 0.3, 1) ${delay}s forwards;
    `;
    
    holder.appendChild(particle);
  }
}

// OS API integrations: Play File
async function playVideo(filePath) {
  if (!filePath) return;
  try {
    const response = await fetch('/api/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath })
    });
    if (!response.ok) throw new Error();
    showToast('윈도우 미디어 플레이어로 영상을 재생합니다!');
    playTickSound(700, 0.05);
  } catch (e) {
    alert('영상을 실행하는 데 실패했습니다. 파일 경로 또는 시스템 연결을 확인하세요.');
  }
}

// OS API integrations: Highlight in Explorer
async function openFolder(filePath) {
  if (!filePath) return;
  try {
    const response = await fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath })
    });
    if (!response.ok) throw new Error();
    showToast('탐색기에서 파일 위치를 열었습니다!');
    playTickSound(850, 0.04);
  } catch (e) {
    alert('폴더를 열지 못했습니다.');
  }
}

// Add winner to Pick History queue
function addToHistory(video) {
  // Check if it already exists to avoid duplicates
  pickHistory = pickHistory.filter(item => item.path !== video.path);
  
  // Insert at front
  const timestamp = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  pickHistory.unshift({
    name: video.name,
    path: video.path,
    size: video.size,
    ext: video.ext,
    time: timestamp
  });

  // Keep top 5
  if (pickHistory.length > 5) {
    pickHistory.pop();
  }

  // Persist
  localStorage.setItem('pick_history', JSON.stringify(pickHistory));

  renderHistoryList();
}

// Render dynamic history card list
function renderHistoryList() {
  const container = document.getElementById('historyList');
  const historyCard = document.getElementById('historyCard');

  if (pickHistory.length === 0) {
    historyCard.classList.add('hidden');
    return;
  }

  historyCard.classList.remove('hidden');
  container.innerHTML = '';

  pickHistory.forEach(item => {
    const row = document.createElement('div');
    row.className = 'history-item';
    row.innerHTML = `
      <div class="history-info">
        <div class="history-dot"></div>
        <div class="history-name" title="${item.name}">${item.name}</div>
        <div class="history-meta">[${item.ext} | ${item.time}]</div>
      </div>
      <div class="history-actions">
        <button class="btn-mini play" title="재생하기">
          <i class="fa-solid fa-play"></i> 재생
        </button>
        <button class="btn-mini folder" title="위치 보기">
          <i class="fa-solid fa-folder-open"></i> 폴더
        </button>
      </div>
    `;

    // Hook buttons
    row.querySelector('.play').addEventListener('click', () => playVideo(item.path));
    row.querySelector('.folder').addEventListener('click', () => openFolder(item.path));

    container.appendChild(row);
  });
}
